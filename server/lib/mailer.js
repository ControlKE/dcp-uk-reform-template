// Outgoing email. One send() for every transport, chosen by MAIL_TRANSPORT:
//   log     store only; nothing leaves the server (the local default)
//   brevo   Brevo HTTP API          (BREVO_API_KEY)
//   resend  Resend HTTP API         (RESEND_API_KEY)
//   smtp    any SMTP server         (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
// Switching provider is only an environment change. The HTTP APIs matter on
// Railway, whose non-Pro plans block outbound SMTP.
const crypto = require('node:crypto');

const IN_PRODUCTION = process.env.NODE_ENV === 'production';
const TRANSPORTS = ['log', 'brevo', 'resend', 'smtp'];

function parseAddress(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(.*)<([^>]+)>$/);
  return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { name: '', email: s };
}

function config() {
  const transport = (process.env.MAIL_TRANSPORT || 'log').toLowerCase();
  const port = Number(process.env.PORT) || 3000;
  return {
    transport: TRANSPORTS.includes(transport) ? transport : 'invalid',
    rawTransport: transport,
    from: parseAddress(process.env.MAIL_FROM || 'DCP UK <no-reply@localhost>'),
    replyTo: (process.env.MAIL_REPLY_TO || '').trim() || null,
    ratePerMinute: Math.max(1, Math.min(600, Number(process.env.MAIL_RATE_PER_MINUTE) || 30)),
    dailyLimit: Number(process.env.MAIL_DAILY_LIMIT) || null,
    baseUrl: (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    secret: process.env.APP_SECRET || '',
  };
}

// Problems an admin needs to see (the admin area shows these as a red banner).
function problems() {
  const c = config();
  const out = [];
  if (c.transport === 'invalid') out.push(`MAIL_TRANSPORT="${c.rawTransport}" is not one of ${TRANSPORTS.join(', ')}. No email can be sent.`);
  if (IN_PRODUCTION && c.transport === 'log') out.push('MAIL_TRANSPORT=log: emails are only stored, never delivered. Activation emails, receipts and replies will not reach anyone. Set MAIL_TRANSPORT to brevo, resend or smtp.');
  if (c.transport === 'brevo' && !process.env.BREVO_API_KEY) out.push('MAIL_TRANSPORT=brevo but BREVO_API_KEY is not set.');
  if (c.transport === 'resend' && !process.env.RESEND_API_KEY) out.push('MAIL_TRANSPORT=resend but RESEND_API_KEY is not set.');
  if (c.transport === 'smtp' && !process.env.SMTP_HOST) out.push('MAIL_TRANSPORT=smtp but SMTP_HOST is not set.');
  if (IN_PRODUCTION && c.transport !== 'log' && /@localhost$/.test(c.from.email)) out.push('MAIL_FROM is not set to an address on your sending domain.');
  if (IN_PRODUCTION && !c.secret) out.push('APP_SECRET is not set, so bulk email (which needs signed unsubscribe links) is disabled.');
  if (IN_PRODUCTION && !process.env.APP_BASE_URL) out.push('APP_BASE_URL is not set, so links in emails point at localhost.');
  return out;
}

// ---------------------------------------------------------------- unsubscribe links

// Local development gets a fixed secret so links keep working across restarts.
const secretFor = (c) => c.secret || (IN_PRODUCTION ? null : 'dev-only-unsubscribe-secret');

function unsubscribeToken(memberId, email) {
  const secret = secretFor(config());
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`unsubscribe:${memberId}:${String(email).toLowerCase()}`).digest('base64url');
}
function checkUnsubscribeToken(memberId, email, token) {
  const expected = unsubscribeToken(memberId, email);
  return Boolean(expected && token && expected.length === String(token).length
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token))));
}
function unsubscribeUrl(memberId, email) {
  const token = unsubscribeToken(memberId, email);
  return token ? `${config().baseUrl}/unsubscribe?m=${memberId}&t=${token}` : null;
}

// Signed links for other purposes (e.g. a payer's receipt page).
function sign(purpose, value) {
  const secret = secretFor(config());
  return secret ? crypto.createHmac('sha256', secret).update(`${purpose}:${value}`).digest('base64url').slice(0, 32) : null;
}
function checkSign(purpose, value, token) {
  const expected = sign(purpose, value);
  return Boolean(expected && token && expected.length === String(token).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token))));
}

// ---------------------------------------------------------------- rendering

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// {{first_name}} etc. Values are escaped for HTML bodies.
function merge(template, fields, { html = true } = {}) {
  return String(template || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key) => (key in fields ? (html ? escapeHtml(fields[key]) : String(fields[key])) : all));
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (m, href, text) => (text.replace(/<[^>]+>/g, '') === href ? href : `${text} (${href})`))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ').replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Wraps a body in the DCP layout. Bulk mail carries the unsubscribe footer;
// transactional mail only says why the person is receiving it.
function layout({ bodyHtml, category, unsubscribe }) {
  const c = config();
  const footer = category === 'bulk'
    ? `You are receiving this because you are a DCP UK member and asked to receive chapter news.<br>
       <a href="${escapeHtml(unsubscribe)}" style="color:#4b5f52">Unsubscribe from chapter emails</a>. You will still receive messages about your own membership, such as receipts.`
    : 'This is a service message about your contact with DCP UK. It is not a newsletter.';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f8f1;font-family:Arial,Helvetica,sans-serif;color:#14201a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f8f1"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#17401b;padding:18px 24px;color:#ffffff;font-size:20px;font-weight:bold">DCP <span style="color:#57c065">UK</span></td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #dbe6dc;font-size:12px;line-height:1.5;color:#4b5f52">${footer}<br>Democracy for the Citizens Party, United Kingdom chapter · <a href="${escapeHtml(c.baseUrl)}/" style="color:#4b5f52">${escapeHtml(c.baseUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${htmlToText(bodyHtml)}\n\n--\n${category === 'bulk' ? `Unsubscribe from chapter emails: ${unsubscribe}` : 'This is a service message about your contact with DCP UK.'}\nDCP UK · ${c.baseUrl}/`;
  return { html, text };
}

// ---------------------------------------------------------------- transports

class SendError extends Error {
  constructor(message, { permanent = false } = {}) { super(message); this.permanent = permanent; }
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new SendError(`Could not reach the email provider (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.message || data.error || data.code || res.statusText;
    // 4xx (other than rate limiting) will fail the same way again.
    throw new SendError(`Provider rejected the message (${res.status}): ${detail}`, { permanent: res.status >= 400 && res.status < 500 && res.status !== 429 });
  }
  return data;
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
const fmt = (a) => (a.name ? `${a.name.replace(/["<>]/g, '')} <${a.email}>` : a.email);

const transports = {
  async log() {
    return { id: `log-${crypto.randomBytes(8).toString('hex')}` };
  },
  async brevo(m) {
    const data = await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': process.env.BREVO_API_KEY }, {
      sender: { name: m.from.name || undefined, email: m.from.email },
      to: m.to.map((a) => ({ email: a.email, name: a.name || undefined })),
      cc: m.cc.length ? m.cc.map((a) => ({ email: a.email })) : undefined,
      bcc: m.bcc.length ? m.bcc.map((a) => ({ email: a.email })) : undefined,
      replyTo: m.replyTo ? { email: m.replyTo } : undefined,
      subject: m.subject, htmlContent: m.html, textContent: m.text,
      headers: Object.keys(m.headers).length ? m.headers : undefined,
      attachment: m.attachments.length ? m.attachments.map((a) => ({ name: a.filename, content: b64(a.content) })) : undefined,
    });
    return { id: data.messageId || '' };
  },
  async resend(m) {
    const data = await postJson('https://api.resend.com/emails', { authorization: `Bearer ${process.env.RESEND_API_KEY}` }, {
      from: fmt(m.from), to: m.to.map((a) => a.email),
      cc: m.cc.length ? m.cc.map((a) => a.email) : undefined,
      bcc: m.bcc.length ? m.bcc.map((a) => a.email) : undefined,
      reply_to: m.replyTo || undefined,
      subject: m.subject, html: m.html, text: m.text,
      headers: Object.keys(m.headers).length ? m.headers : undefined,
      attachments: m.attachments.length ? m.attachments.map((a) => ({ filename: a.filename, content: b64(a.content) })) : undefined,
    });
    return { id: data.id || '' };
  },
  async smtp(m) {
    const nodemailer = require('nodemailer');
    transports.smtpClient ||= nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    try {
      const info = await transports.smtpClient.sendMail({
        from: fmt(m.from), to: m.to.map(fmt), cc: m.cc.map(fmt), bcc: m.bcc.map(fmt), replyTo: m.replyTo || undefined,
        subject: m.subject, html: m.html, text: m.text, headers: m.headers,
        attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      return { id: info.messageId || '' };
    } catch (err) {
      throw new SendError(`SMTP error: ${err.message}`, { permanent: Number(err.responseCode) >= 500 && Number(err.responseCode) < 600 });
    }
  },
};

// Sends one message now. Callers normally go through the queue (lib/mail-queue.js).
async function send(message) {
  const c = config();
  if (c.transport === 'invalid') throw new SendError(`MAIL_TRANSPORT="${c.rawTransport}" is not recognised.`, { permanent: true });
  const m = {
    from: c.from, replyTo: message.replyTo ?? c.replyTo,
    to: message.to, cc: message.cc || [], bcc: message.bcc || [],
    subject: message.subject, html: message.html, text: message.text,
    headers: message.headers || {}, attachments: message.attachments || [],
  };
  const result = await transports[c.transport](m);
  return { provider: c.transport, id: result.id, delivered: c.transport !== 'log' };
}

module.exports = {
  TRANSPORTS, config, problems, parseAddress, send, SendError,
  layout, merge, escapeHtml, htmlToText,
  unsubscribeUrl, checkUnsubscribeToken, sign, checkSign,
};
