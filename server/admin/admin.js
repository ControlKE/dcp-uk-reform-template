// DCP UK admin area. All data is rendered with textContent, never innerHTML,
// because member-submitted text must not be able to run as code here.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PAYMENT_LABELS = { pending_payment: ['Not paid', 'bad'], payment_reported: ['Check payment', 'warn'], paid: ['Paid', 'good'] };
  const STATUS_LABELS = { pending: ['Pending', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', 'bad'] };
  const DONATION_LABELS = { pledged: ['Pledged', 'warn'], received: ['Received', 'good'], cancelled: ['Cancelled', ''] };
  const TAB_TITLES = { overview: 'Overview', members: 'Members', donations: 'Donations', accounts: 'Payment accounts', users: 'Admin users' };
  const PAGE_SIZE = 25;

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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, extraClass = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `ic ${extraClass}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function badge([label, kind]) { return el('span', { class: `adm-badge ${kind || ''}`, text: label }); }

  function iconButton(name, label, onclick, extraClass = '') {
    return el('button', { type: 'button', class: `adm-icon-btn ${extraClass}`.trim(), 'aria-label': label, title: label, onclick }, icon(name));
  }

  const initials = (email) => String(email || '?').replace(/@.*/, '').split(/[._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('') || '?';

  function alertIn(root, message, ok) {
    const box = $('.form-alert', root);
    box.textContent = message || '';
    box.classList.toggle('success', Boolean(ok));
    box.hidden = !message;
  }

  function toast(message, kind = 'success') {
    const node = el('div', { class: `adm-toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      icon(kind === 'error' ? 'alert' : 'check'), el('p', { text: message }));
    const close = () => node.remove();
    node.append(iconButton('x', 'Dismiss notification', close));
    $('#adm-toasts').append(node);
    setTimeout(close, kind === 'error' ? 7000 : 4000);
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
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function formValues(form) { return Object.fromEntries(new FormData(form)); }

  // Disables a form's submit button while a request is in flight.
  async function busy(form, work) {
    const btn = $('button[type="submit"]', form);
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try { return await work(); } finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    session(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { return null; } },
  };

  // Show/hide toggles on password fields.
  $$('[data-reveal]').forEach((btn) => btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.reveal);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    $('use', btn).setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  }));

  // ------------------------------------------------------------ views & auth

  function showView(name) {
    for (const v of ['login', 'app']) $(`#view-${v}`).hidden = v !== name;
    $('#admin-nav').hidden = name !== 'app';
    closeUserMenu();
    closeDrawer(false);
    if (name === 'login') $('#l-user').focus();
  }

  async function boot() {
    const s = await api('GET', '/api/admin/session');
    if (s.admin) return enterApp(s.admin);
    showView('login');
  }

  function enterApp(admin) {
    $('#who').textContent = admin.username;
    $('#adm-who-2').textContent = admin.username;
    $('#adm-avatar').textContent = initials(admin.username);
    $('#adm-avatar-2').textContent = initials(admin.username);
    showView('app');
    openTab(location.hash.slice(1) || 'overview');
  }

  function fieldError(input, message) {
    const err = document.getElementById(`${input.id}-err`);
    input.closest('.adm-field').classList.toggle('invalid', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (err) { err.textContent = message || ''; err.hidden = !message; }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const user = $('#l-user');
    const pass = $('#l-pass');
    alertIn(f, '');
    fieldError(user, !user.value.trim() ? 'Enter your admin email.' : (!user.checkValidity() ? 'Enter a valid email address.' : ''));
    fieldError(pass, !pass.value ? 'Enter your password.' : '');
    const firstBad = [user, pass].find((i) => i.getAttribute('aria-invalid') === 'true');
    if (firstBad) { firstBad.focus(); return; }
    try {
      const { admin } = await busy(f, () => api('POST', '/api/admin/login', formValues(f)));
      f.reset(); alertIn(f, '');
      enterApp(admin);
    } catch (err) { alertIn(f, err.message); pass.select(); }
  });
  ['#l-user', '#l-pass'].forEach((s) => $(s).addEventListener('input', (e) => fieldError(e.currentTarget, '')));

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout').catch(() => {});
    showView('login');
  });

  // ------------------------------------------------------------ sidebar & top bar

  const sidebar = $('#adm-sidebar');
  const menuBtn = $('#adm-menu-btn');
  const desktop = matchMedia('(min-width: 1200px)');
  const mobile = matchMedia('(max-width: 767px)');

  // Desktop: the menu button collapses the sidebar to an icon rail (remembered).
  // Tablet: always a rail; the button opens the full sidebar over the page.
  // Phone: the sidebar is an off-canvas drawer.
  function syncRail() {
    const collapsed = store.get('adm-collapsed') === '1';
    document.body.classList.toggle('adm-rail', !mobile.matches && (!desktop.matches || collapsed));
    if (desktop.matches) closeDrawer(false);
    menuBtn.setAttribute('aria-expanded', String(desktop.matches ? !collapsed : sidebar.classList.contains('open')));
  }
  desktop.addEventListener('change', syncRail);
  mobile.addEventListener('change', syncRail);

  function openDrawer() {
    sidebar.classList.add('open');
    $('#adm-backdrop').hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    ($('.adm-nav button.selected') || $('.adm-nav button')).focus();
  }
  function closeDrawer(returnFocus = true) {
    if (!sidebar.classList.contains('open')) return;
    sidebar.classList.remove('open');
    $('#adm-backdrop').hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) menuBtn.focus();
  }

  menuBtn.addEventListener('click', () => {
    if (desktop.matches) {
      store.set('adm-collapsed', store.get('adm-collapsed') === '1' ? '0' : '1');
      syncRail();
    } else if (sidebar.classList.contains('open')) closeDrawer();
    else openDrawer();
  });
  $('#adm-backdrop').addEventListener('click', () => closeDrawer());
  $('#adm-sidebar-close').addEventListener('click', () => closeDrawer());

  const userBtn = $('#adm-user-btn');
  const userMenu = $('#adm-user-menu');
  function closeUserMenu(returnFocus = false) {
    if (userMenu.hidden) return;
    userMenu.hidden = true;
    userBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) userBtn.focus();
  }
  userBtn.addEventListener('click', () => {
    const open = userMenu.hidden;
    userMenu.hidden = !open;
    userBtn.setAttribute('aria-expanded', String(open));
    if (open) $('button', userMenu).focus();
  });
  userMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = $$('button', userMenu);
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.adm-user')) closeUserMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!userMenu.hidden) closeUserMenu(true);
    else if (sidebar.classList.contains('open')) closeDrawer();
  });
  $('#adm-change-password').addEventListener('click', () => {
    closeUserMenu();
    openTab('users');
    $('#p-cur').focus();
  });

  // ------------------------------------------------------------ tabs

  const loaders = { overview: loadOverview, members: loadMembers, donations: loadDonations, accounts: loadAccounts, users: loadUsers };

  function openTab(name) {
    if (!loaders[name]) name = 'overview';
    $$('.tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('selected', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('[data-panel]', $('#view-app')).forEach((p) => { p.hidden = p.dataset.panel !== name; });
    $('#adm-title').textContent = TAB_TITLES[name];
    $('#adm-crumb').textContent = TAB_TITLES[name];
    document.title = `${TAB_TITLES[name]} · DCP UK Admin`;
    history.replaceState(null, '', `#${name}`);
    closeDrawer(false);
    loaders[name]().catch((err) => { console.error(err); toast(err.message, 'error'); });
  }
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

  // Opens the Members list with the given filters.
  function showMembers(filters = {}) {
    $('#m-search').value = '';
    $('#m-status').value = filters.status || '';
    $('#m-payment').value = filters.payment || '';
    $('#m-chapter').value = '';
    openTab('members');
  }
  function showDonations(status = '') {
    $('#d-search').value = '';
    $('#d-status').value = status;
    openTab('donations');
  }

  // ------------------------------------------------------------ overview

  async function loadOverview() {
    $('#stats').replaceChildren(...Array.from({ length: 4 }, () => el('div', { class: 'adm-stat', 'aria-hidden': 'true' },
      el('span', { class: 'adm-skel', style: 'width:42px;height:42px;border-radius:8px' }),
      el('span', { class: 'adm-skel', style: 'width:40%;height:22px' }), el('span', { class: 'adm-skel', style: 'width:70%' }))));

    const [s, cfg] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/settings')]);

    const card = ({ n, label, sub, iconName, tone, go }) => el('div', {
      class: 'adm-stat', role: 'button', tabindex: '0', onclick: go,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } },
    },
      el('div', { class: 'adm-stat-top' }, el('span', { class: `adm-tile adm-tone-${tone}` }, icon(iconName)), icon('arrow-right', 'adm-go')),
      el('div', {}, el('div', { class: 'adm-stat-n', text: String(n) }), el('div', { class: 'adm-stat-l', text: label })),
      el('div', { class: 'adm-stat-sub', text: sub }),
    );
    $('#stats').replaceChildren(
      card({ n: s.members, label: 'Registered members', sub: `${s.membersApproved} approved so far`, iconName: 'users', tone: 'primary', go: () => showMembers() }),
      card({ n: s.membersPending, label: 'Awaiting review', sub: 'Applications to approve or reject', iconName: 'clock', tone: 'warning', go: () => showMembers({ status: 'pending' }) }),
      card({ n: s.paymentsToCheck, label: 'Fee payments to check', sub: 'Members who say they have paid', iconName: 'cash', tone: 'bright', go: () => showMembers({ payment: 'payment_reported' }) }),
      card({ n: gbp(s.donationsReceivedGbp), label: 'Donations received', sub: `${plural(s.donationsPledged, 'pledge')} awaiting transfer`, iconName: 'heart', tone: 'danger', go: () => showDonations() }),
    );

    const navBadge = $('#nav-badge-members');
    navBadge.textContent = String(s.membersPending);
    navBadge.hidden = !s.membersPending;
    navBadge.setAttribute('aria-label', `${s.membersPending} awaiting review`);

    const attention = [
      { n: s.membersPending, title: 'Review new applications', text: 'Approve or reject pending registrations.', iconName: 'clock', tone: 'warning', go: () => showMembers({ status: 'pending' }) },
      { n: s.paymentsToCheck, title: 'Confirm fee payments', text: 'Match reported M-Pesa or bank codes, then mark them paid.', iconName: 'cash', tone: 'bright', go: () => showMembers({ payment: 'payment_reported' }) },
      { n: s.donationsPledged, title: 'Match donation pledges', text: 'Mark pledges received once the transfer arrives.', iconName: 'heart', tone: 'danger', go: () => showDonations('pledged') },
    ];
    $('#attention').replaceChildren(...attention.map((a) => el('li', {}, el('button', { type: 'button', onclick: a.go },
      el('span', { class: `adm-tile adm-tone-${a.tone}` }, icon(a.iconName)),
      el('span', { class: 'adm-attn-text' }, el('strong', { text: a.title }), el('span', { text: a.text })),
      el('span', { class: 'adm-attn-count', text: String(a.n) }), icon('chevron-right', 'adm-go')))));

    const missing = [];
    if (!cfg.feeAccount.configured) missing.push('the membership fee account (applicants are told the chapter will contact them)');
    if (!cfg.donationAccount.configured) missing.push('the donations bank account (the Donate page is closed until you do)');
    const reminder = $('#setup-reminder');
    const dismissKey = `adm-setup-dismissed:${missing.length}`;
    reminder.hidden = !missing.length || store.session(dismissKey) === '1';
    reminder.replaceChildren(icon('alert'),
      el('p', {}, el('strong', { text: 'Set up payment accounts. ' }), `You haven't saved ${missing.join(' or ')} yet. `,
        el('a', { href: '#accounts', text: 'Open Payment accounts', onclick: (e) => { e.preventDefault(); openTab('accounts'); } })),
      iconButton('x', 'Dismiss reminder', () => { reminder.hidden = true; store.session(dismissKey, '1'); }));
  }

  // ------------------------------------------------------------ tables: shared bits

  function skeletonRows(body, cols) {
    body.replaceChildren(...Array.from({ length: 5 }, () => el('tr', { 'aria-hidden': 'true' },
      ...Array.from({ length: cols }, (_, i) => el('td', {}, el('span', { class: 'adm-skel', style: `width:${[70, 85, 90, 55, 65, 50, 50, 30][i] || 60}%` }))))));
  }

  function emptyRow(body, cols, title, text) {
    body.replaceChildren(el('tr', {}, el('td', { class: 'adm-empty', colspan: String(cols) },
      el('div', { class: 'adm-empty-inner' }, el('span', { class: 'adm-tile adm-tone-primary' }, icon('inbox')), el('strong', { text: title }), el('span', { text: text })))));
  }

  // Client-side paging over the rows the API returned.
  function pager(root, total, page, onChange) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (pages === 1) { root.replaceChildren(); return; }
    const prev = iconButton('chevron-left', 'Previous page', () => onChange(page - 1));
    const next = iconButton('chevron-right', 'Next page', () => onChange(page + 1));
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
    root.replaceChildren(prev, el('span', { class: 'adm-pager-label', text: `Page ${page} of ${pages}` }), next);
  }

  const rangeText = (total, page, noun) => {
    if (!total) return `No ${noun}s shown.`;
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(total, page * PAGE_SIZE);
    return total <= PAGE_SIZE ? `${plural(total, noun)} shown.` : `Showing ${from}–${to} of ${total} ${noun}s.`;
  };

  // ------------------------------------------------------------ members

  const membersState = { rows: [], page: 1, filtered: false };

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
    const body = $('#members-body');
    if (!membersState.rows.length) skeletonRows(body, 8);
    body.closest('table').setAttribute('aria-busy', 'true');
    const { members } = await api('GET', `/api/admin/members${qs ? '?' + qs : ''}`);
    body.closest('table').removeAttribute('aria-busy');
    Object.assign(membersState, { rows: members, page: 1, filtered: Boolean(qs) });
    renderMembers();
  }

  function renderMembers() {
    const { rows, page, filtered } = membersState;
    const body = $('#members-body');
    if (!rows.length) {
      emptyRow(body, 8, filtered ? 'No matching members' : 'No registrations yet', filtered ? 'Try a different search or clear the filters.' : 'New registrations from the Membership page appear here.');
    } else {
      body.replaceChildren(...rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((m) => el('tr', {
        class: 'clickable', tabindex: '0',
        onclick: () => openMember(m.id),
        onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openMember(m.id); },
      },
        el('td', { class: 'mono', text: m.reference }),
        el('td', {}, el('div', { class: 'adm-person' }, el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initials(m.full_name.replace(/\s+/g, '.')) }),
          el('div', {}, el('strong', { text: m.full_name }), m.possible_duplicates ? el('span', { class: 'sub warn', text: '⚠ possible duplicate' }) : null))),
        el('td', {}, m.email, el('span', { class: 'sub', text: m.phone })),
        el('td', { text: m.chapter || '—' }),
        el('td', { class: 'when', text: when(m.created_at) }),
        el('td', {}, badge(PAYMENT_LABELS[m.payment_status])),
        el('td', {}, badge(STATUS_LABELS[m.status])),
        el('td', { class: 'actions' }, iconButton('eye', `View ${m.full_name}`, (e) => { e.stopPropagation(); openMember(m.id); })),
      )));
    }
    $('#members-count').textContent = rangeText(rows.length, page, 'member');
    pager($('#members-pager'), rows.length, page, (p) => { membersState.page = p; renderMembers(); $('#members-body').closest('.adm-table-wrap').scrollTop = 0; });
  }

  const reloadMembers = debounce(() => loadMembers().catch((err) => toast(err.message, 'error')), 250);
  $('#m-search').addEventListener('input', reloadMembers);
  ['#m-status', '#m-payment', '#m-chapter'].forEach((s) => $(s).addEventListener('change', reloadMembers));

  const dialog = $('#member-dialog');
  let currentMember = null;

  function row(dl, label, value) {
    if (value === null || value === undefined || value === '') return;
    dl.append(el('dt', { text: label }), el('dd', { text: String(value) }));
  }

  async function openMember(id) {
    let m;
    try { ({ member: m } = await api('GET', `/api/admin/members/${id}`)); } catch (err) { toast(err.message, 'error'); return; }
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
    const f = e.currentTarget;
    try {
      await busy(f, () => api('PATCH', `/api/admin/members/${currentMember.id}`, formValues(f)));
      dialog.close();
      toast(`Saved changes for ${currentMember.full_name}.`);
      loadMembers().catch((err) => toast(err.message, 'error'));
    } catch (err) { alertIn(dialog, err.message); }
  });

  $('#md-delete').addEventListener('click', async () => {
    const m = currentMember;
    if (!confirm(`Permanently delete ${m.full_name} (${m.reference})? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/admin/members/${m.id}`);
      dialog.close();
      toast(`Deleted ${m.full_name} (${m.reference}).`);
      loadMembers().catch((err) => toast(err.message, 'error'));
    } catch (err) { alertIn(dialog, err.message); }
  });

  // ------------------------------------------------------------ donations

  const donationsState = { rows: [], page: 1, filtered: false };

  async function loadDonations() {
    const p = new URLSearchParams();
    if ($('#d-search').value.trim()) p.set('q', $('#d-search').value.trim());
    if ($('#d-status').value) p.set('status', $('#d-status').value);
    const qs = p.toString();
    $('#d-export').href = `/api/admin/donations.csv${qs ? '?' + qs : ''}`;
    const body = $('#donations-body');
    if (!donationsState.rows.length) skeletonRows(body, 7);
    const { donations } = await api('GET', `/api/admin/donations${qs ? '?' + qs : ''}`);
    Object.assign(donationsState, { rows: donations, page: 1, filtered: Boolean(qs) });
    renderDonations();
  }

  async function setDonationStatus(d, status) {
    try {
      const { donation } = await api('PATCH', `/api/admin/donations/${d.id}`, { status });
      Object.assign(d, donation);
      renderDonations();
      toast(`${d.reference} marked ${DONATION_LABELS[status][0].toLowerCase()}.`);
    } catch (err) { toast(err.message, 'error'); }
  }

  function donationActions(d) {
    const actions = [];
    if (d.status !== 'received') actions.push(iconButton('check', `Mark ${d.reference} received`, () => setDonationStatus(d, 'received')));
    if (d.status !== 'pledged') actions.push(iconButton('rotate', `Move ${d.reference} back to pledged`, () => setDonationStatus(d, 'pledged')));
    if (d.status !== 'cancelled') actions.push(iconButton('x', `Cancel pledge ${d.reference}`, () => setDonationStatus(d, 'cancelled'), 'danger'));
    return actions;
  }

  function renderDonations() {
    const { rows, page, filtered } = donationsState;
    const body = $('#donations-body');
    if (!rows.length) {
      emptyRow(body, 7, filtered ? 'No matching pledges' : 'No donation pledges yet', filtered ? 'Try a different search or clear the filter.' : 'Pledges made on the Donate page appear here.');
    } else {
      body.replaceChildren(...rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((d) => el('tr', {},
        el('td', { class: 'mono', text: d.reference }),
        el('td', {}, el('strong', { text: d.full_name }), el('span', { class: 'sub', text: d.email })),
        el('td', { class: 'amount' }, gbp(d.amount_gbp), el('span', { class: 'sub', text: d.frequency === 'monthly' ? 'monthly' : 'one-off' })),
        el('td', { class: 'when', text: when(d.created_at) }),
        el('td', { class: 'msg', text: d.message || '' }),
        el('td', {}, badge(DONATION_LABELS[d.status] || [d.status, ''])),
        el('td', { class: 'actions' }, ...donationActions(d)),
      )));
    }
    $('#donations-count').textContent = rangeText(rows.length, page, 'pledge');
    pager($('#donations-pager'), rows.length, page, (p) => { donationsState.page = p; renderDonations(); });
  }
  const reloadDonations = debounce(() => loadDonations().catch((err) => toast(err.message, 'error')), 250);
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
        const saved = await busy(f, () => api('PUT', url, formValues(f)));
        fill(f, saved.value); meta(f, saved);
        if (f.id === 'fee-form') syncMethod();
        alertIn(f, `${label} saved. The public pages now show these details.`, true);
        toast(`${label} saved.`);
      } catch (err) { alertIn(f, err.message); toast(err.message, 'error'); }
    });
  }
  saveAccountForm('#fee-form', '/api/admin/settings/fee-account', 'Membership fee account');
  saveAccountForm('#donation-form', '/api/admin/settings/donation-account', 'Donations account');

  // ------------------------------------------------------------ admin users

  async function loadUsers() {
    const { admins } = await api('GET', '/api/admin/admins');
    const me = $('#who').textContent;
    $('#admin-list').replaceChildren(...admins.map((a) => el('li', {},
      el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initials(a.username) }),
      el('div', {}, el('strong', { text: a.username }), el('span', { text: `Added ${when(a.created_at)}` })),
      a.username === me ? el('span', { class: 'adm-badge good', text: 'You' }) : null)));
  }

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await busy(f, () => api('POST', '/api/admin/password', formValues(f)));
      f.reset(); alertIn(f, 'Password changed.', true); toast('Password changed. Other sessions were signed out.');
    } catch (err) { alertIn(f, err.message); }
  });

  $('#add-admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const { username } = formValues(f);
      await busy(f, () => api('POST', '/api/admin/admins', formValues(f)));
      f.reset();
      alertIn(f, `Admin "${username}" added. Ask them to change their password after signing in.`, true);
      toast(`Admin "${username}" added.`);
      loadUsers();
    } catch (err) { alertIn(f, err.message); }
  });

  syncRail();
  boot().catch((err) => { showView('login'); alertIn($('#login-form'), err.message); });
})();
