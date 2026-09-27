// Runs the background jobs that are due, then exits (lib/jobs.js).
//   npm run jobs:run                      whatever is due: mail, clean-up, the nightly backup
//   npm run jobs:run -- --only backup     just that job, if due
//   npm run jobs:run -- --force backup    run it now even if not due (e.g. before an upgrade)
// For schedulers: a Railway cron service, cPanel cron, or any crontab, e.g. every minute:
//   * * * * * cd /path/to/app && npm run jobs:run >> jobs.log 2>&1
// Exit code 1 if a job failed, so the scheduler can alert.
const db = require('../lib/db');
const migrations = require('../lib/migrations');

const list = (name) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1].split(',') : null; };

(async () => {
  await db.init();
  // Code newer than the database: do nothing until the migrations are applied.
  const { pending } = await migrations.plan();
  if (pending.length) {
    console.log(`Skipped: ${pending.length} database migration(s) are waiting (apply them in the admin → Settings → Database).`);
    process.exit(0);
  }
  const jobs = require('../lib/jobs');
  const results = await jobs.runDue({ trigger: 'cli', only: list('--only'), force: list('--force') || [] });
  for (const r of results) console.log(`${r.job}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
  if (!results.length) console.log('Nothing due.');
  process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
