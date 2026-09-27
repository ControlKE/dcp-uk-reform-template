// Shows or applies pending database migrations.
//   npm run migrate                show what would be applied (changes nothing)
//   npm run migrate -- --yes       apply them
// On Railway: take a backup first (DEPLOY.md), then `railway ssh` and run the above.
const db = require('../lib/db');
const migrations = require('../lib/migrations');

(async () => {
  await db.init();
  const { pending, applied } = await migrations.plan();
  console.log(`Database "${db.config.database}" on ${db.config.host}: ${applied.length} migration(s) already applied.`);
  if (!pending.length) { console.log('Nothing to apply. The schema is up to date.'); process.exit(0); }
  console.log(`Pending (${pending.length}):\n${migrations.describe(pending)}`);
  if (!process.argv.includes('--yes')) {
    console.log('\nNothing changed. Back up the database, then run: npm run migrate -- --yes');
    process.exit(0);
  }
  await migrations.apply(pending);
  console.log('Done.');
  process.exit(0);
})().catch((err) => {
  console.error(err instanceof migrations.MigrationStop ? `STOPPED: ${err.message}` : (err.message || err.code));
  process.exit(1);
});
