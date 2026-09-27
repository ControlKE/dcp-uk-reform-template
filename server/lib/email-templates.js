// Email templates. Bodies are HTML fragments that go inside the DCP layout
// (mailer.layout) and may use merge fields such as {{first_name}}.
//   bulkOnly    only for bulk sends (consent and unsubscribe rules apply)
//   systemOnly  sent automatically by the app, never picked in Compose
const TEMPLATES = [
  {
    key: 'welcome', name: 'Welcome',
    subject: 'Welcome to DCP UK, {{first_name}}',
    html: `<p>Dear {{first_name}},</p>
<p>Welcome to the United Kingdom chapter of the Democracy for the Citizens Party. Your membership reference is <strong>{{reference}}</strong>.</p>
<p>Your nearest chapter is {{chapter}}. The chapter team will be in touch about meetings and ways to get involved.</p>
<p>Skiza Wakenya,<br>DCP UK</p>`,
  },
  {
    key: 'payment_reminder', name: 'Payment reminder',
    subject: 'Your DCP UK membership fee',
    html: `<p>Dear {{first_name}},</p>
<p>Our records show your membership fee (reference <strong>{{reference}}</strong>) has not been received yet.</p>
<p>The payment details are on the Membership page of our website. If you have already paid, please reply with the M-Pesa or bank transaction code so we can match it.</p>
<p>Thank you,<br>DCP UK Treasurer</p>`,
  },
  {
    key: 'general_notice', name: 'General notice', bulkOnly: true,
    subject: 'News from DCP UK',
    html: `<p>Dear {{first_name}},</p>
<p>[Write your notice here.]</p>
<p>Skiza Wakenya,<br>DCP UK</p>`,
  },
  {
    key: 'activation', name: 'Activation', systemOnly: true,
    subject: 'Your DCP UK member login',
    html: '<p>Sent automatically when an admin activates a member login (member logins arrive in a later update).</p>',
  },
  {
    key: 'payment_receipt', name: 'Payment receipt', systemOnly: true,
    subject: 'Your DCP UK receipt',
    html: '<p>Sent automatically when a payment is verified (arrives with the Finance module).</p>',
  },
];

const byKey = (key) => TEMPLATES.find((t) => t.key === key) || null;

module.exports = { TEMPLATES, byKey };
