// Tier choice at registration, Stakeholder approval, and visit contributions
// moving to the Donate page.
//   membership_tiers.kind         membership (chosen when joining) | payment (a payment
//                                 type on the Donate page; the visit contribution)
//   membership_tiers.description  shown next to the tier on the public pages
//   members.tier_status           confirmed | awaiting (a tier that needs an admin to
//                                 confirm it; nothing is due until then)
//   donations.kind                donation | visit_contribution
//   donations.member_id / member_reference
//                                 a visit contribution from a member, linked when the
//                                 reference and email given both match that member
exports.description = 'Tier choice at registration, Stakeholder approval, visit contributions on the Donate page';

const DESCRIPTIONS = [
  ['ordinary', 'Standard membership, renewed every year.'],
  ['stakeholder', 'For members who support the chapter at a higher level, renewed every year. The chapter confirms Stakeholder applications before the fee is due.'],
  ['visit', 'A one-off contribution, paid by bank transfer. Members can add their membership reference so it is linked to them.'],
];

exports.up = async (db, { hasColumn }) => {
  if (!(await hasColumn('membership_tiers', 'kind'))) {
    await db.query(`ALTER TABLE membership_tiers
      ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'membership' AFTER tkey,
      ADD COLUMN description VARCHAR(300) NULL AFTER name`);
    await db.query("UPDATE membership_tiers SET kind = 'payment' WHERE tkey = 'visit'");
    for (const [key, text] of DESCRIPTIONS) await db.query('UPDATE membership_tiers SET description = ? WHERE tkey = ? AND description IS NULL', [text, key]);
  }

  if (!(await hasColumn('members', 'tier_status'))) {
    await db.query("ALTER TABLE members ADD COLUMN tier_status VARCHAR(10) NOT NULL DEFAULT 'confirmed' AFTER tier_id");
    // Anyone an admin put on the visit contribution is left as they are (no money
    // changes silently) but flagged, since it is no longer a membership tier.
    await db.query(`UPDATE members SET fee_review = 1, fee_review_reason = CONCAT_WS(' ', fee_review_reason,
        'Visit contribution is no longer a membership tier: move this member to Ordinary or Stakeholder, and record visit contributions as payments.')
      WHERE tier_id = (SELECT id FROM membership_tiers WHERE tkey = 'visit')`);
  }

  if (!(await hasColumn('donations', 'kind'))) {
    await db.query(`ALTER TABLE donations
      ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'donation' AFTER reference,
      ADD COLUMN member_id INT NULL AFTER kind,
      ADD COLUMN member_reference VARCHAR(20) NULL AFTER member_id,
      ADD INDEX idx_donations_member (member_id)`);
  }
};
