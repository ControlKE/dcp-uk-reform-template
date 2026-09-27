// Where uploaded files are kept, chosen by STORAGE_DRIVER:
//   db    in the database (files.data). The default: nothing else to set up, and
//         database backups include the files.
//   disk  in STORAGE_DIR (default server/storage), outside the public web root and
//         only ever served through the app's own controlled routes. Needs a
//         persistent disk: on Railway attach a volume, or the files vanish on redeploy.
//   s3    in S3-compatible storage (lib/s3.js, the same settings as the backups).
// Each file remembers the driver it was stored with, so changing STORAGE_DRIVER
// later only affects new files; old ones stay readable.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const db = require('./db');
const s3 = require('./s3');

const DRIVERS = ['db', 'disk', 's3'];
const driver = () => (process.env.STORAGE_DRIVER || 'db').toLowerCase();
const DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage'));

// Problems to show at startup and in the admin.
function problems() {
  const d = driver();
  if (!DRIVERS.includes(d)) return [`STORAGE_DRIVER="${d}" is not one of ${DRIVERS.join(', ')}. Uploads will fail.`];
  if (d === 's3' && !s3.configured()) return [`STORAGE_DRIVER=s3 but ${s3.missing().join(', ')} ${s3.missing().length === 1 ? 'is' : 'are'} not set. Uploads will fail.`];
  if (d === 'disk') {
    try { fsSync.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fsSync.accessSync(DIR, fsSync.constants.W_OK); } catch { return [`STORAGE_DIR (${DIR}) is not writable. Uploads will fail.`]; }
  }
  return [];
}

function diskPath(key) {
  const p = path.resolve(DIR, key);
  if (!p.startsWith(DIR + path.sep)) throw new Error('Invalid storage key.');
  return p;
}

// Stores bytes and returns the new file id.
async function put({ buffer, filename, contentType = 'application/octet-stream', purpose, by = null }) {
  const d = driver();
  if (!DRIVERS.includes(d)) throw new Error(`STORAGE_DRIVER="${d}" is not supported.`);
  const now = new Date();
  const key = `${purpose}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}`;
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (d === 'disk') {
    const file = diskPath(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, buffer, { mode: 0o600, flag: 'wx' });
  } else if (d === 's3') {
    await s3.put(key, buffer, contentType);
  }
  try {
    const r = await db.query(`INSERT INTO files (driver, object_key, purpose, filename, content_type, size, sha256, data, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [d, key, purpose, filename, contentType, buffer.length, sha256, d === 'db' ? buffer : null, by]);
    return r.insertId;
  } catch (err) {
    await removeBytes(d, key).catch(() => {});
    throw err;
  }
}

async function readBytes(f) {
  if (f.driver === 'db') return f.data;
  if (f.driver === 'disk') return fs.readFile(diskPath(f.object_key));
  if (f.driver === 's3') return s3.get(f.object_key);
  throw new Error(`Unknown storage driver "${f.driver}".`);
}
async function removeBytes(d, key) {
  if (d === 'disk') await fs.rm(diskPath(key), { force: true });
  else if (d === 's3') await s3.remove(key);
}

// { buffer, filename, contentType, size } or null. Checks the bytes against the
// stored hash, so a file changed or corrupted outside the app is refused.
async function get(id) {
  const f = await db.one('SELECT * FROM files WHERE id = ?', [Number(id) || 0]);
  if (!f) return null;
  const buffer = await readBytes(f);
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== f.sha256) throw new Error(`Stored file ${f.id} does not match its checksum.`);
  return { buffer, filename: f.filename, contentType: f.content_type, size: f.size };
}

async function remove(id) {
  const f = await db.one('SELECT id, driver, object_key FROM files WHERE id = ?', [Number(id) || 0]);
  if (!f) return;
  await removeBytes(f.driver, f.object_key);
  await db.query('DELETE FROM files WHERE id = ?', [f.id]);
}

module.exports = { DRIVERS, DIR, driver, problems, put, get, remove };
