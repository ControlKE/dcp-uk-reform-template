// Numbered schema migrations (server/migrations/NNN_name.js), recorded in the
// schema_migrations table.
//
// Before changing anything the runner checks the database looks like this
// app's: no unknown tables, the original tables have their key columns, and no
// recorded migration is missing from this code. If anything looks wrong it stops
// without touching the database.
//
// Locally, pending migrations apply at startup. In production they apply only
// from the admin (Settings → Database, Super admin, after confirming a backup),
// through `npm run migrate -- --yes`, or at startup when AUTO_MIGRATE=true, so
// there is always a chance to back up first (see DEPLOY.md). Until then the app
// runs in maintenance mode.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const DIR = path.join(__dirname, '..', 'migrations');
const IN_PRODUCTION = process.env.NODE_ENV === 'production';

// Tables that existed before numbered migrations, with columns that must be there.
const LEGACY = {
  admins: ['id', 'username', 'password_hash'],
  sessions: ['token_hash', 'admin_id', 'expires_at'],
  settings: ['key', 'value'],
  members: ['id', 'reference', 'full_name', 'email', 'status', 'payment_status'],
  donations: ['id', 'reference', 'amount_gbp', 'status'],
};

class MigrationStop extends Error {}
// Production with migrations waiting: the app starts in maintenance mode instead.
class PendingMigrations extends MigrationStop {
  constructor(message, pending) { super(message); this.pending = pending; }
}

function load() {
  return fs.readdirSync(DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.js$/.test(f)).sort()
    .map((file) => ({ id: file.replace(/\.js$/, ''), ...require(path.join(DIR, file)) }));
}

async function tables() {
  const rows = await db.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db.config.database]);
  return new Set(rows.map((r) => r.t));
}
async function columns(table) {
  const rows = await db.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db.config.database, table]);
  return new Set(rows.map((r) => r.c));
}
const hasColumn = async (table, column) => (await columns(table)).has(column);
const hasTable = async (table) => (await tables()).has(table);

// Every table any migration in this code creates, so a partly-migrated database is recognised.
function knownTables(migrations) {
  const names = new Set([...Object.keys(LEGACY), 'schema_migrations']);
  for (const m of migrations) for (const t of m.tables || []) names.add(t);
  return names;
}

// Works out what would be applied, or throws MigrationStop if the database looks wrong.
async function plan() {
  const migrations = load();
  const existing = await tables();
  let applied = [];
  if (existing.has('schema_migrations')) {
    applied = (await db.query('SELECT id FROM schema_migrations ORDER BY id')).map((r) => r.id);
    const unknown = applied.filter((id) => !migrations.some((m) => m.id === id));
    if (unknown.length) {
      throw new MigrationStop(`The database has migrations this code does not know about (${unknown.join(', ')}). It was probably upgraded by a newer version of the app. Deploy that version instead.`);
    }
  }
  const unexpected = [...existing].filter((t) => !knownTables(migrations).has(t));
  if (unexpected.length) {
    throw new MigrationStop(`Database "${db.config.database}" contains tables this app does not use (${unexpected.join(', ')}). Check DATABASE_URL / DB_NAME points at the DCP UK database.`);
  }
  for (const [table, cols] of Object.entries(LEGACY)) {
    if (!existing.has(table)) continue;
    const have = await columns(table);
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) throw new MigrationStop(`Table "${table}" is missing expected columns (${missing.join(', ')}). The database does not look like a DCP UK database.`);
  }
  return { migrations, pending: migrations.filter((m) => !applied.includes(m.id)), applied };
}

function describe(pending) {
  return pending.map((m) => `  - ${m.id}: ${m.description}`).join('\n');
}

async function apply(pending, log = console.log) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         VARCHAR(100) PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const m of pending) {
    log(`Applying ${m.id} …`);
    // MySQL commits DDL immediately, so migrations are written to be safe to re-run
    // if one fails part-way; the id is only recorded once it has fully succeeded.
    await m.up(db, { hasColumn, hasTable });
    await db.query('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
  }
}

// Used at server start and by the scripts.
async function prepare({ log = console.log } = {}) {
  const { pending } = await plan();
  if (!pending.length) return;
  const where = `"${db.config.database}" on ${db.config.host}`;
  // An empty database has nothing to back up: a fresh install creates its tables.
  const fresh = (await tables()).size === 0;
  if (IN_PRODUCTION && process.env.AUTO_MIGRATE !== 'true' && !fresh) {
    throw new PendingMigrations(`Database ${where} needs ${pending.length} migration(s):\n${describe(pending)}\nBack up the database, then apply them in the admin (Settings → Database) or with "npm run migrate -- --yes". See DEPLOY.md.`, pending);
  }
  log(`Database ${where}: applying ${pending.length} migration(s):\n${describe(pending)}`);
  await apply(pending, log);
}

// Every migration in this code, with when it was applied (null if pending).
async function status() {
  const migrations = load();
  const rows = (await tables()).has('schema_migrations') ? await db.query('SELECT id, applied_at FROM schema_migrations') : [];
  const at = Object.fromEntries(rows.map((r) => [r.id, r.applied_at]));
  return migrations.map((m) => ({ id: m.id, description: m.description, appliedAt: at[m.id] || null }));
}

module.exports = { plan, apply, prepare, describe, status, MigrationStop, PendingMigrations, hasColumn, hasTable };
