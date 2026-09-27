// Append-only audit log: who did what, when, with the record before and after.
// The app only ever INSERTs here; there is no route that edits or deletes entries.
const db = require('./db');

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v).slice(0, 60000));

// q is db or a db.transaction() handle, so audit rows commit with the change they describe.
async function record(q, { actor, actorType = 'admin', action, entity, entityId = null, summary = null, before, after, flags = [], ip = null }) {
  await (q || db).query(
    `INSERT INTO audit_log (actor_type, actor, action, entity, entity_id, summary, before_json, after_json, flags, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [actorType, String(actor || 'unknown').slice(0, 190), action, entity, entityId == null ? null : String(entityId), summary ? String(summary).slice(0, 300) : null,
      json(before), json(after), flags.length ? flags.join(',') : null, ip ? String(ip).slice(0, 45) : null]);
}

// Shortcut for admin requests.
const fromReq = (req) => ({ actor: req.admin?.username || 'unknown', actorType: 'admin', ip: req.ip });

// Only the fields that changed, for readable before/after pairs.
function diff(before, after) {
  const b = {};
  const a = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (String(before?.[key] ?? '') !== String(after?.[key] ?? '')) { b[key] = before?.[key] ?? null; a[key] = after?.[key] ?? null; }
  }
  return { before: b, after: a };
}

module.exports = { record, fromReq, diff };
