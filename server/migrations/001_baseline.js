// The schema as it was before numbered migrations: the five original tables and
// the small upgrades the old startup code used to make. Every statement is safe
// to run on a database that already has them.
exports.description = 'Original tables: admins, sessions, settings, members, donations';

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

exports.up = async (db, { hasColumn }) => {
  for (const statement of SCHEMA) await db.query(statement);
  if (!(await hasColumn('members', 'interest_other'))) {
    await db.query('ALTER TABLE members ADD COLUMN interest_other VARCHAR(100) NULL AFTER interest');
  }
  if (!(await hasColumn('members', 'chapter_other'))) {
    await db.query('ALTER TABLE members ADD COLUMN chapter_other VARCHAR(120) NULL AFTER chapter');
  }
  if (await hasColumn('members', 'fee_amount_kes')) {
    // The fee used to be shillings-only; it now carries its own currency.
    await db.query('ALTER TABLE members CHANGE COLUMN fee_amount_kes fee_amount DECIMAL(10,2) NOT NULL');
    await db.query("ALTER TABLE members ADD COLUMN fee_currency VARCHAR(3) NOT NULL DEFAULT 'KES' AFTER fee_amount");
    await db.query("ALTER TABLE members ALTER COLUMN fee_currency SET DEFAULT 'GBP'");
  }
};
