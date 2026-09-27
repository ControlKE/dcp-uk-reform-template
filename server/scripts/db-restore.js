// Restores a backup made by db:export-data or the nightly off-site backup
// (.sql or .sql.gz; phpMyAdmin exports work too).
//
// Restore test (monthly, see DEPLOY.md): restore into a scratch database, check the
// row counts, then drop it. The live database is not touched:
//   npm run db:restore -- --file backup.sql.gz --database dcp_restore_test --drop-after
//
// Real restore into the app's own database (replaces what is there):
//   npm run db:restore -- --file backup.sql.gz --replace
// In production this also needs --confirm <database name>.
const mysql = require('mysql2/promise');
const db = require('../lib/db');
const dump = require('../lib/dump');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (name) => process.argv.includes(name);

(async () => {
  const file = arg('--file');
  if (!file) throw new Error('Give the backup file: --file <backup.sql.gz>');
  const target = arg('--database') || db.config.database;
  if (!/^[A-Za-z0-9_]+$/.test(target)) throw new Error('--database may only contain letters, numbers and underscores.');
  const live = target === db.config.database;
  if (has('--drop-after') && live) throw new Error('--drop-after is only for a scratch database (use --database <name>).');

  const admin = await mysql.createConnection({ host: db.config.host, port: db.config.port, user: db.config.user, password: db.config.password,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  try {
    if (!live) await admin.query(`CREATE DATABASE IF NOT EXISTS ${dump.ident(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    const [[{ n }]] = await admin.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [target]);
    if (Number(n) > 0 && !has('--replace')) {
      throw new Error(`Database "${target}" already has ${n} table(s). Add --replace to overwrite them${live ? ' (this is the app\'s own database: back it up first)' : ''}.`);
    }
    if (live && process.env.NODE_ENV === 'production' && arg('--confirm') !== target) {
      throw new Error(`This replaces the production database. Add --confirm ${target} to go ahead.`);
    }
    console.log(`Restoring ${file} into "${target}" on ${db.config.host} …`);
    const statements = await dump.restoreFile(file, target);
    const counts = await dump.rowCounts(target);
    console.log(`Done: ${statements} statements.`);
    console.log('Rows:', Object.entries(counts).map(([t, c]) => `${t} ${c}`).join(', '));
    const [mig] = await admin.query(`SELECT COUNT(*) AS n, MAX(id) AS latest FROM ${dump.ident(target)}.schema_migrations`).catch(() => [[{ n: 0, latest: null }]]);
    console.log(`Migrations recorded: ${mig[0].n} (latest ${mig[0].latest || 'none'}).`);
    if (has('--drop-after')) {
      await admin.query(`DROP DATABASE ${dump.ident(target)}`);
      console.log(`Dropped "${target}". Restore test complete.`);
    }
  } finally {
    await admin.end();
  }
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
