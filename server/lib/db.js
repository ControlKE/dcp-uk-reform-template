// MySQL / MariaDB storage (the database phpMyAdmin manages, e.g. XAMPP's MariaDB).
// Connection settings come from server/.env (see .env.example).
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// Hosts hand the database over in one of three ways: a connection URL, their
// own MYSQL* variables, or the DB_* ones used locally.
function readConfig() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.JAWSDB_URL || process.env.CLEARDB_DATABASE_URL;
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'dcp_uk',
    };
  }
  return {
    host: process.env.DB_HOST || process.env.MYSQLHOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || process.env.MYSQLPORT) || 3306,
    user: process.env.DB_USER || process.env.MYSQLUSER || 'root',
    password: process.env.DB_PASSWORD ?? process.env.MYSQLPASSWORD ?? '',
    database: process.env.DB_NAME || process.env.MYSQLDATABASE || 'dcp_uk',
  };
}

const config = readConfig();
// Managed databases usually require TLS; local XAMPP does not.
const ssl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined;

if (!/^[A-Za-z0-9_]+$/.test(config.database)) throw new Error('DB_NAME may only contain letters, numbers and underscores.');

let pool;

// Connects, creating the database if it does not exist yet. Tables come from
// the numbered migrations in server/migrations (see lib/migrations.js).
async function init() {
  // Managed databases are created for you and often forbid CREATE DATABASE,
  // so only try it when connecting without a password-protected host account.
  try {
    const bootstrap = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, ssl });
    await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await bootstrap.end();
  } catch (err) {
    if (!['ER_DBACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(err.code)) throw err;
    // The database already exists and this user simply may not create one.
  }

  pool = mysql.createPool({
    ...config,
    ssl,
    connectionLimit: 10,
    charset: 'utf8mb4',
    dateStrings: true,     // DATETIME/DATE come back as 'YYYY-MM-DD HH:MM:SS' strings (UTC, see below)
    decimalNumbers: true,  // DECIMAL amounts come back as numbers
  });
  // Store and read every timestamp in UTC so times are the same whatever the server's clock zone.
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));
}

// Returns all rows for a SELECT, or the result header (affectedRows, insertId) for writes.
async function query(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

// Raw pool access for the migrations runner.
const raw = () => pool;

module.exports = { init, query, one, config, raw };
