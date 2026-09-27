// A full backup of the database (structure and data) as SQL, gzipped by default.
// It restores with `npm run db:restore` or phpMyAdmin → Import (which accepts .gz).
//
//   npm run db:export-data                               ./dcp-uk-<db>-<date>.sql.gz
//   npm run db:export-data -- --out backup.sql.gz
//   npm run db:export-data -- --out backup.sql           uncompressed
//   npm run db:export-data -- --per-table --out dir/     one file per table, for hosts
//                                                        whose phpMyAdmin import limit is small
//
// The file holds members' personal data: keep it somewhere private and delete
// copies you no longer need.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../lib/db');
const dump = require('../lib/dump');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

(async () => {
  await db.init();
  const perTable = process.argv.includes('--per-table');
  const before = await dump.rowCounts();
  if (perTable) {
    const dir = arg('--out') || `dcp-uk-${db.config.database}-${stamp}`;
    fs.mkdirSync(dir, { recursive: true });
    const conn = await dump.rawConnection();
    const tables = await dump.listTables(conn);
    await conn.end();
    let n = 0;
    for (const t of tables) {
      const file = path.join(dir, `${String(++n).padStart(2, '0')}-${t}.sql.gz`);
      await dump.dumpToFile(file, { tables: [t], label: `table ${t}` });
    }
    console.log(`Wrote ${tables.length} files to ${dir}/ (import them in any order).`);
  } else {
    const file = arg('--out') || `dcp-uk-${db.config.database}-${stamp}.sql.gz`;
    const bytes = await dump.dumpToFile(file);
    console.log(`Wrote ${file} (${(bytes / 1024).toFixed(0)} KB).`);
  }
  console.log('Rows:', Object.entries(before).map(([t, n]) => `${t} ${n}`).join(', '));
  console.log('This file contains personal data. Keep it private.');
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
