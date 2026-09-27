// DEMO_MODE=true marks a demonstration copy of the site (the Railway "demo"
// environment shown to the owners and potential buyers):
//   - a subtle "Demo" badge in the admin and the site footer, and a notice on the
//     public forms asking people not to enter real details
//   - outbound email is forced to the log transport, whatever MAIL_TRANSPORT says
//   - seed data may be loaded (npm run seed:dev) even though it is a hosted database
//   - real imports are refused (refuse() below)
// Production runs with DEMO_MODE unset or false; nothing is ever copied between them.
const DEMO = process.env.DEMO_MODE === 'true';

// The seed script's email domain: how demo data is told apart from real people.
const SEED_DOMAIN = 'seed.example';

class DemoRefused extends Error {
  constructor(what) { super(`${what} is switched off on the demo site. Use the production site for real data.`); this.status = 403; }
}

// Call before anything that would bring real personal data into the demo.
function refuse(what) {
  if (DEMO) throw new DemoRefused(what);
}

// Startup check: warns when the data doesn't match the mode (real people in a demo
// database, or seed data in production).
async function checkData(db, inProduction) {
  const row = await db.one(`SELECT SUM(email LIKE ?) AS seeded, SUM(email NOT LIKE ?) AS other FROM members`, [`%@${SEED_DOMAIN}`, `%@${SEED_DOMAIN}`]);
  const seeded = Number(row?.seeded || 0);
  const other = Number(row?.other || 0);
  if (DEMO && other > 0) return `DEMO_MODE is on but the database has ${other} member(s) who are not seed data. The demo must only hold seed data: check DATABASE_URL points at the demo database.`;
  if (!DEMO && inProduction && seeded > 0) return `This production database contains ${seeded} seed member(s) (@${SEED_DOMAIN}). Seed data belongs only in the demo environment.`;
  return null;
}

module.exports = { DEMO, SEED_DOMAIN, DemoRefused, refuse, checkData };
