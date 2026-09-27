// Nightly off-site backup: a gzipped SQL dump of the whole database uploaded to
// S3-compatible storage (Backblaze B2 or Cloudflare R2; the same S3_* settings as
// the storage adapter). Keeps the newest 14 daily and 6 monthly copies:
//   <prefix>daily/dcp-uk-<db>-YYYY-MM-DD.sql.gz
//   <prefix>monthly/dcp-uk-<db>-YYYY-MM.sql.gz    (the first backup of each month)
// Runs from the jobs runner (lib/jobs.js). Restore with npm run db:restore.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('./db');
const dump = require('./dump');
const s3 = require('./s3');

const prefix = () => { const p = (process.env.BACKUP_S3_PREFIX ?? 'backups/').replace(/^\/+/, ''); return p && !p.endsWith('/') ? `${p}/` : p; };
const keep = (name, fallback) => Math.max(1, Number(process.env[name]) || fallback);
const KEEP_DAILY = () => keep('BACKUP_KEEP_DAILY', 14);
const KEEP_MONTHLY = () => keep('BACKUP_KEEP_MONTHLY', 6);
// A backup older than this shows red on the dashboard.
const STALE_HOURS = 48;

const configured = () => s3.configured();

// Removes all but the newest `count` backups under a prefix (only our own file names).
async function prune(dir, count) {
  const mine = (await s3.list(dir)).filter((o) => /\/dcp-uk-[A-Za-z0-9_]+-\d{4}-\d{2}(-\d{2})?\.sql\.gz$/.test(o.key)).sort((a, b) => b.key.localeCompare(a.key));
  const old = mine.slice(count);
  for (const o of old) await s3.remove(o.key);
  return old.map((o) => o.key);
}

// Takes a backup now. Returns { key, bytes, monthly, pruned }.
async function run() {
  if (!configured()) throw new Error(`Off-site backups need S3 storage (missing ${s3.missing().join(', ')}).`);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const name = `dcp-uk-${db.config.database}`;
  const tmp = path.join(os.tmpdir(), `${name}-${process.pid}-${now.getTime()}.sql.gz`);
  try {
    const bytes = await dump.dumpToFile(tmp, { label: 'nightly off-site backup' });
    const body = await fs.readFile(tmp);
    const key = `${prefix()}daily/${name}-${day}.sql.gz`;
    await s3.put(key, body, 'application/gzip');
    const stored = await s3.head(key);
    if (!stored || stored.size !== bytes) throw new Error(`Uploaded backup size does not match (${stored?.size ?? 'missing'} vs ${bytes} bytes).`);
    // The first backup of each month is also kept as the monthly copy.
    const monthlyKey = `${prefix()}monthly/${name}-${month}.sql.gz`;
    let monthly = false;
    if (!(await s3.head(monthlyKey))) { await s3.put(monthlyKey, body, 'application/gzip'); monthly = true; }
    const pruned = [...await prune(`${prefix()}daily/`, KEEP_DAILY()), ...await prune(`${prefix()}monthly/`, KEEP_MONTHLY())];
    return { key, bytes, monthly, pruned };
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// For the dashboard: when the last backup worked, and whether it's overdue.
async function status() {
  // Before migration 007 there is no job_runs table: no recorded backups yet.
  const safe = (p) => p.catch((err) => { if (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146) return null; throw err; });
  const ok = await safe(db.one("SELECT finished_at, detail, bytes FROM job_runs WHERE job = 'backup' AND status = 'ok' ORDER BY id DESC LIMIT 1"));
  const failed = await safe(db.one("SELECT finished_at, detail FROM job_runs WHERE job = 'backup' AND status = 'failed' ORDER BY id DESC LIMIT 1"));
  const lastOk = ok?.finished_at || null;
  const ageHours = lastOk ? (Date.now() - Date.parse(`${lastOk.replace(' ', 'T')}Z`)) / 3600000 : null;
  return {
    configured: configured(),
    lastSuccessAt: lastOk, lastSuccessBytes: ok?.bytes ?? null, lastSuccessKey: ok?.detail ?? null,
    lastFailureAt: failed && (!lastOk || failed.finished_at > lastOk) ? failed.finished_at : null,
    lastFailure: failed && (!lastOk || failed.finished_at > lastOk) ? failed.detail : null,
    stale: ageHours === null || ageHours > STALE_HOURS,
    staleHours: STALE_HOURS,
  };
}

module.exports = { configured, run, status, prune, STALE_HOURS };
