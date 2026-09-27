// Finance: membership tiers, the transactions ledger, sequential receipts, the
// append-only audit log, admin roles, the donor declaration, and tables ready for
// online payments later (feature-flagged off).
exports.description = 'Finance: tiers, transactions ledger, receipts, audit log, admin roles, donor declaration';
exports.tables = ['membership_tiers', 'transactions', 'receipt_sequences', 'audit_log', 'payment_webhook_events'];

const TABLES = [
  // Append-only: the app never updates or deletes rows here.
  `CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    -- admin | member | system
    actor_type  VARCHAR(10) NOT NULL DEFAULT 'admin',
    actor       VARCHAR(190) NOT NULL,
    action      VARCHAR(60) NOT NULL,
    entity      VARCHAR(30) NOT NULL,
    entity_id   VARCHAR(40) NULL,
    summary     VARCHAR(300) NULL,
    before_json MEDIUMTEXT NULL,
    after_json  MEDIUMTEXT NULL,
    -- comma-separated warnings, e.g. self_verified
    flags       VARCHAR(100) NULL,
    ip          VARCHAR(45) NULL,
    INDEX idx_audit_entity (entity, entity_id),
    INDEX idx_audit_at (at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS membership_tiers (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    tkey       VARCHAR(30) NOT NULL UNIQUE,
    name       VARCHAR(80) NOT NULL,
    -- amount due per period, in GBP
    amount     DECIMAL(10,2) NOT NULL,
    currency   CHAR(3) NOT NULL DEFAULT 'GBP',
    -- yearly | one_off
    renewal    VARCHAR(10) NOT NULL DEFAULT 'yearly',
    -- the transaction type a payment for this tier is recorded as
    tx_type    VARCHAR(30) NOT NULL,
    active     TINYINT(1) NOT NULL DEFAULT 1,
    sort       INT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by VARCHAR(190) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS transactions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    -- DCPUK-2026-00001, issued when an income transaction is verified
    receipt_no      VARCHAR(30) NULL UNIQUE,
    -- membership_fee | stakeholder_membership | visit_contribution | donation | other_income | refund | expense
    type            VARCHAR(30) NOT NULL,
    -- the amount as paid, in its own currency (always positive; refund/expense count as money out)
    amount          DECIMAL(12,2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'GBP',
    -- units of currency per 1 GBP, entered by hand (1 for GBP). Never looked up live.
    fx_rate         DECIMAL(14,6) NULL,
    -- GBP equivalent fixed when recorded; reports only ever use this value
    amount_gbp      DECIMAL(12,2) NULL,
    -- mpesa_paybill | mpesa_till | bank_transfer | cash | card_online
    method          VARCHAR(20) NOT NULL,
    -- fee_account | donations_account | other, plus the account details as they were
    account         VARCHAR(20) NOT NULL,
    account_label   VARCHAR(200) NULL,
    member_id       INT NULL,
    donation_id     INT NULL,
    payer_name      VARCHAR(120) NOT NULL,
    payer_email     VARCHAR(200) NULL,
    -- donor's declaration for donations: yes | no | unknown
    donor_kenyan    VARCHAR(7) NULL,
    date_received   DATE NOT NULL,
    external_ref    VARCHAR(100) NULL,
    notes           TEXT NULL,
    -- pending -> verified -> reconciled; pending -> rejected; anything -> void (with reason)
    status          VARCHAR(12) NOT NULL DEFAULT 'pending',
    -- admin | member_report | import | webhook
    source          VARCHAR(20) NOT NULL DEFAULT 'admin',
    recorded_by     VARCHAR(190) NOT NULL,
    recorded_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    verified_by     VARCHAR(190) NULL,
    verified_at     DATETIME NULL,
    -- verified by the same admin who recorded it (only possible with four-eyes off)
    self_verified   TINYINT(1) NOT NULL DEFAULT 0,
    reconciled_by   VARCHAR(190) NULL,
    reconciled_at   DATETIME NULL,
    rejected_reason VARCHAR(500) NULL,
    void_reason     VARCHAR(500) NULL,
    voided_by       VARCHAR(190) NULL,
    voided_at       DATETIME NULL,
    -- for online payments later (Stripe, M-Pesa Daraja); unused while the features are off
    provider        VARCHAR(20) NULL,
    provider_ref    VARCHAR(120) NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_tx_member (member_id),
    INDEX idx_tx_donation (donation_id),
    INDEX idx_tx_status (status),
    INDEX idx_tx_date (date_received),
    INDEX idx_tx_type (type),
    UNIQUE KEY uq_tx_provider (provider, provider_ref)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS receipt_sequences (
    year    INT PRIMARY KEY,
    last_no INT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS payment_webhook_events (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    provider     VARCHAR(20) NOT NULL,
    event_id     VARCHAR(120) NOT NULL,
    payload      MEDIUMTEXT NOT NULL,
    received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    UNIQUE KEY uq_webhook_event (provider, event_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

exports.up = async (db, { hasColumn }) => {
  for (const sql of TABLES) await db.query(sql);

  if (!(await hasColumn('admins', 'role'))) {
    // Everyone who is an admin today keeps full access.
    await db.query("ALTER TABLE admins ADD COLUMN role VARCHAR(24) NOT NULL DEFAULT 'super_admin'");
  }

  const tiers = [
    ['ordinary', 'Ordinary membership', 20, 'yearly', 'membership_fee', 1],
    ['stakeholder', 'Stakeholder membership', 500, 'yearly', 'stakeholder_membership', 2],
    ['visit', 'Visit contribution', 200, 'one_off', 'visit_contribution', 3],
  ];
  for (const t of tiers) await db.query('INSERT IGNORE INTO membership_tiers (tkey, name, amount, renewal, tx_type, sort) VALUES (?, ?, ?, ?, ?, ?)', t);

  if (!(await hasColumn('members', 'tier_id'))) {
    await db.query(`ALTER TABLE members
      ADD COLUMN tier_id INT NULL,
      ADD COLUMN billing_start DATE NULL,
      ADD COLUMN membership_start DATE NULL,
      ADD COLUMN fee_review TINYINT(1) NOT NULL DEFAULT 0,
      ADD COLUMN fee_review_reason VARCHAR(400) NULL`);
    // Every existing (website) registration goes on Ordinary. Their original fee and
    // currency are kept untouched; anything that doesn't match is flagged for the treasurer.
    await db.query("UPDATE members SET tier_id = (SELECT id FROM membership_tiers WHERE tkey = 'ordinary'), billing_start = DATE(created_at)");
    await db.query(`UPDATE members SET fee_review = 1, fee_review_reason = CONCAT('Registered with a fee of ', fee_currency, ' ', fee_amount,
      ', not the Ordinary tier''s GBP 20.00. The original amount is kept; check what was agreed.')
      WHERE fee_currency <> 'GBP' OR fee_amount <> 20`);
    await db.query(`UPDATE members SET fee_review = 1, fee_review_reason = CONCAT_WS(' ', fee_review_reason,
      'Marked paid before the Finance module, with no transaction on record. Record and verify the payment so it is on the ledger.')
      WHERE payment_status = 'paid'`);
  }
  if (!(await hasColumn('donations', 'donor_kenyan'))) {
    // Pledges made before the question existed are "unknown", which flags them.
    await db.query("ALTER TABLE donations ADD COLUMN donor_kenyan VARCHAR(7) NOT NULL DEFAULT 'unknown'");
  }
};
