// MySQL / MariaDB storage (the database phpMyAdmin manages, e.g. XAMPP's MariaDB).
// Connection settings come from server/.env (see .env.example).
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dcp_uk',
};

if (!/^[A-Za-z0-9_]+$/.test(config.database)) throw new Error('DB_NAME may only contain letters, numbers and underscores.');

let pool;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admins (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    admin_id   INT NOT NULL,
    expires_at BIGINT NOT NULL,
    CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS settings (
    \`key\`    VARCHAR(64) PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(190) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS members (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    reference          VARCHAR(20) NOT NULL UNIQUE,
    access_token_hash  CHAR(64) NOT NULL,
    full_name          VARCHAR(120) NOT NULL,
    phone              VARCHAR(30) NOT NULL,
    email              VARCHAR(200) NOT NULL,
    date_of_birth      DATE NOT NULL,
    id_document_type   VARCHAR(40) NOT NULL,
    id_document_number VARCHAR(30) NOT NULL,
    language           VARCHAR(20) NOT NULL,
    occupation         VARCHAR(120) NULL,
    interest           VARCHAR(60) NULL,
    -- filled in when interest is "Other"
    interest_other     VARCHAR(100) NULL,
    chapter            VARCHAR(40) NULL,
    -- filled in when chapter is "None nearby"
    chapter_other      VARCHAR(120) NULL,
    address_line1      VARCHAR(120) NOT NULL,
    address_line2      VARCHAR(120) NULL,
    town               VARCHAR(80) NOT NULL,
    county             VARCHAR(80) NULL,
    postcode           VARCHAR(10) NOT NULL,
    fee_amount         DECIMAL(10,2) NOT NULL,
    fee_currency       VARCHAR(3) NOT NULL DEFAULT 'GBP',
    -- pending_payment -> payment_reported -> paid (set by an admin)
    payment_status     VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
    -- M-Pesa / bank transaction code the applicant gave when reporting payment
    payment_note       VARCHAR(100) NULL,
    -- pending -> approved | rejected (set by an admin)
    status             VARCHAR(20) NOT NULL DEFAULT 'pending',
    admin_notes        TEXT NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_members_email (email),
    INDEX idx_members_id_number (id_document_number),
    INDEX idx_members_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS donations (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    reference   VARCHAR(20) NOT NULL UNIQUE,
    full_name   VARCHAR(120) NOT NULL,
    email       VARCHAR(200) NOT NULL,
    amount_gbp  DECIMAL(10,2) NOT NULL,
    frequency   VARCHAR(20) NOT NULL,
    message     TEXT NULL,
    -- pledged -> received (set by an admin) | cancelled
    status      VARCHAR(20) NOT NULL DEFAULT 'pledged',
    admin_notes TEXT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_donations_created (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

// Creates the database and tables if they don't exist yet. Call once at startup.
async function init() {
  const bootstrap = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bootstrap.end();

  pool = mysql.createPool({
    ...config,
    connectionLimit: 10,
    charset: 'utf8mb4',
    dateStrings: true,     // DATETIME/DATE come back as 'YYYY-MM-DD HH:MM:SS' strings (UTC, see below)
    decimalNumbers: true,  // DECIMAL amounts come back as numbers
  });
  // Store and read every timestamp in UTC so times are the same whatever the server's clock zone.
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

  for (const statement of SCHEMA) await pool.query(statement);
  await migrate();
}

// Small schema changes for databases created by an earlier version.
async function hasColumn(table, column) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [config.database, table, column]);
  return rows.length > 0;
}

async function migrate() {
  if (!(await hasColumn('members', 'interest_other'))) {
    await pool.query("ALTER TABLE members ADD COLUMN interest_other VARCHAR(100) NULL AFTER interest");
  }
  if (!(await hasColumn('members', 'chapter_other'))) {
    await pool.query("ALTER TABLE members ADD COLUMN chapter_other VARCHAR(120) NULL AFTER chapter");
  }
  if (await hasColumn('members', 'fee_amount_kes')) {
    // The fee used to be shillings-only; it now carries its own currency.
    await pool.query('ALTER TABLE members CHANGE COLUMN fee_amount_kes fee_amount DECIMAL(10,2) NOT NULL');
    await pool.query("ALTER TABLE members ADD COLUMN fee_currency VARCHAR(3) NOT NULL DEFAULT 'KES' AFTER fee_amount");
    await pool.query("ALTER TABLE members ALTER COLUMN fee_currency SET DEFAULT 'GBP'");
  }
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

module.exports = { init, query, one, config };
