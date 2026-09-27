// Operations: stored files behind a storage adapter (db | disk | s3), the log of
// background jobs (nightly off-site backup, clean-up), and an index for the mail
// queue's per-minute rate check.
//   files        one row per stored file; the bytes live in files.data (db driver),
//                a directory outside the web root (disk) or S3-compatible storage (s3)
//   job_runs     one row per job run: what ran, when, and whether it worked
// Email attachments point at a file (file_id); attachments stored before this keep
// their bytes in email_attachments.data and still work.
exports.description = 'Storage adapter (files), job run log, mail rate index';
exports.tables = ['files', 'job_runs'];

const TABLES = [
  `CREATE TABLE IF NOT EXISTS files (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    -- db | disk | s3: where the bytes are, fixed when the file is stored
    driver       VARCHAR(10) NOT NULL,
    object_key   VARCHAR(255) NOT NULL,
    purpose      VARCHAR(30) NOT NULL,
    filename     VARCHAR(200) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    size         INT NOT NULL,
    sha256       CHAR(64) NOT NULL,
    data         MEDIUMBLOB NULL,
    created_by   VARCHAR(190) NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_files_key (driver, object_key),
    INDEX idx_files_purpose (purpose, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS job_runs (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    job         VARCHAR(30) NOT NULL,
    -- running | ok | failed | skipped
    status      VARCHAR(10) NOT NULL,
    started_at  DATETIME(3) NOT NULL,
    finished_at DATETIME(3) NULL,
    detail      VARCHAR(500) NULL,
    bytes       BIGINT NULL,
    -- how it was started: loop | cron | cli | admin
    trigger_by  VARCHAR(20) NULL,
    INDEX idx_job_runs (job, status, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

exports.up = async (db, { hasColumn }) => {
  for (const sql of TABLES) await db.query(sql);
  if (!(await hasColumn('email_attachments', 'file_id'))) {
    await db.query('ALTER TABLE email_attachments ADD COLUMN file_id INT NULL AFTER size, MODIFY COLUMN data MEDIUMBLOB NULL, ADD INDEX idx_attachments_file (file_id)');
  }
  const idx = await db.query("SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_recipients' AND INDEX_NAME = 'idx_recipients_sent'");
  if (!idx.length) await db.query('ALTER TABLE email_recipients ADD INDEX idx_recipients_sent (status, sent_at)');
};
