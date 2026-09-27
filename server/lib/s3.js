// A small client for S3-compatible object storage (Cloudflare R2, Backblaze B2,
// AWS S3, MinIO): put, get, head, delete and list, signed with AWS Signature v4.
// Used by the storage adapter (STORAGE_DRIVER=s3) and the off-site backups.
//
//   S3_ENDPOINT           e.g. https://<account>.r2.cloudflarestorage.com
//                         or   https://s3.eu-central-003.backblazeb2.com
//   S3_BUCKET             the bucket name (create it private)
//   S3_REGION             "auto" for R2; the region in the B2 endpoint, e.g. eu-central-003
//   S3_ACCESS_KEY_ID      a key limited to this bucket
//   S3_SECRET_ACCESS_KEY
// Addresses are path-style (endpoint/bucket/key), which all of these accept.
const { AwsClient } = require('aws4fetch');

function config() {
  return {
    endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'auto',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  };
}
const configured = () => { const c = config(); return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey); };

function missing() {
  const c = config();
  return [['S3_ENDPOINT', c.endpoint], ['S3_BUCKET', c.bucket], ['S3_ACCESS_KEY_ID', c.accessKeyId], ['S3_SECRET_ACCESS_KEY', c.secretAccessKey]]
    .filter(([, v]) => !v).map(([k]) => k);
}

let cached = null;
function client() {
  const c = config();
  if (!configured()) throw new Error(`S3 storage is not configured (missing ${missing().join(', ')}).`);
  const sig = `${c.endpoint}|${c.bucket}|${c.accessKeyId}|${c.region}`;
  if (!cached || cached.sig !== sig) cached = { sig, aws: new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: 's3', region: c.region }) };
  return cached.aws;
}

const objectUrl = (key) => { const c = config(); return `${c.endpoint}/${encodeURIComponent(c.bucket)}/${String(key).split('/').map(encodeURIComponent).join('/')}`; };

async function check(res, what) {
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const err = new Error(`S3 ${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
  err.status = res.status;
  throw err;
}

async function put(key, body, contentType = 'application/octet-stream') {
  await check(await client().fetch(objectUrl(key), { method: 'PUT', body, headers: { 'Content-Type': contentType } }), `upload of ${key}`);
}
async function get(key) {
  const res = await check(await client().fetch(objectUrl(key)), `download of ${key}`);
  return Buffer.from(await res.arrayBuffer());
}
async function head(key) {
  const res = await client().fetch(objectUrl(key), { method: 'HEAD' });
  if (res.status === 404) return null;
  await check(res, `check of ${key}`);
  return { size: Number(res.headers.get('content-length')), lastModified: res.headers.get('last-modified') };
}
async function remove(key) {
  const res = await client().fetch(objectUrl(key), { method: 'DELETE' });
  if (res.status !== 404) await check(res, `delete of ${key}`);
}
// Every object under prefix: [{ key, size, lastModified }].
async function list(prefix) {
  const c = config();
  const out = [];
  let token = null;
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) q.set('continuation-token', token);
    const res = await check(await client().fetch(`${c.endpoint}/${encodeURIComponent(c.bucket)}?${q}`), `listing of ${prefix}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (t) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(m[1]) || [])[1];
      out.push({ key: tag('Key').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
        size: Number(tag('Size')), lastModified: tag('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml) || [])[1] : null;
  } while (token);
  return out;
}

module.exports = { config, configured, missing, put, get, head, remove, list };
