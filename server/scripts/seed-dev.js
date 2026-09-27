// Fills a LOCAL database with realistic fake members and donations so the
// dashboard and table paging have something to show:
//   npm run seed:dev              (adds ~180 members, ~70 donation pledges and their payments)
//   npm run seed:dev -- --reset   (removes everything this script added)
// Seeded rows all use @seed.example email addresses, which is how --reset finds
// them. Refuses to run in production or against a non-local database.
const crypto = require('node:crypto');
const db = require('../lib/db');
const migrations = require('../lib/migrations');
const auth = require('../lib/auth');
const finance = require('../lib/finance');

const { DEMO, SEED_DOMAIN } = require('../lib/demo');
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// Local development, or the demo environment (DEMO_MODE=true). Never production.
if (!DEMO && (process.env.NODE_ENV === 'production' || !LOCAL_HOSTS.includes(db.config.host))) {
  console.error(`Refusing to seed: NODE_ENV=${process.env.NODE_ENV || '(unset)'}, database host ${db.config.host}, DEMO_MODE off. Seeding is for local development and the demo environment only.`);
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
  // Seeded payments go first (recorded by seed actors, or linked to seeded people).
  const t = await db.query(`DELETE FROM transactions WHERE recorded_by LIKE ? OR member_id IN (SELECT id FROM members WHERE email LIKE ?)
    OR donation_id IN (SELECT id FROM donations WHERE email LIKE ?)`, [`%@${SEED_DOMAIN}`, `%@${SEED_DOMAIN}`, `%@${SEED_DOMAIN}`]);
  console.log(`Removed ${t.affectedRows} seeded transactions (their audit-log entries stay: the log is append-only).`);
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
    // Most seeded members agreed to their data being processed; about 60% also
    // ticked "Email me chapter news" (the only consent bulk email uses).
    await db.query(`UPDATE members SET data_consent_at = created_at, marketing_consent_at = IF(RAND() < 0.6, created_at, NULL) WHERE email = ?`,
      [`${first}.${last}.${i}@${SEED_DOMAIN}`.toLowerCase()]);
  }
  const donations = 70;
  for (let i = 0; i < donations; i++) {
    const created = recent(300);
    const first = pick(FIRST); const last = pick(LAST);
    await db.query(`INSERT INTO donations (reference, full_name, email, amount_gbp, frequency, message, status, donor_kenyan, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      ref('DON'), `${first} ${last}`, `${first}.${last}.d${i}@${SEED_DOMAIN}`.toLowerCase(),
      pick([10, 20, 25, 50, 50, 100, 150, 250, 500]), weighted([['one_off', 80], ['monthly', 20]]), pick(MESSAGES),
      weighted([['received', 55], ['pledged', 35], ['cancelled', 10]]), weighted([['yes', 80], ['no', 8], ['unknown', 12]]), sqlTime(created), sqlTime(created),
    ]);
  }
  // Visit contributions from the Donate page: some from members (linked by their reference).
  const visit = await db.one("SELECT amount FROM membership_tiers WHERE tkey = 'visit'");
  const visitors = await db.query("SELECT id, reference, full_name, email FROM members WHERE email LIKE ? AND status = 'approved' ORDER BY RAND() LIMIT 8", [`%@${SEED_DOMAIN}`]);
  for (const [i, m] of visitors.entries()) {
    const created = recent(200);
    const linked = i % 4 !== 3;
    await db.query(`INSERT INTO donations (reference, kind, member_id, member_reference, full_name, email, amount_gbp, frequency, message, status, donor_kenyan, created_at, updated_at)
      VALUES (?, 'visit_contribution', ?, ?, ?, ?, ?, 'one_off', NULL, ?, 'yes', ?, ?)`, [
      ref('DON'), linked ? m.id : null, linked ? m.reference : null, m.full_name, m.email, visit ? visit.amount : 200,
      weighted([['received', 50], ['pledged', 50]]), sqlTime(created), sqlTime(created),
    ]);
  }
  const n = await seedFinance();
  console.log(`Added ${members} members, ${donations} donation pledges, ${visitors.length} visit contributions and ${n} transactions (emails @${SEED_DOMAIN}). Remove them with: npm run seed:dev -- --reset`);
}

// Payments for the seeded people, recorded and verified through the real finance
// code (so receipts, balances and the audit log are exactly as in use): GBP bank
// transfers, KES M-Pesa payments with a hand-entered rate, pending reports,
// a rejected and a voided entry, a refund, expenses and other income.
async function seedFinance() {
  const recorder = { actor: `seed-treasurer@${SEED_DOMAIN}`, actorType: 'system' };
  const verifier = { actor: `seed-chair@${SEED_DOMAIN}`, actorType: 'system' };
  const tiers = Object.fromEntries((await finance.listTiers()).map((t) => [t.tkey, t]));
  const today = new Date().toISOString().slice(0, 10);
  const dayAfter = (sql, days) => { const d = new Date(sql.replace(' ', 'T') + 'Z'); d.setUTCDate(d.getUTCDate() + days); const iso = d.toISOString().slice(0, 10); return iso > today ? today : iso; };
  let count = 0;
  const record = async (input, source) => { count++; return finance.recordTransaction(input, recorder, source ? { source } : undefined); };

  // Tiers: mostly Ordinary, some Stakeholder. Unpaid Stakeholder applications still
  // pending review are awaiting tier approval.
  const seeded = await db.query('SELECT id, created_at, payment_status, status FROM members WHERE email LIKE ? ORDER BY id', [`%@${SEED_DOMAIN}`]);
  for (const m of seeded) {
    const tier = weighted([['ordinary', 88], ['stakeholder', 12]]);
    m.awaiting = tier === 'stakeholder' && m.status === 'pending' && m.payment_status === 'pending_payment';
    await db.query('UPDATE members SET tier_id = ?, tier_status = ?, billing_start = DATE(created_at), fee_review = 0, fee_review_reason = NULL WHERE id = ?',
      [tiers[tier].id, m.awaiting ? 'awaiting' : 'confirmed', m.id]);
    m.tier = tiers[tier];
  }
  for (const m of seeded) {
    const kes = Math.random() < 0.4;
    const rate = kes ? Math.round((158 + Math.random() * 14) * 100) / 100 : 1;
    const input = {
      type: m.tier.tx_type, amount: kes ? Math.round(m.tier.amount * rate) : m.tier.amount, currency: kes ? 'KES' : 'GBP', fxRate: rate,
      method: kes ? 'mpesa_paybill' : 'bank_transfer', account: 'fee_account', memberId: m.id, dateReceived: dayAfter(m.created_at, crypto.randomInt(0, 6)),
      externalRef: kes ? `Q${crypto.randomBytes(4).toString('hex').toUpperCase()}` : `BACS ${crypto.randomInt(100000, 999999)}`,
    };
    if (m.payment_status === 'paid') {
      const id = await record(input);
      await finance.verifyTransaction(id, verifier);
      if (Math.random() < 0.3) await finance.reconcileTransaction(id, recorder);
    } else if (m.payment_status === 'payment_reported') {
      // The member said they paid; KES reports arrive without a rate for the treasurer to fill in.
      await record({ ...input, fxRate: kes ? '' : 1, notes: 'Reported by the member on the website after registering.' }, 'member_report');
    }
  }

  // Donations: received pledges get their verified payment; declarations come from the pledge.
  const pledges = await db.query("SELECT id, kind, member_id, amount_gbp, created_at, donor_kenyan FROM donations WHERE email LIKE ? AND status = 'received'", [`%@${SEED_DOMAIN}`]);
  await db.query("UPDATE donations SET status = 'pledged' WHERE email LIKE ? AND status = 'received'", [`%@${SEED_DOMAIN}`]);
  for (const p of pledges) {
    const id = await record({ type: p.kind, amount: p.amount_gbp, currency: 'GBP', fxRate: 1, method: 'bank_transfer', account: 'donations_account',
      donationId: p.id, memberId: p.member_id, donorKenyan: p.donor_kenyan, dateReceived: dayAfter(p.created_at, crypto.randomInt(1, 10)), externalRef: `DON ${crypto.randomInt(10000, 99999)}` });
    await finance.verifyTransaction(id, verifier);
  }

  // A few of everything else.
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const other = [
    { type: 'other_income', amount: 185, currency: 'GBP', method: 'cash', account: 'other', payerName: 'Summer meet-up raffle', dateReceived: daysAgo(40) },
    { type: 'other_income', amount: 240, currency: 'GBP', method: 'card_online', account: 'other', payerName: 'Event tickets (Leeds town hall)', dateReceived: daysAgo(12) },
    { type: 'donation', amount: 16500, currency: 'KES', fxRate: 165, method: 'mpesa_till', account: 'other', payerName: 'Wanjiku Harambee group', donorKenyan: 'yes', dateReceived: daysAgo(3), externalRef: 'SKL88A1B2C' },
    { type: 'expense', amount: 150, currency: 'GBP', method: 'bank_transfer', account: 'donations_account', payerName: 'Venue hire, Birmingham community hall', dateReceived: daysAgo(20) },
    { type: 'expense', amount: 45.5, currency: 'GBP', method: 'card_online', account: 'other', payerName: 'Leaflet printing', dateReceived: daysAgo(8) },
  ];
  for (const input of other) await finance.verifyTransaction(await record(input), verifier);
  const paid = await db.one("SELECT x.member_id AS id FROM transactions x WHERE x.status = 'verified' AND x.type = 'membership_fee' AND x.member_id IS NOT NULL ORDER BY x.id DESC LIMIT 1");
  if (paid) await finance.verifyTransaction(await record({ type: 'refund', amount: 20, currency: 'GBP', method: 'bank_transfer', account: 'fee_account', memberId: paid.id, dateReceived: daysAgo(1), notes: 'Paid twice; second payment returned.' }), verifier);
  const toReject = await record({ type: 'donation', amount: 50, currency: 'GBP', method: 'bank_transfer', account: 'donations_account', payerName: 'Unknown transfer', donorKenyan: 'unknown', dateReceived: daysAgo(5) });
  await finance.rejectTransaction(toReject, 'No matching credit in the bank statement.', verifier);
  const toVoid = await db.one("SELECT id FROM transactions WHERE status = 'verified' AND type = 'donation' ORDER BY id LIMIT 1");
  if (toVoid) await finance.voidTransaction(toVoid.id, 'Recorded twice by mistake; the other entry stands.', recorder);
  return count;
}

(async () => {
  await db.init();
  await migrations.prepare();
  if (process.argv.includes('--reset')) await reset(); else await seed();
  process.exit(0);
})().catch((err) => { console.error(err.message || err.code); process.exit(1); });
