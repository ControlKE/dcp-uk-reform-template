// Admin roles. Enforced on every /api/admin route (the UI only hides what a role
// cannot use).
//   super_admin            everything
//   treasurer              finance (record, verify, reports, tiers, accounts) + read members
//   membership_secretary   members, imports, activations, email; read-only finance
const ROLES = {
  super_admin: { label: 'Super admin', perms: ['*'] },
  treasurer: {
    label: 'Treasurer',
    perms: ['dashboard', 'members.read', 'donations.read', 'donations.write', 'finance.read', 'finance.write', 'finance.settings', 'audit.read'],
  },
  membership_secretary: {
    label: 'Membership secretary',
    perms: ['dashboard', 'members.read', 'members.write', 'members.ids', 'imports', 'activations', 'email', 'donations.read', 'finance.read'],
  },
};

function permissions(role) {
  const r = ROLES[role] || ROLES.super_admin;
  return r.perms;
}
function can(admin, perm) {
  if (!admin) return false;
  const perms = permissions(admin.role);
  return perms.includes('*') || perms.includes(perm);
}
// Express middleware: 403 unless the signed-in admin's role has perm.
function need(perm) {
  return (req, res, next) => (can(req.admin, perm) ? next()
    : res.status(403).json({ error: `Your role (${ROLES[req.admin?.role]?.label || 'unknown'}) cannot do this.` }));
}

module.exports = { ROLES, permissions, can, need };
