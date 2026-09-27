// Fills a LOCAL database with realistic fake members and donations so the
// dashboard and table paging have something to show:
//   npm run seed:dev              (adds ~180 members and ~70 donation pledges)
//   npm run seed:dev -- --reset   (removes everything this script added)
// Seeded rows all use @seed.example email addresses, which is how --reset finds
// them. Refuses to run in production or against a non-local database.
const crypto = require('node:crypto');
const db = require('../lib/db');
const auth = require('../lib/auth');

const SEED_DOMAIN = 'seed.example';
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

if (process.env.NODE_ENV === 'production' || !LOCAL_HOSTS.includes(db.config.host)) {
  console.error(`Refusing to seed: NODE_ENV=${process.env.NODE_ENV || '(unset)'}, database host ${db.config.host}. Seeding is for local development only.`);
  process.exit(1);
}

const FIRST = ['Wanjiru', 'Otieno', 'Achieng', 'Kamau', 'Njeri', 'Mwangi', 'Akinyi', 'Kiprono', 'Chebet', 'Mutua', 'Nyambura', 'Omondi', 'Wambui', 'Kiplagat', 'Atieno', 'Njoroge', 'Wairimu', 'Odhiambo', 'Jepkosgei', 'Muthoni', 'Kibet', 'Adhiambo', 'Gitau', 'Moraa', 'Onyango', 'Nduta', 'Barasa', 'Naliaka', 'Wafula', 'Nekesa'];
const LAST = ['Kariuki', 'Ochieng', 'Mwangi', 'Wekesa', 'Njoroge', 'Kiprotich', 'Otieno', 'Mutiso', 'Chege', 'Onyango', 'Kimani', 'Rotich', 'Owino', 'Macharia', 'Kiptoo', 'Nyaga', 'Musyoka', 'Oduor', 'Keter', 'Githinji'];
const CHAPTERS = [['London', 'London', 'SE15 4QP'], ['Manchester', 'Manchester', 'M14 5RR'], ['Birmingham', 'Birmingham', 'B12 9QD'], ['Leeds', 'Leeds', 'LS6 2AB'], ['Glasgow', 'Glasgow', 'G12 8QQ'], ['Cardiff', 'Cardiff', 'CF24 4HQ'], ['Nottingham', 'Nottingham', 'NG7 2RD'], ['Belfast', 'Belfast', 'BT7 1NN'], ['None nearby', 'Plymouth', 'PL4 8AA']];
const INTERESTS = ['Community outreach', 'Youth mobilisation', 'Policy and research', 'Fundraising', 'Communications', 'Other'];
const OCCUPATIONS = ['Nurse', 'Software engineer', 'Student', 'Care worker', 'Accountant', 'Teacher', 'Pharmacist', 'Business owner', 'Civil engineer', 'Social worker'];
const MESSAGES = ['For the chapter launch event.', 'Keep up the good work!', 'Towards voter education in the diaspora.', null, null, 'Monthly support from the Leeds group.', null];

const pick = (a) => a[crypto.randomInt(a.length)];
const weighted = (pairs) => { let r = Math.random() * pairs.reduce((s, [, w]) => s + w, 0); for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs[0][0]; };
const REF = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ref = (prefix) => `${prefix}-${Array.from(crypto.randomBytes(6), (b) => REF[b % REF.length]).join('')}`;
// A random moment in the last `days` days, weighted towards recent dates.
const recent = (days) => new Date(Date.now() - Math.floor(days * Math.random() ** 1.6 * 86400000));
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

async function reset() {
  const m = await db.query('DELETE FROM members WHERE email LIKE ?', [`%@${SEED_DOMAIN}`]);
  const d = await db.query('DELETE FROM donations WHERE email LIKE ?', [`%@${SEED_DOMAIN}`]);
  console.log(`Removed ${m.affectedRows} seeded members and ${d.affectedRows} seeded donations.`);
}

async function seed() {
  const members = 180;
  for (let i = 0; i < members; i++) {
    const first = pick(FIRST); const last = pick(LAST);
    const [chapter, town, postcode] = pick(CHAPTERS);
    const created = recent(420);
    const status = weighted([['approved', 60], ['pending', 30], ['rejected', 5]]);
    const payment = status === 'approved' ? weighted([['paid', 75], ['payment_reported', 15], ['pending_payment', 10]]) : weighted([['pending_payment', 55], ['payment_reported', 35], ['paid', 10]]);
    const passport = Math.random() < 0.6;
    await db.query(`INSERT INTO members (reference, access_token_hash, full_name, phone, email, date_of_birth, id_document_type,
        id_document_number, language, occupation, interest, interest_other, chapter, chapter_other, address_line1, town, postcode,
        fee_amount, fee_currency, payment_status, payment_note, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 20, 'GBP', ?, ?, ?, ?, ?)`, [
      ref('DCPUK'), auth.sha256(crypto.randomBytes(24).toString('hex')), `${first} ${last}`,
      `+447${String(crypto.randomInt(100000000, 999999999))}`,
      `${first}.${last}.${i}@${SEED_DOMAIN}`.toLowerCase(),
      `19${crypto.randomInt(55, 99)}-${String(crypto.randomInt(1, 13)).padStart(2, '0')}-${String(crypto.randomInt(1, 29)).padStart(2, '0')}`,
      passport ? 'Kenyan Passport' : 'Kenyan National ID',
      passport ? `A${pick(['K', 'B', 'C'])}${crypto.randomInt(1000000, 9999999)}` : String(crypto.randomInt(10000000, 39999999)),
      pick(['English', 'English', 'Kiswahili']), pick(OCCUPATIONS), pick(INTERESTS), null,
      chapter, chapter === 'None nearby' ? town : null, `${crypto.randomInt(1, 200)} ${pick(['High Street', 'Station Road', 'Church Lane', 'Victoria Road', 'Park Avenue'])}`,
      town, postcode, payment, payment !== 'pending_payment' ? `Q${crypto.randomBytes(4).toString('hex').toUpperCase()}` : null,
      status, sqlTime(created), sqlTime(created),
    ]);
  }
  const donations = 70;
  for (let i = 0; i < donations; i++) {
    const created = recent(300);
    const first = pick(FIRST); const last = pick(LAST);
    await db.query(`INSERT INTO donations (reference, full_name, email, amount_gbp, frequency, message, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      ref('DON'), `${first} ${last}`, `${first}.${last}.d${i}@${SEED_DOMAIN}`.toLowerCase(),
      pick([10, 20, 25, 50, 50, 100, 150, 250, 500]), weighted([['one_off', 80], ['monthly', 20]]), pick(MESSAGES),
      weighted([['received', 55], ['pledged', 35], ['cancelled', 10]]), sqlTime(created), sqlTime(created),
    ]);
  }
  console.log(`Added ${members} members and ${donations} donation pledges (emails @${SEED_DOMAIN}). Remove them with: npm run seed:dev -- --reset`);
}

(async () => {
  await db.init();
  if (process.argv.includes('--reset')) await reset(); else await seed();
  process.exit(0);
})().catch((err) => { console.error(err.message || err.code); process.exit(1); });
