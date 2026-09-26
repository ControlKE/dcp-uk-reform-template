// Create an admin account, or reset the password of an existing one:
//   npm run admin:reset -- --email you@example.com              (asks for the password)
//   npm run admin:reset -- --email you@example.com --generate   (makes a strong one, shown once)
// On Railway: railway run npm run admin:reset -- --email you@example.com --generate
//
// The password is hashed the same way the app does it (scrypt, lib/auth.js) and is
// never written to a file. Resetting also signs that admin out of every session.
const crypto = require('node:crypto');
const db = require('../lib/db');
const auth = require('../lib/auth');
const askHidden = require('./ask-hidden');

const USAGE = 'Usage: npm run admin:reset -- --email <email> [--generate]';

function parseArgs(argv) {
  const args = { email: null, generate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--generate') args.generate = true;
    else if (a === '--email') args.email = argv[++i];
    else if (a.startsWith('--email=')) args.email = a.slice('--email='.length);
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else { console.error(`Unknown option "${a}".\n${USAGE}`); process.exit(1); }
  }
  return args;
}

async function choosePassword(generate) {
  if (generate) return crypto.randomBytes(18).toString('base64url'); // 24 characters, 144 bits
  if (!process.stdin.isTTY) {
    console.error('No terminal to type a password into. Add --generate to have one made for you.');
    process.exit(1);
  }
  const password = await askHidden('New password (min 10 characters): ');
  const problem = auth.validateNewPassword(password);
  if (problem) { console.error(problem); process.exit(1); }
  if (password !== await askHidden('Confirm password: ')) { console.error('Passwords do not match.'); process.exit(1); }
  return password;
}

(async () => {
  const { email, generate } = parseArgs(process.argv.slice(2));
  if (!email) { console.error(USAGE); process.exit(1); }
  const username = String(email).trim().toLowerCase();

  const password = await choosePassword(generate);
  await db.init();

  const existing = await db.one('SELECT id FROM admins WHERE username = ?', [username]);
  if (existing) {
    await db.query('UPDATE admins SET password_hash = ? WHERE id = ?', [auth.hashPassword(password), existing.id]);
    await db.query('DELETE FROM sessions WHERE admin_id = ?', [existing.id]);
    console.log(`Password reset for admin "${username}". Any open sessions were signed out.`);
  } else {
    await auth.createAdmin(username, password);
    console.log(`Admin account "${username}" created.`);
  }
  if (generate) {
    console.log(`\nPassword (shown once, not saved anywhere): ${password}\n`);
    console.log('Sign in at /admin/ and change it under Admin users > Change password.');
  }
  process.exit(0);
})().catch((err) => {
  console.error(err.message || err.code);
  process.exit(1);
});
