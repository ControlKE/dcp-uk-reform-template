// Create an extra admin account from the command line:
//   npm run create-admin -- <email>
// (To reset an existing admin's password, use npm run admin:reset instead.)
// You'll be asked for the password (it isn't echoed or saved in shell history).
const db = require('../lib/db');
const { createAdmin } = require('../lib/auth');
const askHidden = require('./ask-hidden');

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run create-admin -- <email>');
  process.exit(1);
}

(async () => {
  const password = await askHidden('Password (min 10 characters): ');
  const confirm = await askHidden('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }
  try {
    await db.init();
    await createAdmin(username, password);
    console.log(`Admin account "${username}" created.`);
    process.exit(0);
  } catch (err) {
    console.error(err.message || err.code);
    process.exit(1);
  }
})();
