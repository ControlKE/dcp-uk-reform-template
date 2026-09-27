// An optional, approximate KES figure per tier for people paying by M-Pesa. It is
// shown on the public pages only ("about KES 3,300") and is never used for billing:
// dues stay in GBP.
exports.description = 'Tiers: optional approximate KES display amount';

exports.up = async (db, { hasColumn }) => {
  if (!(await hasColumn('membership_tiers', 'display_kes'))) {
    await db.query('ALTER TABLE membership_tiers ADD COLUMN display_kes DECIMAL(12,2) NULL AFTER currency');
  }
};
