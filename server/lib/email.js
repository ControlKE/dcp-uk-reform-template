// The email app's storage and sending rules.
//
// Two kinds of outgoing email:
//   transactional  one person (plus optional Cc/Bcc): replies, receipts,
//                  activation, a note to one member. Always allowed.
//   bulk           a segment, or more than one member in To. Only members with
//                  data consent recorded who have not opted out; each copy is
//                  personalised and carries a signed unsubscribe link plus the
//                  List-Unsubscribe headers. Sent through the throttled queue.
const sanitizeHtml = require('sanitize-html');
const db = require('./db');
const mailer = require('./mailer');

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_EMAIL = 20 * 1024 * 1024;
const FOLDERS = ['inbox', 'sent', 'draft', 'spam', 'trash'];
const BACKOFF_MIN = [1, 5, 30]; // minutes before retries 1, 2, 3
const MAX_ATTEMPTS = 4;

const SEGMENTS = {
  all: { label: () => 'All members', where: null },
  chapter: { label: (v) => `Chapter: ${v}`, where: 'chapter = ?' },
  status: { label: (v) => `Status: ${v}`, where: 'status = ?', values: ['pending', 'approved', 'rejected'] },
  payment: { label: (v) => `Payment: ${{ pending_payment: 'not paid', payment_reported: 'reported paid', paid: 'paid' }[v] || v}`, where: 'payment_status = ?', values: ['pending_payment', 'payment_reported', 'paid'] },
};

class EmailError extends Error {}

function cleanHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'a', 'h2', 'h3', 'blockquote', 'hr', 'div', 'span'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener' }) },
  }).slice(0, 200000);
}

const normAddress = (a) => String(a || '').trim().toLowerCase();
const MEMBER_FIELDS = 'id, full_name, email, reference, chapter, data_consent_at, email_opt_out';

// Works out who a message goes to, applying the consent rules.
async function resolveAudience({ to = [], segments = [], cc = [], bcc = [] }) {
  const errors = [];
  const memberIds = [...new Set(to.filter((t) => t && t.memberId).map((t) => Number(t.memberId)).filter(Boolean))];
  const addresses = to.filter((t) => t && !t.memberId && t.address).map((t) => ({ address: normAddress(t.address), name: String(t.name || '').slice(0, 120) }));
  for (const a of [...addresses, ...cc.map((x) => ({ address: normAddress(x) })), ...bcc.map((x) => ({ address: normAddress(x) }))]) {
    if (!EMAIL_RE.test(a.address)) errors.push(`"${a.address}" is not a valid email address.`);
  }
  const segs = [];
  for (const s of segments) {
    const def = SEGMENTS[s && s.type];
    if (!def) { errors.push('Unknown segment.'); continue; }
    if (def.where && !s.value) { errors.push(`Choose a value for the ${s.type} segment.`); continue; }
    if (def.values && !def.values.includes(s.value)) { errors.push(`Unknown ${s.type} "${s.value}".`); continue; }
    segs.push({ type: s.type, value: def.where ? String(s.value) : null });
  }
  const bulk = segs.length > 0 || memberIds.length + addresses.length > 1;
  if (bulk && (cc.length || bcc.length)) errors.push('Cc and Bcc are only for messages to one person. Bulk emails go to each member separately.');

  let members = [];
  if (memberIds.length) members.push(...await db.query(`SELECT ${MEMBER_FIELDS} FROM members WHERE id IN (${memberIds.map(() => '?').join(',')})`, memberIds));
  for (const s of segs) {
    const def = SEGMENTS[s.type];
    members.push(...await db.query(`SELECT ${MEMBER_FIELDS} FROM members${def.where ? ` WHERE ${def.where}` : ''}`, def.where ? [s.value] : []));
  }
  const seen = new Set();
  let duplicate = 0;
  members = members.filter((m) => { const k = normAddress(m.email); if (seen.has(k)) { duplicate++; return false; } seen.add(k); return true; });

  const excluded = { noConsent: 0, optedOut: 0, notMember: 0 };
  const recipients = [];
  if (bulk) {
    for (const m of members) {
      if (m.email_opt_out) excluded.optedOut++;
      else if (!m.data_consent_at) excluded.noConsent++;
      else recipients.push({ kind: 'to', address: normAddress(m.email), name: m.full_name, memberId: m.id });
    }
    excluded.notMember = addresses.filter((a) => !seen.has(a.address)).length; // bulk goes to members only
  } else {
    const m = members[0];
    if (m) recipients.push({ kind: 'to', address: normAddress(m.email), name: m.full_name, memberId: m.id });
    else if (addresses[0]) {
      const known = await db.one(`SELECT ${MEMBER_FIELDS} FROM members WHERE email = ? LIMIT 1`, [addresses[0].address]);
      recipients.push({ kind: 'to', address: addresses[0].address, name: addresses[0].name || known?.full_name || '', memberId: known?.id || null });
    }
    for (const a of cc) recipients.push({ kind: 'cc', address: normAddress(a), name: '', memberId: null });
    for (const a of bcc) recipients.push({ kind: 'bcc', address: normAddress(a), name: '', memberId: null });
  }
  const summary = [
    ...segs.map((s) => SEGMENTS[s.type].label(s.value)),
    ...(bulk ? [] : recipients.filter((r) => r.kind === 'to').map((r) => (r.name ? `${r.name} <${r.address}>` : r.address))),
    ...(bulk && (memberIds.length + addresses.length) ? [`${memberIds.length + addresses.length} chosen ${memberIds.length + addresses.length === 1 ? 'person' : 'people'}`] : []),
  ].join(', ');
  return {
    category: bulk ? 'bulk' : 'transactional',
    recipients, excluded, duplicate,
    excludedTotal: excluded.noConsent + excluded.optedOut + excluded.notMember,
    summary: summary.slice(0, 500), errors,
    segments: segs,
  };
}

// Queues an outgoing email. Returns the new email id.
async function createOutgoing({ admin, audience, subject, html, template, attachmentIds = [], inReplyTo = null, source = 'compose', draftId = null }) {
  if (audience.errors.length) throw new EmailError(audience.errors[0]);
  if (!audience.recipients.some((r) => r.kind === 'to')) throw new EmailError(audience.category === 'bulk' ? 'Nobody in this audience can receive bulk email (no consent recorded, or opted out).' : 'Add a recipient.');
  if (!String(subject || '').trim()) throw new EmailError('Add a subject.');
  const body = cleanHtml(html);
  if (!mailer.htmlToText(body).trim()) throw new EmailError('Write a message.');
  if (audience.category === 'bulk' && !mailer.unsubscribeUrl(1, 'check@example.org')) {
    throw new EmailError('Bulk email is disabled until APP_SECRET is set (it signs the unsubscribe links).');
  }
  const cfg = mailer.config();
  const ids = [...new Set(attachmentIds.map(Number).filter(Boolean))];
  if (ids.length) {
    const rows = await db.query(`SELECT id, size FROM email_attachments WHERE id IN (${ids.map(() => '?').join(',')}) AND (email_id IS NULL OR email_id = ?)`, [...ids, draftId || 0]);
    if (rows.length !== ids.length) throw new EmailError('An attachment is missing. Remove it and attach it again.');
    if (rows.reduce((s, r) => s + r.size, 0) > MAX_ATTACHMENTS_PER_EMAIL) throw new EmailError('Attachments on one email can total at most 20 MB.');
  }
  const single = audience.category === 'transactional' ? audience.recipients.find((r) => r.kind === 'to') : null;
  const values = [
    'sent', 'out', source, audience.category, template || null, cfg.from.name, cfg.from.email, cfg.replyTo,
    audience.summary, String(subject).trim().slice(0, 250), body, mailer.htmlToText(body),
    audience.category === 'bulk' ? 5 : 1, single?.memberId || null, inReplyTo,
    audience.recipients.filter((r) => r.kind === 'to').length, audience.excludedTotal, admin,
  ];
  let emailId = draftId;
  if (draftId) {
    await db.query(`UPDATE emails SET folder = ?, direction = ?, source = ?, category = ?, template = ?, from_name = ?, from_email = ?, reply_to = ?,
      to_summary = ?, subject = ?, body_html = ?, body_text = ?, priority = ?, member_id = ?, in_reply_to = ?, recipient_count = ?, excluded_count = ?,
      created_by = ?, status = 'queued', is_read = 1, draft_json = NULL, created_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND folder = 'draft'`, [...values, draftId]);
  } else {
    const r = await db.query(`INSERT INTO emails (folder, direction, source, category, template, from_name, from_email, reply_to,
      to_summary, subject, body_html, body_text, priority, member_id, in_reply_to, recipient_count, excluded_count, created_by,
      status, is_read, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, values);
    emailId = r.insertId;
  }
  for (const rcp of audience.recipients) {
    await db.query('INSERT INTO email_recipients (email_id, kind, address, name, member_id, next_attempt_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
      [emailId, rcp.kind, rcp.address, rcp.name || null, rcp.memberId || null]);
  }
  if (ids.length) await db.query(`UPDATE email_attachments SET email_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [emailId, ...ids]);
  kick();
  return emailId;
}

// Records an incoming message (contact form, new application, later member replies).
async function receive({ source, fromName, fromEmail, subject, text, memberId = null, labels = [] }) {
  const r = await db.query(`INSERT INTO emails (folder, direction, source, category, from_name, from_email, reply_to, to_summary, subject,
      body_text, status, priority, member_id, created_at, updated_at)
    VALUES ('inbox', 'in', ?, 'transactional', ?, ?, ?, 'DCP UK chapter', ?, ?, 'received', 5, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
  [source, String(fromName || '').slice(0, 120), normAddress(fromEmail), normAddress(fromEmail), String(subject || '(no subject)').slice(0, 250), String(text || '').slice(0, 20000), memberId]);
  for (const name of labels) {
    await db.query('INSERT IGNORE INTO email_label_map (email_id, label_id) SELECT ?, id FROM email_labels WHERE name = ?', [r.insertId, name]);
  }
  return r.insertId;
}

// ---------------------------------------------------------------- the send queue

const recentSends = [];
let running = false;
let timer = null;
let lastCleanup = 0;

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || 'friend';
async function fieldsFor(memberId, fallbackName) {
  const m = memberId ? await db.one('SELECT full_name, email, reference, chapter FROM members WHERE id = ?', [memberId]) : null;
  return {
    first_name: firstName(m?.full_name || fallbackName), full_name: m?.full_name || fallbackName || '',
    reference: m?.reference || '', chapter: m?.chapter && m.chapter !== 'None nearby' ? m.chapter : 'your nearest chapter', email: m?.email || '',
  };
}

async function refreshStatus(emailId) {
  const rows = await db.query('SELECT status, COUNT(*) AS n FROM email_recipients WHERE email_id = ? GROUP BY status', [emailId]);
  const c = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  let status;
  if ((c.queued || 0) + (c.sending || 0)) status = 'queued';
  else if ((c.failed || 0) === total) status = 'failed';
  else if (c.failed) status = 'partial';
  else if (c.logged && (c.logged || 0) + (c.skipped || 0) === total) status = 'logged';
  else status = 'sent';
  await db.query(`UPDATE emails SET status = ?, sent_at = ${status === 'queued' ? 'sent_at' : 'COALESCE(sent_at, UTC_TIMESTAMP())'}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [status, emailId]);
}

async function deliver(emailId, recipientIds) {
  const email = await db.one('SELECT * FROM emails WHERE id = ?', [emailId]);
  const rcps = await db.query(`SELECT * FROM email_recipients WHERE id IN (${recipientIds.map(() => '?').join(',')}) AND status = 'sending'`, recipientIds);
  if (!email || !rcps.length) return;
  const attachments = (await db.query('SELECT filename, content_type, data FROM email_attachments WHERE email_id = ?', [emailId]))
    .map((a) => ({ filename: a.filename, contentType: a.content_type, content: a.data }));
  const to = rcps.filter((r) => r.kind === 'to');
  const lead = to[0] || rcps[0];
  const fields = await fieldsFor(lead.member_id, lead.name);
  const bulk = email.category === 'bulk';
  const ids = rcps.map((r) => r.id);
  const idList = ids.map(() => '?').join(',');
  if (bulk && lead.member_id) {
    // Consent is checked again at send time: someone may have unsubscribed after queueing.
    const m = await db.one('SELECT data_consent_at, email_opt_out FROM members WHERE id = ?', [lead.member_id]);
    if (!m || m.email_opt_out || !m.data_consent_at) {
      await db.query(`UPDATE email_recipients SET status = 'skipped', last_error = ? WHERE id IN (${idList})`,
        [!m ? 'Member no longer exists.' : m.email_opt_out ? 'Unsubscribed before this was sent.' : 'No data consent recorded.', ...ids]);
      await refreshStatus(emailId);
      return;
    }
  }
  const unsubscribe = bulk ? mailer.unsubscribeUrl(lead.member_id, lead.address) : null;
  const { html, text } = mailer.layout({ bodyHtml: mailer.merge(email.body_html, fields), category: email.category, unsubscribe });
  const headers = bulk && unsubscribe ? { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {};
  try {
    const result = await mailer.send({
      to: to.map((r) => ({ email: r.address, name: r.name || '' })),
      cc: rcps.filter((r) => r.kind === 'cc').map((r) => ({ email: r.address })),
      bcc: rcps.filter((r) => r.kind === 'bcc').map((r) => ({ email: r.address })),
      replyTo: email.reply_to || undefined,
      subject: mailer.merge(email.subject, fields, { html: false }), html, text, headers, attachments,
    });
    await db.query(`UPDATE email_recipients SET status = ?, provider = ?, provider_id = ?, sent_at = UTC_TIMESTAMP(), attempts = attempts + 1, last_error = NULL WHERE id IN (${idList})`,
      [result.delivered ? 'sent' : 'logged', result.provider, String(result.id || '').slice(0, 200), ...ids]);
  } catch (err) {
    const attempts = Math.max(...rcps.map((r) => r.attempts)) + 1;
    const giveUp = err.permanent || attempts >= MAX_ATTEMPTS;
    await db.query(`UPDATE email_recipients SET status = ?, attempts = ?, last_error = ?, next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id IN (${idList})`,
      [giveUp ? 'failed' : 'queued', attempts, String(err.message).slice(0, 500), BACKOFF_MIN[attempts - 1] || 30, ...ids]);
    console.error(`Email ${emailId} to ${rcps.map((r) => r.address).join(', ')}: ${err.message}${giveUp ? ' (giving up)' : ' (will retry)'}`);
  }
  await refreshStatus(emailId);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // A crash mid-send leaves rows in 'sending'; put them back after 10 minutes.
    await db.query("UPDATE email_recipients SET status = 'queued' WHERE status = 'sending' AND next_attempt_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE");
    const now = Date.now();
    while (recentSends.length && now - recentSends[0] > 60000) recentSends.shift();
    let budget = mailer.config().ratePerMinute - recentSends.length;
    // Optional provider daily cap (e.g. Brevo's free plan: 300 a day). Anything over
    // it stays queued and goes out the next day; transactional mail still goes first.
    const daily = Number(process.env.MAIL_DAILY_LIMIT) || 0;
    if (daily) {
      const sent = Number((await db.one("SELECT COUNT(*) AS n FROM email_recipients WHERE status = 'sent' AND sent_at > UTC_TIMESTAMP() - INTERVAL 1 DAY")).n);
      budget = Math.min(budget, daily - sent);
    }
    while (budget > 0) {
      // Transactional mail (priority 1) always goes ahead of bulk (5).
      const next = await db.one(`SELECT r.id, r.email_id, e.category FROM email_recipients r JOIN emails e ON e.id = r.email_id
        WHERE r.status = 'queued' AND r.next_attempt_at <= UTC_TIMESTAMP() ORDER BY e.priority, r.next_attempt_at, r.id LIMIT 1`);
      if (!next) break;
      const unit = next.category === 'bulk' ? [next.id]
        : (await db.query("SELECT id FROM email_recipients WHERE email_id = ? AND status = 'queued' AND next_attempt_at <= UTC_TIMESTAMP()", [next.email_id])).map((r) => r.id);
      const claimed = await db.query(`UPDATE email_recipients SET status = 'sending', next_attempt_at = UTC_TIMESTAMP() WHERE status = 'queued' AND id IN (${unit.map(() => '?').join(',')})`, unit);
      if (!claimed.affectedRows) continue;
      await deliver(next.email_id, unit);
      recentSends.push(Date.now());
      budget--;
    }
    if (now - lastCleanup > 3600000) {
      lastCleanup = now;
      await db.query('DELETE FROM email_attachments WHERE email_id IS NULL AND created_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
    }
  } catch (err) {
    console.error('Mail queue:', err.message);
  } finally {
    running = false;
  }
}

function kick() { setTimeout(() => { tick(); }, 50); }
function startQueue(intervalMs = 3000) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  kick();
}

module.exports = {
  EMAIL_RE, FOLDERS, SEGMENTS, MAX_ATTACHMENT, MAX_ATTACHMENTS_PER_EMAIL, EmailError,
  cleanHtml, resolveAudience, createOutgoing, receive, startQueue, kick, tick,
};
