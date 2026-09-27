// /api/admin finance routes: transactions, tiers, finance settings, reports, audit log.
// Mounted on the admin router, after sign-in; each route checks the role's permission.
const express = require('express');
const db = require('../lib/db');
const finance = require('../lib/finance');
const audit = require('../lib/audit');
const { need } = require('../lib/roles');
const { pageParams, paged } = require('../lib/paging');
const { sendTable } = require('../lib/export');

const router = express.Router();
const who = audit.fromReq;
const likeParam = (q) => `%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Turns FinanceError into a clean 4xx; anything else goes to the error handler.
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof finance.FinanceError) return res.status(err.status).json({ error: err.message, fields: err.fields });
    next(err);
  }
};

// ---------------------------------------------------------------- reference data

router.get('/finance/options', need('dashboard'), wrap(async (req, res) => {
  const [tiers, fs] = await Promise.all([finance.listTiers(), finance.getFinanceSettings()]);
  res.json({
    types: finance.TYPES, methods: finance.METHODS, currencies: finance.CURRENCIES, accounts: finance.ACCOUNTS,
    statuses: finance.STATUSES, tiers, settings: fs,
  });
}));

router.put('/tiers/:id', need('finance.settings'), wrap(async (req, res) => {
  await finance.updateTier(Number(req.params.id), req.body || {}, who(req));
  res.json({ tiers: await finance.listTiers() });
}));

router.put('/finance-settings', need('finance.settings'), wrap(async (req, res) => {
  res.json({ settings: await finance.saveFinanceSettings(req.body || {}, who(req)) });
}));

// ---------------------------------------------------------------- transactions

const TX_SORTS = { date: 'x.date_received', amount: 'x.amount_gbp', payer: 'x.payer_name', type: 'x.type', status: 'x.status', receipt: 'x.receipt_no', recorded: 'x.recorded_at' };

function txFilters(q) {
  const where = [];
  const params = [];
  const inList = (col, value, allowed) => {
    const vals = String(value || '').split(',').filter((v) => allowed.includes(v));
    if (vals.length) { where.push(`${col} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); }
  };
  inList('x.type', q.type, Object.keys(finance.TYPES));
  inList('x.method', q.method, Object.keys(finance.METHODS));
  inList('x.status', q.status, finance.STATUSES);
  inList('x.account', q.account, Object.keys(finance.ACCOUNTS));
  if (ISO_DATE.test(q.from || '')) { where.push('x.date_received >= ?'); params.push(q.from); }
  if (ISO_DATE.test(q.to || '')) { where.push('x.date_received <= ?'); params.push(q.to); }
  if (q.min !== undefined && q.min !== '' && Number.isFinite(Number(q.min))) { where.push('x.amount_gbp >= ?'); params.push(Number(q.min)); }
  if (q.max !== undefined && q.max !== '' && Number.isFinite(Number(q.max))) { where.push('x.amount_gbp <= ?'); params.push(Number(q.max)); }
  if (Number(q.member)) { where.push('x.member_id = ?'); params.push(Number(q.member)); }
  if (Number(q.donation)) { where.push('x.donation_id = ?'); params.push(Number(q.donation)); }
  if (q.flag === 'self_verified') where.push('x.self_verified = 1');
  if (q.flag === 'no_rate') where.push('x.amount_gbp IS NULL');
  if (q.flag === 'not_kenyan') where.push("x.type = 'donation' AND COALESCE(x.donor_kenyan, 'unknown') <> 'yes'");
  if (q.q) {
    const like = likeParam(q.q);
    where.push('(x.payer_name LIKE ? OR x.payer_email LIKE ? OR x.receipt_no LIKE ? OR x.external_ref LIKE ? OR m.reference LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return { where, params };
}

const TX_SELECT = `x.id, x.receipt_no, x.type, x.amount, x.currency, x.fx_rate, x.amount_gbp, x.method, x.account, x.account_label,
  x.member_id, x.donation_id, x.payer_name, x.payer_email, x.donor_kenyan, x.date_received, x.external_ref, x.notes, x.status, x.source,
  x.recorded_by, x.recorded_at, x.verified_by, x.verified_at, x.self_verified, x.reconciled_by, x.reconciled_at,
  x.rejected_reason, x.void_reason, x.voided_by, x.voided_at, m.reference AS member_reference, m.chapter AS member_chapter, d.reference AS donation_reference`;
const TX_FROM = 'transactions x LEFT JOIN members m ON m.id = x.member_id LEFT JOIN donations d ON d.id = x.donation_id';

router.get('/transactions', need('finance.read'), wrap(async (req, res) => {
  const { where, params } = txFilters(req.query);
  const { rows, ...page } = await paged(db, { select: TX_SELECT, from: TX_FROM, where, params, p: pageParams(req.query, TX_SORTS, 'date'), tiebreak: 'x.id DESC' });
  const totals = await db.one(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN x.status IN ${finance.COUNTED} THEN ${finance.SIGNED_GBP} ELSE 0 END), 0) AS net_gbp,
      COALESCE(SUM(CASE WHEN x.status = 'pending' THEN x.amount_gbp ELSE 0 END), 0) AS pending_gbp
    FROM ${TX_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  const settings = await finance.getFinanceSettings();
  res.json({ transactions: rows, ...page, totals, requireSecondVerifier: settings.requireSecondVerifier });
}));

const TX_EXPORT = [
  ['date_received', 'Date received'], ['receipt_no', 'Receipt'], ['type_label', 'Type'], ['status', 'Status'], ['payer_name', 'Payer'],
  ['member_reference', 'Member ref'], ['payer_email', 'Payer email'], ['amount', 'Amount', 'money'], ['currency', 'Currency'], ['fx_rate', 'Rate (per £1)'],
  ['amount_gbp', 'GBP', 'gbp'], ['method_label', 'Method'], ['account_label', 'Paid into'], ['external_ref', 'External ref'], ['donor_kenyan', 'Donor Kenyan'],
  ['recorded_by', 'Recorded by'], ['verified_by', 'Verified by'], ['self_verified', 'Self-verified'], ['void_reason', 'Void reason'], ['notes', 'Notes'],
];
router.get('/transactions/export', need('finance.read'), wrap(async (req, res) => {
  const { where, params } = txFilters(req.query);
  const p = pageParams(req.query, TX_SORTS, 'date');
  const rows = (await db.query(`SELECT ${TX_SELECT} FROM ${TX_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${p.orderBy}, x.id DESC`, params))
    .map((r) => ({ ...r, type_label: finance.TYPES[r.type]?.label, method_label: finance.METHODS[r.method], self_verified: r.self_verified ? 'yes' : '' }));
  await sendTable(req, res, 'dcp-uk-transactions', 'Transactions', TX_EXPORT, rows);
}));

router.get('/transactions/:id', need('finance.read'), wrap(async (req, res) => {
  const tx = await db.one(`SELECT ${TX_SELECT}, m.full_name AS member_name FROM ${TX_FROM} WHERE x.id = ?`, [Number(req.params.id) || 0]);
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  const history = await db.query("SELECT at, actor, action, summary, flags FROM audit_log WHERE entity = 'transaction' AND entity_id = ? ORDER BY id", [String(tx.id)]);
  const settings = await finance.getFinanceSettings();
  res.json({ transaction: tx, history, requireSecondVerifier: settings.requireSecondVerifier, receiptUrl: tx.receipt_no ? finance.receiptUrl(tx) : null });
}));

router.post('/transactions', need('finance.write'), wrap(async (req, res) => {
  const id = await finance.recordTransaction(req.body || {}, who(req));
  res.status(201).json({ id });
}));

router.put('/transactions/:id', need('finance.write'), wrap(async (req, res) => {
  await finance.updateTransaction(Number(req.params.id), req.body || {}, who(req));
  res.json({ ok: true });
}));

router.post('/transactions/:id/verify', need('finance.write'), wrap(async (req, res) => {
  const { receipt, self, tx } = await finance.verifyTransaction(Number(req.params.id), who(req));
  let emailed = false;
  if (receipt) {
    try { emailed = Boolean(await finance.emailReceipt(tx)); } catch (err) { console.error('Receipt email:', err.message); }
  }
  res.json({ ok: true, receipt, selfVerified: self, emailed });
}));
router.post('/transactions/:id/reconcile', need('finance.write'), wrap(async (req, res) => {
  await finance.reconcileTransaction(Number(req.params.id), who(req));
  res.json({ ok: true });
}));
router.post('/transactions/:id/reject', need('finance.write'), wrap(async (req, res) => {
  await finance.rejectTransaction(Number(req.params.id), req.body?.reason, who(req));
  res.json({ ok: true });
}));
router.post('/transactions/:id/void', need('finance.write'), wrap(async (req, res) => {
  await finance.voidTransaction(Number(req.params.id), req.body?.reason, who(req));
  res.json({ ok: true });
}));

router.get('/transactions/:id/receipt', need('finance.read'), wrap(async (req, res) => {
  const tx = await db.one('SELECT * FROM transactions WHERE id = ?', [Number(req.params.id) || 0]);
  if (!tx || !tx.receipt_no) return res.status(404).send('No receipt has been issued for this transaction yet.');
  const member = tx.member_id ? await db.one('SELECT reference FROM members WHERE id = ?', [tx.member_id]) : null;
  res.set('Cache-Control', 'no-store').send(finance.renderReceiptPage(tx, member));
}));

router.get('/members/:id/finance', need('members.read'), wrap(async (req, res) => {
  const f = await finance.memberFinance(Number(req.params.id) || 0);
  if (!f) return res.status(404).json({ error: 'Member not found.' });
  const transactions = await db.query(`SELECT id, receipt_no, type, amount, currency, amount_gbp, status, date_received, method, self_verified
    FROM transactions WHERE member_id = ? ORDER BY date_received DESC, id DESC LIMIT 50`, [Number(req.params.id)]);
  res.json({ finance: f, transactions });
}));

// ---------------------------------------------------------------- reports

function range(q) {
  const today = new Date().toISOString().slice(0, 10);
  const from = ISO_DATE.test(q.from || '') ? q.from : `${today.slice(0, 4)}-01-01`;
  const to = ISO_DATE.test(q.to || '') ? q.to : today;
  return { from, to };
}
function reportWhere(q) {
  const { from, to } = range(q);
  const where = [`x.status IN ${finance.COUNTED}`, 'x.date_received BETWEEN ? AND ?'];
  const params = [from, to];
  if (finance.TYPES[q.type]) { where.push('x.type = ?'); params.push(q.type); }
  if (finance.METHODS[q.method]) { where.push('x.method = ?'); params.push(q.method); }
  if (q.chapter) { where.push("COALESCE(m.chapter, 'Not linked to a member') = ?"); params.push(String(q.chapter)); }
  return { where: where.join(' AND '), params, from, to };
}

router.get('/reports/summary', need('finance.read'), wrap(async (req, res) => {
  const { where, params, from, to } = reportWhere(req.query);
  const base = `FROM transactions x LEFT JOIN members m ON m.id = x.member_id WHERE ${where}`;
  const group = (col) => db.query(`SELECT ${col} AS k, COUNT(*) AS n, SUM(${finance.SIGNED_GBP}) AS gbp ${base} GROUP BY k ORDER BY gbp DESC`, params);
  const [byType, byMethod, byChapter, byMonth, totals, pending, donations, declarations] = await Promise.all([
    group('x.type'), group('x.method'), group("COALESCE(m.chapter, 'Not linked to a member')"),
    db.query(`SELECT DATE_FORMAT(x.date_received, '%Y-%m') AS k, SUM(CASE WHEN x.type IN ('refund','expense') THEN 0 ELSE x.amount_gbp END) AS income,
      SUM(CASE WHEN x.type IN ('refund','expense') THEN x.amount_gbp ELSE 0 END) AS out_gbp ${base} GROUP BY k ORDER BY k`, params),
    db.one(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN x.type IN ('refund','expense') THEN 0 ELSE x.amount_gbp END), 0) AS income,
      COALESCE(SUM(CASE WHEN x.type IN ('refund','expense') THEN x.amount_gbp ELSE 0 END), 0) AS out_gbp ${base}`, params),
    db.one("SELECT COUNT(*) AS n, COALESCE(SUM(amount_gbp), 0) AS gbp, SUM(amount_gbp IS NULL) AS no_rate FROM transactions WHERE status = 'pending'"),
    db.one(`SELECT COUNT(*) AS pledges, COALESCE(SUM(amount_gbp), 0) AS pledged_gbp, SUM(status = 'received') AS received, SUM(status = 'pledged') AS open
      FROM donations WHERE DATE(created_at) BETWEEN ? AND ?`, [from, to]),
    db.query(`SELECT COALESCE(x.donor_kenyan, 'unknown') AS k, COUNT(*) AS n, SUM(x.amount_gbp) AS gbp ${base} AND x.type = 'donation' GROUP BY k`, params),
  ]);
  const num = (rows) => rows.map((r) => ({ ...r, n: Number(r.n), gbp: Number(r.gbp || 0) }));
  res.json({
    from, to, totals: { n: Number(totals.n), income: Number(totals.income), out: Number(totals.out_gbp), net: Number(totals.income) - Number(totals.out_gbp) },
    byType: num(byType).map((r) => ({ ...r, label: finance.TYPES[r.k]?.label || r.k })),
    byMethod: num(byMethod).map((r) => ({ ...r, label: finance.METHODS[r.k] || r.k })),
    byChapter: num(byChapter), byMonth: byMonth.map((r) => ({ month: r.k, income: Number(r.income || 0), out: Number(r.out_gbp || 0) })),
    pending: { n: Number(pending.n), gbp: Number(pending.gbp), noRate: Number(pending.no_rate || 0) },
    donations: { pledges: Number(donations.pledges), pledgedGbp: Number(donations.pledged_gbp), received: Number(donations.received || 0), open: Number(donations.open || 0),
      byDeclaration: num(declarations) },
  });
}));

// Members who owe money for their current tier, most owed first.
const OUT_SORTS = { balance: 'balance', name: 'm.full_name', chapter: 'm.chapter', registered: 'm.created_at' };
function outstandingQuery(q) {
  const where = [`${finance.BALANCE_EXPR} > 0`, "m.status <> 'rejected'"];
  const params = [];
  if (q.chapter) { where.push('m.chapter = ?'); params.push(String(q.chapter)); }
  if (Number(q.tier)) { where.push('m.tier_id = ?'); params.push(Number(q.tier)); }
  if (['pending', 'approved'].includes(q.status)) { where.push('m.status = ?'); params.push(q.status); }
  if (q.q) { const like = likeParam(q.q); where.push('(m.full_name LIKE ? OR m.email LIKE ? OR m.reference LIKE ?)'); params.push(like, like, like); }
  return { where, params };
}
const OUT_SELECT = `m.id, m.reference, m.full_name, m.email, m.phone, m.chapter, m.status, m.payment_status, m.fee_review, t.name AS tier_name,
  ${finance.BALANCE_EXPR} AS balance, COALESCE(m.billing_start, DATE(m.created_at)) AS billing_start,
  COALESCE((SELECT MAX(x.date_received) FROM transactions x WHERE x.member_id = m.id AND x.status IN ${finance.COUNTED}), NULL) AS last_paid`;
router.get('/reports/outstanding', need('finance.read'), wrap(async (req, res) => {
  const { where, params } = outstandingQuery(req.query);
  const { rows, ...page } = await paged(db, { select: OUT_SELECT, from: 'members m LEFT JOIN membership_tiers t ON t.id = m.tier_id', where, params, p: pageParams(req.query, OUT_SORTS, 'balance'), tiebreak: 'm.id' });
  const total = await db.one(`SELECT COALESCE(SUM(${finance.BALANCE_EXPR}), 0) AS owed FROM members m LEFT JOIN membership_tiers t ON t.id = m.tier_id WHERE ${where.join(' AND ')}`, params);
  res.json({ members: rows.map((r) => ({ ...r, balance: Number(r.balance) })), ...page, owed: Number(total.owed) });
}));

// Payment reminders: one service email per member about their own balance.
router.post('/reports/outstanding/remind', need('finance.write'), wrap(async (req, res) => {
  const email = require('../lib/email');
  const ids = [...new Set((req.body?.memberIds || []).map(Number).filter(Boolean))].slice(0, 500);
  if (!ids.length) return res.status(400).json({ error: 'Choose the members to remind.' });
  let sent = 0;
  const skipped = [];
  for (const id of ids) {
    const f = await finance.memberFinance(id);
    const m = await db.one('SELECT id, full_name, reference, email FROM members WHERE id = ?', [id]);
    if (!f || !m || f.balance <= 0) { skipped.push(id); continue; }
    const audience = await email.resolveAudience({ to: [{ memberId: id }] });
    const html = `<p>Dear {{first_name}},</p>
<p>Our records show <strong>£${f.balance.toFixed(2)}</strong> is due on your DCP UK membership (${f.tier ? f.tier.name : 'membership'}, reference <strong>{{reference}}</strong>).</p>
<p>The payment details are on the Membership page of our website. If you have already paid, please reply with the M-Pesa or bank transaction code so we can match it.</p>
<p>Thank you,<br>DCP UK Treasurer</p>`;
    await email.createOutgoing({ admin: req.admin.username, audience, subject: 'Your DCP UK membership fee', html, template: 'payment_reminder', source: 'system' });
    sent++;
  }
  await audit.record(null, { ...who(req), action: 'reminders.sent', entity: 'report', entityId: 'outstanding', summary: `Payment reminders queued for ${sent} member(s)` });
  res.json({ ok: true, sent, skipped: skipped.length });
}));

// Exports: income (transactions in range), outstanding fees, donations, donor totals by period.
router.get('/reports/export', need('finance.read'), wrap(async (req, res) => {
  const kind = req.query.kind;
  if (kind === 'income') {
    const { where, params, from, to } = reportWhere(req.query);
    const rows = (await db.query(`SELECT ${TX_SELECT} FROM ${TX_FROM} WHERE ${where} ORDER BY x.date_received, x.id`, params))
      .map((r) => ({ ...r, type_label: finance.TYPES[r.type]?.label, method_label: finance.METHODS[r.method], self_verified: r.self_verified ? 'yes' : '' }));
    return sendTable(req, res, `dcp-uk-income-${from}-to-${to}`, 'Income', TX_EXPORT, rows);
  }
  if (kind === 'outstanding') {
    const { where, params } = outstandingQuery(req.query);
    const rows = await db.query(`SELECT ${OUT_SELECT} FROM members m LEFT JOIN membership_tiers t ON t.id = m.tier_id WHERE ${where.join(' AND ')} ORDER BY balance DESC`, params);
    return sendTable(req, res, 'dcp-uk-outstanding-fees', 'Outstanding fees', [
      ['reference', 'Reference'], ['full_name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['chapter', 'Chapter'], ['tier_name', 'Tier'],
      ['status', 'Status'], ['balance', 'Balance due', 'gbp'], ['billing_start', 'Fees counted from'], ['last_paid', 'Last payment'],
    ], rows);
  }
  if (kind === 'donations') {
    const { from, to } = range(req.query);
    const rows = await db.query(`SELECT d.reference, d.created_at, d.full_name, d.email, d.amount_gbp AS pledged_gbp, d.frequency, d.status, d.donor_kenyan,
        COALESCE((SELECT SUM(x.amount_gbp) FROM transactions x WHERE x.donation_id = d.id AND x.status IN ${finance.COUNTED}), 0) AS received_gbp
      FROM donations d WHERE DATE(d.created_at) BETWEEN ? AND ? ORDER BY d.created_at`, [from, to]);
    return sendTable(req, res, `dcp-uk-donations-${from}-to-${to}`, 'Donations', [
      ['reference', 'Reference'], ['created_at', 'Pledged (UTC)'], ['full_name', 'Donor'], ['email', 'Email'], ['pledged_gbp', 'Pledged', 'gbp'],
      ['frequency', 'Frequency'], ['status', 'Status'], ['received_gbp', 'Received', 'gbp'], ['donor_kenyan', 'Kenyan citizen (declared)'],
    ], rows);
  }
  if (kind === 'donors') {
    // One row per donor per period, for reporting to party HQ.
    const { from, to } = range(req.query);
    const fmt = { month: '%Y-%m', quarter: null, year: '%Y' }[req.query.period] !== undefined ? req.query.period : 'month';
    const periodSql = fmt === 'quarter' ? "CONCAT(YEAR(x.date_received), '-Q', QUARTER(x.date_received))" : `DATE_FORMAT(x.date_received, '${fmt === 'year' ? '%Y' : '%Y-%m'}')`;
    const rows = await db.query(`SELECT ${periodSql} AS period, MIN(x.payer_name) AS donor, LOWER(COALESCE(x.payer_email, '')) AS email,
        COUNT(*) AS donations, SUM(x.amount_gbp) AS total_gbp,
        CASE WHEN SUM(COALESCE(x.donor_kenyan, 'unknown') = 'yes') = COUNT(*) THEN 'yes'
             WHEN SUM(x.donor_kenyan = 'no') > 0 THEN 'no' ELSE 'unknown' END AS kenyan,
        GROUP_CONCAT(COALESCE(x.receipt_no, CONCAT('tx ', x.id)) ORDER BY x.date_received SEPARATOR ' ') AS receipts
      FROM transactions x WHERE x.type = 'donation' AND x.status IN ${finance.COUNTED} AND x.date_received BETWEEN ? AND ?
      GROUP BY period, LOWER(COALESCE(NULLIF(x.payer_email, ''), x.payer_name)), email ORDER BY period, total_gbp DESC`, [from, to]);
    const out = rows.map((r) => ({ ...r, total_gbp: Number(r.total_gbp), flag: r.kenyan === 'yes' ? '' : 'CHECK: donor has not declared Kenyan citizenship' }));
    return sendTable(req, res, `dcp-uk-donors-by-${fmt}-${from}-to-${to}`, 'Donors', [
      ['period', 'Period'], ['donor', 'Donor'], ['email', 'Email'], ['donations', 'Donations', 'int'], ['total_gbp', 'Total', 'gbp'],
      ['kenyan', 'Kenyan citizen (declared)'], ['flag', 'Flag'], ['receipts', 'Receipts'],
    ], out);
  }
  res.status(400).json({ error: 'Unknown report.' });
}));

// ---------------------------------------------------------------- audit log (read-only)

const AUDIT_SORTS = { at: 'a.id' };
router.get('/audit', need('audit.read'), wrap(async (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  if (q.entity) { where.push('a.entity = ?'); params.push(String(q.entity)); }
  if (q.entityId) { where.push('a.entity_id = ?'); params.push(String(q.entityId)); }
  if (q.actor) { where.push('a.actor LIKE ?'); params.push(likeParam(q.actor)); }
  if (q.flagged === '1') where.push('a.flags IS NOT NULL');
  if (ISO_DATE.test(q.from || '')) { where.push('a.at >= ?'); params.push(`${q.from} 00:00:00`); }
  if (ISO_DATE.test(q.to || '')) { where.push('a.at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(q.to); }
  if (q.q) { const like = likeParam(q.q); where.push('(a.summary LIKE ? OR a.action LIKE ? OR a.entity_id LIKE ?)'); params.push(like, like, like); }
  const { rows, ...page } = await paged(db, {
    select: 'a.id, a.at, a.actor_type, a.actor, a.action, a.entity, a.entity_id, a.summary, a.before_json, a.after_json, a.flags',
    from: 'audit_log a', where, params, p: pageParams(q, AUDIT_SORTS, 'at'), tiebreak: 'a.id DESC',
  });
  res.json({ entries: rows, ...page });
}));

module.exports = router;
