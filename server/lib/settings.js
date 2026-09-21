// The two payment destinations the admin sets up:
//   feeAccount      - where the membership registration fee goes (bank or M-Pesa),
//                     with the amount and its currency
//   donationAccount - the UK bank account that receives GBP donations
const db = require('./db');

const FEE_METHODS = ['bank', 'mpesa_paybill', 'mpesa_till'];
const FEE_CURRENCIES = ['GBP', 'KES', 'USD', 'EUR'];

const DEFAULTS = {
  feeAccount: {
    method: 'bank',
    feeAmount: 20,
    feeCurrency: 'GBP',
    accountName: '', bankName: '', accountNumber: '', sortCode: '', iban: '', swift: '',
    paybillNumber: '', tillNumber: '',
    instructions: '',
  },
  donationAccount: {
    accountName: '', bankName: '', sortCode: '', accountNumber: '', iban: '', swift: '',
    instructions: '',
  },
};

class ValidationError extends Error {}

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function normaliseSortCode(v) {
  const digits = str(v).replace(/[\s-]/g, '');
  if (!digits) return '';
  if (!/^\d{6}$/.test(digits)) throw new ValidationError('Sort code must be 6 digits, e.g. 12-34-56.');
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

function normaliseIban(v) {
  const iban = str(v).replace(/\s+/g, '').toUpperCase();
  if (!iban) return '';
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new ValidationError('IBAN format is not valid.');
  // ISO 13616 mod-97 checksum.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  if (remainder !== 1) throw new ValidationError('IBAN checksum failed. Please check the number.');
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

function normaliseSwift(v) {
  const swift = str(v).replace(/\s+/g, '').toUpperCase();
  if (!swift) return '';
  if (!/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) throw new ValidationError('SWIFT/BIC must be 8 or 11 characters.');
  return swift;
}

function validateFeeAccount(input) {
  const method = FEE_METHODS.includes(input.method) ? input.method : null;
  if (!method) throw new ValidationError('Choose how the membership fee is paid.');
  const feeCurrency = FEE_CURRENCIES.includes(String(input.feeCurrency || '').toUpperCase())
    ? String(input.feeCurrency).toUpperCase() : null;
  if (!feeCurrency) throw new ValidationError(`Choose a fee currency (${FEE_CURRENCIES.join(', ')}).`);
  const feeAmount = Math.round(Number(input.feeAmount) * 100) / 100;
  if (!Number.isFinite(feeAmount) || feeAmount < 1 || feeAmount > 1000000) {
    throw new ValidationError('Fee amount must be between 1 and 1,000,000.');
  }
  const out = {
    ...DEFAULTS.feeAccount,
    method,
    feeAmount,
    feeCurrency,
    accountName: str(input.accountName, 120),
    instructions: str(input.instructions, 1000),
  };
  if (method === 'bank') {
    out.bankName = str(input.bankName, 120);
    out.accountNumber = str(input.accountNumber, 40).replace(/\s+/g, '');
    out.sortCode = normaliseSortCode(input.sortCode);
    out.iban = normaliseIban(input.iban);
    out.swift = normaliseSwift(input.swift);
    if (!out.accountName || !out.bankName) throw new ValidationError('Bank transfers need an account name and bank name.');
    if (!out.accountNumber && !out.iban) throw new ValidationError('Enter an account number or an IBAN.');
    if (out.accountNumber && !/^[A-Za-z0-9-]{4,34}$/.test(out.accountNumber)) throw new ValidationError('Account number format is not valid.');
  } else if (method === 'mpesa_paybill') {
    out.paybillNumber = str(input.paybillNumber, 10).replace(/\s+/g, '');
    if (!/^\d{5,7}$/.test(out.paybillNumber)) throw new ValidationError('M-Pesa Paybill number must be 5-7 digits.');
  } else {
    out.tillNumber = str(input.tillNumber, 10).replace(/\s+/g, '');
    if (!/^\d{5,8}$/.test(out.tillNumber)) throw new ValidationError('M-Pesa Till number must be 5-8 digits.');
  }
  return out;
}

function validateDonationAccount(input) {
  const out = {
    ...DEFAULTS.donationAccount,
    accountName: str(input.accountName, 120),
    bankName: str(input.bankName, 120),
    sortCode: normaliseSortCode(input.sortCode),
    accountNumber: str(input.accountNumber, 20).replace(/[\s-]/g, ''),
    iban: normaliseIban(input.iban),
    swift: normaliseSwift(input.swift),
    instructions: str(input.instructions, 1000),
  };
  if (!out.accountName || !out.bankName) throw new ValidationError('Enter the account name and bank name.');
  if (out.accountNumber && !/^\d{8}$/.test(out.accountNumber)) throw new ValidationError('UK account numbers are 8 digits.');
  if (Boolean(out.sortCode) !== Boolean(out.accountNumber)) throw new ValidationError('Enter both the sort code and the account number.');
  if (!out.sortCode && !out.iban) throw new ValidationError('Enter a sort code and account number, or an IBAN.');
  return out;
}

async function getSetting(key) {
  const row = await db.one('SELECT value, updated_at, updated_by FROM settings WHERE `key` = ?', [key]);
  const value = row ? { ...DEFAULTS[key], ...JSON.parse(row.value) } : { ...DEFAULTS[key] };
  return { value, configured: Boolean(row), updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null };
}

async function saveSetting(key, value, adminUsername) {
  await db.query(`
    INSERT INTO settings (\`key\`, value, updated_at, updated_by) VALUES (?, ?, UTC_TIMESTAMP(), ?)
    ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)
  `, [key, JSON.stringify(value), adminUsername]);
}

// What the public pages are allowed to see: only the fields that apply to the
// chosen method, and nothing at all until an admin has saved the account.
async function publicFeeAccount() {
  const { value: a, configured } = await getSetting('feeAccount');
  if (!configured) return { configured: false, feeAmount: a.feeAmount, feeCurrency: a.feeCurrency };
  const base = { configured: true, method: a.method, feeAmount: a.feeAmount, feeCurrency: a.feeCurrency, accountName: a.accountName, instructions: a.instructions };
  if (a.method === 'bank') return { ...base, bankName: a.bankName, accountNumber: a.accountNumber, sortCode: a.sortCode, iban: a.iban, swift: a.swift };
  if (a.method === 'mpesa_paybill') return { ...base, paybillNumber: a.paybillNumber };
  return { ...base, tillNumber: a.tillNumber };
}

async function publicDonationAccount() {
  const { value: a, configured } = await getSetting('donationAccount');
  if (!configured) return { configured: false };
  const { accountName, bankName, sortCode, accountNumber, iban, swift, instructions } = a;
  return { configured: true, accountName, bankName, sortCode, accountNumber, iban, swift, instructions };
}

module.exports = {
  ValidationError, FEE_METHODS, FEE_CURRENCIES,
  getSetting, saveSetting, validateFeeAccount, validateDonationAccount,
  publicFeeAccount, publicDonationAccount,
};
