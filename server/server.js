// DCP UK backend: serves the dcp-preview site, takes member registrations and
// donation pledges, and runs the admin area at /admin. Data lives in MySQL/MariaDB.
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const db = require('./lib/db'); // loads server/.env
const migrations = require('./lib/migrations');
const auth = require('./lib/auth');
const settings = require('./lib/settings');
const { validateMember, validateDonation } = require('./lib/validate');
const { pageParams, paged, dateRange } = require('./lib/paging');
const mailer = require('./lib/mailer');
const email = require('./lib/email');
const templates = require('./lib/email-templates');

// Feature flags: switched off until the feature is built and configured.
const FEATURES = {
  inboundEmail: process.env.FEATURE_INBOUND_EMAIL === 'true',
};

const PORT = Number(process.env.PORT) || 3000;
const IN_PRODUCTION = process.env.NODE_ENV === 'production';
// Hosting platforms route traffic to the container's own address, so listen on
// all interfaces there; locally stay on loopback.
const HOST = process.env.HOST || (IN_PRODUCTION ? '0.0.0.0' : '127.0.0.1');
const SITE_DIR = path.join(__dirname, '..', 'dcp-preview');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const ADMIN_DIR = path.join(__dirname, 'admin');

const app = express();
app.disable('x-powered-by');
// Hosts terminate HTTPS in front of the app, so trust their proxy headers:
// that's what makes req.secure true and marks the admin cookie Secure.
if (process.env.TRUST_PROXY || IN_PRODUCTION) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
  });
  next();
});

const smallJson = express.json({ limit: '20kb' });
const composeJson = express.json({ limit: '400kb' });
app.use((req, res, next) => (req.path.startsWith('/api/admin/emails') ? composeJson : smallJson)(req, res, next));

// Reject cross-site writes: browsers send Origin on POST/PUT/PATCH/DELETE, and it must
// match this server. Admin cookies are also SameSite=Strict as a second layer.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
});

// ---------------------------------------------------------------- helpers

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, easy to read out over the phone
async function newReference(prefix, table) {
  for (;;) {
    let code = '';
    for (const byte of crypto.randomBytes(6)) code += REF_ALPHABET[byte % REF_ALPHABET.length];
    const ref = `${prefix}-${code}`;
    if (!(await db.one(`SELECT 1 AS x FROM ${table} WHERE reference = ?`, [ref]))) return ref;
  }
}

// Per-IP cap on public form submissions, to stop the tables being flooded.
const submissions = new Map();
function submissionLimit(req, res, next) {
  const now = Date.now();
  const recent = (submissions.get(req.ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 20) return res.status(429).json({ error: 'Too many submissions from this connection. Please try again later.' });
  recent.push(now);
  submissions.set(req.ip, recent);
  next();
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, columns, rows) {
  const lines = [columns.map(([, label]) => csvCell(label)).join(',')];
  for (const row of rows) lines.push(columns.map(([key]) => csvCell(row[key])).join(','));
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send('﻿' + lines.join('\r\n'));
}

const likeParam = (q) => `%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`;
const orNull = (v) => (v === undefined || v === '' ? null : v);

// ---------------------------------------------------------------- public API

// Used by hosting platforms' health checks.
app.get('/api/health', async (req, res) => {
  try {
    await db.one('SELECT 1 AS ok');
    res.json({ ok: true, database: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, database: 'down' });
  }
});

app.get('/api/payment-details', async (req, res) => {
  res.json({ feeAccount: await settings.publicFeeAccount(), donationAccount: await settings.publicDonationAccount() });
});

app.post('/api/members', submissionLimit, async (req, res) => {
  const { value: m, errors } = validateMember(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });

  const feeAccount = await settings.publicFeeAccount();
  const reference = await newReference('DCPUK', 'members');
  const accessToken = crypto.randomBytes(24).toString('base64url');
  await db.query(`
    INSERT INTO members (reference, access_token_hash, full_name, phone, email, date_of_birth,
      id_document_type, id_document_number, language, occupation, interest, interest_other, chapter, chapter_other,
      address_line1, address_line2, town, county, postcode, fee_amount, fee_currency, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [reference, auth.sha256(accessToken), m.fullName, m.phone, m.email, m.dateOfBirth,
    m.idDocumentType, m.idDocumentNumber, m.language, orNull(m.occupation), orNull(m.interest), orNull(m.interestOther),
    orNull(m.chapter), orNull(m.chapterOther),
    m.addressLine1, orNull(m.addressLine2), m.town, orNull(m.county), m.postcode, feeAccount.feeAmount, feeAccount.feeCurrency]);
  const created = await db.one('SELECT id FROM members WHERE reference = ?', [reference]);
  // The form requires the data-consent declaration (validateMember); chapter news is optional.
  await db.query(`UPDATE members SET data_consent_at = UTC_TIMESTAMP(), marketing_consent_at = ${m.marketingConsent ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE id = ?`, [created.id]);
  await email.receive({
    source: 'application', fromName: m.fullName, fromEmail: m.email, memberId: created.id, labels: ['Membership'],
    subject: `New membership application: ${m.fullName}`,
    text: [`${m.fullName} applied to join DCP UK.`, '', `Reference: ${reference}`, `Email: ${m.email}`, `Phone: ${m.phone}`,
      `Chapter: ${m.chapter || 'not chosen'}${m.chapterOther ? ` (${m.chapterOther})` : ''}`, `Town: ${m.town}`, '',
      'Review it under Members. Replying to this message emails the applicant.'].join('\n'),
  }).catch((err) => console.error('Could not add the application to the inbox:', err.message));

  res.status(201).json({ reference, accessToken, feeAccount });
});

// The applicant tells us they've paid. Only the browser that registered holds the token.
app.post('/api/members/:reference/payment-reported', async (req, res) => {
  const token = String(req.body?.accessToken || '');
  const row = await db.one('SELECT id, access_token_hash, payment_status FROM members WHERE reference = ?', [req.params.reference]);
  if (!row || !token || !crypto.timingSafeEqual(Buffer.from(auth.sha256(token)), Buffer.from(row.access_token_hash))) {
    return res.status(404).json({ error: 'Registration not found.' });
  }
  const note = String(req.body?.paymentNote || '').trim().slice(0, 100) || null;
  if (row.payment_status === 'pending_payment') {
    await db.query("UPDATE members SET payment_status = 'payment_reported', payment_note = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [note, row.id]);
  }
  res.json({ ok: true });
});

app.post('/api/donations', submissionLimit, async (req, res) => {
  const donationAccount = await settings.publicDonationAccount();
  if (!donationAccount.configured) {
    return res.status(503).json({ error: 'Donations are not open yet: the chapter has not set up its bank account.' });
  }
  const { value: d, errors } = validateDonation(req.body);
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });

  const reference = await newReference('DON', 'donations');
  await db.query(`INSERT INTO donations (reference, full_name, email, amount_gbp, frequency, message, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
  [reference, d.fullName, d.email, d.amountGbp, d.frequency, orNull(d.message)]);
  res.status(201).json({ reference, amountGbp: d.amountGbp, frequency: d.frequency, donationAccount });
});

// Contact form. Rate limited per IP, with a honeypot field and a minimum fill
// time; suspected bots get a normal-looking success so they learn nothing.
// The subjects offered on contact.html, and the inbox labels each one gets.
const CONTACT_TOPICS = {
  'General enquiry': [], Membership: ['Membership'], 'Find or start a UK chapter': ['Chapters'], Events: ['Chapters'],
  'Diaspora policy': [], 'Volunteering or a chapter role': ['Chapters'], 'Media enquiry': [], 'Data protection request': [],
  'Complaint or feedback': [], 'Website support': [],
};
const contactHits = new Map();
function contactLimit(req, res, next) {
  const now = Date.now();
  const recent = (contactHits.get(req.ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 5) return res.status(429).json({ error: 'You have sent several messages in the last hour. Please try again later, or email the chapter directly.' });
  recent.push(now);
  contactHits.set(req.ip, recent);
  next();
}
app.post('/api/contact', contactLimit, async (req, res) => {
  const b = req.body || {};
  const startedAt = Number(b.startedAt) || 0;
  if (String(b.website || '').trim() || !startedAt || Date.now() - startedAt < 3000) return res.json({ ok: true });
  const fields = {};
  const name = String(b.name || '').trim();
  const from = String(b.email || '').trim().toLowerCase();
  const topic = String(b.topic || '').trim();
  const message = String(b.message || '').trim();
  const phone = String(b.phone || '').trim().slice(0, 30);
  const region = String(b.region || '').trim().slice(0, 60);
  if (name.length < 2 || name.length > 120) fields.name = 'Enter your name.';
  if (!email.EMAIL_RE.test(from) || from.length > 200) fields.email = 'Enter a valid email address so we can reply.';
  if (!Object.hasOwn(CONTACT_TOPICS, topic)) fields.topic = 'Choose a subject.';
  if (b.consent !== true) fields.consent = 'Tick the box so we can use your details to reply.';
  if (message.length < 10) fields.message = 'Write a message of at least 10 characters.';
  if (message.length > 5000) fields.message = 'Keep your message under 5,000 characters.';
  if (Object.keys(fields).length) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields });
  const member = await db.one('SELECT id FROM members WHERE email = ? LIMIT 1', [from]);
  await email.receive({
    source: 'contact', fromName: name, fromEmail: from, memberId: member?.id || null,
    labels: ['Contact', ...CONTACT_TOPICS[topic]],
    subject: `[${topic}] Message from ${name}`,
    text: [message, '', '--', `From: ${name} <${from}>`, phone && `Phone: ${phone}`, region && `Area: ${region}`, 'Sent from the website contact form. Replying emails the sender.'].filter(Boolean).join('\n'),
  });
  res.status(201).json({ ok: true });
});

// Member replies by email arrive later, behind FEATURE_INBOUND_EMAIL.
app.post('/api/inbound-email', (req, res) => {
  if (!FEATURES.inboundEmail) return res.status(404).json({ error: 'Not found.' });
  res.status(501).json({ error: 'Inbound email is not implemented yet.' });
});

// ---------------------------------------------------------------- admin auth

const adminApi = express.Router();
adminApi.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

adminApi.get('/session', async (req, res) => {
  res.json({ admin: await auth.getSessionAdmin(req) });
});

adminApi.post('/login', async (req, res) => {
  if (auth.loginBlocked(req.ip)) return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
  const admin = await auth.checkCredentials(req.body?.username, req.body?.password);
  if (!admin) {
    auth.recordLoginFailure(req.ip);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  auth.clearLoginFailures(req.ip);
  res.set('Set-Cookie', auth.sessionCookie(await auth.createSession(admin.id), req, auth.SESSION_TTL_MS));
  res.json({ admin: { id: admin.id, username: admin.username } });
});

adminApi.post('/logout', async (req, res) => {
  await auth.destroySession(req);
  res.set('Set-Cookie', auth.sessionCookie('', req, 0));
  res.json({ ok: true });
});

// Everything below needs a signed-in admin.
adminApi.use(auth.requireAdmin);

adminApi.post('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!(await auth.checkCredentials(req.admin.username, currentPassword))) return res.status(400).json({ error: 'Current password is incorrect.' });
  const problem = auth.validateNewPassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  await db.query('UPDATE admins SET password_hash = ? WHERE id = ?', [auth.hashPassword(newPassword), req.admin.id]);
  // Sign out every other session for this admin.
  await db.query('DELETE FROM sessions WHERE admin_id = ?', [req.admin.id]);
  res.set('Set-Cookie', auth.sessionCookie(await auth.createSession(req.admin.id), req, auth.SESSION_TTL_MS));
  res.json({ ok: true });
});

adminApi.post('/admins', async (req, res) => {
  try {
    await auth.createAdmin(req.body?.username, req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json({ ok: true });
});

const ADMIN_SORTS = { username: 'username', created: 'created_at' };
adminApi.get('/admins', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) { where.push('username LIKE ?'); params.push(likeParam(req.query.q)); }
  const { rows, ...page } = await paged(db, {
    select: 'id, username, created_at', from: 'admins', where, params,
    p: pageParams(req.query, ADMIN_SORTS, 'username', 'asc'), tiebreak: 'id',
  });
  res.json({ admins: rows, ...page });
});

// ---------------------------------------------------------------- admin: payment accounts

adminApi.get('/settings', async (req, res) => {
  res.json({ feeAccount: await settings.getSetting('feeAccount'), donationAccount: await settings.getSetting('donationAccount') });
});

function saveAccount(key, validator) {
  return async (req, res) => {
    let value;
    try {
      value = validator(req.body || {});
    } catch (err) {
      if (err instanceof settings.ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
    await settings.saveSetting(key, value, req.admin.username);
    res.json(await settings.getSetting(key));
  };
}
adminApi.put('/settings/fee-account', saveAccount('feeAccount', settings.validateFeeAccount));
adminApi.put('/settings/donation-account', saveAccount('donationAccount', settings.validateDonationAccount));

// ---------------------------------------------------------------- admin: email app

adminApi.get('/mail-status', (req, res) => {
  const c = mailer.config();
  res.json({ transport: c.transport, production: IN_PRODUCTION, from: c.from, replyTo: c.replyTo, ratePerMinute: c.ratePerMinute, dailyLimit: c.dailyLimit, problems: mailer.problems(), inbound: FEATURES.inboundEmail });
});

adminApi.get('/email-templates', (req, res) => res.json({ templates: templates.TEMPLATES }));
adminApi.get('/email-labels', async (req, res) => res.json({ labels: await db.query('SELECT id, name, color FROM email_labels ORDER BY id') }));

// Member search for the compose "To" field, with what each person can receive.
adminApi.get('/members/lookup', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ members: [] });
  const like = likeParam(q);
  res.json({ members: await db.query(`SELECT id, full_name, email, chapter, marketing_consent_at IS NOT NULL AS consent, email_opt_out AS opted_out
    FROM members WHERE full_name LIKE ? OR email LIKE ? OR reference LIKE ? ORDER BY full_name LIMIT 8`, [like, like, like]) });
});

const EMAIL_SORTS = { date: 'e.created_at', subject: 'e.subject', from: 'e.from_email' };
adminApi.get('/emails', async (req, res) => {
  const q = req.query;
  const folder = q.folder === 'starred' || email.FOLDERS.includes(q.folder) ? q.folder : 'inbox';
  const where = [];
  const params = [];
  if (folder === 'starred') where.push("e.is_starred = 1 AND e.folder <> 'trash'"); else { where.push('e.folder = ?'); params.push(folder); }
  if (Number(q.label)) { where.push('EXISTS (SELECT 1 FROM email_label_map lm WHERE lm.email_id = e.id AND lm.label_id = ?)'); params.push(Number(q.label)); }
  if (q.q) {
    const like = likeParam(q.q);
    where.push('(e.subject LIKE ? OR e.from_email LIKE ? OR e.from_name LIKE ? OR e.to_summary LIKE ? OR e.body_text LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (q.unread === '1') where.push('e.is_read = 0');
  const { rows, ...page } = await paged(db, {
    select: `e.id, e.folder, e.direction, e.source, e.category, e.from_name, e.from_email, e.to_summary, e.subject,
      LEFT(e.body_text, 160) AS snippet, e.is_read, e.is_starred, e.status, e.created_at, e.sent_at, e.recipient_count, e.excluded_count,
      (SELECT GROUP_CONCAT(lm.label_id) FROM email_label_map lm WHERE lm.email_id = e.id) AS label_ids,
      (SELECT COUNT(*) FROM email_attachments a WHERE a.email_id = e.id) AS attachments`,
    from: 'emails e', where, params, p: pageParams(q, EMAIL_SORTS, 'date'), tiebreak: 'e.id DESC',
  });
  const counts = await db.one(`SELECT
    SUM(folder = 'inbox' AND is_read = 0) AS inbox, SUM(folder = 'draft') AS draft, SUM(folder = 'spam' AND is_read = 0) AS spam,
    SUM(is_starred = 1 AND folder <> 'trash') AS starred, SUM(folder = 'sent' AND status IN ('queued', 'failed', 'partial')) AS sent_attention
    FROM emails`);
  const labelCounts = await db.query(`SELECT lm.label_id AS id, COUNT(*) AS n FROM email_label_map lm JOIN emails e ON e.id = lm.email_id
    WHERE e.folder <> 'trash' AND e.is_read = 0 GROUP BY lm.label_id`);
  res.json({
    emails: rows.map((r) => ({ ...r, label_ids: r.label_ids ? r.label_ids.split(',').map(Number) : [], attachments: Number(r.attachments) })),
    ...page, folder,
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])),
    labelCounts: Object.fromEntries(labelCounts.map((l) => [l.id, Number(l.n)])),
  });
});

adminApi.get('/emails/:id', async (req, res) => {
  const id = Number(req.params.id) || 0;
  const row = await db.one('SELECT * FROM emails WHERE id = ?', [id]);
  if (!row) return res.status(404).json({ error: 'Email not found.' });
  if (!row.is_read) await db.query('UPDATE emails SET is_read = 1 WHERE id = ?', [id]);
  res.json({
    email: { ...row, is_read: 1, draft: row.draft_json ? JSON.parse(row.draft_json) : null, draft_json: undefined },
    recipients: await db.query('SELECT id, kind, address, name, member_id, status, attempts, last_error, provider, sent_at FROM email_recipients WHERE email_id = ? ORDER BY kind DESC, id LIMIT 500', [id]),
    recipientTotals: Object.fromEntries((await db.query('SELECT status, COUNT(*) AS n FROM email_recipients WHERE email_id = ? GROUP BY status', [id])).map((r) => [r.status, Number(r.n)])),
    attachments: await db.query('SELECT id, filename, content_type, size FROM email_attachments WHERE email_id = ? ORDER BY id', [id]),
    labels: (await db.query('SELECT label_id FROM email_label_map WHERE email_id = ?', [id])).map((l) => l.label_id),
  });
});

// Bulk actions on selected emails: read, unread, star, unstar, move, restore, label, unlabel, delete.
adminApi.post('/emails/bulk', async (req, res) => {
  const { action, value } = req.body || {};
  const ids = [...new Set((req.body?.ids || []).map(Number).filter(Boolean))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Select at least one email.' });
  const inList = `id IN (${ids.map(() => '?').join(',')})`;
  let result;
  switch (action) {
    case 'read': case 'unread': result = await db.query(`UPDATE emails SET is_read = ? WHERE ${inList}`, [action === 'read' ? 1 : 0, ...ids]); break;
    case 'star': case 'unstar': result = await db.query(`UPDATE emails SET is_starred = ? WHERE ${inList}`, [action === 'star' ? 1 : 0, ...ids]); break;
    case 'move':
      if (value === 'trash') result = await db.query(`UPDATE emails SET restore_folder = folder, folder = 'trash' WHERE folder <> 'trash' AND ${inList}`, ids);
      else if (value === 'inbox' || value === 'spam') result = await db.query(`UPDATE emails SET folder = ? WHERE direction = 'in' AND ${inList}`, [value, ...ids]);
      else return res.status(400).json({ error: 'Emails can be moved to Inbox, Spam or Trash.' });
      break;
    case 'restore': result = await db.query(`UPDATE emails SET folder = COALESCE(restore_folder, IF(direction = 'in', 'inbox', 'sent')), restore_folder = NULL WHERE folder = 'trash' AND ${inList}`, ids); break;
    case 'label': case 'unlabel': {
      const label = await db.one('SELECT id FROM email_labels WHERE id = ?', [Number(value) || 0]);
      if (!label) return res.status(400).json({ error: 'Unknown label.' });
      for (const id of ids) {
        result = await db.query(action === 'label' ? 'INSERT IGNORE INTO email_label_map (email_id, label_id) VALUES (?, ?)' : 'DELETE FROM email_label_map WHERE email_id = ? AND label_id = ?', [id, label.id]);
      }
      break;
    }
    case 'delete':
      // From Trash (or a draft) it is deleted for good; anywhere else it goes to Trash.
      await db.query(`DELETE FROM emails WHERE (folder = 'trash' OR folder = 'draft') AND ${inList}`, ids);
      result = await db.query(`UPDATE emails SET restore_folder = folder, folder = 'trash' WHERE folder <> 'trash' AND ${inList}`, ids);
      break;
    default: return res.status(400).json({ error: 'Unknown action.' });
  }
  res.json({ ok: true, changed: result?.affectedRows ?? 0 });
});

// What the "To" summary shows before sending.
adminApi.post('/emails/audience', async (req, res) => {
  const a = await email.resolveAudience(req.body || {});
  res.json({
    category: a.category, recipients: a.recipients.filter((r) => r.kind === 'to').length, excluded: a.excluded, excludedTotal: a.excludedTotal,
    duplicate: a.duplicate, summary: a.summary, errors: a.errors, bulkBlocked: a.category === 'bulk' && !mailer.unsubscribeUrl(1, 'x@example.org'),
  });
});

adminApi.post('/emails', async (req, res) => {
  const b = req.body || {};
  const draftId = Number(b.draftId) || null;
  if (draftId && !(await db.one("SELECT id FROM emails WHERE id = ? AND folder = 'draft'", [draftId]))) return res.status(404).json({ error: 'Draft not found.' });
  const input = { to: Array.isArray(b.to) ? b.to.slice(0, 500) : [], segments: Array.isArray(b.segments) ? b.segments.slice(0, 20) : [], cc: Array.isArray(b.cc) ? b.cc.slice(0, 20) : [], bcc: Array.isArray(b.bcc) ? b.bcc.slice(0, 20) : [] };
  const template = templates.byKey(b.template);
  if (template?.systemOnly) return res.status(400).json({ error: 'That template is sent automatically and cannot be used here.' });
  const audience = await email.resolveAudience(input);
  if (template?.bulkOnly && audience.category !== 'bulk') return res.status(400).json({ error: `The "${template.name}" template is for bulk emails to members.` });
  const attachmentIds = Array.isArray(b.attachmentIds) ? b.attachmentIds : [];

  if (b.action === 'draft') {
    const draft = JSON.stringify({ ...input, attachmentIds, template: template?.key || null, inReplyTo: Number(b.inReplyTo) || null });
    const values = [audience.summary || '(no recipients yet)', String(b.subject || '').slice(0, 250), email.cleanHtml(b.html), draft, req.admin.username];
    let id = draftId;
    if (id) await db.query("UPDATE emails SET to_summary = ?, subject = ?, body_html = ?, draft_json = ?, created_by = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [...values, id]);
    else id = (await db.query(`INSERT INTO emails (folder, direction, source, category, status, is_read, to_summary, subject, body_html, draft_json, created_by, created_at, updated_at)
      VALUES ('draft', 'out', 'compose', 'transactional', 'draft', 1, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, values)).insertId;
    const ids = attachmentIds.map(Number).filter(Boolean);
    if (ids.length) await db.query(`UPDATE email_attachments SET email_id = ? WHERE email_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [id, ...ids]);
    return res.json({ ok: true, id, draft: true });
  }
  try {
    const id = await email.createOutgoing({
      admin: req.admin.username, audience, subject: b.subject, html: b.html, template: template?.key,
      attachmentIds, inReplyTo: Number(b.inReplyTo) || null, source: b.inReplyTo ? 'reply' : 'compose', draftId,
    });
    res.status(201).json({ ok: true, id, category: audience.category, recipients: audience.recipients.filter((r) => r.kind === 'to').length, excluded: audience.excludedTotal });
  } catch (err) {
    if (err instanceof email.EmailError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// Attachments are uploaded one at a time as raw bytes, before the email is sent.
adminApi.post('/email-attachments', express.raw({ type: () => true, limit: email.MAX_ATTACHMENT }), async (req, res) => {
  let name = '';
  try { name = decodeURIComponent(String(req.get('x-filename') || '')); } catch { /* malformed name */ }
  name = name.replace(/[\\/\r\n"]/g, '_').trim().slice(0, 200);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('content-type') || '') ? req.get('content-type') : 'application/octet-stream';
  if (!name) return res.status(400).json({ error: 'The file needs a name.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
  const r = await db.query('INSERT INTO email_attachments (filename, content_type, size, data, uploaded_by) VALUES (?, ?, ?, ?, ?)', [name, type, req.body.length, req.body, req.admin.username]);
  res.status(201).json({ id: r.insertId, filename: name, size: req.body.length, contentType: type });
});
adminApi.delete('/email-attachments/:id', async (req, res) => {
  await db.query('DELETE FROM email_attachments WHERE id = ? AND (email_id IS NULL OR email_id IN (SELECT id FROM emails WHERE folder = \'draft\'))', [Number(req.params.id) || 0]);
  res.json({ ok: true });
});
adminApi.get('/email-attachments/:id', async (req, res) => {
  const a = await db.one('SELECT filename, content_type, data FROM email_attachments WHERE id = ?', [Number(req.params.id) || 0]);
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  // Always a download, never rendered in the admin's origin.
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`, 'Cache-Control': 'no-store' });
  res.send(a.data);
});

// ---------------------------------------------------------------- admin: dashboard, search, notifications

const isoDay = (d) => d.toISOString().slice(0, 10);

adminApi.get('/dashboard', async (req, res) => {
  const n = async (sql, params = []) => Number((await db.one(sql, params)).n);
  // Registrations per day for the last 14 days (UTC), oldest first.
  const rows = await db.query(`SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS n FROM members
    WHERE created_at >= UTC_DATE() - INTERVAL 13 DAY GROUP BY d`);
  const byDay = Object.fromEntries(rows.map((r) => [r.d, Number(r.n)]));
  const days = Array.from({ length: 14 }, (_, i) => isoDay(new Date(Date.now() - (13 - i) * 86400000)));
  const daily = days.map((d) => ({ date: d, n: byDay[d] || 0 }));
  res.json({
    newMembers: { thisWeek: daily.slice(7), thisWeekTotal: daily.slice(7).reduce((s, x) => s + x.n, 0), lastWeekTotal: daily.slice(0, 7).reduce((s, x) => s + x.n, 0) },
    members: await n('SELECT COUNT(*) AS n FROM members'),
    membersApproved: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'approved'"),
    membersPending: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'pending'"),
    paymentsToCheck: await n("SELECT COUNT(*) AS n FROM members WHERE payment_status = 'payment_reported'"),
    byChapter: (await db.query("SELECT COALESCE(chapter, 'Not given') AS chapter, COUNT(*) AS n FROM members GROUP BY chapter ORDER BY n DESC, chapter"))
      .map((r) => ({ chapter: r.chapter, n: Number(r.n) })),
    recentRegistrations: await db.query(`SELECT id, reference, full_name, email, chapter, status, payment_status, created_at
      FROM members ORDER BY created_at DESC, id DESC LIMIT 6`),
  });
});

// Top-bar search across members, donations and admins (5 of each).
adminApi.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ members: [], donations: [], admins: [] });
  const like = likeParam(q);
  res.json({
    members: await db.query(`SELECT id, reference, full_name, email, status FROM members
      WHERE full_name LIKE ? OR email LIKE ? OR reference LIKE ? OR phone LIKE ? OR postcode LIKE ?
      ORDER BY created_at DESC LIMIT 5`, [like, like, like, like, like]),
    donations: await db.query(`SELECT id, reference, full_name, amount_gbp, status FROM donations
      WHERE full_name LIKE ? OR email LIKE ? OR reference LIKE ? ORDER BY created_at DESC LIMIT 5`, [like, like, like]),
    admins: await db.query('SELECT id, username FROM admins WHERE username LIKE ? ORDER BY username LIMIT 5', [like]),
  });
});

// The bell: things waiting on an admin.
adminApi.get('/notifications', async (req, res) => {
  const n = async (sql) => Number((await db.one(sql)).n);
  res.json({
    pending: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'pending'"),
    paymentsToCheck: await n("SELECT COUNT(*) AS n FROM members WHERE payment_status = 'payment_reported'"),
    donationsPledged: await n("SELECT COUNT(*) AS n FROM donations WHERE status = 'pledged'"),
    unreadMessages: await n("SELECT COUNT(*) AS n FROM emails WHERE folder = 'inbox' AND is_read = 0 AND source = 'contact'"),
    failedEmails: await n("SELECT COUNT(*) AS n FROM emails WHERE folder = 'sent' AND status IN ('failed', 'partial')"),
    newRegistrations: await db.query(`SELECT id, reference, full_name, chapter, created_at FROM members
      WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`),
  });
});

// ---------------------------------------------------------------- admin: members

const MEMBER_STATUSES = ['pending', 'approved', 'rejected'];
const PAYMENT_STATUSES = ['pending_payment', 'payment_reported', 'paid'];

const MEMBER_COLUMNS = `
  m.id, m.reference, m.full_name, m.phone, m.email, m.date_of_birth, m.id_document_type,
  m.id_document_number, m.language, m.occupation, m.interest, m.interest_other, m.chapter, m.chapter_other, m.address_line1,
  m.address_line2, m.town, m.county, m.postcode, m.fee_amount, m.fee_currency, m.payment_status, m.payment_note, m.status,
  m.admin_notes, m.created_at, m.updated_at,
  (SELECT COUNT(*) FROM members d WHERE d.id <> m.id AND (d.id_document_number = m.id_document_number OR d.email = m.email)) AS possible_duplicates`;

// Sortable columns for ?sort= (keys are what the admin table sends).
const MEMBER_SORTS = {
  reference: 'm.reference', name: 'm.full_name', email: 'm.email', chapter: 'm.chapter',
  registered: 'm.created_at', payment: 'm.payment_status', status: 'm.status',
};

function memberFilters(q) {
  const where = [];
  const params = [];
  if (MEMBER_STATUSES.includes(q.status)) { where.push('m.status = ?'); params.push(q.status); }
  if (PAYMENT_STATUSES.includes(q.payment)) { where.push('m.payment_status = ?'); params.push(q.payment); }
  if (q.chapter) { where.push('m.chapter = ?'); params.push(String(q.chapter)); }
  if (q.q) {
    const like = likeParam(q.q);
    where.push('(m.full_name LIKE ? OR m.email LIKE ? OR m.reference LIKE ? OR m.phone LIKE ? OR m.id_document_number LIKE ? OR m.postcode LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  dateRange(q, 'm.created_at', where, params);
  return { where, params };
}

// Every matching member, in the table's sort order (for CSV export).
async function memberQuery(q) {
  const { where, params } = memberFilters(q);
  const p = pageParams(q, MEMBER_SORTS, 'registered');
  return db.query(`SELECT ${MEMBER_COLUMNS} FROM members m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${p.orderBy}, m.id DESC`, params);
}

const getMember = (id) => db.one(`SELECT ${MEMBER_COLUMNS} FROM members m WHERE m.id = ?`, [Number(id) || 0]);

adminApi.get('/stats', async (req, res) => {
  const n = async (sql) => Number((await db.one(sql)).n);
  res.json({
    members: await n('SELECT COUNT(*) AS n FROM members'),
    membersPending: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'pending'"),
    membersApproved: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'approved'"),
    paymentsToCheck: await n("SELECT COUNT(*) AS n FROM members WHERE payment_status = 'payment_reported'"),
    donationsPledged: await n("SELECT COUNT(*) AS n FROM donations WHERE status = 'pledged'"),
    donationsReceivedGbp: await n("SELECT COALESCE(SUM(amount_gbp), 0) AS n FROM donations WHERE status = 'received'"),
    emailsUnread: await n("SELECT COUNT(*) AS n FROM emails WHERE folder = 'inbox' AND is_read = 0"),
  });
});

adminApi.get('/members', async (req, res) => {
  const { where, params } = memberFilters(req.query);
  const { rows, ...page } = await paged(db, {
    select: MEMBER_COLUMNS, from: 'members m', where, params,
    p: pageParams(req.query, MEMBER_SORTS, 'registered'), tiebreak: 'm.id DESC',
  });
  res.json({ members: rows, ...page });
});

adminApi.get('/members.csv', async (req, res) => {
  sendCsv(res, `dcp-uk-members-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['reference', 'Reference'], ['created_at', 'Registered (UTC)'], ['status', 'Status'], ['payment_status', 'Payment'],
    ['full_name', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['date_of_birth', 'Date of birth'],
    ['id_document_type', 'ID document'], ['id_document_number', 'Document number'], ['language', 'Language'],
    ['occupation', 'Occupation'], ['interest', 'Interest'], ['interest_other', 'Interest (other)'],
    ['chapter', 'Chapter'], ['chapter_other', 'Nearest town/city'],
    ['address_line1', 'Address 1'], ['address_line2', 'Address 2'], ['town', 'Town'], ['county', 'County'], ['postcode', 'Postcode'],
    ['fee_amount', 'Fee'], ['fee_currency', 'Fee currency'], ['payment_note', 'Payment code given'], ['admin_notes', 'Admin notes'],
  ], await memberQuery(req.query));
});

adminApi.get('/members/:id', async (req, res) => {
  const member = await getMember(req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  res.json({ member });
});

// Rejecting a member or cancelling a pledge needs a reason. It is added to the
// record's admin notes with who and when (and to the audit log once that exists).
function reasonNote(verb, admin, reason) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `[${stamp} UTC] ${verb} by ${admin}: ${reason}`;
}
const cleanReason = (r) => String(r || '').trim().slice(0, 500);

adminApi.patch('/members/:id', async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const params = [];
  const current = await db.one('SELECT status, admin_notes FROM members WHERE id = ?', [Number(req.params.id) || 0]);
  if (!current) return res.status(404).json({ error: 'Member not found.' });
  let notes = b.adminNotes !== undefined ? String(b.adminNotes).slice(0, 2000) : undefined;
  if (b.status !== undefined) {
    if (!MEMBER_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    if (b.status === 'rejected' && current.status !== 'rejected') {
      const reason = cleanReason(b.reason);
      if (!reason) return res.status(400).json({ error: 'Give a reason for rejecting this application.' });
      notes = [notes ?? current.admin_notes, reasonNote('Rejected', req.admin.username, reason)].filter(Boolean).join('\n');
    }
    updates.push('status = ?'); params.push(b.status);
  }
  if (b.paymentStatus !== undefined) {
    if (!PAYMENT_STATUSES.includes(b.paymentStatus)) return res.status(400).json({ error: 'Unknown payment status.' });
    updates.push('payment_status = ?'); params.push(b.paymentStatus);
  }
  if (notes !== undefined) { updates.push('admin_notes = ?'); params.push(notes.slice(-4000) || null); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
  const result = await db.query(`UPDATE members SET ${updates.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...params, Number(req.params.id) || 0]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Member not found.' });
  res.json({ member: await getMember(req.params.id) });
});

// Permanent deletion, e.g. for a data-erasure request.
adminApi.delete('/members/:id', async (req, res) => {
  const result = await db.query('DELETE FROM members WHERE id = ?', [Number(req.params.id) || 0]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Member not found.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin: donations

const DONATION_STATUSES = ['pledged', 'received', 'cancelled'];

const DONATION_SORTS = { reference: 'reference', donor: 'full_name', amount: 'amount_gbp', pledged: 'created_at', status: 'status' };

function donationFilters(q) {
  const where = [];
  const params = [];
  if (DONATION_STATUSES.includes(q.status)) { where.push('status = ?'); params.push(q.status); }
  if (q.q) {
    const like = likeParam(q.q);
    where.push('(full_name LIKE ? OR email LIKE ? OR reference LIKE ?)');
    params.push(like, like, like);
  }
  dateRange(q, 'created_at', where, params);
  return { where, params };
}

// Every matching donation, in the table's sort order (for CSV export).
async function donationQuery(q) {
  const { where, params } = donationFilters(q);
  const p = pageParams(q, DONATION_SORTS, 'pledged');
  return db.query(`SELECT * FROM donations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${p.orderBy}, id DESC`, params);
}

adminApi.get('/donations', async (req, res) => {
  const { where, params } = donationFilters(req.query);
  const { rows, ...page } = await paged(db, {
    select: '*', from: 'donations', where, params,
    p: pageParams(req.query, DONATION_SORTS, 'pledged'), tiebreak: 'id DESC',
  });
  res.json({ donations: rows, ...page });
});

adminApi.get('/donations.csv', async (req, res) => {
  sendCsv(res, `dcp-uk-donations-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['reference', 'Reference'], ['created_at', 'Pledged (UTC)'], ['status', 'Status'], ['amount_gbp', 'Amount (GBP)'],
    ['frequency', 'Frequency'], ['full_name', 'Name'], ['email', 'Email'], ['message', 'Message'], ['admin_notes', 'Admin notes'],
  ], await donationQuery(req.query));
});

adminApi.get('/donations/:id', async (req, res) => {
  const donation = await db.one('SELECT * FROM donations WHERE id = ?', [Number(req.params.id) || 0]);
  if (!donation) return res.status(404).json({ error: 'Donation not found.' });
  res.json({ donation });
});

adminApi.patch('/donations/:id', async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const params = [];
  const current = await db.one('SELECT status, admin_notes FROM donations WHERE id = ?', [Number(req.params.id) || 0]);
  if (!current) return res.status(404).json({ error: 'Donation not found.' });
  let notes = b.adminNotes !== undefined ? String(b.adminNotes).slice(0, 2000) : undefined;
  if (b.status !== undefined) {
    if (!DONATION_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    if (b.status === 'cancelled' && current.status !== 'cancelled') {
      const reason = cleanReason(b.reason);
      if (!reason) return res.status(400).json({ error: 'Give a reason for cancelling this pledge.' });
      notes = [notes ?? current.admin_notes, reasonNote('Cancelled', req.admin.username, reason)].filter(Boolean).join('\n');
    }
    updates.push('status = ?'); params.push(b.status);
  }
  if (notes !== undefined) { updates.push('admin_notes = ?'); params.push(notes.slice(-4000) || null); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
  const result = await db.query(`UPDATE donations SET ${updates.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...params, Number(req.params.id) || 0]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Donation not found.' });
  res.json({ donation: await db.one('SELECT * FROM donations WHERE id = ?', [Number(req.params.id) || 0]) });
});

app.use('/api/admin', adminApi);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------- unsubscribe

function unsubscribePage(title, body, form = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · DCP UK</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#f3f8f1;color:#14201a">
<main style="max-width:480px;margin:10vh auto;padding:32px;background:#fff;border-radius:10px;box-shadow:0 4px 18px rgba(13,36,16,.1)">
<p style="margin:0 0 16px;font-weight:800;font-size:20px">DCP <span style="color:#24592a">UK</span></p>
<h1 style="font-size:22px;margin:0 0 12px">${title}</h1><p style="line-height:1.6;color:#4b5f52">${body}</p>${form}
<p style="margin-top:24px"><a href="/" style="color:#24592a">Back to the website</a></p></main></body></html>`;
}
async function unsubscribeTarget(req) {
  const id = Number(req.query.m || req.body?.m) || 0;
  const token = String(req.query.t || req.body?.t || '');
  const member = id ? await db.one('SELECT id, email, email_opt_out FROM members WHERE id = ?', [id]) : null;
  return member && mailer.checkUnsubscribeToken(member.id, member.email, token) ? { member, token } : null;
}
// GET only shows a button, so link scanners that open URLs cannot unsubscribe people.
app.get('/unsubscribe', async (req, res) => {
  const t = await unsubscribeTarget(req);
  res.set('Cache-Control', 'no-store');
  if (!t) return res.status(400).send(unsubscribePage('Link not recognised', 'This unsubscribe link is incomplete or has expired. Contact the chapter and we will remove you by hand.'));
  if (t.member.email_opt_out) return res.send(unsubscribePage('You are unsubscribed', 'You will not receive chapter news emails. You will still get messages about your own membership, such as receipts.'));
  res.send(unsubscribePage('Unsubscribe from chapter emails?', 'You will stop receiving DCP UK news and notices. Messages about your own membership, such as receipts and login emails, will still be sent.',
    `<form method="post" action="/unsubscribe"><input type="hidden" name="m" value="${t.member.id}"><input type="hidden" name="t" value="${t.token}">
     <button type="submit" style="margin-top:8px;padding:12px 20px;border:0;border-radius:6px;background:#24592a;color:#fff;font-weight:600;font-size:15px;cursor:pointer">Unsubscribe</button></form>`));
});
// Handles both the button above and RFC 8058 one-click requests from mail apps.
app.post('/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  const t = await unsubscribeTarget(req);
  res.set('Cache-Control', 'no-store');
  if (!t) return res.status(400).send(unsubscribePage('Link not recognised', 'This unsubscribe link is incomplete or has expired. Contact the chapter and we will remove you by hand.'));
  await db.query('UPDATE members SET email_opt_out = 1, email_opt_out_at = COALESCE(email_opt_out_at, UTC_TIMESTAMP()) WHERE id = ?', [t.member.id]);
  res.send(unsubscribePage('You are unsubscribed', 'You will not receive chapter news emails any more. You will still get messages about your own membership, such as receipts.'));
});

// ---------------------------------------------------------------- static files

const VENDOR_FILES = {
  'apexcharts.min.js': require.resolve('apexcharts/dist/apexcharts.min.js'),
  'inter-latin.woff2': require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'),
};
app.get('/admin/vendor/:file', (req, res, next) => {
  const file = VENDOR_FILES[req.params.file];
  if (!file) return next();
  res.set({ 'Cache-Control': 'public, max-age=604800', 'X-Robots-Tag': 'noindex, nofollow' });
  res.sendFile(file);
});
app.use('/admin', (req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }); next(); },
  express.static(ADMIN_DIR));
app.use('/shared', express.static(SHARED_DIR));

// Browsers ask for /favicon.ico on every page; answer with the DCP logo.
app.get('/favicon.ico', (req, res) => res.type('image/png').sendFile(path.join(SITE_DIR, 'assets', 'img', 'dcp-logo.png')));

// Friendly URLs for the header buttons; the .html files still work too.
const PAGE_ROUTES = { '/donate': 'donate.html', '/join': 'membership.html', '/member-portal': 'member-portal.html' };
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (req, res) => res.sendFile(path.join(SITE_DIR, file)));
}

app.use(express.static(SITE_DIR));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error(err);
  const dbDown = ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR'].includes(err.code);
  res.status(dbDown ? 503 : 500).json({ error: dbDown ? 'The database is not available. Please try again shortly.' : 'Something went wrong on the server.' });
});

(async () => {
  try {
    await db.init();
  } catch (err) {
    console.error(`Could not connect to MySQL/MariaDB at ${db.config.host}:${db.config.port} as "${db.config.user}".`);
    console.error('Start MySQL in the XAMPP Control Panel (or check DB_* in server/.env), then run npm start again.');
    console.error(`(${err.code || err.message})`);
    process.exit(1);
  }
  try {
    await migrations.prepare();
  } catch (err) {
    console.error(err instanceof migrations.MigrationStop ? `
NOT STARTING: ${err.message}
` : err);
    process.exit(1);
  }
  const seeded = await auth.ensureConfiguredAdmin();
  email.startQueue();
  const mailProblems = mailer.problems();
  const weakAdmins = await auth.adminsWithExamplePassword();
  app.listen(PORT, HOST, () => {
    const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`Database:      ${db.config.database} on ${db.config.host}:${db.config.port} (manage it in phpMyAdmin)`);
    console.log(`DCP UK site:   ${base}/`);
    console.log(`Admin area:    ${base}/admin/`);
    const where = IN_PRODUCTION ? 'the host\'s environment variables' : 'server/.env';
    if (seeded) console.log(`Admin login:   ${seeded} (password set in ${where})`);
    else console.log(`No ADMIN_EMAIL / ADMIN_PASSWORD in ${where}: add them, or run npm run admin:reset -- --email <email>.`);
    for (const name of weakAdmins) {
      console.warn(`WARNING: admin "${name}" still uses the example password from .env.example. Change it now: npm run admin:reset -- --email ${name}`);
    }
    if (IN_PRODUCTION && !db.config.password) console.warn('WARNING: the database user has no password. Set one before going live.');
    const mc = mailer.config();
    console.log(`Email:         ${mc.transport}${mc.transport === 'log' ? ' (stored only, nothing is delivered)' : ''}, from ${mc.from.email}`);
    if (mailProblems.length) {
      const bar = '!'.repeat(78);
      console.warn(`\n${bar}\n EMAIL IS NOT PROPERLY CONFIGURED\n${mailProblems.map((p) => ` - ${p}`).join('\n')}\n${bar}\n`);
    }
  });
})();
