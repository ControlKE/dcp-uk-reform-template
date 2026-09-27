// Background jobs, run in batches:
//   mail     send what the mail queue's rate limits allow
//   cleanup  unsent attachments older than a day, stored files nothing uses any more
//   backup   the nightly off-site backup (lib/backup.js), once a day after BACKUP_HOUR (UTC)
//
// Three ways to run them (JOBS_MODE):
//   loop (default)  the web app sends mail every few seconds and checks the other
//                   jobs every 10 minutes. Right for Railway and any always-on host.
//   cron            the web app starts nothing; a scheduler runs `npm run jobs:run`
//                   (or calls GET /internal/cron?token=CRON_TOKEN) every minute. For
//                   hosts that stop idle apps (cPanel/Passenger).
// Either way a database lock makes sure two runs never overlap, and every run of
// cleanup and backup is recorded in job_runs (the dashboard reads it).
const db = require('./db');
const email = require('./email');
const storage = require('./storage');
const backup = require('./backup');
const maintenance = require('./maintenance');

const MODE = (process.env.JOBS_MODE || 'loop').toLowerCase() === 'cron' ? 'cron' : 'loop';
const BACKUP_HOUR = Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR_UTC ?? 2)));
const LOCK = 'dcp_uk_jobs';

// The last run of a job with the given status (any status when omitted).
async function lastRun(job, status = null) {
  return (status
    ? db.one('SELECT started_at, finished_at FROM job_runs WHERE job = ? AND status = ? ORDER BY id DESC LIMIT 1', [job, status])
    : db.one('SELECT started_at, finished_at FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1', [job]))
    .catch((err) => { if (noTable(err)) return null; throw err; });
}
// job_runs arrives with migration 007. Before that (maintenance mode with that migration
// waiting) jobs still run, most importantly the backup taken before applying it; they
// just aren't logged.
const noTable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
// Runs that couldn't be logged yet; written by flushUnlogged() once the table exists.
const unlogged = [];
async function flushUnlogged() {
  while (unlogged.length) {
    const u = unlogged[0];
    await db.query('INSERT INTO job_runs (job, status, started_at, finished_at, detail, bytes, trigger_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [u.job, u.status, u.startedAt, u.finishedAt, u.detail, u.bytes, u.trigger]);
    unlogged.shift();
  }
}
const sqlNow = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

async function logStart(name, trigger) {
  try { return (await db.query("INSERT INTO job_runs (job, status, started_at, trigger_by) VALUES (?, 'running', UTC_TIMESTAMP(3), ?)", [name, trigger])).insertId; } catch (err) { if (noTable(err)) return null; throw err; }
}

const hoursSince = (sqlTime) => (sqlTime ? (Date.now() - Date.parse(`${sqlTime.replace(' ', 'T')}Z`)) / 3600000 : Infinity);

async function cleanup() {
  let files = 0;
  // Attachments added to a compose window that was never sent.
  const stale = await db.query('SELECT id, file_id FROM email_attachments WHERE email_id IS NULL AND created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
  if (stale.length) await db.query(`DELETE FROM email_attachments WHERE id IN (${stale.map(() => '?').join(',')})`, stale.map((a) => a.id));
  // Stored attachment files no email refers to any more (e.g. the email was deleted).
  const orphans = await db.query(`SELECT f.id FROM files f LEFT JOIN email_attachments a ON a.file_id = f.id
    WHERE f.purpose = 'email_attachment' AND a.id IS NULL AND f.created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY`);
  for (const f of orphans) { await storage.remove(f.id); files++; }
  await db.query('DELETE FROM job_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 400 DAY');
  return { detail: `${stale.length} unsent attachment(s), ${files} unused file(s) removed` };
}

const JOBS = {
  mail: { due: async () => true, run: async () => { const n = await email.tick(); return { detail: `${n} message(s) delivered`, quiet: n === 0 }; } },
  cleanup: { due: async () => hoursSince((await lastRun('cleanup'))?.started_at) >= 1, run: cleanup },
  // Once a day after BACKUP_HOUR; after a failure, tried again an hour later.
  backup: {
    due: async () => backup.configured() && new Date().getUTCHours() >= BACKUP_HOUR
      && hoursSince((await lastRun('backup', 'ok'))?.started_at) >= 20 && hoursSince((await lastRun('backup'))?.started_at) >= 1,
    run: async () => { const r = await backup.run(); return { detail: r.key, bytes: r.bytes, extra: r }; },
  },
};

// Runs every job that is due (or those in `force`), one run at a time across all
// processes. Returns [{ job, status, detail }].
// ignoreMaintenance: for the admin's "Back up now", which is most needed in maintenance mode.
async function runDue({ trigger = 'cli', only = null, force = [], ignoreMaintenance = false } = {}) {
  if (maintenance.on() && !ignoreMaintenance) return [{ job: '*', status: 'skipped', detail: 'maintenance mode' }];
  const conn = await db.raw().getConnection();
  const results = [];
  try {
    const [[got]] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [LOCK]);
    if (!got?.ok) return [{ job: '*', status: 'skipped', detail: 'another run is in progress' }];
    for (const [name, job] of Object.entries(JOBS)) {
      if (only && !only.includes(name)) continue;
      if (!force.includes(name) && !(await job.due())) continue;
      const id = name === 'mail' ? null : await logStart(name, trigger);
      const startedAt = sqlNow();
      try {
        const r = await job.run();
        if (!id && name !== 'mail') unlogged.push({ job: name, status: 'ok', startedAt, finishedAt: sqlNow(), detail: String(r.detail || '').slice(0, 500), bytes: r.bytes ?? null, trigger });
        if (id) await db.query("UPDATE job_runs SET status = 'ok', finished_at = UTC_TIMESTAMP(3), detail = ?, bytes = ? WHERE id = ?", [String(r.detail || '').slice(0, 500), r.bytes ?? null, id]);
        if (!r.quiet) results.push({ job: name, status: 'ok', detail: r.detail, ...(r.extra ? { result: r.extra } : {}) });
      } catch (err) {
        if (id) await db.query("UPDATE job_runs SET status = 'failed', finished_at = UTC_TIMESTAMP(3), detail = ? WHERE id = ?", [String(err.message).slice(0, 500), id]);
        console.error(`Job ${name} failed:`, err.message);
        results.push({ job: name, status: 'failed', detail: err.message });
      }
    }
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
    conn.release();
  }
  return results;
}

// JOBS_MODE=loop: mail every few seconds (lib/email.js), everything else every 10 minutes.
let loopTimer = null;
function startLoop() {
  if (MODE !== 'loop' || loopTimer) return;
  email.startQueue();
  const tick = () => runDue({ trigger: 'loop', only: ['cleanup', 'backup'] }).catch((err) => console.error('Jobs:', err.message));
  loopTimer = setInterval(tick, 10 * 60 * 1000);
  loopTimer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}

module.exports = { noTable, flushUnlogged, MODE, BACKUP_HOUR, JOBS, runDue, startLoop, cleanup };
