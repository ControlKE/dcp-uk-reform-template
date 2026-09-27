// Email app storage, and the member fields that decide who may receive bulk email.
exports.description = 'Email app (emails, recipients, labels, attachments) and member email consent/opt-out';
exports.tables = ['emails', 'email_recipients', 'email_labels', 'email_label_map', 'email_attachments'];

const TABLES = [
  `CREATE TABLE IF NOT EXISTS emails (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    -- inbox | sent | draft | spam | trash
    folder          VARCHAR(10) NOT NULL DEFAULT 'inbox',
    -- where a trashed email goes back to when restored
    restore_folder  VARCHAR(10) NULL,
    -- in | out
    direction       VARCHAR(3) NOT NULL,
    -- contact | application | compose | reply | system
    source          VARCHAR(20) NOT NULL,
    -- transactional (one person, service message) | bulk (consent + unsubscribe rules apply)
    category        VARCHAR(15) NOT NULL DEFAULT 'transactional',
    template        VARCHAR(40) NULL,
    from_name       VARCHAR(120) NULL,
    from_email      VARCHAR(200) NULL,
    reply_to        VARCHAR(200) NULL,
    to_summary      VARCHAR(500) NULL,
    subject         VARCHAR(250) NOT NULL DEFAULT '',
    body_html       MEDIUMTEXT NULL,
    body_text       MEDIUMTEXT NULL,
    -- compose state kept for drafts: recipients, segments, cc, bcc, attachment ids
    draft_json      MEDIUMTEXT NULL,
    -- received | draft | queued | sent | partial | failed | logged
    status          VARCHAR(12) NOT NULL DEFAULT 'received',
    -- lower is sent first: transactional 1, bulk 5
    priority        TINYINT NOT NULL DEFAULT 5,
    is_read         TINYINT(1) NOT NULL DEFAULT 0,
    is_starred      TINYINT(1) NOT NULL DEFAULT 0,
    member_id       INT NULL,
    in_reply_to     INT NULL,
    recipient_count INT NOT NULL DEFAULT 0,
    excluded_count  INT NOT NULL DEFAULT 0,
    created_by      VARCHAR(190) NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at         DATETIME NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_emails_folder (folder, created_at),
    INDEX idx_emails_member (member_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS email_recipients (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    email_id        INT NOT NULL,
    -- to | cc | bcc
    kind            VARCHAR(3) NOT NULL DEFAULT 'to',
    address         VARCHAR(200) NOT NULL,
    name            VARCHAR(120) NULL,
    member_id       INT NULL,
    -- queued | sending | sent | logged (MAIL_TRANSPORT=log, not delivered) | failed | skipped
    status          VARCHAR(10) NOT NULL DEFAULT 'queued',
    attempts        TINYINT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error      VARCHAR(500) NULL,
    provider        VARCHAR(10) NULL,
    provider_id     VARCHAR(200) NULL,
    sent_at         DATETIME NULL,
    INDEX idx_recipients_queue (status, next_attempt_at),
    INDEX idx_recipients_email (email_id),
    CONSTRAINT fk_recipients_email FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS email_labels (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    name  VARCHAR(40) NOT NULL UNIQUE,
    -- a colour name the admin maps to a DCP token: primary | bright | warning | danger | neutral
    color VARCHAR(10) NOT NULL DEFAULT 'neutral'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS email_label_map (
    email_id INT NOT NULL,
    label_id INT NOT NULL,
    PRIMARY KEY (email_id, label_id),
    CONSTRAINT fk_label_map_email FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    CONSTRAINT fk_label_map_label FOREIGN KEY (label_id) REFERENCES email_labels(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Files are kept in the database because Railway's disk is wiped on each deploy.
  // 5 MB per file and 20 MB per email are enforced by the API.
  `CREATE TABLE IF NOT EXISTS email_attachments (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    -- NULL while attached to an unsent compose window
    email_id     INT NULL,
    filename     VARCHAR(200) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    size         INT NOT NULL,
    data         MEDIUMBLOB NOT NULL,
    uploaded_by  VARCHAR(190) NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_attachments_email (email_id),
    CONSTRAINT fk_attachments_email FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

exports.up = async (db, { hasColumn }) => {
  for (const sql of TABLES) await db.query(sql);

  if (!(await hasColumn('members', 'data_consent_at'))) {
    // When the member agreed to their data being processed. Website registrations
    // must tick the data-consent declaration, so every existing member (all from the
    // website) gets their registration time. Imported members start without it.
    await db.query('ALTER TABLE members ADD COLUMN data_consent_at DATETIME NULL');
    await db.query('UPDATE members SET data_consent_at = created_at WHERE data_consent_at IS NULL');
  }
  if (!(await hasColumn('members', 'email_opt_out'))) {
    await db.query('ALTER TABLE members ADD COLUMN email_opt_out TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN email_opt_out_at DATETIME NULL');
  }

  for (const [name, color] of [['Membership', 'primary'], ['Donations', 'danger'], ['Contact', 'warning'], ['Chapters', 'bright'], ['Imports', 'neutral']]) {
    await db.query('INSERT IGNORE INTO email_labels (name, color) VALUES (?, ?)', [name, color]);
  }
};
