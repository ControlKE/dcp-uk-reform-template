// Create an extra admin account from the command line:
//   npm run create-admin -- <email>
// You'll be asked for the password (it isn't echoed or saved in shell history).
const readline = require('node:readline');
const db = require('../lib/db');
const { createAdmin } = require('../lib/auth');

const username = process.argv[2];
if (!username) {
  console.error('Usage: npm run create-admin -- <email>');
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
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
