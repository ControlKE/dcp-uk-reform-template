// DCP UK backend: serves the dcp-preview site, takes member registrations and
// donation pledges, and runs the admin area at /admin. Data lives in MySQL/MariaDB.
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const db = require('./lib/db'); // loads server/.env
const auth = require('./lib/auth');
const settings = require('./lib/settings');
const { validateMember, validateDonation } = require('./lib/validate');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const SITE_DIR = path.join(__dirname, '..', 'dcp-preview');
const SHARED_DIR = path.join(__dirname, '..', 'shared');
const ADMIN_DIR = path.join(__dirname, 'admin');

const app = express();
app.disable('x-powered-by');
// Set TRUST_PROXY=1 when running behind a reverse proxy (e.g. on a host with HTTPS in front).
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'self'",
  });
  next();
});

app.use(express.json({ limit: '20kb' }));

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
      id_document_type, id_document_number, language, occupation, interest, chapter,
      address_line1, address_line2, town, county, postcode, fee_amount_kes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
  `, [reference, auth.sha256(accessToken), m.fullName, m.phone, m.email, m.dateOfBirth,
    m.idDocumentType, m.idDocumentNumber, m.language, orNull(m.occupation), orNull(m.interest), orNull(m.chapter),
    m.addressLine1, orNull(m.addressLine2), m.town, orNull(m.county), m.postcode, feeAccount.feeAmountKes]);

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

adminApi.get('/admins', async (req, res) => {
  res.json({ admins: await db.query('SELECT id, username, created_at FROM admins ORDER BY username') });
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

// ---------------------------------------------------------------- admin: members

const MEMBER_STATUSES = ['pending', 'approved', 'rejected'];
const PAYMENT_STATUSES = ['pending_payment', 'payment_reported', 'paid'];

const MEMBER_COLUMNS = `
  m.id, m.reference, m.full_name, m.phone, m.email, m.date_of_birth, m.id_document_type,
  m.id_document_number, m.language, m.occupation, m.interest, m.chapter, m.address_line1,
  m.address_line2, m.town, m.county, m.postcode, m.fee_amount_kes, m.payment_status, m.payment_note, m.status,
  m.admin_notes, m.created_at, m.updated_at,
  (SELECT COUNT(*) FROM members d WHERE d.id <> m.id AND (d.id_document_number = m.id_document_number OR d.email = m.email)) AS possible_duplicates`;

async function memberQuery(q) {
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
  const sql = `SELECT ${MEMBER_COLUMNS} FROM members m ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC, m.id DESC`;
  return db.query(sql, params);
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
  });
});

adminApi.get('/members', async (req, res) => res.json({ members: await memberQuery(req.query) }));

adminApi.get('/members.csv', async (req, res) => {
  sendCsv(res, `dcp-uk-members-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['reference', 'Reference'], ['created_at', 'Registered (UTC)'], ['status', 'Status'], ['payment_status', 'Payment'],
    ['full_name', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['date_of_birth', 'Date of birth'],
    ['id_document_type', 'ID document'], ['id_document_number', 'Document number'], ['language', 'Language'],
    ['occupation', 'Occupation'], ['interest', 'Interest'], ['chapter', 'Chapter'],
    ['address_line1', 'Address 1'], ['address_line2', 'Address 2'], ['town', 'Town'], ['county', 'County'], ['postcode', 'Postcode'],
    ['fee_amount_kes', 'Fee (KES)'], ['payment_note', 'Payment code given'], ['admin_notes', 'Admin notes'],
  ], await memberQuery(req.query));
});

adminApi.get('/members/:id', async (req, res) => {
  const member = await getMember(req.params.id);
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  res.json({ member });
});

adminApi.patch('/members/:id', async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const params = [];
  if (b.status !== undefined) {
    if (!MEMBER_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    updates.push('status = ?'); params.push(b.status);
  }
  if (b.paymentStatus !== undefined) {
    if (!PAYMENT_STATUSES.includes(b.paymentStatus)) return res.status(400).json({ error: 'Unknown payment status.' });
    updates.push('payment_status = ?'); params.push(b.paymentStatus);
  }
  if (b.adminNotes !== undefined) { updates.push('admin_notes = ?'); params.push(String(b.adminNotes).slice(0, 2000) || null); }
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

async function donationQuery(q) {
  const where = [];
  const params = [];
  if (DONATION_STATUSES.includes(q.status)) { where.push('status = ?'); params.push(q.status); }
  if (q.q) {
    const like = likeParam(q.q);
    where.push('(full_name LIKE ? OR email LIKE ? OR reference LIKE ?)');
    params.push(like, like, like);
  }
  return db.query(`SELECT * FROM donations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`, params);
}

adminApi.get('/donations', async (req, res) => res.json({ donations: await donationQuery(req.query) }));

adminApi.get('/donations.csv', async (req, res) => {
  sendCsv(res, `dcp-uk-donations-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['reference', 'Reference'], ['created_at', 'Pledged (UTC)'], ['status', 'Status'], ['amount_gbp', 'Amount (GBP)'],
    ['frequency', 'Frequency'], ['full_name', 'Name'], ['email', 'Email'], ['message', 'Message'], ['admin_notes', 'Admin notes'],
  ], await donationQuery(req.query));
});

adminApi.patch('/donations/:id', async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const params = [];
  if (b.status !== undefined) {
    if (!DONATION_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    updates.push('status = ?'); params.push(b.status);
  }
  if (b.adminNotes !== undefined) { updates.push('admin_notes = ?'); params.push(String(b.adminNotes).slice(0, 2000) || null); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });
  const result = await db.query(`UPDATE donations SET ${updates.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...params, Number(req.params.id) || 0]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Donation not found.' });
  res.json({ donation: await db.one('SELECT * FROM donations WHERE id = ?', [Number(req.params.id) || 0]) });
});

app.use('/api/admin', adminApi);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------- static files

app.use('/admin', (req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }); next(); },
  express.static(ADMIN_DIR));
app.use('/shared', express.static(SHARED_DIR));
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
  const seeded = await auth.ensureConfiguredAdmin();
  app.listen(PORT, HOST, () => {
    const base = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`Database:      ${db.config.database} on ${db.config.host}:${db.config.port} (manage it in phpMyAdmin)`);
    console.log(`DCP UK site:   ${base}/`);
    console.log(`Admin area:    ${base}/admin/`);
    if (seeded) console.log(`Admin login:   ${seeded} (password set in server/.env)`);
    else console.log('No ADMIN_EMAIL / ADMIN_PASSWORD in server/.env: add them, or run npm run create-admin -- <email>.');
  });
})();
