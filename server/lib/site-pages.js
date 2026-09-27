// Public pages whose wording depends on data. The HTML files keep sensible default
// text (so they still read correctly opened as plain files); when served, the marked
// elements are filled from the database:
//   <span data-tiers="summary">   the tier sentence ("Ordinary membership: £20 a year, ...")
//   <ul data-tiers="list">        one item per active tier, with the approximate KES figure
//   <span data-tiers="fee">       the Ordinary tier's price ("£20 a year"): what the form registers
//   <span data-tiers="fee-name">  the Ordinary tier's name
const fs = require('node:fs/promises');
const path = require('node:path');
const finance = require('./finance');
const { escapeHtml } = require('./mailer');

const money = finance.gbpText;
const kes = (n) => `KES ${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const price = (t) => (t.renewal === 'yearly' ? `${money(t.amount)} a year` : `${money(t.amount)}, one-off`);

function tierItem(t) {
  const approx = t.displayKes ? ` <span class="tier-kes">(about ${escapeHtml(kes(t.displayKes))})</span>` : '';
  return `<li><strong>${escapeHtml(t.name)}</strong>: ${escapeHtml(price(t))}${approx}</li>`;
}

// Replaces the contents of every <tag data-tiers="name"> (nothing of the same tag nested inside).
function fillMarker(html, tag, name, inner) {
  const re = new RegExp(`(<${tag}\\b[^>]*\\bdata-tiers="${name}"[^>]*>)[\\s\\S]*?(</${tag}>)`, 'g');
  return html.replace(re, (m, open, close) => open + inner + close);
}

function fillTiers(html, tiers) {
  let out = fillMarker(html, 'span', 'summary', escapeHtml(finance.tierSentence(tiers)));
  out = fillMarker(out, 'ul', 'list', tiers.map(tierItem).join(''));
  const ordinary = tiers.find((t) => t.key === 'ordinary');
  if (ordinary) {
    out = fillMarker(out, 'span', 'fee', escapeHtml(price(ordinary)));
    out = fillMarker(out, 'span', 'fee-name', escapeHtml(ordinary.name));
  }
  return out;
}

// Express handler that serves file from dir with the tier wording filled in.
function tierPage(dir, file) {
  return async (req, res, next) => {
    try {
      const [html, tiers] = await Promise.all([fs.readFile(path.join(dir, file), 'utf8'), finance.publicTiers()]);
      res.set('Cache-Control', 'no-cache').type('html').send(fillTiers(html, tiers));
    } catch (err) { next(err); }
  };
}

module.exports = { fillTiers, tierPage };
