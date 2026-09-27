// Public pages whose wording depends on data. The HTML files keep sensible default
// text (so they still read correctly opened as plain files); when served, the marked
// elements are filled from the tier table:
//   <span data-tiers="summary">       the membership sentence ("Ordinary membership: £20 a year, ...")
//   <ul data-tiers="list">            one item per membership tier, with the approximate KES figure
//   <span data-tiers="fee">           the Ordinary tier's price ("£20 a year")
//   <span data-tiers="fee-name">      the Ordinary tier's name
//   <div data-tiers="choices">        the tier radio buttons on the registration form
//   <div data-tiers="donate-types">   Donation / Visit contribution choice on the Donate page
const fs = require('node:fs/promises');
const path = require('node:path');
const finance = require('./finance');
const { escapeHtml } = require('./mailer');
const { DEMO } = require('./demo');

const money = finance.gbpText;
const kes = (n) => `KES ${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const price = (t) => (t.renewal === 'yearly' ? `${money(t.amount)} a year` : `${money(t.amount)}, one-off`);
const approx = (t) => (t.displayKes ? ` <span class="tier-kes">(about ${escapeHtml(kes(t.displayKes))})</span>` : '');

const tierItem = (t) => `<li><strong>${escapeHtml(t.name)}</strong>: ${escapeHtml(price(t))}${approx(t)}</li>`;

function tierChoice(t, checked) {
  const desc = t.description ? `<span class="tier-desc">${escapeHtml(t.description)}</span>` : '';
  return `<label class="tier-choice"><input type="radio" name="tier" value="${escapeHtml(t.key)}"${checked ? ' checked' : ''}>`
    + `<span class="tier-choice-body"><span class="tier-choice-head"><strong>${escapeHtml(t.name)}</strong>`
    + `<span class="tier-price">${escapeHtml(price(t))}${approx(t)}</span></span>${desc}</span></label>`;
}

// Donation is always offered; the visit contribution only while its row is active.
function donateTypes(visit) {
  const option = (value, label, detail, desc, checked) => `<label class="tier-choice"><input type="radio" name="kind" value="${value}"${checked ? ' checked' : ''}>`
    + `<span class="tier-choice-body"><span class="tier-choice-head"><strong>${label}</strong>${detail}</span>`
    + `${desc ? `<span class="tier-desc">${escapeHtml(desc)}</span>` : ''}</span></label>`;
  return option('donation', 'Donation', '<span class="tier-price">Any amount, one-off or monthly</span>', '', true)
    + (visit ? option('visit_contribution', escapeHtml(visit.name),
      `<span class="tier-price" data-visit-amount="${visit.amount}">${escapeHtml(price(visit))}${approx(visit)}</span>`, visit.description, false) : '');
}

// Replaces the contents of every <tag data-tiers="name"> (nothing of the same tag nested inside).
function fillMarker(html, tag, name, inner) {
  const re = new RegExp(`(<${tag}\\b[^>]*\\bdata-tiers="${name}"[^>]*>)[\\s\\S]*?(</${tag}>)`, 'g');
  return html.replace(re, (m, open, close) => open + inner + close);
}

function fillTiers(html, tiers) {
  const membership = tiers.filter((t) => t.kind === 'membership');
  let out = fillMarker(html, 'span', 'summary', escapeHtml(finance.tierSentence(membership)));
  out = fillMarker(out, 'ul', 'list', membership.map(tierItem).join(''));
  out = fillMarker(out, 'div', 'choices', membership.map((t, i) => tierChoice(t, t.key === 'ordinary' || (i === 0 && !membership.some((x) => x.key === 'ordinary')))).join(''));
  out = fillMarker(out, 'div', 'donate-types', donateTypes(tiers.find((t) => t.key === 'visit')));
  const ordinary = membership.find((t) => t.key === 'ordinary');
  if (ordinary) {
    out = fillMarker(out, 'span', 'fee', escapeHtml(price(ordinary)));
    out = fillMarker(out, 'span', 'fee-name', escapeHtml(ordinary.name));
  }
  return out;
}

// On the demo site: a small badge in the footer, and a notice under the header on
// pages with a form.
const DEMO_BADGE = '<div class="container"><p class="demo-badge"><span>Demo</span> A demonstration site with sample data. Nothing entered here is kept for real use.</p></div>';
const DEMO_NOTICE = '<div class="demo-notice" role="note"><div class="container"><strong>Demo site.</strong> Everything here is sample data and no email is sent. Please don\'t enter real personal details.</div></div>';
function markDemo(html) {
  let out = html.replace('</footer>', `${DEMO_BADGE}</footer>`);
  if (/<form\b/.test(out)) out = out.replace('</header>', `</header>${DEMO_NOTICE}`);
  return out;
}

// Serves the public site's HTML pages (friendly routes included), filling in tier
// wording where a page has it and marking the demo site. Anything else goes on to
// express.static.
const ROUTES = { '/': 'index.html', '/join': 'membership.html', '/donate': 'donate.html', '/member-portal': 'member-portal.html' };
function pages(dir) {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const file = ROUTES[req.path] || (/^\/[a-z0-9-]+\.html$/.test(req.path) ? req.path.slice(1) : null);
    if (!file) return next();
    let html;
    try { html = await fs.readFile(path.join(dir, file), 'utf8'); } catch { return next(); }
    try {
      if (html.includes('data-tiers=')) html = fillTiers(html, await finance.publicTiers());
      if (DEMO) html = markDemo(html);
      res.set('Cache-Control', 'no-cache').type('html').send(html);
    } catch (err) { next(err); }
  };
}

module.exports = { fillTiers, markDemo, pages };
