// Agreement to receive chapter news (bulk email), separate from the data-processing
// consent every member gives at registration. Collected only by the optional
// registration checkbox and, later, the member portal. Existing members start
// without it: nobody is opted in on their behalf.
exports.description = 'Members: marketing_consent_at (optional chapter-news consent)';

exports.up = async (db, { hasColumn }) => {
  if (!(await hasColumn('members', 'marketing_consent_at'))) {
    await db.query('ALTER TABLE members ADD COLUMN marketing_consent_at DATETIME NULL AFTER data_consent_at');
  }
};
