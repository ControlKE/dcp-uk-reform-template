-- DCP UK database schema: every table, plus the rows a fresh install needs.
-- Generated from the migrations by `npm run db:export-schema`. Do not edit by hand.
-- Contains no members, payments or other personal data.
--
-- New database: create it with utf8mb4 / utf8mb4_unicode_ci, then import this file
-- (phpMyAdmin → Import). The app then sees every migration as already applied.
-- Minimum versions: MariaDB 10.6 or MySQL 8.0.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET time_zone = '+00:00';
SET FOREIGN_KEY_CHECKS = 0;

-- Table admins
CREATE TABLE IF NOT EXISTS `admins` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(190) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `role` varchar(24) NOT NULL DEFAULT 'super_admin',
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table audit_log
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `actor_type` varchar(10) NOT NULL DEFAULT 'admin',
  `actor` varchar(190) NOT NULL,
  `action` varchar(60) NOT NULL,
  `entity` varchar(30) NOT NULL,
  `entity_id` varchar(40) DEFAULT NULL,
  `summary` varchar(300) DEFAULT NULL,
  `before_json` mediumtext DEFAULT NULL,
  `after_json` mediumtext DEFAULT NULL,
  `flags` varchar(100) DEFAULT NULL,
  `ip` varchar(45) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audit_entity` (`entity`,`entity_id`),
  KEY `idx_audit_at` (`at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table donations
CREATE TABLE IF NOT EXISTS `donations` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `reference` varchar(20) NOT NULL,
  `kind` varchar(20) NOT NULL DEFAULT 'donation',
  `member_id` int(11) DEFAULT NULL,
  `member_reference` varchar(20) DEFAULT NULL,
  `full_name` varchar(120) NOT NULL,
  `email` varchar(200) NOT NULL,
  `amount_gbp` decimal(10,2) NOT NULL,
  `frequency` varchar(20) NOT NULL,
  `message` text DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pledged',
  `admin_notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  `donor_kenyan` varchar(7) NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (`id`),
  UNIQUE KEY `reference` (`reference`),
  KEY `idx_donations_created` (`created_at`),
  KEY `idx_donations_member` (`member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table emails
CREATE TABLE IF NOT EXISTS `emails` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `folder` varchar(10) NOT NULL DEFAULT 'inbox',
  `restore_folder` varchar(10) DEFAULT NULL,
  `direction` varchar(3) NOT NULL,
  `source` varchar(20) NOT NULL,
  `category` varchar(15) NOT NULL DEFAULT 'transactional',
  `template` varchar(40) DEFAULT NULL,
  `from_name` varchar(120) DEFAULT NULL,
  `from_email` varchar(200) DEFAULT NULL,
  `reply_to` varchar(200) DEFAULT NULL,
  `to_summary` varchar(500) DEFAULT NULL,
  `subject` varchar(250) NOT NULL DEFAULT '',
  `body_html` mediumtext DEFAULT NULL,
  `body_text` mediumtext DEFAULT NULL,
  `draft_json` mediumtext DEFAULT NULL,
  `status` varchar(12) NOT NULL DEFAULT 'received',
  `priority` tinyint(4) NOT NULL DEFAULT 5,
  `is_read` tinyint(1) NOT NULL DEFAULT 0,
  `is_starred` tinyint(1) NOT NULL DEFAULT 0,
  `member_id` int(11) DEFAULT NULL,
  `in_reply_to` int(11) DEFAULT NULL,
  `recipient_count` int(11) NOT NULL DEFAULT 0,
  `excluded_count` int(11) NOT NULL DEFAULT 0,
  `created_by` varchar(190) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `sent_at` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_emails_folder` (`folder`,`created_at`),
  KEY `idx_emails_member` (`member_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table email_attachments
CREATE TABLE IF NOT EXISTS `email_attachments` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email_id` int(11) DEFAULT NULL,
  `filename` varchar(200) NOT NULL,
  `content_type` varchar(100) NOT NULL,
  `size` int(11) NOT NULL,
  `file_id` int(11) DEFAULT NULL,
  `data` mediumblob DEFAULT NULL,
  `uploaded_by` varchar(190) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_attachments_email` (`email_id`),
  KEY `idx_attachments_file` (`file_id`),
  CONSTRAINT `fk_attachments_email` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table email_labels
CREATE TABLE IF NOT EXISTS `email_labels` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(40) NOT NULL,
  `color` varchar(10) NOT NULL DEFAULT 'neutral',
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO `email_labels` (`id`, `name`, `color`) VALUES
(1, 'Membership', 'primary'),
(2, 'Donations', 'danger'),
(3, 'Contact', 'warning'),
(4, 'Chapters', 'bright'),
(5, 'Imports', 'neutral');

-- Table email_label_map
CREATE TABLE IF NOT EXISTS `email_label_map` (
  `email_id` int(11) NOT NULL,
  `label_id` int(11) NOT NULL,
  PRIMARY KEY (`email_id`,`label_id`),
  KEY `fk_label_map_label` (`label_id`),
  CONSTRAINT `fk_label_map_email` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_label_map_label` FOREIGN KEY (`label_id`) REFERENCES `email_labels` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table email_recipients
CREATE TABLE IF NOT EXISTS `email_recipients` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `email_id` int(11) NOT NULL,
  `kind` varchar(3) NOT NULL DEFAULT 'to',
  `address` varchar(200) NOT NULL,
  `name` varchar(120) DEFAULT NULL,
  `member_id` int(11) DEFAULT NULL,
  `status` varchar(10) NOT NULL DEFAULT 'queued',
  `attempts` tinyint(4) NOT NULL DEFAULT 0,
  `next_attempt_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_error` varchar(500) DEFAULT NULL,
  `provider` varchar(10) DEFAULT NULL,
  `provider_id` varchar(200) DEFAULT NULL,
  `sent_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_recipients_queue` (`status`,`next_attempt_at`),
  KEY `idx_recipients_email` (`email_id`),
  KEY `idx_recipients_sent` (`status`,`sent_at`),
  CONSTRAINT `fk_recipients_email` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table files
CREATE TABLE IF NOT EXISTS `files` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `driver` varchar(10) NOT NULL,
  `object_key` varchar(255) NOT NULL,
  `purpose` varchar(30) NOT NULL,
  `filename` varchar(200) NOT NULL,
  `content_type` varchar(100) NOT NULL,
  `size` int(11) NOT NULL,
  `sha256` char(64) NOT NULL,
  `data` mediumblob DEFAULT NULL,
  `created_by` varchar(190) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_files_key` (`driver`,`object_key`),
  KEY `idx_files_purpose` (`purpose`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table job_runs
CREATE TABLE IF NOT EXISTS `job_runs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `job` varchar(30) NOT NULL,
  `status` varchar(10) NOT NULL,
  `started_at` datetime(3) NOT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `detail` varchar(500) DEFAULT NULL,
  `bytes` bigint(20) DEFAULT NULL,
  `trigger_by` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_job_runs` (`job`,`status`,`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table members
CREATE TABLE IF NOT EXISTS `members` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `reference` varchar(20) NOT NULL,
  `access_token_hash` char(64) NOT NULL,
  `full_name` varchar(120) NOT NULL,
  `phone` varchar(30) NOT NULL,
  `email` varchar(200) NOT NULL,
  `date_of_birth` date NOT NULL,
  `id_document_type` varchar(40) NOT NULL,
  `id_document_number` varchar(30) NOT NULL,
  `language` varchar(20) NOT NULL,
  `occupation` varchar(120) DEFAULT NULL,
  `interest` varchar(60) DEFAULT NULL,
  `interest_other` varchar(100) DEFAULT NULL,
  `chapter` varchar(40) DEFAULT NULL,
  `chapter_other` varchar(120) DEFAULT NULL,
  `address_line1` varchar(120) NOT NULL,
  `address_line2` varchar(120) DEFAULT NULL,
  `town` varchar(80) NOT NULL,
  `county` varchar(80) DEFAULT NULL,
  `postcode` varchar(10) NOT NULL,
  `fee_amount` decimal(10,2) NOT NULL,
  `fee_currency` varchar(3) NOT NULL DEFAULT 'GBP',
  `payment_status` varchar(20) NOT NULL DEFAULT 'pending_payment',
  `payment_note` varchar(100) DEFAULT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  `admin_notes` text DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  `data_consent_at` datetime DEFAULT NULL,
  `marketing_consent_at` datetime DEFAULT NULL,
  `email_opt_out` tinyint(1) NOT NULL DEFAULT 0,
  `email_opt_out_at` datetime DEFAULT NULL,
  `tier_id` int(11) DEFAULT NULL,
  `tier_status` varchar(10) NOT NULL DEFAULT 'confirmed',
  `billing_start` date DEFAULT NULL,
  `membership_start` date DEFAULT NULL,
  `fee_review` tinyint(1) NOT NULL DEFAULT 0,
  `fee_review_reason` varchar(400) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `reference` (`reference`),
  KEY `idx_members_email` (`email`),
  KEY `idx_members_id_number` (`id_document_number`),
  KEY `idx_members_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table membership_tiers
CREATE TABLE IF NOT EXISTS `membership_tiers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tkey` varchar(30) NOT NULL,
  `kind` varchar(12) NOT NULL DEFAULT 'membership',
  `name` varchar(80) NOT NULL,
  `description` varchar(300) DEFAULT NULL,
  `amount` decimal(10,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'GBP',
  `display_kes` decimal(12,2) DEFAULT NULL,
  `renewal` varchar(10) NOT NULL DEFAULT 'yearly',
  `tx_type` varchar(30) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `sort` int(11) NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_by` varchar(190) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tkey` (`tkey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO `membership_tiers` (`id`, `tkey`, `kind`, `name`, `description`, `amount`, `currency`, `display_kes`, `renewal`, `tx_type`, `active`, `sort`, `updated_at`, `updated_by`) VALUES
(1, 'ordinary', 'membership', 'Ordinary membership', 'Standard membership, renewed every year.', '20.00', 'GBP', NULL, 'yearly', 'membership_fee', 1, 1, UTC_TIMESTAMP(), NULL),
(2, 'stakeholder', 'membership', 'Stakeholder membership', 'For members who support the chapter at a higher level, renewed every year. The chapter confirms Stakeholder applications before the fee is due.', '500.00', 'GBP', NULL, 'yearly', 'stakeholder_membership', 1, 2, UTC_TIMESTAMP(), NULL),
(3, 'visit', 'payment', 'Visit contribution', 'A one-off contribution, paid by bank transfer. Members can add their membership reference so it is linked to them.', '200.00', 'GBP', NULL, 'one_off', 'visit_contribution', 1, 3, UTC_TIMESTAMP(), NULL);

-- Table payment_webhook_events
CREATE TABLE IF NOT EXISTS `payment_webhook_events` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `provider` varchar(20) NOT NULL,
  `event_id` varchar(120) NOT NULL,
  `payload` mediumtext NOT NULL,
  `received_at` datetime NOT NULL DEFAULT current_timestamp(),
  `processed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_webhook_event` (`provider`,`event_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table receipt_sequences
CREATE TABLE IF NOT EXISTS `receipt_sequences` (
  `year` int(11) NOT NULL,
  `last_no` int(11) NOT NULL,
  PRIMARY KEY (`year`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table schema_migrations
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `id` varchar(100) NOT NULL,
  `applied_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO `schema_migrations` (`id`, `applied_at`) VALUES
('001_baseline', UTC_TIMESTAMP()),
('002_email', UTC_TIMESTAMP()),
('003_marketing_consent', UTC_TIMESTAMP()),
('004_finance', UTC_TIMESTAMP()),
('005_tier_display_kes', UTC_TIMESTAMP()),
('006_tier_choice', UTC_TIMESTAMP()),
('007_storage_jobs', UTC_TIMESTAMP());

-- Table sessions
CREATE TABLE IF NOT EXISTS `sessions` (
  `token_hash` char(64) NOT NULL,
  `admin_id` int(11) NOT NULL,
  `expires_at` bigint(20) NOT NULL,
  PRIMARY KEY (`token_hash`),
  KEY `fk_sessions_admin` (`admin_id`),
  CONSTRAINT `fk_sessions_admin` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table settings
CREATE TABLE IF NOT EXISTS `settings` (
  `key` varchar(64) NOT NULL,
  `value` text NOT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_by` varchar(190) DEFAULT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table transactions
CREATE TABLE IF NOT EXISTS `transactions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `receipt_no` varchar(30) DEFAULT NULL,
  `type` varchar(30) NOT NULL,
  `amount` decimal(12,2) NOT NULL,
  `currency` char(3) NOT NULL DEFAULT 'GBP',
  `fx_rate` decimal(14,6) DEFAULT NULL,
  `amount_gbp` decimal(12,2) DEFAULT NULL,
  `method` varchar(20) NOT NULL,
  `account` varchar(20) NOT NULL,
  `account_label` varchar(200) DEFAULT NULL,
  `member_id` int(11) DEFAULT NULL,
  `donation_id` int(11) DEFAULT NULL,
  `payer_name` varchar(120) NOT NULL,
  `payer_email` varchar(200) DEFAULT NULL,
  `donor_kenyan` varchar(7) DEFAULT NULL,
  `date_received` date NOT NULL,
  `external_ref` varchar(100) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `status` varchar(12) NOT NULL DEFAULT 'pending',
  `source` varchar(20) NOT NULL DEFAULT 'admin',
  `recorded_by` varchar(190) NOT NULL,
  `recorded_at` datetime NOT NULL DEFAULT current_timestamp(),
  `verified_by` varchar(190) DEFAULT NULL,
  `verified_at` datetime DEFAULT NULL,
  `self_verified` tinyint(1) NOT NULL DEFAULT 0,
  `reconciled_by` varchar(190) DEFAULT NULL,
  `reconciled_at` datetime DEFAULT NULL,
  `rejected_reason` varchar(500) DEFAULT NULL,
  `void_reason` varchar(500) DEFAULT NULL,
  `voided_by` varchar(190) DEFAULT NULL,
  `voided_at` datetime DEFAULT NULL,
  `provider` varchar(20) DEFAULT NULL,
  `provider_ref` varchar(120) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `receipt_no` (`receipt_no`),
  UNIQUE KEY `uq_tx_provider` (`provider`,`provider_ref`),
  KEY `idx_tx_member` (`member_id`),
  KEY `idx_tx_donation` (`donation_id`),
  KEY `idx_tx_status` (`status`),
  KEY `idx_tx_date` (`date_received`),
  KEY `idx_tx_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
