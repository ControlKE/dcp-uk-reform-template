// The finance ledger: recording, verifying and voiding payments, member balances,
// pledge status, receipts. Every change is written to the audit log inside the same
// database transaction as the change itself.
const db = require('./db');
const audit = require('./audit');
const settings = require('./settings');
const mailer = require('./mailer');

const TYPES = {
  membership_fee: { label: 'Membership fee', fee: true },
  stakeholder_membership: { label: 'Stakeholder membership', fee: true },
  visit_contribution: { label: 'Visit contribution', fee: true },
  donation: { label: 'Donation' },
  other_income: { label: 'Other income' },
  refund: { label: 'Refund', out: true },
  expense: { label: 'Expense', out: true },
};
const METHODS = { mpesa_paybill: 'M-Pesa Paybill', mpesa_till: 'M-Pesa Till', bank_transfer: 'Bank transfer', cash: 'Cash', card_online: 'Card / online' };
const CURRENCIES = ['GBP', 'KES', 'USD', 'EUR'];
const ACCOUNTS = { fee_account: 'Membership fee account', donations_account: 'Donations bank account', other: 'Other (cash or another account)' };
const STATUSES = ['pending', 'verified', 'reconciled', 'rejected', 'void'];
const DONOR_KENYAN = ['yes', 'no', 'unknown'];
const FEE_TYPES = Object.keys(TYPES).filter((t) => TYPES[t].fee);
const COUNTED = "('verified', 'reconciled')";

class FinanceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const q2 = (list) => list.map((x) => `'${x}'`).join(', ');

// Signed amount in GBP for sums: refunds and expenses count as money out.
const SIGNED_GBP = "(CASE WHEN x.type IN ('refund', 'expense') THEN -x.amount_gbp ELSE x.amount_gbp END)";

// ---------------------------------------------------------------- settings and tiers

const FINANCE_DEFAULTS = { requireSecondVerifier: true };
async function getFinanceSettings(q = db) {
  const row = await q.one("SELECT value, updated_at, updated_by FROM settings WHERE `key` = 'finance'");
  return { ...FINANCE_DEFAULTS, ...(row ? JSON.parse(row.value) : {}), updatedAt: row?.updated_at || null, updatedBy: row?.updated_by || null };
}
async function saveFinanceSettings(input, who) {
  const value = { requireSecondVerifier: input.requireSecondVerifier !== false };
  return db.transaction(async (q) => {
    const before = await getFinanceSettings(q);
    await q.query("INSERT INTO settings (`key`, value, updated_at, updated_by) VALUES ('finance', ?, UTC_TIMESTAMP(), ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)",
      [JSON.stringify(value), who.actor]);
    await audit.record(q, { ...who, action: 'settings.finance', entity: 'settings', entityId: 'finance',
      summary: `Four-eyes check ${value.requireSecondVerifier ? 'on' : 'OFF'}`, before: { requireSecondVerifier: before.requireSecondVerifier }, after: value,
      flags: value.requireSecondVerifier ? [] : ['four_eyes_off'] });
    return getFinanceSettings(q);
  });
}

const listTiers = (q = db) => q.query('SELECT id, tkey, name, amount, currency, display_kes, renewal, tx_type, active, sort, updated_at, updated_by FROM membership_tiers ORDER BY sort, id');

// What the public pages show: active tiers, in order. displayKes is approximate
// and for display only; dues are always the GBP amount.
async function publicTiers(q = db) {
  const rows = await q.query('SELECT tkey, name, amount, display_kes, renewal FROM membership_tiers WHERE active = 1 ORDER BY sort, id');
  return rows.map((t) => ({ key: t.tkey, name: t.name, amount: Number(t.amount), renewal: t.renewal, displayKes: t.display_kes === null ? null : Number(t.display_kes) }));
}

const gbpText = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;
// "Ordinary membership: £20 a year, renewed annually. Stakeholder membership: £500 a year.
// Visit contribution: £200, one-off." Only the first yearly tier says "renewed annually".
function tierSentence(tiers) {
  let saidRenewal = false;
  return tiers.map((t) => {
    if (t.renewal !== 'yearly') return `${t.name}: ${gbpText(t.amount)}, one-off.`;
    const tail = saidRenewal ? '' : ', renewed annually';
    saidRenewal = true;
    return `${t.name}: ${gbpText(t.amount)} a year${tail}.`;
  }).join(' ');
}

async function updateTier(id, input, who) {
  const name = String(input.name || '').trim().slice(0, 80);
  const amount = round2(input.amount);
  const renewal = input.renewal;
  const kesInput = input.displayKes === undefined || input.displayKes === null ? '' : String(input.displayKes).trim();
  const displayKes = kesInput === '' ? null : Math.round(Number(kesInput));
  if (name.length < 2) throw new FinanceError('Give the tier a name.');
  if (!(amount > 0) || amount > 100000) throw new FinanceError('Enter an amount between £0.01 and £100,000.');
  if (!['yearly', 'one_off'].includes(renewal)) throw new FinanceError('Renewal must be yearly or one-off.');
  if (displayKes !== null && !(displayKes >= 1 && displayKes <= 100000000)) throw new FinanceError('The approximate KES amount must be a whole number, or left blank.');
  return db.transaction(async (q) => {
    const before = await q.one('SELECT name, amount, display_kes, renewal, active FROM membership_tiers WHERE id = ? FOR UPDATE', [Number(id) || 0]);
    if (!before) throw new FinanceError('Tier not found.', 404);
    const after = { name, amount, display_kes: displayKes, renewal, active: input.active === false ? 0 : 1 };
    await q.query('UPDATE membership_tiers SET name = ?, amount = ?, display_kes = ?, renewal = ?, active = ?, updated_at = UTC_TIMESTAMP(), updated_by = ? WHERE id = ?', [name, amount, displayKes, renewal, after.active, who.actor, id]);
    const d = audit.diff(before, after);
    await audit.record(q, { ...who, action: 'tier.updated', entity: 'tier', entityId: id, summary: `Tier "${name}" updated`, ...d });
  });
}

// ---------------------------------------------------------------- member balances

// Dues and payments for members, in SQL so lists, reports and the member view agree.
// Yearly tiers bill one period per year from billing_start (the first period
// immediately); one-off tiers bill once. Payments are verified fee transactions,
// less refunds linked to the member.
const MEMBER_BALANCE_SELECT = `
  t.id AS tier_id, t.name AS tier_name, t.amount AS tier_amount, t.renewal AS tier_renewal, t.tx_type AS tier_tx_type,
  (CASE WHEN t.id IS NULL THEN 0 WHEN t.renewal = 'yearly' THEN TIMESTAMPDIFF(YEAR, COALESCE(m.billing_start, DATE(m.created_at)), UTC_DATE()) + 1 ELSE 1 END) AS periods,
  COALESCE((SELECT SUM(${SIGNED_GBP}) FROM transactions x WHERE x.member_id = m.id AND x.status IN ${COUNTED}
    AND x.type IN (${q2([...FEE_TYPES, 'refund'])})), 0) AS paid_gbp,
  COALESCE((SELECT SUM(x.amount_gbp) FROM transactions x WHERE x.member_id = m.id AND x.status = 'pending'), 0) AS pending_gbp`;
const BALANCE_EXPR = `((CASE WHEN t.id IS NULL THEN 0 WHEN t.renewal = 'yearly' THEN TIMESTAMPDIFF(YEAR, COALESCE(m.billing_start, DATE(m.created_at)), UTC_DATE()) + 1 ELSE 1 END) * COALESCE(t.amount, 0)
  - COALESCE((SELECT SUM(${SIGNED_GBP}) FROM transactions x WHERE x.member_id = m.id AND x.status IN ${COUNTED} AND x.type IN (${q2([...FEE_TYPES, 'refund'])})), 0))`;

const addYears = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
};

// Everything the member view shows about money.
async function memberFinance(memberId, q = db) {
  const row = await q.one(`SELECT m.id, m.payment_status, m.membership_start, m.fee_review, m.fee_review_reason, m.fee_amount, m.fee_currency,
      COALESCE(m.billing_start, DATE(m.created_at)) AS billing_start, ${MEMBER_BALANCE_SELECT}
    FROM members m LEFT JOIN membership_tiers t ON t.id = m.tier_id WHERE m.id = ?`, [memberId]);
  if (!row) return null;
  const amount = Number(row.tier_amount || 0);
  const due = round2(Number(row.periods) * amount);
  const paid = round2(row.paid_gbp);
  const balance = round2(due - paid);
  const yearly = row.tier_renewal === 'yearly';
  const periodStart = yearly ? addYears(row.billing_start, Number(row.periods) - 1) : row.billing_start;
  return {
    tier: row.tier_id ? { id: row.tier_id, name: row.tier_name, amount, renewal: row.tier_renewal, txType: row.tier_tx_type } : null,
    billingStart: row.billing_start, membershipStart: row.membership_start,
    periods: Number(row.periods), due, paid, balance, pending: round2(row.pending_gbp),
    currentPeriodStart: periodStart,
    nextRenewal: yearly ? addYears(row.billing_start, Number(row.periods)) : null,
    paidUntil: yearly && amount > 0 && paid >= amount ? addYears(row.billing_start, Math.floor(paid / amount)) : null,
    state: balance <= 0 ? 'up_to_date' : paid > 0 ? 'part_paid' : 'unpaid',
    feeReview: Boolean(row.fee_review), feeReviewReason: row.fee_review_reason,
    registrationFee: { amount: row.fee_amount, currency: row.fee_currency },
  };
}

// Brings a member's payment status and membership start in line with the ledger.
// "Paid (confirmed)" only ever comes from verified transactions.
async function syncMember(q, memberId, who) {
  const m = await q.one('SELECT id, payment_status, membership_start FROM members WHERE id = ? FOR UPDATE', [memberId]);
  if (!m) return;
  const f = await memberFinance(memberId, q);
  const first = await q.one(`SELECT MIN(date_received) AS d, COUNT(*) AS n FROM transactions WHERE member_id = ? AND status IN ${COUNTED} AND type IN (${q2(FEE_TYPES)})`, [memberId]);
  let status = m.payment_status;
  if (Number(first.n) > 0 && f.balance <= 0) status = 'paid';
  else if (m.payment_status === 'paid') status = 'pending_payment';
  const start = first.d || null;
  if (status !== m.payment_status || String(start || '') !== String(m.membership_start || '')) {
    await q.query('UPDATE members SET payment_status = ?, membership_start = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [status, start, memberId]);
    await audit.record(q, { ...who, action: 'member.payment_synced', entity: 'member', entityId: memberId,
      summary: `Payment status ${m.payment_status} → ${status} (balance £${f.balance.toFixed(2)})`,
      before: { payment_status: m.payment_status, membership_start: m.membership_start }, after: { payment_status: status, membership_start: start } });
  }
}

// A pledge is "received" exactly when a verified transaction is linked to it.
async function syncPledge(q, donationId, who) {
  const d = await q.one('SELECT id, status FROM donations WHERE id = ? FOR UPDATE', [donationId]);
  if (!d || d.status === 'cancelled') return;
  const n = Number((await q.one(`SELECT COUNT(*) AS n FROM transactions WHERE donation_id = ? AND status IN ${COUNTED}`, [donationId])).n);
  const status = n ? 'received' : 'pledged';
  if (status !== d.status) {
    await q.query('UPDATE donations SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [status, donationId]);
    await audit.record(q, { ...who, action: 'donation.status_synced', entity: 'donation', entityId: donationId,
      summary: `Pledge ${d.status} → ${status} (linked transactions)`, before: { status: d.status }, after: { status } });
  }
}

async function applyEffects(q, tx, who) {
  if (tx.member_id && (TYPES[tx.type]?.fee || tx.type === 'refund')) await syncMember(q, tx.member_id, who);
  if (tx.donation_id) await syncPledge(q, tx.donation_id, who);
}

// ---------------------------------------------------------------- recording

async function accountLabel(account) {
  if (account === 'fee_account') {
    const { value: f } = await settings.getSetting('feeAccount');
    const detail = f.method === 'mpesa_paybill' ? `M-Pesa Paybill ${f.paybillNumber}` : f.method === 'mpesa_till' ? `M-Pesa Till ${f.tillNumber}` : [f.bankName, f.accountNumber && `acct ${f.accountNumber}`].filter(Boolean).join(' ');
    return [f.accountName, detail].filter(Boolean).join(' · ') || ACCOUNTS.fee_account;
  }
  if (account === 'donations_account') {
    const { value: d } = await settings.getSetting('donationAccount');
    return [d.accountName, d.bankName, d.sortCode && `sort code ${d.sortCode}`, d.accountNumber && `acct ${d.accountNumber}`].filter(Boolean).join(' · ') || ACCOUNTS.donations_account;
  }
  return ACCOUNTS.other;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

// Checks and normalises a transaction from the Record payment form.
async function validate(input, { allowMissingRate = false } = {}) {
  const errors = {};
  const v = {};
  v.type = String(input.type || '');
  if (!TYPES[v.type]) errors.type = 'Choose what the payment is for.';
  v.amount = round2(input.amount);
  if (!(v.amount > 0) || v.amount > 10000000) errors.amount = 'Enter the amount received (more than 0).';
  v.currency = String(input.currency || 'GBP').toUpperCase();
  if (!CURRENCIES.includes(v.currency)) errors.currency = 'Choose GBP, KES, USD or EUR.';
  if (v.currency === 'GBP') v.fx_rate = 1;
  else {
    const rate = Number(input.fxRate);
    if (input.fxRate === '' || input.fxRate == null) {
      if (!allowMissingRate) errors.fxRate = `Enter the exchange rate used: how many ${v.currency} to 1 GBP.`;
      v.fx_rate = null;
    } else if (!(rate > 0) || rate > 100000) errors.fxRate = `Enter how many ${v.currency} make 1 GBP (e.g. 165.5).`;
    else v.fx_rate = Math.round(rate * 1e6) / 1e6;
  }
  v.amount_gbp = v.fx_rate ? round2(v.amount / v.fx_rate) : null;
  v.method = String(input.method || '');
  if (!METHODS[v.method]) errors.method = 'Choose how it was paid.';
  v.account = String(input.account || '');
  if (!ACCOUNTS[v.account]) errors.account = 'Choose the account it was paid into.';
  v.date_received = String(input.dateReceived || '');
  const today = new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(v.date_received) || v.date_received < '2020-01-01' || v.date_received > today) errors.dateReceived = 'Enter the date the money arrived (not in the future).';
  v.member_id = Number(input.memberId) || null;
  v.donation_id = Number(input.donationId) || null;
  v.payer_name = String(input.payerName || '').trim().slice(0, 120);
  v.payer_email = String(input.payerEmail || '').trim().toLowerCase().slice(0, 200) || null;
  if (v.payer_email && !EMAIL_RE.test(v.payer_email)) errors.payerEmail = 'Enter a valid email address, or leave it empty.';
  v.external_ref = String(input.externalRef || '').trim().slice(0, 100) || null;
  v.notes = String(input.notes || '').trim().slice(0, 2000) || null;
  v.donor_kenyan = null;

  if (v.member_id) {
    const m = await db.one('SELECT id, full_name, email FROM members WHERE id = ?', [v.member_id]);
    if (!m) errors.memberId = 'That member no longer exists.';
    else { v.payer_name ||= m.full_name; v.payer_email ||= m.email; }
  } else if (TYPES[v.type]?.fee) errors.memberId = 'Choose the member this fee is for.';
  if (v.donation_id) {
    const d = await db.one('SELECT id, full_name, email, donor_kenyan, status FROM donations WHERE id = ?', [v.donation_id]);
    if (!d) errors.donationId = 'That pledge no longer exists.';
    else if (v.type !== 'donation') errors.donationId = 'Only donations can be linked to a pledge.';
    else if (d.status === 'cancelled') errors.donationId = 'That pledge was cancelled.';
    else { v.payer_name ||= d.full_name; v.payer_email ||= d.email; }
  }
  if (v.type === 'donation') {
    v.donor_kenyan = DONOR_KENYAN.includes(input.donorKenyan) ? input.donorKenyan : 'unknown';
  }
  if (!v.payer_name) errors.payerName = 'Enter who paid.';
  if (Object.keys(errors).length) throw Object.assign(new FinanceError('Please correct the highlighted fields.'), { fields: errors });
  v.account_label = await accountLabel(v.account);
  return v;
}

const COLUMNS = ['type', 'amount', 'currency', 'fx_rate', 'amount_gbp', 'method', 'account', 'account_label', 'member_id', 'donation_id',
  'payer_name', 'payer_email', 'donor_kenyan', 'date_received', 'external_ref', 'notes'];

async function recordTransaction(input, who, { source = 'admin' } = {}) {
  const v = await validate(input, { allowMissingRate: source === 'member_report' });
  return db.transaction(async (q) => {
    const r = await q.query(`INSERT INTO transactions (${COLUMNS.join(', ')}, status, source, recorded_by, recorded_at, updated_at)
      VALUES (${COLUMNS.map(() => '?').join(', ')}, 'pending', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [...COLUMNS.map((c) => v[c]), source, who.actor]);
    await audit.record(q, { ...who, action: 'transaction.recorded', entity: 'transaction', entityId: r.insertId,
      summary: `${TYPES[v.type].label}: ${v.currency} ${v.amount.toFixed(2)}${v.currency !== 'GBP' ? ` (£${v.amount_gbp == null ? '?' : v.amount_gbp.toFixed(2)} at ${v.fx_rate ?? '?'})` : ''} from ${v.payer_name}`,
      after: Object.fromEntries(COLUMNS.map((c) => [c, v[c]])) });
    return r.insertId;
  });
}

// Pending transactions can be corrected; anything verified is fixed (void it instead).
async function updateTransaction(id, input, who) {
  const current = await db.one('SELECT * FROM transactions WHERE id = ?', [id]);
  if (!current) throw new FinanceError('Transaction not found.', 404);
  if (current.status !== 'pending') throw new FinanceError('Only pending transactions can be edited. Void a verified one and record it again.');
  const v = await validate(input, { allowMissingRate: current.source === 'member_report' });
  return db.transaction(async (q) => {
    const locked = await q.one('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [id]);
    if (locked.status !== 'pending') throw new FinanceError('This transaction has just been verified by someone else.');
    await q.query(`UPDATE transactions SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...COLUMNS.map((c) => v[c]), id]);
    const d = audit.diff(Object.fromEntries(COLUMNS.map((c) => [c, locked[c]])), Object.fromEntries(COLUMNS.map((c) => [c, v[c]])));
    await audit.record(q, { ...who, action: 'transaction.edited', entity: 'transaction', entityId: id, summary: `Edited: ${Object.keys(d.after).join(', ') || 'no changes'}`, ...d });
  });
}

async function nextReceiptNo(q) {
  const year = new Date().getUTCFullYear();
  await q.query('INSERT INTO receipt_sequences (year, last_no) VALUES (?, 1) ON DUPLICATE KEY UPDATE last_no = last_no + 1', [year]);
  const { last_no: n } = await q.one('SELECT last_no FROM receipt_sequences WHERE year = ?', [year]);
  return `DCPUK-${year}-${String(n).padStart(5, '0')}`;
}

async function verifyTransaction(id, who) {
  const result = await db.transaction(async (q) => {
    const tx = await q.one('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [id]);
    if (!tx) throw new FinanceError('Transaction not found.', 404);
    if (tx.status !== 'pending') throw new FinanceError(`This transaction is already ${tx.status}.`);
    if (tx.amount_gbp == null) throw new FinanceError('Enter the exchange rate (edit the transaction) before verifying.');
    const fs = await getFinanceSettings(q);
    const self = tx.recorded_by === who.actor;
    if (self && fs.requireSecondVerifier) throw new FinanceError('Four-eyes check: a different admin must verify a payment you recorded.', 403);
    const receipt = TYPES[tx.type].out ? null : await nextReceiptNo(q);
    await q.query("UPDATE transactions SET status = 'verified', verified_by = ?, verified_at = UTC_TIMESTAMP(), self_verified = ?, receipt_no = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [who.actor, self ? 1 : 0, receipt, id]);
    await audit.record(q, { ...who, action: 'transaction.verified', entity: 'transaction', entityId: id,
      summary: `Verified${receipt ? `, receipt ${receipt}` : ''}${self ? ' (by the admin who recorded it)' : ''}`,
      before: { status: 'pending' }, after: { status: 'verified', receipt_no: receipt, verified_by: who.actor }, flags: self ? ['self_verified'] : [] });
    await applyEffects(q, tx, who);
    return { receipt, self };
  });
  return { ...result, tx: await db.one('SELECT * FROM transactions WHERE id = ?', [id]) };
}

async function setStatus(id, who, { from, to, action, reason, reasonColumn, summary }) {
  return db.transaction(async (q) => {
    const tx = await q.one('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [id]);
    if (!tx) throw new FinanceError('Transaction not found.', 404);
    if (!from.includes(tx.status)) throw new FinanceError(`A ${tx.status} transaction cannot be ${to === 'void' ? 'voided' : to}.`);
    const sets = ['status = ?', 'updated_at = UTC_TIMESTAMP()'];
    const params = [to];
    if (to === 'reconciled') { sets.push('reconciled_by = ?', 'reconciled_at = UTC_TIMESTAMP()'); params.push(who.actor); }
    if (to === 'void') { sets.push('voided_by = ?', 'voided_at = UTC_TIMESTAMP()'); params.push(who.actor); }
    if (reasonColumn) { sets.push(`${reasonColumn} = ?`); params.push(reason); }
    await q.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    await audit.record(q, { ...who, action, entity: 'transaction', entityId: id, summary: summary(tx),
      before: { status: tx.status }, after: { status: to, ...(reasonColumn ? { [reasonColumn]: reason } : {}) } });
    if (['verified', 'reconciled'].includes(tx.status) || to === 'void') await applyEffects(q, tx, who);
  });
}

const needReason = (reason, what) => {
  const r = String(reason || '').trim().slice(0, 500);
  if (!r) throw new FinanceError(`Give a reason for ${what}.`);
  return r;
};
const reconcileTransaction = (id, who) => setStatus(id, who, { from: ['verified'], to: 'reconciled', action: 'transaction.reconciled', summary: () => 'Reconciled against the bank statement' });
const rejectTransaction = (id, reason, who) => setStatus(id, who, {
  from: ['pending'], to: 'rejected', action: 'transaction.rejected', reason: needReason(reason, 'rejecting it'), reasonColumn: 'rejected_reason', summary: () => `Rejected: ${reason}`,
});
const voidTransaction = (id, reason, who) => setStatus(id, who, {
  from: ['pending', 'verified', 'reconciled', 'rejected'], to: 'void', action: 'transaction.voided', reason: needReason(reason, 'voiding it'), reasonColumn: 'void_reason',
  summary: (tx) => `Voided${tx.receipt_no ? ` (receipt ${tx.receipt_no} cancelled)` : ''}: ${reason}`,
});

// ---------------------------------------------------------------- receipts

const money = (amount, currency) => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));
const esc = mailer.escapeHtml;
const longDate = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function receiptUrl(tx) {
  const t = mailer.sign('receipt', tx.receipt_no);
  return t ? `${mailer.config().baseUrl}/receipts/${encodeURIComponent(tx.receipt_no)}?t=${t}` : null;
}

// Plain payment receipt. DCP UK is not a UK charity: no Gift Aid, tax or charity wording.
function receiptDetails(tx, member) {
  const rows = [
    ['Receipt number', tx.receipt_no],
    ['Date received', longDate(tx.date_received)],
    ['Received from', tx.payer_name + (member?.reference ? ` (member ${member.reference})` : '')],
    ['Payment for', TYPES[tx.type].label],
    ['Amount', money(tx.amount, tx.currency)],
    ...(tx.currency !== 'GBP' ? [['GBP equivalent', `${money(tx.amount_gbp, 'GBP')} at ${Number(tx.fx_rate)} ${tx.currency} = £1, the rate recorded on the day`]] : []),
    ['Paid by', METHODS[tx.method]],
    ...(tx.external_ref ? [['Payment reference', tx.external_ref]] : []),
    ['Paid into', tx.account_label || ACCOUNTS[tx.account]],
  ];
  return rows;
}

function renderReceiptPage(tx, member) {
  const rows = receiptDetails(tx, member).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const isVoid = tx.status === 'void';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Payment receipt ${esc(tx.receipt_no)} · DCP UK</title>
<style>
  body { margin: 0; background: #f3f8f1; font-family: Arial, Helvetica, sans-serif; color: #14201a; }
  .sheet { max-width: 680px; margin: 32px auto; background: #fff; border-radius: 10px; box-shadow: 0 4px 18px rgba(13,36,16,.1); overflow: hidden; position: relative; }
  header { background: #17401b; color: #fff; padding: 20px 28px; display: flex; justify-content: space-between; align-items: center; }
  header strong { font-size: 22px; } header span { color: #57c065; }
  main { padding: 28px; }
  h1 { font-size: 24px; margin: 0 0 4px; } .sub { color: #4b5f52; margin: 0 0 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th { text-align: left; color: #4b5f52; font-weight: 600; width: 38%; padding: 10px 12px 10px 0; vertical-align: top; }
  td { padding: 10px 0; border-bottom: 1px solid #dbe6dc; } tr:last-child td { border-bottom: 0; }
  .total td { font-size: 20px; font-weight: 700; }
  footer { padding: 16px 28px 24px; font-size: 13px; color: #4b5f52; border-top: 1px solid #dbe6dc; }
  .void { position: absolute; top: 40%; left: 50%; transform: translate(-50%,-50%) rotate(-20deg); font-size: 110px; font-weight: 900; color: rgba(122,46,34,.18); letter-spacing: 8px; pointer-events: none; }
  .actions { text-align: center; margin: 0 0 32px; }
  .actions button { padding: 10px 18px; border: 0; border-radius: 6px; background: #24592a; color: #fff; font-size: 15px; cursor: pointer; }
  @media print { body { background: #fff; } .sheet { box-shadow: none; margin: 0; max-width: none; } .actions { display: none; } }
</style></head><body>
<div class="sheet">${isVoid ? '<div class="void" aria-hidden="true">VOID</div>' : ''}
<header><strong>DCP <span>UK</span></strong><div>Payment receipt</div></header>
<main>
  <h1>Payment receipt</h1>
  <p class="sub">${isVoid ? `<strong>This receipt has been cancelled.</strong> ${esc(tx.void_reason || '')}` : 'Thank you. This confirms the chapter has received your payment.'}</p>
  <table>${rows}</table>
</main>
<footer>Democracy for the Citizens Party, United Kingdom chapter. The Democracy for the Citizens Party is a political party registered in Kenya.<br>Keep this receipt for your records.</footer>
</div>
<p class="actions"><button type="button" id="print">Print or save as PDF</button></p>
<script src="/assets/js/receipt.js"></script>
</body></html>`;
}

// Emails the payer a copy on verification. Returns the email id, or null if there's nobody to send to.
async function emailReceipt(tx) {
  const email = require('./email'); // loaded late: email.js does not depend on finance
  const member = tx.member_id ? await db.one('SELECT id, full_name, email, reference FROM members WHERE id = ?', [tx.member_id]) : null;
  const to = member?.email || tx.payer_email;
  if (!to || !tx.receipt_no) return null;
  const url = receiptUrl(tx);
  const rows = receiptDetails(tx, member).map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#4b5f52">${esc(k)}</td><td style="padding:6px 0"><strong>${esc(v)}</strong></td></tr>`).join('');
  const html = `<p>Dear ${esc(String(tx.payer_name).split(/\s+/)[0])},</p>
<p>Thank you. This is your payment receipt from DCP UK.</p>
<table>${rows}</table>
${url ? `<p><a href="${esc(url)}">View or print this receipt</a></p>` : ''}
<p>DCP UK</p>`;
  const audience = await email.resolveAudience({ to: [member ? { memberId: member.id } : { address: to, name: tx.payer_name }] });
  return email.createOutgoing({ admin: 'system', audience, subject: `Payment receipt ${tx.receipt_no}`, html, template: 'payment_receipt', source: 'system' });
}

module.exports = {
  TYPES, METHODS, CURRENCIES, ACCOUNTS, STATUSES, DONOR_KENYAN, FEE_TYPES, COUNTED, SIGNED_GBP, BALANCE_EXPR, MEMBER_BALANCE_SELECT,
  FinanceError, round2,
  getFinanceSettings, saveFinanceSettings, listTiers, updateTier, publicTiers, tierSentence, gbpText,
  memberFinance, syncMember, syncPledge,
  validate, recordTransaction, updateTransaction, verifyTransaction, reconcileTransaction, rejectTransaction, voidTransaction,
  receiptUrl, renderReceiptPage, emailReceipt,
};
