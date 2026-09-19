// Admin accounts and cookie sessions. Passwords use scrypt; session tokens are
// random and only their SHA-256 hash is stored, so a copied database can't be
// used to hijack a live session.
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_COOKIE = 'dcp_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

// Admin usernames are normally email addresses.
const normaliseUsername = (u) => String(u || '').trim().toLowerCase();

async function createAdmin(username, password) {
  const name = normaliseUsername(username);
  if (!/^[a-z0-9._@+-]{3,190}$/.test(name)) {
    throw new Error('Enter an email address (or a username of letters, numbers, dot, dash, underscore).');
  }
  const problem = validateNewPassword(password);
  if (problem) throw new Error(problem);
  if (await db.one('SELECT 1 AS x FROM admins WHERE username = ?', [name])) {
    throw new Error('That admin already exists.');
  }
  await db.query('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [name, hashPassword(password)]);
}

// Creates the admin named in server/.env (ADMIN_EMAIL / ADMIN_PASSWORD) if it
// doesn't exist yet. An existing account's password is left alone, so a password
// changed in the admin area isn't reset on every restart.
async function ensureConfiguredAdmin() {
  const email = normaliseUsername(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return null;
  if (await db.one('SELECT 1 AS x FROM admins WHERE username = ?', [email])) return email;
  await createAdmin(email, password);
  return email;
}

// A dummy hash so failed lookups take as long as real password checks.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

async function checkCredentials(username, password) {
  const admin = await db.one('SELECT * FROM admins WHERE username = ?', [normaliseUsername(username)]);
  const ok = verifyPassword(String(password || ''), admin ? admin.password_hash : DUMMY_HASH);
  return ok && admin ? admin : null;
}

async function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await db.query('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)', [sha256(token), adminId, Date.now() + SESSION_TTL_MS]);
  return token;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function sessionCookie(token, req, maxAgeMs) {
  const secure = req.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

async function getSessionAdmin(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await db.one(`
    SELECT a.id, a.username, s.expires_at FROM sessions s
    JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?`, [sha256(token)]);
  if (!row || Number(row.expires_at) < Date.now()) return null;
  return { id: row.id, username: row.username };
}

async function destroySession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

async function requireAdmin(req, res, next) {
  const admin = await getSessionAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Please sign in.' });
  req.admin = admin;
  next();
}

// Simple in-memory limiter for login attempts: 10 failures per IP per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(ip) {
  const entry = failures.get(ip);
  return Boolean(entry && entry.count >= 10 && Date.now() - entry.first < WINDOW_MS);
}
function recordLoginFailure(ip) {
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.first >= WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else entry.count += 1;
}
function clearLoginFailures(ip) { failures.delete(ip); }

module.exports = {
  SESSION_TTL_MS,
  hashPassword, verifyPassword, validateNewPassword,
  createAdmin, ensureConfiguredAdmin, checkCredentials,
  createSession, sessionCookie, getSessionAdmin, destroySession, requireAdmin,
  loginBlocked, recordLoginFailure, clearLoginFailures,
  sha256,
};
