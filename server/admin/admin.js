// DCP UK admin area. All data is rendered with textContent, never innerHTML,
// because member-submitted text must not be able to run as code here.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PAYMENT_LABELS = { pending_payment: ['Not paid', ''], payment_reported: ['Check payment', 'warn'], paid: ['Paid', 'good'] };
  const STATUS_LABELS = { pending: ['Pending', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', 'bad'] };
  const DONATION_LABELS = { pledged: 'Pledged', received: 'Received', cancelled: 'Cancelled' };

  // ------------------------------------------------------------ helpers

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) { showView('login'); throw new Error('Your session has ended. Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function pill([label, kind]) { return el('span', { class: `pill ${kind || ''}`, text: label }); }

  function alertIn(root, message, ok) {
    const box = $('.form-alert', root);
    box.textContent = message || '';
    box.classList.toggle('success', Boolean(ok));
    box.hidden = !message;
  }

  function when(sqlDate) {
    if (!sqlDate) return '';
    const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const money = (n, currency = 'GBP') => new Intl.NumberFormat('en-GB', {
    style: 'currency', currency, minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2,
  }).format(Number(n));
  const gbp = (n) => money(n, 'GBP');

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function formValues(form) { return Object.fromEntries(new FormData(form)); }

  // ------------------------------------------------------------ views & auth

  function showView(name) {
    for (const v of ['login', 'app']) $(`#view-${v}`).hidden = v !== name;
    $('#admin-nav').hidden = name !== 'app';
    if (name === 'login') $('#l-user').focus();
  }

  async function boot() {
    const s = await api('GET', '/api/admin/session');
    if (s.admin) return enterApp(s.admin);
    showView('login');
  }

  function enterApp(admin) {
    $('#who').textContent = admin.username;
    showView('app');
    openTab(location.hash.slice(1) || 'overview');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const { admin } = await api('POST', '/api/admin/login', formValues(f));
      f.reset(); alertIn(f, '');
      enterApp(admin);
    } catch (err) { alertIn(f, err.message); }
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout').catch(() => {});
    showView('login');
  });

  // ------------------------------------------------------------ tabs

  const loaders = { overview: loadOverview, members: loadMembers, donations: loadDonations, accounts: loadAccounts, users: loadUsers };

  function openTab(name) {
    if (!loaders[name]) name = 'overview';
    $$('.tabs [data-tab]').forEach((b) => { b.classList.toggle('selected', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name); });
    $$('[data-panel]', $('#view-app')).forEach((p) => { p.hidden = p.dataset.panel !== name; });
    history.replaceState(null, '', `#${name}`);
    loaders[name]().catch((err) => console.error(err));
  }
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

  // ------------------------------------------------------------ overview

  async function loadOverview() {
    const [s, cfg] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/settings')]);
    const card = (n, l, tab) => el('div', { class: 'stat-card clickable', role: 'button', tabindex: '0', onclick: () => openTab(tab) },
      el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: l }));
    $('#stats').replaceChildren(
      card(s.members, 'Registered members', 'members'),
      card(s.membersPending, 'Awaiting review', 'members'),
      card(s.paymentsToCheck, 'Fee payments to check', 'members'),
      card(s.membersApproved, 'Approved members', 'members'),
      card(s.donationsPledged, 'Donation pledges awaiting transfer', 'donations'),
      card(gbp(s.donationsReceivedGbp), 'Donations received', 'donations'),
    );
    const missing = [];
    if (!cfg.feeAccount.configured) missing.push('the membership fee account (applicants are told the chapter will contact them)');
    if (!cfg.donationAccount.configured) missing.push('the donations bank account (the Donate page is closed until you do)');
    const reminder = $('#setup-reminder');
    reminder.hidden = !missing.length;
    reminder.replaceChildren(el('strong', { text: 'Set up payment accounts. ' }), `You haven't saved ${missing.join(' or ')} yet. `,
      el('a', { href: '#accounts', text: 'Open Payment accounts', onclick: (e) => { e.preventDefault(); openTab('accounts'); } }));
  }

  // ------------------------------------------------------------ members

  function memberFilters() {
    const p = new URLSearchParams();
    const add = (k, v) => { if (v) p.set(k, v); };
    add('q', $('#m-search').value.trim());
    add('status', $('#m-status').value);
    add('payment', $('#m-payment').value);
    add('chapter', $('#m-chapter').value);
    return p.toString();
  }

  async function loadMembers() {
    const qs = memberFilters();
    $('#m-export').href = `/api/admin/members.csv${qs ? '?' + qs : ''}`;
    const { members } = await api('GET', `/api/admin/members${qs ? '?' + qs : ''}`);
    const body = $('#members-body');
    body.replaceChildren(...members.map((m) => el('tr', {
      class: 'clickable', tabindex: '0',
      onclick: () => openMember(m.id),
      onkeydown: (e) => { if (e.key === 'Enter') openMember(m.id); },
    },
      el('td', { class: 'mono', text: m.reference }),
      el('td', {}, el('strong', { text: m.full_name }), m.possible_duplicates ? el('span', { class: 'sub', text: '⚠ possible duplicate' }) : null),
      el('td', {}, m.email, el('span', { class: 'sub', text: m.phone })),
      el('td', { text: m.chapter || '—' }),
      el('td', { text: when(m.created_at) }),
      el('td', {}, pill(PAYMENT_LABELS[m.payment_status])),
      el('td', {}, pill(STATUS_LABELS[m.status])),
    )));
    if (!members.length) body.append(el('tr', {}, el('td', { class: 'empty', colspan: '7', text: qs ? 'No members match these filters.' : 'No one has registered yet.' })));
    $('#members-count').textContent = `${members.length} member${members.length === 1 ? '' : 's'} shown.`;
  }

  const reloadMembers = debounce(() => loadMembers().catch(console.error), 250);
  $('#m-search').addEventListener('input', reloadMembers);
  ['#m-status', '#m-payment', '#m-chapter'].forEach((s) => $(s).addEventListener('change', reloadMembers));

  const dialog = $('#member-dialog');
  let currentMember = null;

  function row(dl, label, value) {
    if (value === null || value === undefined || value === '') return;
    dl.append(el('dt', { text: label }), el('dd', { text: String(value) }));
  }

  async function openMember(id) {
    const { member: m } = await api('GET', `/api/admin/members/${id}`);
    currentMember = m;
    $('#md-title').textContent = m.full_name;
    $('#md-sub').textContent = `${m.reference} · registered ${when(m.created_at)}`;
    const dupe = $('#md-dupe');
    dupe.hidden = !m.possible_duplicates;
    dupe.textContent = m.possible_duplicates ? `Another registration uses the same email address or ID number. Search for "${m.id_document_number}" to compare.` : '';
    const dl = $('#md-details');
    dl.replaceChildren();
    row(dl, 'Email', m.email);
    row(dl, 'Phone', m.phone);
    row(dl, 'Date of birth', m.date_of_birth);
    row(dl, 'ID document', `${m.id_document_type}: ${m.id_document_number}`);
    row(dl, 'Address', [m.address_line1, m.address_line2, m.town, m.county, m.postcode].filter(Boolean).join(', '));
    row(dl, 'Chapter', m.chapter === 'None nearby' && m.chapter_other ? `None nearby — ${m.chapter_other}` : m.chapter);
    row(dl, 'Language', m.language);
    row(dl, 'Occupation', m.occupation);
    row(dl, 'Interest', m.interest === 'Other' && m.interest_other ? `Other — ${m.interest_other}` : m.interest);
    row(dl, 'Fee due', money(m.fee_amount, m.fee_currency));
    row(dl, 'Payment code given', m.payment_note);
    row(dl, 'Last updated', when(m.updated_at));
    const f = $('#md-form');
    f.elements.status.value = m.status;
    f.elements.paymentStatus.value = m.payment_status;
    f.elements.adminNotes.value = m.admin_notes || '';
    alertIn(dialog, '');
    dialog.showModal();
  }

  $('#md-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/admin/members/${currentMember.id}`, formValues(e.currentTarget));
      dialog.close();
      loadMembers();
    } catch (err) { alertIn(dialog, err.message); }
  });

  $('#md-delete').addEventListener('click', async () => {
    const m = currentMember;
    if (!confirm(`Permanently delete ${m.full_name} (${m.reference})? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/admin/members/${m.id}`);
      dialog.close();
      loadMembers();
    } catch (err) { alertIn(dialog, err.message); }
  });

  // ------------------------------------------------------------ donations

  async function loadDonations() {
    const p = new URLSearchParams();
    if ($('#d-search').value.trim()) p.set('q', $('#d-search').value.trim());
    if ($('#d-status').value) p.set('status', $('#d-status').value);
    const qs = p.toString();
    $('#d-export').href = `/api/admin/donations.csv${qs ? '?' + qs : ''}`;
    const { donations } = await api('GET', `/api/admin/donations${qs ? '?' + qs : ''}`);
    const body = $('#donations-body');
    body.replaceChildren(...donations.map((d) => {
      const select = el('select', { 'aria-label': `Status for ${d.reference}` },
        ...Object.entries(DONATION_LABELS).map(([v, l]) => el('option', { value: v, text: l })));
      select.value = d.status;
      select.addEventListener('change', async () => {
        try { await api('PATCH', `/api/admin/donations/${d.id}`, { status: select.value }); }
        catch (err) { alert(err.message); select.value = d.status; }
      });
      return el('tr', {},
        el('td', { class: 'mono', text: d.reference }),
        el('td', {}, el('strong', { text: d.full_name }), el('span', { class: 'sub', text: d.email })),
        el('td', {}, gbp(d.amount_gbp), el('span', { class: 'sub', text: d.frequency === 'monthly' ? 'monthly' : 'one-off' })),
        el('td', { text: when(d.created_at) }),
        el('td', { class: 'msg', text: d.message || '' }),
        el('td', {}, select),
      );
    }));
    if (!donations.length) body.append(el('tr', {}, el('td', { class: 'empty', colspan: '6', text: qs ? 'No donations match these filters.' : 'No donation pledges yet.' })));
    $('#donations-count').textContent = `${donations.length} pledge${donations.length === 1 ? '' : 's'} shown. Mark a pledge "Received" once the transfer shows in the bank account.`;
  }
  const reloadDonations = debounce(() => loadDonations().catch(console.error), 250);
  $('#d-search').addEventListener('input', reloadDonations);
  $('#d-status').addEventListener('change', reloadDonations);

  // ------------------------------------------------------------ payment accounts

  function fill(form, values) {
    for (const [k, v] of Object.entries(values)) if (form.elements[k]) form.elements[k].value = v ?? '';
  }
  function meta(form, s) {
    $('[data-meta]', form).textContent = s.configured ? `Last saved ${when(s.updatedAt)} by ${s.updatedBy}.` : 'Not set up yet.';
  }
  function syncMethod() {
    const method = $('#f-method').value;
    $$('#fee-form [data-method]').forEach((f) => { f.hidden = f.dataset.method !== method; });
  }
  $('#f-method').addEventListener('change', syncMethod);

  async function loadAccounts() {
    const s = await api('GET', '/api/admin/settings');
    const fee = $('#fee-form');
    const don = $('#donation-form');
    fill(fee, s.feeAccount.value); meta(fee, s.feeAccount); syncMethod();
    fill(don, s.donationAccount.value); meta(don, s.donationAccount);
    alertIn(fee, ''); alertIn(don, '');
  }

  function saveAccountForm(selector, url, label) {
    $(selector).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      try {
        const saved = await api('PUT', url, formValues(f));
        fill(f, saved.value); meta(f, saved);
        if (f.id === 'fee-form') syncMethod();
        alertIn(f, `${label} saved. The public pages now show these details.`, true);
      } catch (err) { alertIn(f, err.message); }
    });
  }
  saveAccountForm('#fee-form', '/api/admin/settings/fee-account', 'Membership fee account');
  saveAccountForm('#donation-form', '/api/admin/settings/donation-account', 'Donations account');

  // ------------------------------------------------------------ admin users

  async function loadUsers() {
    const { admins } = await api('GET', '/api/admin/admins');
    $('#admin-list').replaceChildren(...admins.map((a) => el('li', { text: `${a.username} (added ${when(a.created_at)})` })));
  }

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try { await api('POST', '/api/admin/password', formValues(f)); f.reset(); alertIn(f, 'Password changed.', true); }
    catch (err) { alertIn(f, err.message); }
  });

  $('#add-admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const { username } = formValues(f);
      await api('POST', '/api/admin/admins', formValues(f));
      f.reset();
      alertIn(f, `Admin "${username}" added. Ask them to change their password after signing in.`, true);
      loadUsers();
    } catch (err) { alertIn(f, err.message); }
  });

  boot().catch((err) => { showView('login'); alertIn($('#login-form'), err.message); });
})();
