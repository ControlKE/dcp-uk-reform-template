// Validation for the public Membership and Donate forms. Option lists mirror the
// <select> options in dcp-preview/membership.html; keep the two in step.
const OPTIONS = {
  idDocumentType: ['Kenyan National ID', 'Kenyan Passport'],
  language: ['English', 'Kiswahili'],
  interest: [
    'Community outreach', 'Youth activities', "Women's programmes",
    'Persons with disabilities programmes', 'Policy development', 'Events',
    'Digital communication', 'Chapter activities', 'Volunteer coordination', 'Other',
  ],
  chapter: ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Cardiff', 'Nottingham', 'Belfast', 'None nearby'],
  frequency: ['one_off', 'monthly'],
};

const DECLARATIONS = ['kenyanCitizen', 'over18', 'ukResident', 'acceptConstitution', 'accurateInfo', 'dataConsent'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Loose UK postcode check (covers all standard formats, e.g. SW1A 1AA, M1 1AE, BT1 5GS).
const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i;

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function collect(errors) {
  return (field, message) => { if (!errors[field]) errors[field] = message; };
}

function ageOn(dobIso, today = new Date()) {
  const dob = new Date(`${dobIso}T00:00:00Z`);
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function validateMember(body) {
  const errors = {};
  const fail = collect(errors);
  const b = body || {};
  const m = {
    fullName: str(b.fullName, 120),
    phone: str(b.phone, 30),
    email: str(b.email, 200).toLowerCase(),
    dateOfBirth: str(b.dateOfBirth, 10),
    idDocumentType: str(b.idDocumentType, 40),
    idDocumentNumber: str(b.idDocumentNumber, 30).toUpperCase().replace(/\s+/g, ''),
    language: str(b.language, 20),
    occupation: str(b.occupation, 120),
    interest: str(b.interest, 60),
    chapter: str(b.chapter, 40),
    addressLine1: str(b.addressLine1, 120),
    addressLine2: str(b.addressLine2, 120),
    town: str(b.town, 80),
    county: str(b.county, 80),
    postcode: str(b.postcode, 10).toUpperCase(),
  };

  if (m.fullName.length < 2) fail('fullName', 'Enter your full legal name.');
  if (!/^\+?[\d\s()-]{7,20}$/.test(m.phone)) fail('phone', 'Enter a valid phone number.');
  if (!EMAIL_RE.test(m.email)) fail('email', 'Enter a valid email address.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.dateOfBirth) || Number.isNaN(Date.parse(m.dateOfBirth))) {
    fail('dateOfBirth', 'Enter your date of birth.');
  } else {
    const age = ageOn(m.dateOfBirth);
    if (age < 18) fail('dateOfBirth', 'You must be at least 18 to register.');
    else if (age > 120) fail('dateOfBirth', 'Check your date of birth.');
  }
  if (!OPTIONS.idDocumentType.includes(m.idDocumentType)) fail('idDocumentType', 'Choose your identity document.');
  if (!/^[A-Z0-9]{5,20}$/.test(m.idDocumentNumber)) fail('idDocumentNumber', 'Enter your document number (letters and numbers only).');
  if (!OPTIONS.language.includes(m.language)) fail('language', 'Choose a preferred language.');
  if (m.interest && !OPTIONS.interest.includes(m.interest)) fail('interest', 'Choose an area of interest from the list.');
  if (m.chapter && !OPTIONS.chapter.includes(m.chapter)) fail('chapter', 'Choose a chapter from the list.');
  if (!m.addressLine1) fail('addressLine1', 'Enter the first line of your address.');
  if (!m.town) fail('town', 'Enter your town or city.');
  if (!POSTCODE_RE.test(m.postcode)) fail('postcode', 'Enter a valid UK postcode.');
  else m.postcode = m.postcode.replace(/\s+/g, '').replace(/^(.+)(\d[A-Z]{2})$/, '$1 $2');

  const declarations = b.declarations || {};
  if (!DECLARATIONS.every((k) => declarations[k] === true)) fail('declarations', 'Please confirm every declaration to continue.');

  return { value: m, errors };
}

function validateDonation(body) {
  const errors = {};
  const fail = collect(errors);
  const b = body || {};
  const amount = Math.round(Number(b.amountGbp) * 100) / 100;
  const d = {
    fullName: str(b.fullName, 120),
    email: str(b.email, 200).toLowerCase(),
    amountGbp: amount,
    frequency: str(b.frequency, 20),
    message: str(b.message, 1000),
  };
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) fail('amountGbp', 'Enter an amount between £1 and £10,000.');
  if (!OPTIONS.frequency.includes(d.frequency)) fail('frequency', 'Choose one-off or monthly.');
  if (d.fullName.length < 2) fail('fullName', 'Enter your full name.');
  if (!EMAIL_RE.test(d.email)) fail('email', 'Enter a valid email address.');
  if (b.acknowledged !== true) fail('acknowledged', 'Please tick the box to confirm you understand where this donation goes.');
  return { value: d, errors };
}

module.exports = { OPTIONS, DECLARATIONS, validateMember, validateDonation, ageOn };
