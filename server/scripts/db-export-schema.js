// Writes server/schema.sql: every table as the migrations create it, plus the
// rows the app needs to start (tiers, email labels, the migrations already
// applied). No members, payments or other personal data. It is built from the
// migrations on a scratch database, not copied from any real one.
//
//   npm run db:export-schema            regenerate server/schema.sql
//   npm run db:export-schema -- --check exit 1 if server/schema.sql is out of date
//
// Needs a local database user that may create and drop databases (e.g. XAMPP/WAMP root).
// Importing schema.sql into an empty database (phpMyAdmin → Import) gives the same
// result as letting the app run its migrations on it.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'schema.sql');
// Tables whose rows are part of a fresh install.
const SEED_TABLES = ['membership_tiers', 'email_labels', 'schema_migrations'];

if (process.env.DCP_SCHEMA_CHILD !== '1') {
  // Parent: point a child process at a scratch database so nothing real is touched.
  process.chdir(path.join(__dirname, '..'));
  const db = require('../lib/db');
  const c = db.config;
  const scratch = `${c.database}_schema_export`.slice(0, 64);
  const url = `mysql://${encodeURIComponent(c.user)}:${encodeURIComponent(c.password || '')}@${c.host}:${c.port}/${scratch}`;
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    // DATABASE_URL takes precedence over DB_* in lib/db.js; the child must not be "production".
    env: { ...process.env, DCP_SCHEMA_CHILD: '1', DATABASE_URL: url, MYSQL_URL: '', NODE_ENV: 'development' },
  });
  process.exit(r.status ?? 1);
}

(async () => {
  const db = require('../lib/db');
  const migrations = require('../lib/migrations');
  const dump = require('../lib/dump');
  const check = process.argv.includes('--check');
  const scratch = db.config.database;
  if (!scratch.endsWith('_schema_export')) throw new Error('Refusing: not a scratch database.');
  // Start from nothing, every time: drop it before the pool connects (init creates it again).
  const bootstrap = await require('mysql2/promise').createConnection({ host: db.config.host, port: db.config.port, user: db.config.user, password: db.config.password });
  await bootstrap.query(`DROP DATABASE IF EXISTS ${dump.ident(scratch)}`);
  await bootstrap.end();
  await db.init();
  try {
    const { pending } = await migrations.plan();
    await migrations.apply(pending, () => {});

    const conn = await dump.rawConnection(scratch);
    const parts = [
      '-- DCP UK database schema: every table, plus the rows a fresh install needs.',
      '-- Generated from the migrations by `npm run db:export-schema`. Do not edit by hand.',
      '-- Contains no members, payments or other personal data.',
      '--',
      '-- New database: create it with utf8mb4 / utf8mb4_unicode_ci, then import this file',
      '-- (phpMyAdmin → Import). The app then sees every migration as already applied.',
      '-- Minimum versions: MariaDB 10.6 or MySQL 8.0.',
      'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;',
      "SET time_zone = '+00:00';",
      'SET FOREIGN_KEY_CHECKS = 0;',
      '',
    ];
    try {
      for (const t of await dump.listTables(conn)) {
        parts.push(`-- Table ${t}`, `CREATE TABLE IF NOT EXISTS ${dump.ident(t)} ${(await dump.createStatement(conn, t, { keepAutoIncrement: false })).replace(/^CREATE TABLE `[^`]+` /, '')};`);
        if (SEED_TABLES.includes(t)) for await (const stmt of dump.insertStatements(conn, t, { timestampsAsNow: true })) parts.push(stmt.replace(/^INSERT INTO/, 'INSERT IGNORE INTO').trimEnd());
        parts.push('');
      }
    } finally { await conn.end(); }
    parts.push('SET FOREIGN_KEY_CHECKS = 1;', '');
    const sql = parts.join('\n');

    if (check) {
      const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
      if (current !== sql) { console.error('server/schema.sql is out of date: run npm run db:export-schema'); process.exitCode = 1; }
      else console.log('server/schema.sql is up to date.');
    } else {
      fs.writeFileSync(OUT, sql);
      console.log(`Wrote server/schema.sql (${(sql.length / 1024).toFixed(1)} KB, ${pending.length} migrations).`);
    }
  } finally {
    await db.query(`DROP DATABASE IF EXISTS ${dump.ident(scratch)}`).catch(() => {});
    process.exit(process.exitCode || 0);
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
