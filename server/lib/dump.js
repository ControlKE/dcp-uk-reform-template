// SQL dumps and restores written in Node, so they work wherever the app runs
// (Railway has no mysqldump) and the files import cleanly in phpMyAdmin.
//
// A dump is plain SQL: DROP/CREATE TABLE from SHOW CREATE TABLE, then multi-row
// INSERTs. Strings are escaped the way mysql2 escapes them (so no raw newline ever
// appears inside a value), binary columns are written as hex, and DECIMAL and
// DATETIME values come back from the server as exact strings.
const zlib = require('node:zlib');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const mysql = require('mysql2/promise');
const db = require('./db');

const BATCH_ROWS = 500;           // rows fetched per query
const MAX_INSERT_BYTES = 512 * 1024; // keep each INSERT well under max_allowed_packet

// A separate connection that returns values exactly as stored.
async function rawConnection(database = db.config.database) {
  return mysql.createConnection({
    host: db.config.host, port: db.config.port, user: db.config.user, password: db.config.password, database,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    charset: 'UTF8MB4_UNICODE_CI', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
  });
}

const ident = (name) => `\`${String(name).replace(/`/g, '``')}\``;

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return value.length ? `0x${value.toString('hex')}` : "''";
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return mysql.escape(String(value));
}

async function listTables(conn) {
  const [rows] = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
  return rows.map((r) => r.t);
}

async function createStatement(conn, table, { keepAutoIncrement }) {
  const [[row]] = await conn.query(`SHOW CREATE TABLE ${ident(table)}`);
  let sql = row['Create Table'];
  if (!keepAutoIncrement) sql = sql.replace(/ AUTO_INCREMENT=\d+/, '');
  return sql;
}

// Yields the INSERT statements for one table, in primary-key order.
// timestampsAsNow: write DATETIME/TIMESTAMP values as UTC_TIMESTAMP() (for seed rows
// in schema.sql, so the file doesn't change every time it is generated).
async function* insertStatements(conn, table, { timestampsAsNow = false } = {}) {
  const [cols] = await conn.query('SELECT COLUMN_NAME AS c, DATA_TYPE AS t, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [table]);
  const names = cols.map((c) => c.c);
  const timeCols = new Set(cols.filter((c) => ['datetime', 'timestamp'].includes(c.t)).map((c) => c.c));
  const keys = cols.filter((c) => c.k === 'PRI').map((c) => ident(c.c));
  const order = keys.length ? ` ORDER BY ${keys.join(', ')}` : '';
  const head = `INSERT INTO ${ident(table)} (${names.map(ident).join(', ')}) VALUES\n`;
  let chunk = [];
  let size = 0;
  for (let offset = 0; ; offset += BATCH_ROWS) {
    const [rows] = await conn.query(`SELECT * FROM ${ident(table)}${order} LIMIT ${BATCH_ROWS} OFFSET ${offset}`);
    for (const r of rows) {
      const tuple = `(${names.map((n) => (timestampsAsNow && timeCols.has(n) && r[n] !== null ? 'UTC_TIMESTAMP()' : literal(r[n]))).join(', ')})`;
      if (chunk.length && size + tuple.length > MAX_INSERT_BYTES) {
        yield `${head}${chunk.join(',\n')};\n`;
        chunk = []; size = 0;
      }
      chunk.push(tuple); size += tuple.length + 2;
    }
    if (rows.length < BATCH_ROWS) break;
  }
  if (chunk.length) yield `${head}${chunk.join(',\n')};\n`;
}

const HEADER = (what) => [
  `-- DCP UK ${what}`,
  `-- Database: ${db.config.database}   Generated: ${new Date().toISOString()}`,
  '-- Import with phpMyAdmin (Import tab; .sql or .sql.gz) or: npm run db:restore -- --file <this file>',
  'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;',
  "SET time_zone = '+00:00';",
  'SET FOREIGN_KEY_CHECKS = 0;',
  "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
  '',
].join('\n');
const FOOTER = '\nSET FOREIGN_KEY_CHECKS = 1;\n';

// The whole database (structure and data) as a stream of SQL text.
// tables: limit to these; structure/data: which parts.
async function* dumpSql({ tables = null, structure = true, data = true, database, label = 'database backup' } = {}) {
  const conn = await rawConnection(database);
  try {
    // One consistent snapshot of every InnoDB table, like mysqldump --single-transaction:
    // the app keeps running and the dump still matches a single moment.
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const all = await listTables(conn);
    const chosen = tables ? all.filter((t) => tables.includes(t)) : all;
    yield HEADER(label);
    for (const t of chosen) {
      yield `\n-- Table ${t}\n`;
      if (structure) yield `DROP TABLE IF EXISTS ${ident(t)};\n${await createStatement(conn, t, { keepAutoIncrement: data })};\n`;
      if (data) for await (const stmt of insertStatements(conn, t)) yield stmt;
    }
    yield FOOTER;
  } finally {
    await conn.end();
  }
}

// Writes a dump to a file; gzipped when the name ends in .gz. Returns the byte size.
async function dumpToFile(file, options) {
  const source = Readable.from(dumpSql(options));
  await pipeline(source, ...(file.endsWith('.gz') ? [zlib.createGzip({ level: 9 })] : []), fs.createWriteStream(file));
  return fs.statSync(file).size;
}

// Row counts per table: printed after dumps and restores so they can be compared.
async function rowCounts(database) {
  const conn = await rawConnection(database);
  try {
    const out = {};
    for (const t of await listTables(conn)) out[t] = Number((await conn.query(`SELECT COUNT(*) AS n FROM ${ident(t)}`))[0][0].n);
    return out;
  } finally { await conn.end(); }
}

// Splits SQL text into statements on semicolons outside quotes and comments.
// Handles '...' and "..." with backslash or doubled-quote escapes, `identifiers`,
// -- and # line comments, and /* */ blocks (kept, since MySQL runs /*! ... */ hints).
function* splitStatements(sql) {
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && q !== '`') { i += 2; continue; }
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } break; }
        i++;
      }
      i++;
    } else if ((ch === '-' && sql[i + 1] === '-' && /\s/.test(sql[i + 2] || ' ')) || ch === '#') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (ch === ';') {
      const stmt = sql.slice(start, i).trim();
      if (stmt && !/^(--[^\n]*\n?|#[^\n]*\n?|\s)*$/.test(stmt)) yield stmt;
      start = ++i;
    } else i++;
  }
  const rest = sql.slice(start).trim();
  if (rest && !/^(--[^\n]*\n?|#[^\n]*\n?|\s)*$/.test(rest)) yield rest;
}

// Runs a .sql or .sql.gz file against a database. Returns the number of statements.
async function restoreFile(file, database) {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = zlib.gunzipSync(buf);
  const sql = buf.toString('utf8');
  const conn = await rawConnection(database);
  let count = 0;
  try {
    for (const stmt of splitStatements(sql)) { await conn.query(stmt); count++; }
  } finally { await conn.end(); }
  return count;
}

module.exports = { dumpSql, dumpToFile, rowCounts, restoreFile, splitStatements, rawConnection, listTables, createStatement, insertStatements, ident, literal };
