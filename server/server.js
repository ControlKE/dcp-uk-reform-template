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
const audit = require('./lib/audit');
const finance = require('./lib/finance');
const { ROLES, permissions, need, can } = require('./lib/roles');
const { sendCsv } = require('./lib/export');
const financeRoutes = require('./routes/finance');
const sitePages = require('./lib/site-pages');
const storage = require('./lib/storage');
const demo = require('./lib/demo');
const maintenance = require('./lib/maintenance');
const jobs = require('./lib/jobs');
const backup = require('./lib/backup');

// Feature flags: switched off until the feature is built and configured.
const FEATURES = {
  inboundEmail: process.env.FEATURE_INBOUND_EMAIL === 'true',
  // Online payments: only webhook stubs exist; no live payments are taken.
  stripe: process.env.FEATURE_STRIPE === 'true',
  mpesaStk: process.env.FEATURE_MPESA_STK === 'true',
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

// Maintenance mode (lib/maintenance.js): "back shortly" everywhere except the admin sign-in and Database page.
app.use(maintenance.middleware);

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

const likeParam = (q) => `%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`;
const orNull = (v) => (v === undefined || v === '' ? null : v);

// ---------------------------------------------------------------- public API

// Used by hosting platforms' health checks.
app.get('/api/health', async (req, res) => {
  try {
    await db.one('SELECT 1 AS ok');
    // Stays 200 in maintenance mode so the host keeps this version running while an admin applies migrations.
    res.json({ ok: true, database: 'up', ...(maintenance.on() ? { maintenance: true } : {}) });
  } catch (err) {
    res.status(503).json({ ok: false, database: 'down' });
  }
});

app.get('/api/payment-details', async (req, res) => {
  const [feeAccount, donationAccount, tiers] = await Promise.all([settings.publicFeeAccount(), settings.publicDonationAccount(), finance.publicTiers()]);
  res.json({ feeAccount, donationAccount, tiers, tierSummary: finance.tierSentence(tiers.filter((t) => t.kind === 'membership')) });
});

app.post('/api/members', submissionLimit, async (req, res) => {
  const { value: m, errors } = validateMember(req.body);
  const tier = await db.one("SELECT id, tkey, name FROM membership_tiers WHERE tkey = ? AND kind = 'membership' AND active = 1", [m.tier]);
  if (!tier) errors.tier = 'Choose a membership tier.';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });

  const awaiting = finance.tierNeedsApproval(tier.tkey);
  const feeAccount = await settings.publicFeeAccount(tier.tkey);
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
  // Members join on the tier they chose, with fees counted from today. A tier that
  // needs confirming (Stakeholder) has nothing due until an admin confirms it.
  await db.query(`UPDATE members SET data_consent_at = UTC_TIMESTAMP(), marketing_consent_at = ${m.marketingConsent ? 'UTC_TIMESTAMP()' : 'NULL'},
      tier_id = ?, tier_status = ?, billing_start = UTC_DATE() WHERE id = ?`, [tier.id, awaiting ? 'awaiting' : 'confirmed', created.id]);
  await email.receive({
    source: 'application', fromName: m.fullName, fromEmail: m.email, memberId: created.id, labels: ['Membership'],
    subject: `New membership application: ${m.fullName}`,
    text: [`${m.fullName} applied to join DCP UK.`, '', `Reference: ${reference}`, `Tier: ${tier.name}${awaiting ? ' (awaiting approval: confirm it in the member record before the fee is due)' : ''}`,
      `Email: ${m.email}`, `Phone: ${m.phone}`,
      `Chapter: ${m.chapter || 'not chosen'}${m.chapterOther ? ` (${m.chapterOther})` : ''}`, `Town: ${m.town}`, '',
      'Review it under Members. Replying to this message emails the applicant.'].join('\n'),
  }).catch((err) => console.error('Could not add the application to the inbox:', err.message));

  res.status(201).json({ reference, accessToken, feeAccount, tierAwaiting: awaiting });
});

// The applicant tells us they've paid. Only the browser that registered holds the token.
app.post('/api/members/:reference/payment-reported', async (req, res) => {
  const token = String(req.body?.accessToken || '');
  const row = await db.one(`SELECT m.id, m.reference, m.access_token_hash, m.payment_status, m.fee_amount, m.fee_currency, t.tx_type
    FROM members m LEFT JOIN membership_tiers t ON t.id = m.tier_id WHERE m.reference = ?`, [req.params.reference]);
  if (!row || !token || !crypto.timingSafeEqual(Buffer.from(auth.sha256(token)), Buffer.from(row.access_token_hash))) {
    return res.status(404).json({ error: 'Registration not found.' });
  }
  const note = String(req.body?.paymentNote || '').trim().slice(0, 100) || null;
  if (row.payment_status === 'pending_payment') {
    await db.query("UPDATE members SET payment_status = 'payment_reported', payment_note = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [note, row.id]);
    // A pending transaction for the treasurer to check against the account and verify.
    const { value: fee } = await settings.getSetting('feeAccount');
    try {
      await finance.recordTransaction({
        type: row.tx_type || 'membership_fee', amount: row.fee_amount, currency: row.fee_currency, fxRate: row.fee_currency === 'GBP' ? 1 : '',
        method: { mpesa_paybill: 'mpesa_paybill', mpesa_till: 'mpesa_till', bank: 'bank_transfer' }[fee.method] || 'bank_transfer',
        account: 'fee_account', memberId: row.id, dateReceived: new Date().toISOString().slice(0, 10), externalRef: note,
        notes: 'Reported by the member on the website after registering.',
      }, { actor: row.reference, actorType: 'member', ip: req.ip }, { source: 'member_report' });
    } catch (err) {
      console.error(`Could not record the reported payment for ${row.reference}:`, err.message);
    }
  }
  res.json({ ok: true });
});

app.post('/api/donations', submissionLimit, async (req, res) => {
  const donationAccount = await settings.publicDonationAccount();
  if (!donationAccount.configured) {
    return res.status(503).json({ error: 'Donations are not open yet: the chapter has not set up its bank account.' });
  }
  const visit = await db.one("SELECT amount FROM membership_tiers WHERE tkey = 'visit' AND active = 1");
  const { value: d, errors } = validateDonation(req.body, { visitAmount: visit ? Number(visit.amount) : null });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });

  // A member's reference links the contribution only when the email matches that member
  // too. The reply is the same either way, so the form can't be used to test references.
  const member = d.memberReference
    ? await db.one('SELECT id FROM members WHERE reference = ? AND email = ?', [d.memberReference, d.email]) : null;
  const reference = await newReference('DON', 'donations');
  await db.query(`INSERT INTO donations (reference, kind, member_id, member_reference, full_name, email, amount_gbp, frequency, message, donor_kenyan, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
  [reference, d.kind, member?.id ?? null, orNull(d.memberReference), d.fullName, d.email, d.amountGbp, d.frequency, orNull(d.message), d.donorKenyan]);
  res.status(201).json({ reference, kind: d.kind, amountGbp: d.amountGbp, frequency: d.frequency, donationAccount });
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

// Online payments (Stripe, M-Pesa Daraja STK push) are designed for but not built:
// the flags are off by default and, even when on, these stubs take no money.
for (const [route, flag] of [['/api/webhooks/stripe', 'stripe'], ['/api/webhooks/mpesa', 'mpesaStk']]) {
  app.post(route, (req, res) => {
    if (!FEATURES[flag]) return res.status(404).json({ error: 'Not found.' });
    res.status(501).json({ error: 'Online payments are not implemented yet.' });
  });
}

// Member replies by email arrive later, behind FEATURE_INBOUND_EMAIL.
app.post('/api/inbound-email', (req, res) => {
  if (!FEATURES.inboundEmail) return res.status(404).json({ error: 'Not found.' });
  res.status(501).json({ error: 'Inbound email is not implemented yet.' });
});

// ---------------------------------------------------------------- admin auth

const adminApi = express.Router();
adminApi.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const withPerms = (a) => (a ? { ...a, roleLabel: ROLES[a.role]?.label || a.role, perms: permissions(a.role) } : null);

adminApi.get('/session', async (req, res) => {
  res.json({ admin: withPerms(await auth.getSessionAdmin(req)), demo: demo.DEMO, maintenance: maintenance.info() });
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
  res.json({ admin: withPerms({ id: admin.id, username: admin.username, role: admin.role || 'super_admin', created_at: admin.created_at }), demo: demo.DEMO, maintenance: maintenance.info() });
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
  await audit.record(null, { ...audit.fromReq(req), action: 'admin.password_changed', entity: 'admin', entityId: req.admin.id, summary: 'Changed own password' });
  res.set('Set-Cookie', auth.sessionCookie(await auth.createSession(req.admin.id), req, auth.SESSION_TTL_MS));
  res.json({ ok: true });
});

adminApi.post('/admins', need('admins.manage'), async (req, res) => {
  const role = req.body?.role || 'membership_secretary';
  if (!ROLES[role]) return res.status(400).json({ error: 'Choose a role.' });
  try {
    await auth.createAdmin(req.body?.username, req.body?.password, role);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  await audit.record(null, { ...audit.fromReq(req), action: 'admin.created', entity: 'admin', entityId: String(req.body.username).toLowerCase(),
    summary: `Added admin ${String(req.body.username).toLowerCase()} as ${ROLES[role].label}`, after: { username: String(req.body.username).toLowerCase(), role } });
  res.status(201).json({ ok: true });
});

// Changing another admin's role. The last super admin cannot be demoted.
adminApi.patch('/admins/:id', need('admins.manage'), async (req, res) => {
  const role = req.body?.role;
  if (!ROLES[role]) return res.status(400).json({ error: 'Choose a role.' });
  const target = await db.one('SELECT id, username, role FROM admins WHERE id = ?', [Number(req.params.id) || 0]);
  if (!target) return res.status(404).json({ error: 'Admin not found.' });
  if (target.role === 'super_admin' && role !== 'super_admin') {
    const supers = Number((await db.one("SELECT COUNT(*) AS n FROM admins WHERE role = 'super_admin'")).n);
    if (supers <= 1) return res.status(400).json({ error: 'There must always be at least one super admin.' });
  }
  await db.query('UPDATE admins SET role = ? WHERE id = ?', [role, target.id]);
  await audit.record(null, { ...audit.fromReq(req), action: 'admin.role_changed', entity: 'admin', entityId: target.id,
    summary: `${target.username}: ${ROLES[target.role]?.label} → ${ROLES[role].label}`, before: { role: target.role }, after: { role } });
  res.json({ ok: true });
});

const ADMIN_SORTS = { username: 'username', created: 'created_at' };
adminApi.get('/admins', need('admins.manage'), async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) { where.push('username LIKE ?'); params.push(likeParam(req.query.q)); }
  const { rows, ...page } = await paged(db, {
    select: 'id, username, role, created_at', from: 'admins', where, params,
    p: pageParams(req.query, ADMIN_SORTS, 'username', 'asc'), tiebreak: 'id',
  });
  res.json({ admins: rows, ...page });
});

// ---------------------------------------------------------------- admin: payment accounts

adminApi.get('/settings', need('dashboard'), async (req, res) => {
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
    const before = (await settings.getSetting(key)).value;
    await settings.saveSetting(key, value, req.admin.username);
    await audit.record(null, { ...audit.fromReq(req), action: 'settings.payment_account', entity: 'settings', entityId: key,
      summary: `${key === 'feeAccount' ? 'Membership fee' : 'Donations'} account changed`, ...audit.diff(before, value) });
    res.json(await settings.getSetting(key));
  };
}
adminApi.put('/settings/fee-account', need('finance.settings'), saveAccount('feeAccount', settings.validateFeeAccount));
adminApi.put('/settings/donation-account', need('finance.settings'), saveAccount('donationAccount', settings.validateDonationAccount));

// ---------------------------------------------------------------- admin: email app

adminApi.get('/mail-status', need('dashboard'), (req, res) => {
  const c = mailer.config();
  res.json({ transport: c.transport, production: IN_PRODUCTION, from: c.from, replyTo: c.replyTo, ratePerMinute: c.ratePerMinute, dailyLimit: c.dailyLimit, problems: mailer.problems(), inbound: FEATURES.inboundEmail });
});

adminApi.get('/email-templates', need('email'), (req, res) => res.json({ templates: templates.TEMPLATES }));
adminApi.get('/email-labels', need('email'), async (req, res) => res.json({ labels: await db.query('SELECT id, name, color FROM email_labels ORDER BY id') }));

// Member search for the compose "To" field, with what each person can receive.
adminApi.get('/members/lookup', need('email'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ members: [] });
  const like = likeParam(q);
  res.json({ members: await db.query(`SELECT id, full_name, email, chapter, marketing_consent_at IS NOT NULL AS consent, email_opt_out AS opted_out
    FROM members WHERE full_name LIKE ? OR email LIKE ? OR reference LIKE ? ORDER BY full_name LIMIT 8`, [like, like, like]) });
});

const EMAIL_SORTS = { date: 'e.created_at', subject: 'e.subject', from: 'e.from_email' };
adminApi.get('/emails', need('email'), async (req, res) => {
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

adminApi.get('/emails/:id', need('email'), async (req, res) => {
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
adminApi.post('/emails/bulk', need('email'), async (req, res) => {
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
adminApi.post('/emails/audience', need('email'), async (req, res) => {
  const a = await email.resolveAudience(req.body || {});
  res.json({
    category: a.category, recipients: a.recipients.filter((r) => r.kind === 'to').length, excluded: a.excluded, excludedTotal: a.excludedTotal,
    duplicate: a.duplicate, summary: a.summary, errors: a.errors, bulkBlocked: a.category === 'bulk' && !mailer.unsubscribeUrl(1, 'x@example.org'),
  });
});

adminApi.post('/emails', need('email'), async (req, res) => {
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
adminApi.post('/email-attachments', need('email'), express.raw({ type: () => true, limit: email.MAX_ATTACHMENT }), async (req, res) => {
  let name = '';
  try { name = decodeURIComponent(String(req.get('x-filename') || '')); } catch { /* malformed name */ }
  name = name.replace(/[\\/\r\n"]/g, '_').trim().slice(0, 200);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('content-type') || '') ? req.get('content-type') : 'application/octet-stream';
  if (!name) return res.status(400).json({ error: 'The file needs a name.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
  // The bytes go to the storage adapter (STORAGE_DRIVER); the row points at them.
  const fileId = await storage.put({ buffer: req.body, filename: name, contentType: type, purpose: 'email_attachment', by: req.admin.username });
  const r = await db.query('INSERT INTO email_attachments (filename, content_type, size, file_id, uploaded_by) VALUES (?, ?, ?, ?, ?)', [name, type, req.body.length, fileId, req.admin.username]);
  res.status(201).json({ id: r.insertId, filename: name, size: req.body.length, contentType: type });
});
adminApi.delete('/email-attachments/:id', need('email'), async (req, res) => {
  const a = await db.one("SELECT id, file_id FROM email_attachments WHERE id = ? AND (email_id IS NULL OR email_id IN (SELECT id FROM emails WHERE folder = 'draft'))", [Number(req.params.id) || 0]);
  if (a) {
    await db.query('DELETE FROM email_attachments WHERE id = ?', [a.id]);
    if (a.file_id) await storage.remove(a.file_id).catch((err) => console.error('Could not remove a stored file:', err.message));
  }
  res.json({ ok: true });
});
adminApi.get('/email-attachments/:id', need('email'), async (req, res) => {
  const a = await db.one('SELECT filename, content_type, file_id, data FROM email_attachments WHERE id = ?', [Number(req.params.id) || 0]);
  if (!a) return res.status(404).json({ error: 'Attachment not found.' });
  const bytes = a.file_id ? (await storage.get(a.file_id))?.buffer : a.data;
  if (!bytes) return res.status(404).json({ error: 'The attachment file is missing.' });
  // Always a download, never rendered in the admin's origin.
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`, 'Cache-Control': 'no-store' });
  res.send(bytes);
});

// ---------------------------------------------------------------- admin: dashboard, search, notifications

const isoDay = (d) => d.toISOString().slice(0, 10);

adminApi.get('/dashboard', need('dashboard'), async (req, res) => {
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
    money: await dashboardMoney(),
    verifierWarning: await verifierWarning(),
    // Off-site backups: Super admins only. Not shown on the demo site unless set up.
    backup: can(req.admin, 'system') && (!demo.DEMO || backup.configured()) ? { ...(await backup.status()), production: IN_PRODUCTION } : null,
  });
});

// The four-eyes check needs a second admin who can verify payments. With only one,
// pending payments can never be verified, so the dashboard says so.
async function verifierWarning() {
  const { requireSecondVerifier } = await finance.getFinanceSettings();
  if (!requireSecondVerifier) return null;
  const roles = Object.keys(ROLES).filter((r) => can({ role: r }, 'finance.write'));
  const verifiers = Number((await db.one(`SELECT COUNT(*) AS n FROM admins WHERE role IN (${roles.map(() => '?').join(', ')})`, roles)).n);
  return verifiers < 2 ? { verifiers } : null;
}

// Income for the dashboard: verified and reconciled money in, in GBP as recorded.
async function dashboardMoney() {
  const INCOME = "x.status IN ('verified', 'reconciled') AND x.type NOT IN ('refund', 'expense')";
  const sumBy = async (sql, params = []) => Object.fromEntries((await db.query(sql, params)).map((r) => [r.k, Number(r.gbp)]));
  const today = isoDay(new Date());
  const byDay = await sumBy(`SELECT DATE_FORMAT(x.date_received, '%Y-%m-%d') AS k, SUM(x.amount_gbp) AS gbp FROM transactions x
    WHERE ${INCOME} AND x.date_received >= DATE_FORMAT(UTC_DATE() - INTERVAL 1 MONTH, '%Y-%m-01') GROUP BY k`);
  const days = (n) => Array.from({ length: n }, (_, i) => isoDay(new Date(Date.now() - (n - 1 - i) * 86400000)));
  const last14 = days(14).map((d) => ({ date: d, gbp: byDay[d] || 0 }));
  const monthStart = `${today.slice(0, 8)}01`;
  const monthDays = days(Number(today.slice(8, 10))).map((d) => ({ date: d, gbp: byDay[d] || 0 }));
  const prevMonth = new Date(`${monthStart}T00:00:00Z`); prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
  const prevKey = prevMonth.toISOString().slice(0, 7);
  const prevMonthToDate = Object.entries(byDay).filter(([d]) => d.startsWith(prevKey) && Number(d.slice(8)) <= Number(today.slice(8, 10))).reduce((s, [, v]) => s + v, 0);
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(`${monthStart}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (11 - i)); return d.toISOString().slice(0, 7); });
  const byTypeMonth = await db.query(`SELECT x.type, DATE_FORMAT(x.date_received, '%Y-%m') AS k, SUM(x.amount_gbp) AS gbp FROM transactions x
    WHERE ${INCOME} AND x.date_received >= ? GROUP BY x.type, k`, [`${months[0]}-01`]);
  const earnings = {};
  for (const type of ['membership_fee', 'stakeholder_membership', 'visit_contribution', 'donation']) {
    earnings[type] = months.map((mo) => ({ month: mo, gbp: Number(byTypeMonth.find((r) => r.type === type && r.k === mo)?.gbp || 0) }));
  }
  const sum = (arr) => arr.reduce((s, x) => s + x.gbp, 0);
  return {
    week: last14.slice(7), weekTotal: sum(last14.slice(7)), lastWeekTotal: sum(last14.slice(0, 7)),
    month: monthDays, monthTotal: sum(monthDays), prevMonthToDate,
    earnings, months,
    tiers: (await db.query(`SELECT t.name, COUNT(m.id) AS n FROM membership_tiers t
      LEFT JOIN members m ON m.tier_id = t.id AND m.status <> 'rejected' GROUP BY t.id ORDER BY t.sort`)).map((r) => ({ name: r.name, n: Number(r.n) })),
    recent: await db.query(`SELECT id, receipt_no, type, amount, currency, amount_gbp, payer_name, status, date_received, self_verified
      FROM transactions ORDER BY recorded_at DESC, id DESC LIMIT 6`),
    toVerify: Number((await db.one("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'")).n),
  };
}

// Top-bar search across members, donations and admins (5 of each).
adminApi.get('/search', need('dashboard'), async (req, res) => {
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
adminApi.get('/notifications', need('dashboard'), async (req, res) => {
  const n = async (sql) => Number((await db.one(sql)).n);
  res.json({
    pending: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'pending'"),
    paymentsToCheck: await n("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'"),
    feeReviews: await n('SELECT COUNT(*) AS n FROM members WHERE fee_review = 1'),
    tierApprovals: await n("SELECT COUNT(*) AS n FROM members WHERE tier_status = 'awaiting' AND status <> 'rejected'"),
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
  m.admin_notes, m.created_at, m.updated_at, m.tier_id, m.fee_review, m.fee_review_reason, m.membership_start,
  m.marketing_consent_at, m.email_opt_out, m.tier_status,
  (SELECT name FROM membership_tiers WHERE id = m.tier_id) AS tier_name,
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
  if (Number(q.tier)) { where.push('m.tier_id = ?'); params.push(Number(q.tier)); }
  if (q.review === '1') where.push('m.fee_review = 1');
  if (q.review === 'tier') where.push("m.tier_status = 'awaiting'");
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

adminApi.get('/stats', need('dashboard'), async (req, res) => {
  const n = async (sql) => Number((await db.one(sql)).n);
  res.json({
    members: await n('SELECT COUNT(*) AS n FROM members'),
    membersPending: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'pending'"),
    membersApproved: await n("SELECT COUNT(*) AS n FROM members WHERE status = 'approved'"),
    paymentsToCheck: await n("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending'"),
    donationsPledged: await n("SELECT COUNT(*) AS n FROM donations WHERE status = 'pledged'"),
    donationsReceivedGbp: await n("SELECT COALESCE(SUM(amount_gbp), 0) AS n FROM donations WHERE status = 'received'"),
    emailsUnread: await n("SELECT COUNT(*) AS n FROM emails WHERE folder = 'inbox' AND is_read = 0"),
  });
});

adminApi.get('/members', need('members.read'), async (req, res) => {
  const { where, params } = memberFilters(req.query);
  const { rows, ...page } = await paged(db, {
    select: MEMBER_COLUMNS, from: 'members m', where, params,
    p: pageParams(req.query, MEMBER_SORTS, 'registered'), tiebreak: 'm.id DESC',
  });
  res.json({ members: rows, ...page });
});

adminApi.get('/members.csv', need('members.read'), async (req, res) => {
  sendCsv(res, `dcp-uk-members-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['reference', 'Reference'], ['created_at', 'Registered (UTC)'], ['status', 'Status'], ['payment_status', 'Payment'],
    ['full_name', 'Full name'], ['email', 'Email'], ['phone', 'Phone'], ['date_of_birth', 'Date of birth'],
    ['id_document_type', 'ID document'], ['id_document_number', 'Document number'], ['language', 'Language'],
    ['occupation', 'Occupation'], ['interest', 'Interest'], ['interest_other', 'Interest (other)'],
    ['chapter', 'Chapter'], ['chapter_other', 'Nearest town/city'],
    ['address_line1', 'Address 1'], ['address_line2', 'Address 2'], ['town', 'Town'], ['county', 'County'], ['postcode', 'Postcode'],
    ['tier_name', 'Tier'], ['tier_status', 'Tier status'], ['fee_amount', 'Registration fee quoted'], ['fee_currency', 'Fee currency'], ['fee_review', 'Fee needs review'],
    ['payment_note', 'Payment code given'], ['admin_notes', 'Admin notes'],
  ], await memberQuery(req.query));
});

adminApi.get('/members/:id', need('members.read'), async (req, res) => {
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

adminApi.patch('/members/:id', need('members.write'), async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const params = [];
  const id = Number(req.params.id) || 0;
  const current = await db.one('SELECT reference, status, admin_notes, payment_status, tier_id, tier_status, fee_review FROM members WHERE id = ?', [id]);
  if (!current) return res.status(404).json({ error: 'Member not found.' });
  let notes = b.adminNotes !== undefined ? String(b.adminNotes).slice(0, 2000) : undefined;
  let reason = null;
  if (b.status !== undefined) {
    if (!MEMBER_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    if (b.status === 'rejected' && current.status !== 'rejected') {
      reason = cleanReason(b.reason);
      if (!reason) return res.status(400).json({ error: 'Give a reason for rejecting this application.' });
      notes = [notes ?? current.admin_notes, reasonNote('Rejected', req.admin.username, reason)].filter(Boolean).join('\n');
    }
    updates.push('status = ?'); params.push(b.status);
  }
  if (b.paymentStatus !== undefined && b.paymentStatus !== current.payment_status) {
    // "Paid (confirmed)" is never set by hand: it comes from verified transactions.
    if (b.paymentStatus === 'paid') return res.status(400).json({ error: 'Paid (confirmed) is set automatically when a payment is verified. Use Record payment.' });
    if (current.payment_status === 'paid') return res.status(400).json({ error: 'This member is paid according to verified transactions. Void the transaction to change it.' });
    if (!PAYMENT_STATUSES.includes(b.paymentStatus)) return res.status(400).json({ error: 'Unknown payment status.' });
    updates.push('payment_status = ?'); params.push(b.paymentStatus);
  }
  let tierChanged = false;
  let tierNote = null;
  if (b.tierDecision !== undefined) {
    // A tier awaiting approval: confirm it, or move the member to Ordinary (reason required).
    if (current.tier_status !== 'awaiting') return res.status(400).json({ error: 'This member\'s tier is not awaiting approval.' });
    if (b.tierDecision === 'confirm') {
      updates.push("tier_status = 'confirmed'");
      tierNote = reasonNote('Tier confirmed', req.admin.username, cleanReason(b.reason) || 'approved');
    } else if (b.tierDecision === 'ordinary') {
      const reasonText = cleanReason(b.reason);
      if (!reasonText) return res.status(400).json({ error: 'Give a reason for moving this member to Ordinary.' });
      updates.push("tier_id = (SELECT id FROM membership_tiers WHERE tkey = 'ordinary')", "tier_status = 'confirmed'");
      tierNote = reasonNote('Moved to Ordinary', req.admin.username, reasonText);
    } else return res.status(400).json({ error: 'Unknown tier decision.' });
    tierChanged = true;
  } else if (b.tierId !== undefined && Number(b.tierId) !== current.tier_id) {
    const tier = await db.one("SELECT id, active FROM membership_tiers WHERE id = ? AND kind = 'membership'", [Number(b.tierId) || 0]);
    if (!tier || !tier.active) return res.status(400).json({ error: 'Choose an active membership tier.' });
    // An admin choosing the tier is itself the confirmation.
    updates.push('tier_id = ?', "tier_status = 'confirmed'"); params.push(tier.id);
    tierChanged = true;
  }
  if (tierNote) notes = [notes ?? current.admin_notes, tierNote].filter(Boolean).join('\n');
  if (b.feeReviewResolved === true && current.fee_review) {
    if (!can(req.admin, 'finance.write')) return res.status(403).json({ error: 'Only the treasurer can clear a fee review.' });
    updates.push('fee_review = 0');
    notes = [notes ?? current.admin_notes, reasonNote('Fee review cleared', req.admin.username, cleanReason(b.feeReviewNote) || 'checked')].filter(Boolean).join('\n');
  }
  if (notes !== undefined) { updates.push('admin_notes = ?'); params.push(notes.slice(-4000) || null); }
  if (!updates.length) return res.json({ member: await getMember(id) });
  const before = await db.one('SELECT status, payment_status, tier_id, tier_status, fee_review, admin_notes FROM members WHERE id = ?', [id]);
  await db.transaction(async (q) => {
    await q.query(`UPDATE members SET ${updates.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...params, id]);
    const after = await q.one('SELECT status, payment_status, tier_id, tier_status, fee_review, admin_notes FROM members WHERE id = ?', [id]);
    const d = audit.diff(before, after);
    const changed = Object.keys(d.after);
    const action = reason ? 'member.rejected' : b.tierDecision === 'confirm' ? 'member.tier_confirmed' : b.tierDecision === 'ordinary' ? 'member.tier_declined' : 'member.updated';
    await audit.record(q, { ...audit.fromReq(req), action, entity: 'member', entityId: id,
      summary: reason ? `Rejected ${current.reference}: ${reason}` : `${current.reference}: ${changed.map((k) => (k === 'admin_notes' ? 'notes' : k)).join(', ')}`, ...d });
    if (tierChanged) await finance.syncMember(q, id, audit.fromReq(req));
  });
  res.json({ member: await getMember(id) });
});

// Permanent deletion, e.g. for a data-erasure request.
// Payments already on the ledger stay (financial records), under the payer name they were recorded with.
adminApi.delete('/members/:id', need('members.write'), async (req, res) => {
  const id = Number(req.params.id) || 0;
  const m = await db.one('SELECT reference FROM members WHERE id = ?', [id]);
  if (!m) return res.status(404).json({ error: 'Member not found.' });
  await db.transaction(async (q) => {
    await q.query('DELETE FROM members WHERE id = ?', [id]);
    await audit.record(q, { ...audit.fromReq(req), action: 'member.deleted', entity: 'member', entityId: id, summary: `Deleted member ${m.reference} permanently` });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin: donations

const DONATION_STATUSES = ['pledged', 'received', 'cancelled'];

const DONATION_SORTS = { reference: 'reference', donor: 'full_name', amount: 'amount_gbp', pledged: 'created_at', status: 'status' };

function donationFilters(q) {
  const where = [];
  const params = [];
  if (DONATION_STATUSES.includes(q.status)) { where.push('status = ?'); params.push(q.status); }
  if (['donation', 'visit_contribution'].includes(q.kind)) { where.push('kind = ?'); params.push(q.kind); }
  if (q.kenyan === 'flagged') where.push("donor_kenyan <> 'yes'");
  if (['yes', 'no', 'unknown'].includes(q.kenyan)) { where.push('donor_kenyan = ?'); params.push(q.kenyan); }
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

adminApi.get('/donations', need('donations.read'), async (req, res) => {
  const { where, params } = donationFilters(req.query);
  const { rows, ...page } = await paged(db, {
    select: `*, (SELECT COALESCE(SUM(x.amount_gbp), 0) FROM transactions x WHERE x.donation_id = donations.id AND x.status IN ('verified', 'reconciled')) AS received_gbp,
      (SELECT reference FROM members WHERE id = donations.member_id) AS linked_member_reference`,
    from: 'donations', where, params,
    p: pageParams(req.query, DONATION_SORTS, 'pledged'), tiebreak: 'id DESC',
  });
  res.json({ donations: rows, ...page });
});

adminApi.get('/donations.csv', need('donations.read'), async (req, res) => {
  sendCsv(res, `dcp-uk-donations-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['reference', 'Reference'], ['kind', 'Type'], ['created_at', 'Pledged (UTC)'], ['status', 'Status'], ['amount_gbp', 'Amount (GBP)'],
    ['frequency', 'Frequency'], ['full_name', 'Name'], ['email', 'Email'], ['member_reference', 'Membership reference given'], ['donor_kenyan', 'Kenyan citizen (declared)'], ['message', 'Message'], ['admin_notes', 'Admin notes'],
  ], await donationQuery(req.query));
});

adminApi.get('/donations/:id', need('donations.read'), async (req, res) => {
  const donation = await db.one(`SELECT d.*, m.reference AS linked_member_reference, m.full_name AS linked_member_name
    FROM donations d LEFT JOIN members m ON m.id = d.member_id WHERE d.id = ?`, [Number(req.params.id) || 0]);
  if (!donation) return res.status(404).json({ error: 'Donation not found.' });
  const transactions = await db.query(`SELECT id, receipt_no, amount, currency, amount_gbp, status, date_received FROM transactions
    WHERE donation_id = ? ORDER BY date_received DESC, id DESC`, [donation.id]);
  res.json({ donation, transactions });
});

adminApi.patch('/donations/:id', need('donations.write'), async (req, res) => {
  const b = req.body || {};
  const updates = [];
  const params = [];
  const id = Number(req.params.id) || 0;
  const current = await db.one('SELECT reference, status, admin_notes, donor_kenyan FROM donations WHERE id = ?', [id]);
  if (!current) return res.status(404).json({ error: 'Donation not found.' });
  let notes = b.adminNotes !== undefined ? String(b.adminNotes).slice(0, 2000) : undefined;
  let reason = null;
  if (b.status !== undefined && b.status !== current.status) {
    if (!DONATION_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status.' });
    if (b.status === 'received') return res.status(400).json({ error: 'A pledge becomes Received when a verified payment is linked to it. Use Record payment.' });
    const linked = Number((await db.one("SELECT COUNT(*) AS n FROM transactions WHERE donation_id = ? AND status IN ('verified', 'reconciled')", [id])).n);
    if (linked) return res.status(400).json({ error: 'This pledge has a verified payment linked. Void that payment first.' });
    if (b.status === 'cancelled' && current.status !== 'cancelled') {
      reason = cleanReason(b.reason);
      if (!reason) return res.status(400).json({ error: 'Give a reason for cancelling this pledge.' });
      notes = [notes ?? current.admin_notes, reasonNote('Cancelled', req.admin.username, reason)].filter(Boolean).join('\n');
    }
    updates.push('status = ?'); params.push(b.status);
  }
  if (b.donorKenyan !== undefined && b.donorKenyan !== current.donor_kenyan) {
    if (!finance.DONOR_KENYAN.includes(b.donorKenyan)) return res.status(400).json({ error: 'Kenyan citizen must be yes, no or unknown.' });
    updates.push('donor_kenyan = ?'); params.push(b.donorKenyan);
  }
  if (notes !== undefined) { updates.push('admin_notes = ?'); params.push(notes.slice(-4000) || null); }
  if (!updates.length) return res.json({ donation: await db.one('SELECT * FROM donations WHERE id = ?', [id]) });
  const before = await db.one('SELECT status, donor_kenyan, admin_notes FROM donations WHERE id = ?', [id]);
  await db.transaction(async (q) => {
    await q.query(`UPDATE donations SET ${updates.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...params, id]);
    const after = await q.one('SELECT status, donor_kenyan, admin_notes FROM donations WHERE id = ?', [id]);
    const d = audit.diff(before, after);
    await audit.record(q, { ...audit.fromReq(req), action: reason ? 'donation.cancelled' : 'donation.updated', entity: 'donation', entityId: id,
      summary: reason ? `Cancelled ${current.reference}: ${reason}` : `${current.reference}: ${Object.keys(d.after).map((k) => (k === 'admin_notes' ? 'notes' : k)).join(', ')}`, ...d });
  });
  res.json({ donation: await db.one('SELECT * FROM donations WHERE id = ?', [id]) });
});

adminApi.use(financeRoutes);
// ---------------------------------------------------------------- admin: database (Super admin)

// The audit log arrives with migration 004: on an older database waiting for it,
// these entries are skipped rather than blocking the update itself.
const auditSafe = (entry) => audit.record(null, entry).catch((err) => { if (!jobs.noTable(err)) throw err; });

// Migrations, maintenance, backups and jobs, for Settings → Database.
async function databaseState() {
  const [list, backupStatus, recent, version] = await Promise.all([
    migrations.status(), backup.status(),
    db.query("SELECT job, status, started_at, finished_at, detail, bytes, trigger_by FROM job_runs WHERE job <> 'mail' ORDER BY id DESC LIMIT 10")
      .catch((err) => { if (jobs.noTable(err)) return []; throw err; }),
    db.one('SELECT VERSION() AS v'),
  ]);
  let check = { ok: true, message: null };
  try { await migrations.plan(); } catch (err) { check = { ok: false, message: err.message }; }
  return {
    maintenance: maintenance.info(), migrations: list, pending: list.filter((m) => !m.appliedAt).length, check,
    backup: backupStatus, jobs: { mode: jobs.MODE, backupHourUtc: jobs.BACKUP_HOUR, recent },
    storage: { driver: storage.driver(), problems: storage.problems() },
    server: { database: db.config.database, host: db.config.host, version: version.v, node: process.version, production: IN_PRODUCTION, demo: demo.DEMO },
  };
}
adminApi.get('/database', need('system'), async (req, res) => res.json(await databaseState()));

// Applies pending migrations after the admin confirms a backup exists.
adminApi.post('/database/migrate', need('system'), async (req, res) => {
  if (req.body?.backupConfirmed !== true) return res.status(400).json({ error: 'Confirm that you have taken a backup of the live database first.' });
  const conn = await db.raw().getConnection();
  try {
    const [[got]] = await conn.query("SELECT GET_LOCK('dcp_uk_migrate', 0) AS ok");
    if (!got?.ok) return res.status(409).json({ error: 'Another admin is applying migrations right now.' });
    let pending;
    try { ({ pending } = await migrations.plan()); } catch (err) { return res.status(409).json({ error: err.message }); }
    if (!pending.length) return res.json({ applied: [], ...(await databaseState()) });
    const log = [];
    try {
      await migrations.apply(pending, (line) => log.push(line));
    } catch (err) {
      await auditSafe({ ...audit.fromReq(req), action: 'database.migrate_failed', entity: 'database', entityId: db.config.database,
        summary: `Migration failed: ${err.message}`.slice(0, 300), after: { pending: pending.map((m) => m.id), log }, flags: ['migration_failed'] });
      return res.status(500).json({ error: `A migration failed: ${err.message}. The database may be partly updated; restore the backup or ask for help before trying again.` });
    }
    await auditSafe({ ...audit.fromReq(req), action: 'database.migrated', entity: 'database', entityId: db.config.database,
      summary: `Applied ${pending.length} migration(s): ${pending.map((m) => m.id).join(', ')}`.slice(0, 300), after: { applied: pending.map((m) => m.id), backupConfirmed: true } });
    // A backup taken while the job log didn't exist yet is recorded now.
    await jobs.flushUnlogged().catch((err) => console.error('Could not record earlier job runs:', err.message));
    if (maintenance.info().reason === 'migrations') { maintenance.clear(); startServices(); }
    res.json({ applied: pending.map((m) => m.id), ...(await databaseState()) });
  } finally {
    await conn.query("SELECT RELEASE_LOCK('dcp_uk_migrate')").catch(() => {});
    conn.release();
  }
});

// Runs the off-site backup now (e.g. just before applying migrations).
adminApi.post('/database/backup', need('system'), async (req, res) => {
  if (!backup.configured()) return res.status(400).json({ error: 'Off-site backups are not set up (S3_* variables). Use npm run db:export-data instead.' });
  // Backups also run in maintenance mode: that is exactly when one is needed.
  const result = await jobs.runDue({ trigger: 'admin', only: ['backup'], force: ['backup'], ignoreMaintenance: true });
  const r = result.find((x) => x.job === 'backup');
  await auditSafe({ ...audit.fromReq(req), action: 'database.backup', entity: 'database', entityId: db.config.database,
    summary: r?.status === 'ok' ? `Off-site backup taken: ${r.detail}` : `Off-site backup failed: ${r?.detail || 'did not run'}`.slice(0, 300) });
  if (r?.status !== 'ok') return res.status(502).json({ error: `The backup failed: ${r?.detail || 'another job run was in progress; try again in a minute'}` });
  res.json({ result: r, ...(await databaseState()) });
});

app.use('/api/admin', adminApi);

// Scheduler entry point for hosts without an always-on process (JOBS_MODE=cron):
//   GET /internal/cron?token=<CRON_TOKEN>   or   Authorization: Bearer <CRON_TOKEN>
// Missing or short CRON_TOKEN: the route doesn't exist.
const CRON_TOKEN = process.env.CRON_TOKEN || '';
app.all('/internal/cron', async (req, res, next) => {
  if (CRON_TOKEN.length < 24) return next();
  const given = String(req.query.token || (req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(CRON_TOKEN).digest());
  if (!ok) return res.status(403).json({ error: 'Forbidden.' });
  res.set('Cache-Control', 'no-store').json({ ran: await jobs.runDue({ trigger: 'cron' }) });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------------------------------------------------------- receipts (payer's signed link)

app.get('/receipts/:no', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  const no = String(req.params.no);
  if (!mailer.checkSign('receipt', no, req.query.t)) return res.status(404).send(unsubscribePage('Receipt not found', 'This receipt link is incomplete. Ask the chapter to send it again.'));
  const tx = await db.one('SELECT * FROM transactions WHERE receipt_no = ?', [no]);
  if (!tx) return res.status(404).send(unsubscribePage('Receipt not found', 'This receipt could not be found. Ask the chapter to send it again.'));
  const member = tx.member_id ? await db.one('SELECT reference FROM members WHERE id = ?', [tx.member_id]) : null;
  res.send(finance.renderReceiptPage(tx, member));
});

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

// HTML pages: tier wording from the tier table, the demo badge, and the friendly
// URLs (/join, /donate, /member-portal). Everything else is a static file.
app.use(sitePages.pages(SITE_DIR));
app.use(express.static(SITE_DIR));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err instanceof demo.DemoRefused) return res.status(403).json({ error: err.message });
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
    if (err instanceof migrations.PendingMigrations) {
      // Start anyway, in maintenance mode, so a Super admin can back up and apply them from the admin.
      maintenance.set('migrations', err.message);
    } else {
      console.error(err instanceof migrations.MigrationStop ? `
NOT STARTING: ${err.message}
` : err);
      process.exit(1);
    }
  }
  if (process.env.MAINTENANCE_MODE === 'true') maintenance.set('manual', 'MAINTENANCE_MODE=true');
  const seeded = await auth.ensureConfiguredAdmin().catch((err) => { console.error('Could not create the configured admin:', err.message); return null; });
  if (!maintenance.on()) startServices();
  const mailProblems = mailer.problems();
  const opsProblems = [...storage.problems(),
    ...(IN_PRODUCTION && !demo.DEMO && !backup.configured() ? ['Off-site backups are not set up (S3_* variables): the dashboard shows this in red.'] : [])];
  const dataWarning = await demo.checkData(db, IN_PRODUCTION).catch(() => null);
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
    console.log(`Email:         ${mc.transport}${mc.transport === 'log' ? ' (stored only, nothing is delivered)' : ''}${mc.demo ? ', forced by DEMO_MODE' : ''}, from ${mc.from.email}`);
    if (demo.DEMO) console.log('Mode:          DEMO (sample data only; email is never sent; real imports are refused)');
    if (dataWarning) console.warn(`WARNING: ${dataWarning}`);
    console.log(`Jobs:          ${jobs.MODE === 'cron' ? 'cron (run npm run jobs:run or /internal/cron every minute)' : 'in-process loop'}; storage: ${storage.driver()}; off-site backups: ${backup.configured() ? `on, daily after ${String(jobs.BACKUP_HOUR).padStart(2, '0')}:00 UTC` : 'off'}`);
    for (const p of opsProblems) console.warn(`WARNING: ${p}`);
    if (maintenance.on()) {
      const bar = '#'.repeat(78);
      console.warn(`\n${bar}\n MAINTENANCE MODE: the public site says "back shortly".\n ${maintenance.info().message.replace(/\n/g, '\n ')}\n${bar}\n`);
    }
    if (mailProblems.length) {
      const bar = '!'.repeat(78);
      console.warn(`\n${bar}\n EMAIL IS NOT PROPERLY CONFIGURED\n${mailProblems.map((p) => ` - ${p}`).join('\n')}\n${bar}\n`);
    }
  });
})();

// Mail queue and background jobs (lib/jobs.js). Not started in maintenance mode:
// they start once the pending migrations are applied.
function startServices() {
  jobs.startLoop();
}
