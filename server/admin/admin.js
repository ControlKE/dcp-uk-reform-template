// DCP UK admin area. All data is rendered with textContent, never innerHTML,
// because member-submitted text must not be able to run as code here.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PAYMENT_LABELS = { pending_payment: ['Not paid', 'bad'], payment_reported: ['Check payment', 'warn'], paid: ['Paid', 'good'] };
  const STATUS_LABELS = { pending: ['Pending', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', 'bad'] };
  const DONATION_LABELS = { pledged: ['Pledged', 'warn'], received: ['Received', 'good'], cancelled: ['Cancelled', ''] };
  const TAB_TITLES = { transactions: 'Transactions', reports: 'Reports', audit: 'Audit log', email: 'Email', overview: 'Dashboard', members: 'Members', donations: 'Donations', accounts: 'Payment accounts', users: 'Admin users' };

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
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { fields: data.fields });
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
      icon(kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'check'), el('p', { text: message }));
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

  // Date only, for table cells (the full time goes in the tooltip).
  function day(sqlDate) {
    if (!sqlDate) return '';
    return new Date(sqlDate.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
    me = admin;
    applyPerms();
    $('#adm-role-2').textContent = admin.roleLabel || 'Administrator';
    $('#pf-role').textContent = admin.roleLabel || 'Administrator';
    financeOptions().catch(() => {});
    $('#who').textContent = admin.username;
    $('#adm-who-2').textContent = admin.username;
    $('#adm-avatar').textContent = initials(admin.username);
    $('#adm-avatar-2').textContent = initials(admin.username);
    showView('app');
    refreshBadges();
    loadMailStatus().catch(() => {});
    const { name, params } = parseHash();
    openTab(name, params, { push: false });
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
    if (openRowMenu) closeRowMenu(true);
    else if (!bellMenu.hidden) closeBell(true);
    else if (!userMenu.hidden) closeUserMenu(true);
    else if (sidebar.classList.contains('open')) closeDrawer();
  });
  $('#adm-change-password').addEventListener('click', () => {
    closeUserMenu();
    openTab('users');
    $('#p-cur').focus();
  });

  // ------------------------------------------------------------ tabs & URL

  // The hash holds the section and its table state: #members?status=pending&page=2
  const loaders = {
    overview: () => loadOverview(),
    transactions: () => financeOptions().then(() => tables.transactions.load()),
    reports: () => loadReports(),
    audit: () => tables.audit.load(),
    email: () => tables.email.load(),
    members: () => tables.members.load(),
    donations: () => tables.donations.load(),
    accounts: () => loadAccounts(),
    users: () => (canDo('admins.manage') ? tables.users.load() : Promise.resolve()),
  };
  let currentTab = null;

  function parseHash() {
    const h = location.hash.slice(1);
    const i = h.indexOf('?');
    return { name: (i < 0 ? h : h.slice(0, i)) || 'overview', params: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
  }

  // Called by a table when its filters, page or sort change.
  function setTabUrl(name, params, replace) {
    if (name !== currentTab) return;
    const qs = params.toString();
    const url = `#${name}${qs ? '?' + qs : ''}`;
    if (url !== location.hash) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }

  function openTab(name, params, { push = true } = {}) {
    if (!loaders[name] || !tabAllowed(name)) name = 'overview';
    currentTab = name;
    closeRowMenu();
    $$('.tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('selected', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('[data-panel]', $('#view-app')).forEach((p) => { p.hidden = p.dataset.panel !== name; });
    $('#adm-title').textContent = TAB_TITLES[name];
    $('#adm-crumb').textContent = TAB_TITLES[name];
    document.title = `${TAB_TITLES[name]} · DCP UK Admin`;
    const table = tables[name];
    if (table && params) table.setFromParams(params);
    const qs = table ? table.params().toString() : '';
    const url = `#${name}${qs ? '?' + qs : ''}`;
    if (url !== location.hash) history[push ? 'pushState' : 'replaceState'](null, '', url);
    closeDrawer(false);
    loaders[name]().catch((err) => { console.error(err); toast(err.message, 'error'); });
  }
  $$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

  // Back / forward between sections, pages and filter states.
  window.addEventListener('popstate', () => {
    if ($('#view-app').hidden) return;
    const { name, params } = parseHash();
    openTab(name, params, { push: false });
  });

  // Opens a list with the given filters (and nothing else).
  const showMembers = (filters = {}) => openTab('members', new URLSearchParams(filters));
  const showDonations = (status = '') => openTab('donations', new URLSearchParams(status ? { status } : {}));

  // ------------------------------------------------------------ theme (light / dark)

  // Default follows the device; the top-bar toggle saves an explicit choice.
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const currentTheme = () => document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
  function syncThemeButton() {
    const dark = currentTheme() === 'dark';
    const btn = $('#adm-theme');
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    $('use', btn).setAttribute('href', dark ? '#i-sun' : '#i-moon');
  }
  $('#adm-theme').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('adm-theme', next);
    syncThemeButton();
    redrawCharts();
  });
  darkQuery.addEventListener('change', () => { if (!document.documentElement.dataset.theme) { syncThemeButton(); redrawCharts(); } });
  syncThemeButton();

  // ------------------------------------------------------------ charts (ApexCharts, themed from the DCP tokens)

  const charts = {};
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  function chartTheme() {
    return {
      primary: cssVar('--accent'), highlight: cssVar('--accent-light'), text: cssVar('--adm-text'),
      muted: cssVar('--adm-muted'), border: cssVar('--adm-border'), dark: currentTheme() === 'dark',
      font: getComputedStyle(document.body).fontFamily,
      // Dark cards need the bright green for bars; the deep primary green disappears on them.
      bar: currentTheme() === 'dark' ? cssVar('--accent-light') : cssVar('--accent'),
      barSoft: currentTheme() === 'dark' ? 'rgba(87, 192, 101, 0.35)' : cssVar('--accent'),
      barToday: currentTheme() === 'dark' ? cssVar('--accent-light') : cssVar('--accent-light'),
      onBar: currentTheme() === 'dark' ? cssVar('--bg-dark-1') : '#ffffff',
    };
  }
  // build(theme) returns ApexCharts options; kept so the chart can be redrawn on a theme change.
  function drawChart(key, target, build) {
    if (charts[key]) charts[key].chart.destroy();
    if (!window.ApexCharts) { target.textContent = 'Charts could not be loaded.'; return; }
    const chart = new window.ApexCharts(target, build(chartTheme()));
    charts[key] = { chart, target, build };
    chart.render();
  }
  function redrawCharts() {
    for (const [key, { target, build }] of Object.entries(charts)) drawChart(key, target, build);
  }
  const baseChart = (t, extra) => ({
    fontFamily: t.font, foreColor: t.muted, toolbar: { show: false }, zoom: { enabled: false },
    animations: { enabled: !matchMedia('(prefers-reduced-motion: reduce)').matches, speed: 400 }, parentHeightOffset: 0, ...extra,
  });

  // ------------------------------------------------------------ dashboard

  function setNavBadges(s) {
    const set = (id, n, label) => {
      const b = $(id);
      b.textContent = String(n);
      b.hidden = !n;
      b.setAttribute('aria-label', label);
    };
    set('#nav-badge-members', s.membersPending, `${s.membersPending} awaiting review`);
    set('#nav-badge-donations', s.donationsPledged, `${s.donationsPledged} pledges awaiting transfer`);
    set('#nav-badge-transactions', s.paymentsToCheck, `${s.paymentsToCheck} payments to verify`);
    set('#nav-badge-email', s.emailsUnread, `${s.emailsUnread} unread`);
  }
  // Keeps sidebar counts and the bell current whichever section is open.
  const refreshBadges = () => Promise.all([
    api('GET', '/api/admin/stats').then(setNavBadges),
    loadNotifications(),
  ]).catch(() => {});

  const weekday = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

  async function loadOverview() {
    const [d, cfg] = await Promise.all([api('GET', '/api/admin/dashboard'), api('GET', '/api/admin/settings')]);

    // New members this week, with a change chip against last week.
    const nm = d.newMembers;
    $('#dash-new-n').textContent = String(nm.thisWeekTotal);
    const change = nm.lastWeekTotal ? Math.round(((nm.thisWeekTotal - nm.lastWeekTotal) / nm.lastWeekTotal) * 100) : null;
    const trend = change === null ? ['flat', 'new this week'] : change > 0 ? ['up', `+${change}%`] : change < 0 ? ['down', `${change}%`] : ['flat', '0%'];
    $('#dash-new-sub').replaceChildren('Last 7 days', el('span', { class: `adm-chip-trend ${trend[0]}`, text: trend[1], title: `Previous 7 days: ${nm.lastWeekTotal}` }));
    drawChart('new', $('#chart-new'), (t) => ({
      chart: baseChart(t, { type: 'bar', height: 80, sparkline: { enabled: true } }),
      series: [{ name: 'Registrations', data: nm.thisWeek.map((x) => x.n) }],
      xaxis: { categories: nm.thisWeek.map((x) => weekday(x.date)) },
      // Today's bar in the bright "UK" green, the rest in the primary green.
      colors: nm.thisWeek.map((_, i) => (i === nm.thisWeek.length - 1 ? t.barToday : t.barSoft)),
      plotOptions: { bar: { distributed: true, columnWidth: '55%', borderRadius: 3 } },
      legend: { show: false },
      tooltip: { theme: t.dark ? 'dark' : 'light', y: { title: { formatter: () => 'Registrations' } } },
    }));

    $('#dash-pending-n').textContent = String(d.membersPending);
    drawMoney(d.money);

    // Members by chapter
    $('#dash-chapter-sub').textContent = `${d.members} registered in ${d.byChapter.length} ${d.byChapter.length === 1 ? 'group' : 'groups'}`;
    drawChart('chapters', $('#chart-chapters'), (t) => ({
      chart: baseChart(t, { type: 'bar', height: Math.max(220, d.byChapter.length * 30 + 40) }),
      series: [{ name: 'Members', data: d.byChapter.map((c) => c.n) }],
      xaxis: { categories: d.byChapter.map((c) => c.chapter), labels: { style: { colors: t.muted } }, axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: { labels: { style: { colors: t.text, fontSize: '13px' } } },
      colors: [t.bar],
      plotOptions: { bar: { horizontal: true, barHeight: '60%', borderRadius: 4, borderRadiusApplication: 'end' } },
      grid: { borderColor: t.border, strokeDashArray: 4, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } }, padding: { left: 4, right: 12 } },
      dataLabels: { enabled: true, style: { fontSize: '12px', colors: [t.onBar] }, offsetX: -4 },
      tooltip: { theme: t.dark ? 'dark' : 'light' },
    }));

    // Recent registrations
    $('#dash-recent').replaceChildren(...(d.recentRegistrations.length ? d.recentRegistrations.map((m) => el('li', {},
      el('button', { type: 'button', onclick: () => openMember(m.id) },
        el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initials(m.full_name.replace(/\s+/g, '.')) }),
        el('span', { class: 'adm-list-main' }, el('strong', { text: m.full_name }), el('span', { text: `${m.chapter || 'No chapter'} · ${day(m.created_at)}` })),
        badge(STATUS_LABELS[m.status])))) : [el('li', { class: 'adm-muted', text: 'No registrations yet.' })]));

    // Activation funnel: the later steps arrive with member logins.
    const step = (label, n, pct, note, pending) => el('li', { class: pending ? 'pending' : '' },
      el('div', { class: 'adm-funnel-top' }, el('span', { class: 'adm-funnel-label', text: label }), el('span', { class: 'adm-funnel-n', text: pending ? '—' : String(n) })),
      el('div', { class: 'adm-funnel-bar', role: 'img', 'aria-label': pending ? `${label}: not available yet` : `${label}: ${n} (${pct}%)` }, el('span', { style: `width:${pending ? 0 : pct}%` })),
      el('span', { class: 'adm-funnel-note', text: note }));
    const approvedPct = d.members ? Math.round((d.membersApproved / d.members) * 100) : 0;
    $('#dash-funnel').replaceChildren(
      step('Registered', d.members, d.members ? 100 : 0, 'Everyone who has applied'),
      step('Approved', d.membersApproved, approvedPct, `${approvedPct}% of registrations`),
      step('Activated', 0, 0, 'Available once member logins are set up', true),
      step('Logged in', 0, 0, 'Available once member logins are set up', true),
    );

    // Setup reminder
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

    // Four-eyes on with fewer than two admins able to verify: nothing pending can be verified.
    const vw = $('#verifier-warning');
    vw.hidden = !d.verifierWarning;
    if (d.verifierWarning) {
      vw.replaceChildren(icon('alert'), el('p', {},
        el('strong', { text: 'Four-eyes check is on but only one admin can verify payments. ' }),
        'Add a second Treasurer or Super admin, or turn the check off. ',
        canDo('finance.settings')
          ? el('a', { href: '#accounts', text: 'Open finance settings', onclick: (e) => { e.preventDefault(); openFinanceSettings(); } })
          : 'Ask a Super admin to change it.'));
    }
  }
  // Payment accounts, scrolled to the four-eyes switch.
  function openFinanceSettings() {
    openTab('accounts');
    const form = $('#finance-settings-form');
    form.scrollIntoView({ block: 'center' });
    $('#fs-four-eyes').focus({ preventScroll: true });
  }

  const onActivate = (node, fn) => {
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  onActivate($('#dash-pending'), () => showMembers({ status: 'pending' }));
  onActivate($('#dash-verify'), () => (canDo('finance.read') ? openTab('transactions', new URLSearchParams({ status: 'pending' })) : showMembers({ payment: 'payment_reported' })));
  $('#dash-tx-all').addEventListener('click', () => openTab('transactions'));

  let earnType = 'membership_fee';
  let lastMoney = null;
  function trendChip(now, before) {
    const change = before ? Math.round(((now - before) / before) * 100) : null;
    const [kind, text] = change === null ? (now ? ['up', 'new'] : ['flat', '–']) : change > 0 ? ['up', `+${change}%`] : change < 0 ? ['down', `${change}%`] : ['flat', '0%'];
    return el('span', { class: `adm-chip-trend ${kind}`, text });
  }
  function drawMoney(m) {
    lastMoney = m;
    $('#dash-money-n').textContent = gbp(m.monthTotal);
    $('#dash-money-sub').replaceChildren('This month', trendChip(m.monthTotal, m.prevMonthToDate));
    drawChart('money', $('#chart-money'), (t) => ({
      chart: baseChart(t, { type: 'area', height: 80, sparkline: { enabled: true } }),
      series: [{ name: 'Income', data: m.month.map((x) => x.gbp) }],
      colors: [t.bar], stroke: { width: 2, curve: 'smooth' },
      fill: { type: 'gradient', gradient: { opacityFrom: 0.45, opacityTo: 0.05 } },
      tooltip: { theme: t.dark ? 'dark' : 'light', x: { show: false }, y: { formatter: (v) => gbp(v), title: { formatter: () => '' } } },
    }));
    $('#dash-verify-n').textContent = String(m.toVerify);
    $('#dash-growth-n').textContent = gbp(m.weekTotal);
    $('#dash-growth-chip').replaceChildren(trendChip(m.weekTotal, m.lastWeekTotal), el('span', { class: 'adm-muted', text: ` vs previous 7 days (${gbp(m.lastWeekTotal)})` }));
    drawChart('growth', $('#chart-growth'), (t) => ({
      chart: baseChart(t, { type: 'bar', height: 170 }),
      series: [{ name: 'Income', data: m.week.map((x) => x.gbp) }],
      xaxis: { categories: m.week.map((x) => weekday(x.date)), labels: { style: { colors: t.muted } }, axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: { show: false },
      colors: m.week.map((_, i) => (i === m.week.length - 1 ? t.barToday : t.barSoft)),
      plotOptions: { bar: { distributed: true, columnWidth: '50%', borderRadius: 4 } },
      legend: { show: false }, dataLabels: { enabled: false }, grid: { show: false },
      tooltip: { theme: t.dark ? 'dark' : 'light', y: { formatter: (v) => gbp(v), title: { formatter: () => 'Income' } } },
    }));
    drawEarnings();
    drawChart('tiers', $('#chart-tiers'), (t) => ({
      chart: baseChart(t, { type: 'donut', height: 240 }),
      series: m.tiers.map((x) => x.n), labels: m.tiers.map((x) => x.name),
      colors: [t.bar, t.dark ? '#b8e6bf' : cssVar('--bg-dark-3'), cssVar('--accent-2')],
      legend: { position: 'bottom', labels: { colors: t.text } },
      dataLabels: { enabled: false }, stroke: { width: 2, colors: [cssVar('--adm-surface') || '#fff'] },
      plotOptions: { pie: { donut: { size: '68%', labels: { show: true, value: { color: t.text }, total: { show: true, label: 'Members', color: t.muted, formatter: (w) => String(w.globals.seriesTotals.reduce((a, b) => a + b, 0)) } } } } },
      tooltip: { theme: t.dark ? 'dark' : 'light' },
    }));
    $('#dash-tx').replaceChildren(...(m.recent.length ? m.recent.map((x) => el('li', {}, el('button', { type: 'button', onclick: () => (canDo('finance.read') ? openTx(x.id) : null) },
      el('span', { class: `adm-tile adm-tone-${x.type === 'donation' ? 'danger' : isOut(x.type) ? 'warning' : 'primary'}`, 'aria-hidden': 'true' }, icon(x.type === 'donation' ? 'heart' : isOut(x.type) ? 'rotate' : 'cash')),
      el('span', { class: 'adm-list-main' }, el('strong', { text: x.payer_name }), el('span', { text: `${typeLabel(x.type)} · ${fmtDate(x.date_received)}` })),
      el('span', { class: 'adm-list-end' }, el('strong', { class: isOut(x.type) ? 'adm-out' : '', text: txAmount(x) }), badge(TX_STATUS[x.status] || [x.status, '']))))) : [el('li', { class: 'adm-muted', text: 'No payments recorded yet.' })]));
  }
  function drawEarnings() {
    const m = lastMoney;
    if (!m) return;
    $$('[data-earn]').forEach((b) => {
      const on = b.dataset.earn === earnType;
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('selected', on);
      $('[data-earn-total]', b).textContent = gbp(m.earnings[b.dataset.earn].reduce((s, x) => s + x.gbp, 0));
    });
    const series = m.earnings[earnType];
    drawChart('earn', $('#chart-earn'), (t) => ({
      chart: baseChart(t, { type: 'bar', height: 230 }),
      series: [{ name: typeLabel(earnType), data: series.map((x) => x.gbp) }],
      xaxis: { categories: series.map((x) => new Date(`${x.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })), labels: { style: { colors: t.muted } }, axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: { labels: { style: { colors: t.muted }, formatter: (v) => `£${Math.round(v)}` } },
      colors: series.map((_, i) => (i === series.length - 1 ? t.barToday : t.barSoft)),
      plotOptions: { bar: { distributed: true, columnWidth: '45%', borderRadius: 4 } },
      legend: { show: false }, dataLabels: { enabled: false }, grid: { borderColor: t.border, strokeDashArray: 4 },
      tooltip: { theme: t.dark ? 'dark' : 'light', y: { formatter: (v) => gbp(v) } },
    }));
  }
  $$('[data-earn]').forEach((b) => b.addEventListener('click', () => { earnType = b.dataset.earn; drawEarnings(); }));
  $('#dash-recent-all').addEventListener('click', () => showMembers());

  // Sections that arrive in later updates.
  $$('.adm-nav [data-soon]').forEach((b) => b.addEventListener('click', () => toast(`${b.querySelector('.adm-nav-label').textContent} arrives with ${b.dataset.soon}.`, 'info')));

  // ------------------------------------------------------------ global search (Ctrl/⌘ K)

  const gsearch = $('#adm-gsearch');
  const gInput = $('#adm-gsearch-input');
  const gList = $('#adm-gsearch-list');
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  $('#adm-gsearch-kbd').textContent = isMac ? '⌘ K' : 'Ctrl K';
  let gResults = [];
  let gActive = -1;
  let gSeq = 0;

  function closeSearch() {
    gList.hidden = true;
    gInput.setAttribute('aria-expanded', 'false');
    gInput.removeAttribute('aria-activedescendant');
    gActive = -1;
  }
  function setActive(i) {
    gActive = i;
    $$('.adm-gsearch-item', gList).forEach((node, j) => node.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) { gInput.setAttribute('aria-activedescendant', `gs-${i}`); $(`#gs-${i}`).scrollIntoView({ block: 'nearest' }); }
  }
  function chooseResult(i) {
    const r = gResults[i];
    if (!r) return;
    closeSearch();
    gInput.value = '';
    gsearch.classList.remove('open');
    r.go();
  }
  const runSearch = debounce(async () => {
    const q = gInput.value.trim();
    const mySeq = ++gSeq;
    if (q.length < 2) { closeSearch(); return; }
    const res = await api('GET', `/api/admin/search?q=${encodeURIComponent(q)}`).catch(() => null);
    if (mySeq !== gSeq || !res) return;
    gResults = [
      ...res.members.map((m) => ({ group: 'Members', iconName: 'users', title: m.full_name, meta: `${m.reference} · ${m.email}`, go: () => openMember(m.id) })),
      ...res.donations.map((d) => ({ group: 'Donations', iconName: 'heart', title: `${d.full_name} · ${gbp(d.amount_gbp)}`, meta: `${d.reference} · ${DONATION_LABELS[d.status]?.[0] || d.status}`, go: () => openDonationById(d.id) })),
      ...res.admins.map((a) => ({ group: 'Admins', iconName: 'shield', title: a.username, meta: 'Admin user', go: () => openTab('users', new URLSearchParams({ q: a.username })) })),
    ];
    const nodes = [];
    let group = null;
    gResults.forEach((r, i) => {
      if (r.group !== group) { group = r.group; nodes.push(el('p', { class: 'adm-gsearch-group', 'aria-hidden': 'true', text: group })); }
      nodes.push(el('div', { class: 'adm-gsearch-item', role: 'option', id: `gs-${i}`, 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); chooseResult(i); } },
        icon(r.iconName), el('div', {}, el('strong', { text: r.title }), el('span', { text: r.meta }))));
    });
    gList.replaceChildren(...(nodes.length ? nodes : [el('p', { class: 'adm-gsearch-empty', text: `Nothing matches “${q}”.` })]));
    gList.hidden = false;
    gInput.setAttribute('aria-expanded', 'true');
    setActive(gResults.length ? 0 : -1);
  }, 200);
  gInput.addEventListener('input', runSearch);
  gInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!gResults.length || gList.hidden) return;
      e.preventDefault();
      setActive((gActive + (e.key === 'ArrowDown' ? 1 : gResults.length - 1)) % gResults.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (gActive >= 0) chooseResult(gActive);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (!gList.hidden) closeSearch(); else { gInput.blur(); gsearch.classList.remove('open'); }
    }
  });
  gInput.addEventListener('blur', () => setTimeout(closeSearch, 120));
  $('#adm-search-open').addEventListener('click', () => { gsearch.classList.add('open'); gInput.focus(); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$('#view-app').hidden) {
      e.preventDefault();
      gsearch.classList.add('open');
      gInput.focus();
      gInput.select();
    }
  });

  // ------------------------------------------------------------ notifications bell

  const bellBtn = $('#adm-bell-btn');
  const bellMenu = $('#adm-bell-menu');
  async function loadNotifications() {
    const n = await api('GET', '/api/admin/notifications');
    if (canDo('email')) await loadLabels().catch(() => {});
    const count = n.pending + n.paymentsToCheck + n.unreadMessages + n.failedEmails;
    const badgeEl = $('#adm-bell-count');
    badgeEl.textContent = count > 99 ? '99+' : String(count);
    badgeEl.hidden = !count;
    bellBtn.setAttribute('aria-label', count ? `Notifications: ${count} waiting` : 'Notifications');
    $('#adm-bell-summary').textContent = `${count} to review`;
    const item = (tone, iconName, title, meta, go) => el('button', { type: 'button', onclick: () => { closeBell(); go(); } },
      el('span', { class: `adm-tile adm-tone-${tone}`, 'aria-hidden': 'true' }, icon(iconName)),
      el('span', {}, el('strong', { text: title }), el('span', { class: 'adm-bell-meta', text: meta })));
    const items = [];
    if (n.unreadMessages) items.push(item('warning', 'mail', `${plural(n.unreadMessages, 'unread message')}`, 'From the website contact form', () => openTab('email', new URLSearchParams({ label: String(mailLabels.find((l) => l.name === 'Contact')?.id || '') }))));
    if (n.failedEmails) items.push(item('danger', 'alert', `${plural(n.failedEmails, 'email')} failed to send`, 'Open Sent to see the errors', () => openTab('email', new URLSearchParams({ folder: 'sent' }))));
    if (n.paymentsToCheck) items.push(item('bright', 'cash', `${plural(n.paymentsToCheck, 'payment')} to verify`, 'Recorded or reported, not verified yet', () => (canDo('finance.read') ? openTab('transactions', new URLSearchParams({ status: 'pending' })) : showMembers({ payment: 'payment_reported' }))));
    if (n.feeReviews && canDo('finance.write')) items.push(item('warning', 'alert', `${plural(n.feeReviews, 'fee record')} to review`, 'Imported or pre-Finance fees to check', () => showMembers({ review: '1' })));
    for (const m of n.newRegistrations) items.push(item('warning', 'user-plus', `New registration: ${m.full_name}`, `${m.chapter || 'No chapter'} · ${when(m.created_at)}`, () => openMember(m.id)));
    if (n.pending > n.newRegistrations.length) items.push(item('primary', 'users', `All ${n.pending} pending applications`, 'Open the Members list', () => showMembers({ status: 'pending' })));
    if (n.donationsPledged) items.push(item('danger', 'heart', `${plural(n.donationsPledged, 'pledge')} awaiting transfer`, 'Mark them received when the money arrives', () => showDonations('pledged')));
    $('#adm-bell-list').replaceChildren(...(items.length ? items : [el('p', { class: 'adm-bell-empty', text: 'Nothing waiting. All caught up.' })]));
  }
  function closeBell(returnFocus = false) {
    if (bellMenu.hidden) return;
    bellMenu.hidden = true;
    bellBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) bellBtn.focus();
  }
  bellBtn.addEventListener('click', () => {
    const open = bellMenu.hidden;
    closeUserMenu();
    bellMenu.hidden = !open;
    bellBtn.setAttribute('aria-expanded', String(open));
    if (open) { loadNotifications().catch(() => {}); $('button', bellMenu)?.focus(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.adm-bell')) closeBell(); });
  setInterval(() => { if (!$('#view-app').hidden && !document.hidden) refreshBadges(); }, 60000);

  // ------------------------------------------------------------ profile

  $('#adm-profile').addEventListener('click', async () => {
    closeUserMenu();
    const me = $('#who').textContent;
    const pf = $('#profile-dialog');
    $('#pf-title').textContent = me;
    $('#pf-avatar').textContent = initials(me);
    const dl = $('#pf-details');
    dl.replaceChildren();
    row(dl, 'Email (sign-in)', me);
    try {
      const { admins } = await api('GET', `/api/admin/admins?q=${encodeURIComponent(me)}`);
      const self = admins.find((a) => a.username === me);
      if (self) row(dl, 'Admin since', when(self.created_at));
    } catch { /* details are optional */ }
    row(dl, 'Session', 'Signs out after 8 hours');
    pf.showModal();
  });
  $('#pf-password').addEventListener('click', () => { $('#profile-dialog').close(); openTab('users'); $('#p-cur').focus(); });

  // ------------------------------------------------------------ reason dialog (reject / cancel)

  // Resolves with the typed reason, or null if the admin backs out.
  function askReason({ title, sub, confirm }) {
    const dlg = $('#reason-dialog');
    const input = $('#rd-reason');
    $('#rd-title').textContent = title;
    $('#rd-sub').textContent = sub;
    $('#rd-confirm').textContent = confirm;
    input.value = '';
    fieldError(input, '');
    dlg.showModal();
    input.focus();
    return new Promise((resolve) => {
      const finish = (value) => {
        $('#rd-form').removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(value);
      };
      const onSubmit = (e) => {
        e.preventDefault();
        const reason = input.value.trim();
        if (!reason) { fieldError(input, 'Enter a reason.'); input.focus(); return; }
        finish(reason);
      };
      const onClose = () => finish(null);
      $('#rd-form').addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
    });
  }
  $('#rd-cancel').addEventListener('click', () => $('#reason-dialog').close());
  $('#rd-close').addEventListener('click', () => $('#reason-dialog').close());
  $('#rd-reason').addEventListener('input', (e) => fieldError(e.currentTarget, ''));

  // ------------------------------------------------------------ donation details

  const donationDialog = $('#donation-dialog');
  let currentDonation = null;
  function openDonation(d) {
    currentDonation = d;
    $('#dd-title').textContent = d.full_name;
    $('#dd-sub').textContent = `${d.reference} · pledged ${when(d.created_at)}`;
    const dl = $('#dd-details');
    dl.replaceChildren();
    row(dl, 'Email', d.email);
    row(dl, 'Amount', `${gbp(d.amount_gbp)} (${d.frequency === 'monthly' ? 'monthly' : 'one-off'})`);
    row(dl, 'Status', DONATION_LABELS[d.status]?.[0] || d.status);
    row(dl, 'Message', d.message);
    row(dl, 'Last updated', when(d.updated_at));
    $('#dd-notes').value = d.admin_notes || '';
    $('#dd-kenyan').value = d.donor_kenyan || 'unknown';
    lockForm($('#dd-form'), !canDo('donations.write'));
    $('#dd-tx').replaceChildren();
    alertIn(donationDialog, '');
    donationDialog.showModal();
    loadDonationPayments(d).catch((err) => toast(err.message, 'error'));
  }
  async function openDonationById(id) {
    try { openDonation((await api('GET', `/api/admin/donations/${id}`)).donation); } catch (err) { toast(err.message, 'error'); }
  }
  $('#dd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await busy(f, () => api('PATCH', `/api/admin/donations/${currentDonation.id}`, { adminNotes: f.elements.adminNotes.value, donorKenyan: f.elements.donorKenyan.value }));
      donationDialog.close();
      toast(`Saved ${currentDonation.reference}.`);
      tables.donations.load().catch(() => {});
    } catch (err) { alertIn(donationDialog, err.message); }
  });

  $('#adm-year').textContent = String(new Date().getFullYear());

  // ------------------------------------------------------------ tables: server-side paging, sorting, filters

  // Every list uses one controller. Its filter inputs hold the state; their
  // values, plus page, size and sort, go to the API and into the URL hash
  // (e.g. #members?status=pending&page=2), so Back and bookmarks work.
  const PAGE_SIZES = [10, 25, 50, 100];
  const DEFAULT_PAGE_SIZE = 25;

  function skeletonRows(body, cols) {
    body.replaceChildren(...Array.from({ length: 6 }, () => el('tr', { 'aria-hidden': 'true', class: 'adm-skel-row' },
      ...Array.from({ length: cols }, (_, i) => el('td', {}, el('span', { class: 'adm-skel', style: `width:${[70, 85, 90, 55, 65, 50, 50, 30][i] || 60}%` }))))));
  }

  function emptyRow(body, cols, title, text) {
    body.replaceChildren(el('tr', {}, el('td', { class: 'adm-empty', colspan: String(cols) },
      el('div', { class: 'adm-empty-inner' }, el('span', { class: 'adm-tile adm-tone-primary' }, icon('inbox')), el('strong', { text: title }), el('span', { text: text })))));
  }

  // Page buttons: first, previous, a window of numbers with gaps, next, last.
  function pageNumbers(page, last) {
    const wanted = new Set([1, last, page - 1, page, page + 1]);
    if (page <= 3) [2, 3, 4].forEach((n) => wanted.add(n));
    if (page >= last - 2) [last - 1, last - 2, last - 3].forEach((n) => wanted.add(n));
    const nums = [...wanted].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('…'); out.push(n); });
    return out;
  }

  // Row action menus: one open at a time, positioned against the viewport so
  // a scrolling table can't clip them.
  let openRowMenu = null;
  function closeRowMenu(returnFocus = false) {
    if (!openRowMenu) return;
    const { menu, btn } = openRowMenu;
    openRowMenu = null;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }
  document.addEventListener('click', () => closeRowMenu());
  window.addEventListener('resize', () => closeRowMenu());
  document.addEventListener('scroll', (e) => { if (openRowMenu && !openRowMenu.menu.contains(e.target)) closeRowMenu(); }, true);

  function rowMenu(label, items, iconName = 'dots') {
    const btn = el('button', { type: 'button', class: 'adm-icon-btn', 'aria-label': label, title: iconName === 'dots' ? 'Actions' : label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon(iconName));
    const menu = el('div', { class: 'adm-rowmenu-list', role: 'menu', hidden: '' },
      ...items.filter(Boolean).map((it) => el('button', {
        type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
        onclick: () => { closeRowMenu(); it.onClick(); },
      }, icon(it.icon), it.text)));
    btn.addEventListener('click', () => {
      const wasOpen = openRowMenu && openRowMenu.menu === menu;
      closeRowMenu();
      if (wasOpen) return;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      openRowMenu = { menu, btn };
      const r = btn.getBoundingClientRect();
      const below = r.bottom + 4 + menu.offsetHeight <= innerHeight;
      menu.style.top = `${Math.max(8, below ? r.bottom + 4 : r.top - menu.offsetHeight - 4)}px`;
      menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
      $('button', menu).focus();
    });
    menu.addEventListener('keydown', (e) => {
      const items = $$('button', menu);
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      } else if (e.key === 'Tab') closeRowMenu();
    });
    // Clicks inside the menu must not open the row they sit in.
    return el('div', { class: 'adm-rowmenu', onclick: (e) => e.stopPropagation(), onkeydown: (e) => { if (e.key === 'Enter') e.stopPropagation(); } }, btn, menu);
  }

  function createTable(cfg) {
    const { name, endpoint, listKey, body, noun, nounPlural = `${noun}s`, fields, labels, defaultSort, defaultDir = 'desc', render, empty } = cfg;
    const table = body.closest('table');
    const cols = $$('thead th', table).length;
    const sizeSelect = $(`#${cfg.prefix}-size`);
    const chips = $(`#${cfg.prefix}-chips`);
    const countEl = $(`#${cfg.countId}`);
    const pagerEl = $(`#${cfg.pagerId}`);
    const state = { page: 1, pageSize: DEFAULT_PAGE_SIZE, sort: defaultSort, dir: defaultDir, total: 0, loaded: false };
    let seq = 0;

    // Sortable headers become buttons with an arrow and aria-sort.
    const sortHeads = $$('th[data-sort]', table).map((th) => {
      const key = th.dataset.sort;
      const text = th.textContent.trim();
      th.replaceChildren(el('button', {
        type: 'button', class: 'adm-sort',
        onclick: () => {
          if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
          else { state.sort = key; state.dir = key === defaultSort ? defaultDir : 'asc'; }
          state.page = 1;
          update();
        },
      }, text, icon('sort', 'adm-sort-ic')));
      return th;
    });
    const headLabels = $$('thead th', table).map((th) => th.textContent.trim());

    const isFiltered = () => Object.values(fields).some((input) => input.value.trim());

    function params({ paging = true } = {}) {
      const p = new URLSearchParams();
      for (const [key, input] of Object.entries(fields)) { const v = input.value.trim(); if (v) p.set(key, v); }
      if (state.sort !== defaultSort || state.dir !== defaultDir) { p.set('sort', state.sort); p.set('dir', state.dir); }
      if (paging && state.page > 1) p.set('page', String(state.page));
      if (paging && state.pageSize !== DEFAULT_PAGE_SIZE) p.set('pageSize', String(state.pageSize));
      return p;
    }

    function setFromParams(p) {
      for (const [key, input] of Object.entries(fields)) input.value = p.get(key) || '';
      state.sort = sortHeads.some((th) => th.dataset.sort === p.get('sort')) ? p.get('sort') : defaultSort;
      state.dir = ['asc', 'desc'].includes(p.get('dir')) ? p.get('dir') : defaultDir;
      state.page = Math.max(1, Math.floor(Number(p.get('page'))) || 1);
      state.pageSize = PAGE_SIZES.includes(Number(p.get('pageSize'))) ? Number(p.get('pageSize')) : DEFAULT_PAGE_SIZE;
      sizeSelect.value = String(state.pageSize);
    }

    function update({ replace = false } = {}) {
      setTabUrl(name, params(), replace);
      load().catch((err) => toast(err.message, 'error'));
    }

    function renderChips() {
      const active = Object.entries(fields).filter(([, input]) => input.value.trim());
      chips.hidden = !active.length;
      chips.replaceChildren(...active.map(([key, input]) => {
        let shown = input.value.trim();
        if (input.tagName === 'SELECT') shown = input.selectedOptions[0]?.textContent || shown;
        else if (input.type === 'date') shown = new Date(`${shown}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        else shown = `“${shown}”`;
        const text = `${labels[key]}: ${shown}`;
        return el('span', { class: 'adm-chip' }, text,
          el('button', { type: 'button', 'aria-label': `Remove filter ${text}`, onclick: () => { input.value = ''; state.page = 1; update(); } }, icon('x')));
      }), active.length ? el('button', {
        type: 'button', class: 'adm-chip-clear',
        onclick: () => { Object.values(fields).forEach((input) => { input.value = ''; }); state.page = 1; update(); },
      }, 'Clear all') : '');
    }

    function renderHeads() {
      for (const th of sortHeads) {
        const on = th.dataset.sort === state.sort;
        if (on) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
        th.classList.toggle('sorted', on);
        $('use', th).setAttribute('href', on ? `#i-sort-${state.dir}` : '#i-sort');
      }
    }

    function renderRows(rows) {
      if (!rows.length) {
        const filtered = isFiltered();
        emptyRow(body, cols, filtered ? empty.filteredTitle : empty.title, filtered ? 'Try a different search or clear the filters.' : empty.text);
        return;
      }
      body.replaceChildren(...rows.map(render));
      // Labels for the card layout on phones.
      for (const tr of body.rows) {
        [...tr.cells].forEach((td, i) => { if (headLabels[i] && !td.classList.contains('actions')) td.dataset.label = headLabels[i]; });
      }
    }

    function renderFooter() {
      const { total, page, pageSize } = state;
      const last = Math.max(1, Math.ceil(total / pageSize));
      const from = total ? (page - 1) * pageSize + 1 : 0;
      const to = Math.min(total, page * pageSize);
      countEl.textContent = total ? `Showing ${from}–${to} of ${total} ${total === 1 ? noun : nounPlural}` : `No ${nounPlural}`;
      if (last === 1) { pagerEl.replaceChildren(); return; }
      const go = (p) => { state.page = p; update(); body.closest('.adm-table-wrap').scrollTop = 0; };
      const nav = (iconName, label, target, disabled) => {
        const b = iconButton(iconName, label, () => go(target), 'adm-page');
        b.disabled = disabled;
        return b;
      };
      pagerEl.replaceChildren(
        nav('chevrons-left', 'First page', 1, page === 1),
        nav('chevron-left', 'Previous page', page - 1, page === 1),
        ...pageNumbers(page, last).map((n) => (n === '…'
          ? el('span', { class: 'adm-page-gap', 'aria-hidden': 'true', text: '…' })
          : el('button', {
            type: 'button', class: `adm-page${n === page ? ' current' : ''}`, 'aria-label': `Page ${n}`,
            ...(n === page ? { 'aria-current': 'page' } : {}), onclick: () => go(n),
          }, String(n)))),
        nav('chevron-right', 'Next page', page + 1, page === last),
        nav('chevrons-right', 'Last page', last, page === last),
      );
    }

    async function load() {
      const mySeq = ++seq;
      const api_ = params();
      api_.set('sort', state.sort); api_.set('dir', state.dir);
      api_.set('page', String(state.page)); api_.set('pageSize', String(state.pageSize));
      for (const [link, path] of cfg.exportLinks || []) {
        const ex = params({ paging: false });
        ex.set('sort', state.sort); ex.set('dir', state.dir);
        link.href = `${path}${path.includes('?') ? '&' : '?'}${ex}`;
      }
      if (cfg.exportLink) {
        const ex = params({ paging: false });
        ex.set('sort', state.sort); ex.set('dir', state.dir);
        cfg.exportLink.href = `${cfg.exportPath}?${ex}`;
      }
      renderChips();
      renderHeads();
      if (!state.loaded) skeletonRows(body, cols);
      table.setAttribute('aria-busy', 'true');
      try {
        const data = await api('GET', `${endpoint}?${api_}`);
        if (mySeq !== seq) return; // a newer request has been made
        state.loaded = true;
        state.total = data.total;
        if (data.page !== state.page) { state.page = data.page; setTabUrl(name, params(), true); }
        renderRows(data[listKey]);
        renderFooter();
        if (cfg.afterLoad) cfg.afterLoad(data);
      } finally {
        if (mySeq === seq) table.removeAttribute('aria-busy');
      }
    }

    for (const input of Object.values(fields)) {
      if (input.type === 'search') {
        input.addEventListener('input', debounce(() => { state.page = 1; update({ replace: true }); }, 300));
      } else {
        input.addEventListener('change', () => { state.page = 1; update(); });
      }
    }
    sizeSelect.addEventListener('change', () => { state.pageSize = Number(sizeSelect.value); state.page = 1; update(); });

    return { name, load, params, setFromParams };
  }

  // ------------------------------------------------------------ members

  async function updateMember(m, changes, done) {
    try {
      await api('PATCH', `/api/admin/members/${m.id}`, changes);
      toast(`${m.full_name} ${done}.`);
      tables.members.load();
      refreshBadges();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function rejectMember(m) {
    const reason = await askReason({ title: `Reject ${m.full_name}?`, sub: `${m.reference}. The reason is added to the admin notes.`, confirm: 'Reject application' });
    if (reason) updateMember(m, { status: 'rejected', reason }, 'rejected');
  }

  function memberRow(m) {
    return el('tr', {
      class: 'clickable', tabindex: '0',
      onclick: () => openMember(m.id),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openMember(m.id); },
    },
      el('td', { class: 'mono col-ref', text: m.reference }),
      el('td', {}, el('div', { class: 'adm-person' }, el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initials(m.full_name.replace(/\s+/g, '.')) }),
        el('div', {}, el('strong', { text: m.full_name }), el('span', { class: 'sub ref-sub', text: m.reference }), m.possible_duplicates ? el('span', { class: 'sub warn', text: '⚠ possible duplicate' }) : null))),
      el('td', { class: 'col-contact' }, el('div', {}, el('span', { class: 'adm-email', title: m.email, text: m.email }), el('span', { class: 'sub', text: m.phone }))),
      el('td', { text: m.chapter || '—' }),
      el('td', { class: 'when col-reg', title: when(m.created_at), text: day(m.created_at) }),
      el('td', {}, el('div', { class: 'adm-badges' }, badge(PAYMENT_LABELS[m.payment_status]), m.fee_review ? el('span', { class: 'adm-badge warn', title: 'Fee needs review', text: 'Review' }) : null)),
      el('td', {}, badge(STATUS_LABELS[m.status])),
      el('td', { class: 'actions' }, rowMenu(`Actions for ${m.full_name}`, [
        { icon: 'eye', text: 'View details', onClick: () => openMember(m.id) },
        canDo('members.write') && m.status !== 'approved' && { icon: 'check', text: 'Approve', onClick: () => updateMember(m, { status: 'approved' }, 'approved') },
        canDo('finance.write') && { icon: 'cash', text: 'Record payment', onClick: () => openRecordPayment({ member: m }) },
        canDo('members.write') && m.status !== 'rejected' && { icon: 'x', text: 'Reject', danger: true, onClick: () => rejectMember(m) },
      ])),
    );
  }

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
    row(dl, 'Registration fee quoted', money(m.fee_amount, m.fee_currency));
    row(dl, 'Chapter news emails', m.email_opt_out ? 'Unsubscribed' : m.marketing_consent_at ? `Agreed ${day(m.marketing_consent_at)}` : 'Not agreed');
    row(dl, 'Payment code given', m.payment_note);
    row(dl, 'Last updated', when(m.updated_at));
    const f = $('#md-form');
    await financeOptions().catch(() => {});
    $('#md-tier').replaceChildren(...(finOpts?.tiers || []).filter((t) => t.active || t.id === m.tier_id).map((t) => el('option', { value: String(t.id), text: `${t.name} (${gbp(t.amount)}${t.renewal === 'yearly' ? ' a year' : ', once'})` })));
    f.elements.tierId.value = String(m.tier_id || '');
    f.elements.status.value = m.status;
    f.elements.paymentStatus.value = m.payment_status;
    f.elements.adminNotes.value = m.admin_notes || '';
    lockForm(f, !canDo('members.write'));
    // "Paid (confirmed)" comes only from verified transactions.
    f.elements.paymentStatus.disabled = !canDo('members.write') || m.payment_status === 'paid';
    $('#md-delete').hidden = !canDo('members.write');
    $('#md-figures').replaceChildren();
    $('#md-tx').replaceChildren();
    $('#md-review').hidden = true;
    alertIn(dialog, '');
    dialog.showModal();
    loadMemberFinance(m).catch((err) => toast(err.message, 'error'));
  }

  $('#md-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const values = formValues(f);
    if (values.status === 'rejected' && currentMember.status !== 'rejected') {
      values.reason = await askReason({ title: `Reject ${currentMember.full_name}?`, sub: `${currentMember.reference}. The reason is added to the admin notes.`, confirm: 'Reject application' });
      if (!values.reason) return;
    }
    try {
      await busy(f, () => api('PATCH', `/api/admin/members/${currentMember.id}`, values));
      dialog.close();
      toast(`Saved changes for ${currentMember.full_name}.`);
      tables.members.load().catch((err) => toast(err.message, 'error'));
      refreshBadges();
    } catch (err) { alertIn(dialog, err.message); }
  });

  $('#md-delete').addEventListener('click', async () => {
    const m = currentMember;
    if (!confirm(`Permanently delete ${m.full_name} (${m.reference})? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/admin/members/${m.id}`);
      dialog.close();
      toast(`Deleted ${m.full_name} (${m.reference}).`);
      tables.members.load().catch((err) => toast(err.message, 'error'));
    } catch (err) { alertIn(dialog, err.message); }
  });

  // ------------------------------------------------------------ donations

  async function setDonationStatus(d, status) {
    const change = { status };
    if (status === 'cancelled') {
      change.reason = await askReason({ title: `Cancel pledge ${d.reference}?`, sub: `${d.full_name}, ${gbp(d.amount_gbp)}. The reason is added to the admin notes.`, confirm: 'Cancel pledge' });
      if (!change.reason) return;
    }
    try {
      await api('PATCH', `/api/admin/donations/${d.id}`, change);
      toast(`${d.reference} marked ${DONATION_LABELS[status][0].toLowerCase()}.`);
      tables.donations.load();
      refreshBadges();
    } catch (err) { toast(err.message, 'error'); }
  }

  function donationRow(d) {
    return el('tr', {
      class: 'clickable', tabindex: '0',
      onclick: () => openDonation(d),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openDonation(d); },
    },
      el('td', { class: 'mono', text: d.reference }),
      el('td', {}, el('div', {}, el('strong', { text: d.full_name }), el('span', { class: 'sub adm-email', title: d.email, text: d.email }),
        d.donor_kenyan !== 'yes' ? el('span', { class: 'adm-kenyan-sub', text: `Kenyan: ${d.donor_kenyan || 'unknown'}` }) : null)),
      el('td', { class: 'amount' }, el('div', {}, gbp(d.amount_gbp), el('span', { class: 'sub', text: d.frequency === 'monthly' ? 'monthly' : 'one-off' }))),
      el('td', { class: 'when col-pledged', title: when(d.created_at), text: day(d.created_at) }),
      el('td', { class: 'msg col-msg', text: d.message || '—' }),
      el('td', { class: 'col-kenyan' }, badge(KENYAN[d.donor_kenyan] || KENYAN.unknown)),
      el('td', {}, badge(DONATION_LABELS[d.status] || [d.status, ''])),
      el('td', { class: 'actions' }, rowMenu(`Actions for ${d.reference}`, [
        { icon: 'eye', text: 'View details', onClick: () => openDonation(d) },
        canDo('finance.write') && d.status === 'pledged' && { icon: 'cash', text: 'Record payment', onClick: () => openRecordPayment({ donation: d }) },
        canDo('donations.write') && d.status === 'pledged' && { icon: 'x', text: 'Cancel pledge', danger: true, onClick: () => setDonationStatus(d, 'cancelled') },
      ])),
    );
  }

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
    await loadFinanceSettings();
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

  function adminRow(a) {
    return el('tr', {},
      el('td', {}, el('div', { class: 'adm-person' },
        el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initials(a.username) }), el('strong', { class: 'adm-break', text: a.username }))),
      el('td', {}, el('span', { class: `adm-badge ${a.role === 'super_admin' ? 'good' : ''}`, text: ROLE_LABELS[a.role] || a.role })),
      el('td', { class: 'when', title: when(a.created_at), text: day(a.created_at) }),
      el('td', { class: 'actions' }, a.username === $('#who').textContent ? el('span', { class: 'adm-badge good', text: 'You' })
        : rowMenu(`Actions for ${a.username}`, Object.keys(ROLE_LABELS).filter((r) => r !== a.role).map((r) => ({ icon: 'shield', text: `Make ${ROLE_LABELS[r].toLowerCase()}`, onClick: () => changeRole(a, r) })))),
    );
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
      tables.users.load();
    } catch (err) { alertIn(f, err.message); }
  });

  // ------------------------------------------------------------ email app

  const FOLDER_TITLES = { inbox: 'Inbox', sent: 'Sent', draft: 'Drafts', starred: 'Starred', spam: 'Spam', trash: 'Trash' };
  const SEND_STATUS = { queued: ['Sending…', 'warn'], sent: ['Sent', 'good'], logged: ['Logged, not delivered', ''], partial: ['Partly failed', 'bad'], failed: ['Failed', 'bad'], draft: ['Draft', ''] };
  const RECIPIENT_STATUS = { queued: ['Queued', 'warn'], sending: ['Sending', 'warn'], sent: ['Sent', 'good'], logged: ['Logged', ''], failed: ['Failed', 'bad'], skipped: ['Skipped', ''] };
  let mailLabels = [];
  let mailStatus = null;

  // Red banner on every page when email cannot reach anyone (e.g. MAIL_TRANSPORT=log in production).
  async function loadMailStatus() {
    mailStatus = await api('GET', '/api/admin/mail-status');
    const banner = $('#mail-banner');
    banner.hidden = !mailStatus.problems.length;
    banner.replaceChildren(icon('alert'), el('div', {},
      el('strong', { text: 'Email is not set up correctly. ' }),
      el('ul', {}, ...mailStatus.problems.map((p) => el('li', { text: p })))));
    $('#mail-transport').textContent = mailStatus.transport === 'log'
      ? 'Sending: log only. Messages are stored, not delivered.'
      : `Sending via ${mailStatus.transport} as ${mailStatus.from.email}`;
    $('#cp-from').textContent = `From ${mailStatus.from.name ? `${mailStatus.from.name} <${mailStatus.from.email}>` : mailStatus.from.email}${mailStatus.replyTo ? ` · replies go to ${mailStatus.replyTo}` : ''}`;
  }

  async function loadLabels() {
    if (mailLabels.length) return;
    mailLabels = (await api('GET', '/api/admin/email-labels')).labels;
  }
  const labelById = (id) => mailLabels.find((l) => l.id === Number(id));
  const labelDot = (l) => el('span', { class: `adm-dot adm-dot-${l.color}`, title: l.name, 'aria-hidden': 'true' });

  const emailApp = (() => {
    const state = { folder: 'inbox', label: '', q: '', page: 1, pageSize: DEFAULT_PAGE_SIZE, open: 0 };
    let rows = [];
    let total = 0;
    const selected = new Set();
    let current = null;
    let seq = 0;

    function params() {
      const p = new URLSearchParams();
      if (state.label) p.set('label', state.label); else if (state.folder !== 'inbox') p.set('folder', state.folder);
      if (state.q) p.set('q', state.q);
      if (state.page > 1) p.set('page', String(state.page));
      if (state.pageSize !== DEFAULT_PAGE_SIZE) p.set('pageSize', String(state.pageSize));
      if (state.open) p.set('open', String(state.open));
      return p;
    }
    function setFromParams(p) {
      state.label = Number(p.get('label')) ? p.get('label') : '';
      state.folder = [...Object.keys(FOLDER_TITLES)].includes(p.get('folder')) ? p.get('folder') : 'inbox';
      state.q = p.get('q') || '';
      state.page = Math.max(1, Math.floor(Number(p.get('page'))) || 1);
      state.pageSize = PAGE_SIZES.includes(Number(p.get('pageSize'))) ? Number(p.get('pageSize')) : DEFAULT_PAGE_SIZE;
      state.open = Number(p.get('open')) || 0;
      $('#mail-search').value = state.q;
      $('#mail-size').value = String(state.pageSize);
    }
    const update = (replace = false) => { setTabUrl('email', params(), replace); load().catch((err) => toast(err.message, 'error')); };

    function renderSide(counts, labelCounts) {
      $$('#mail-side [data-folder]').forEach((b) => {
        const on = !state.label && b.dataset.folder === state.folder;
        b.classList.toggle('selected', on);
        if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      const set = (key, n) => { const c = $(`[data-count="${key}"]`); c.textContent = String(n); c.hidden = !n; };
      set('inbox', counts.inbox); set('draft', counts.draft); set('spam', counts.spam); set('starred', counts.starred); set('sent', counts.sent_attention);
      $('[data-count="sent"]').title = counts.sent_attention ? 'Sending, failed or partly failed' : '';
      $('#mail-labels').replaceChildren(...mailLabels.map((l) => el('button', {
        type: 'button', class: String(l.id) === String(state.label) ? 'selected' : '', ...(String(l.id) === String(state.label) ? { 'aria-current': 'page' } : {}),
        onclick: () => { state.label = String(l.id); state.page = 1; state.open = 0; selected.clear(); closeSide(); update(); },
      }, labelDot(l), el('span', { text: l.name }), labelCounts[l.id] ? el('span', { class: 'adm-mail-count', text: String(labelCounts[l.id]) }) : '')));
      const navBadge = $('#nav-badge-email');
      navBadge.textContent = String(counts.inbox);
      navBadge.hidden = !counts.inbox;
      navBadge.setAttribute('aria-label', `${counts.inbox} unread`);
    }

    function renderBulk() {
      const bar = $('#mail-bulk');
      const all = $('#mail-select-all');
      all.checked = rows.length > 0 && rows.every((r) => selected.has(r.id));
      all.indeterminate = !all.checked && rows.some((r) => selected.has(r.id));
      bar.hidden = !selected.size;
      $('#mail-tools').hidden = selected.size > 0;
      if (!selected.size) return;
      const ids = [...selected];
      const inTrash = state.folder === 'trash' && !state.label;
      const act = (action, value, done) => async () => {
        try {
          await api('POST', '/api/admin/emails/bulk', { ids, action, value });
          toast(done);
          selected.clear();
          load();
        } catch (err) { toast(err.message, 'error'); }
      };
      bar.replaceChildren(
        el('span', { class: 'adm-mail-selected', text: `${ids.length} selected` }),
        iconButton('mail-opened', 'Mark as read', act('read', null, 'Marked as read.')),
        iconButton('mail', 'Mark as unread', act('unread', null, 'Marked as unread.')),
        rowMenu('Move to', [
          { icon: 'inbox-in', text: 'Inbox', onClick: act('move', 'inbox', 'Moved to Inbox.') },
          { icon: 'ban', text: 'Spam', onClick: act('move', 'spam', 'Moved to Spam.') },
          inTrash ? { icon: 'rotate', text: 'Restore', onClick: act('restore', null, 'Restored.') } : { icon: 'trash', text: 'Trash', onClick: act('move', 'trash', 'Moved to Trash.') },
        ], 'folder-move'),
        rowMenu('Label', mailLabels.flatMap((l) => [
          { icon: 'tag', text: `Add “${l.name}”`, onClick: act('label', l.id, `Labelled ${l.name}.`) },
          { icon: 'x', text: `Remove “${l.name}”`, onClick: act('unlabel', l.id, `Removed label ${l.name}.`) },
        ]), 'tag'),
        iconButton('trash', inTrash ? 'Delete permanently' : 'Delete', async () => {
          if (inTrash && !confirm(`Delete ${ids.length} message${ids.length === 1 ? '' : 's'} permanently?`)) return;
          await act('delete', null, inTrash ? 'Deleted permanently.' : 'Moved to Trash.')();
        }, 'danger'),
      );
    }

    function rowFor(e) {
      const outbound = e.direction === 'out';
      const who = outbound ? `To: ${e.to_summary || '(no recipients)'}` : (e.from_name || e.from_email);
      const star = el('button', {
        type: 'button', class: `adm-star${e.is_starred ? ' on' : ''}`, 'aria-pressed': String(Boolean(e.is_starred)),
        'aria-label': e.is_starred ? 'Unstar' : 'Star',
        onclick: async (ev) => {
          ev.stopPropagation();
          await api('POST', '/api/admin/emails/bulk', { ids: [e.id], action: e.is_starred ? 'unstar' : 'star' }).catch((err) => toast(err.message, 'error'));
          load();
        },
      }, icon('star'));
      const box = el('input', {
        type: 'checkbox', class: 'adm-check', 'aria-label': `Select “${e.subject || '(no subject)'}”`,
        onclick: (ev) => ev.stopPropagation(),
        onchange: (ev) => { if (ev.target.checked) selected.add(e.id); else selected.delete(e.id); renderBulk(); },
      });
      box.checked = selected.has(e.id);
      const status = outbound && e.status !== 'sent' ? SEND_STATUS[e.status] : null;
      return el('li', {
        class: `adm-mail-row${e.is_read ? '' : ' unread'}`, tabindex: '0',
        onclick: () => openEmail(e.id),
        onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) openEmail(e.id); },
      },
        box, star,
        el('span', { class: 'adm-mail-who', title: who, text: who }),
        el('span', { class: 'adm-mail-what' },
          el('span', { class: 'adm-mail-subject', text: e.subject || '(no subject)' }),
          el('span', { class: 'adm-mail-snippet', text: e.snippet ? ` – ${e.snippet.replace(/\s+/g, ' ')}` : '' })),
        el('span', { class: 'adm-mail-meta' },
          ...e.label_ids.map(labelById).filter(Boolean).map(labelDot),
          e.attachments ? el('span', { class: 'adm-mail-clip', title: `${e.attachments} attachment${e.attachments === 1 ? '' : 's'}` }, icon('paperclip')) : '',
          e.category === 'bulk' ? el('span', { class: 'adm-badge', text: `Bulk · ${e.recipient_count}` }) : '',
          status ? badge(status) : '',
          el('time', { class: 'adm-mail-date', datetime: e.created_at, title: when(e.created_at), text: shortDate(e.created_at) })),
      );
    }

    async function load() {
      const mySeq = ++seq;
      await loadLabels();
      const p = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
      if (state.label) p.set('label', state.label); else p.set('folder', state.folder);
      if (state.q) p.set('q', state.q);
      const list = $('#mail-list');
      list.setAttribute('aria-busy', 'true');
      const data = await api('GET', `/api/admin/emails?${p}`);
      if (mySeq !== seq) return;
      list.removeAttribute('aria-busy');
      rows = data.emails;
      total = data.total;
      if (data.page !== state.page) { state.page = data.page; setTabUrl('email', params(), true); }
      for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);
      renderSide(data.counts, data.labelCounts);
      const label = state.label && labelById(state.label);
      $('#mail-title').textContent = label ? `Label: ${label.name}` : FOLDER_TITLES[state.folder];
      list.replaceChildren(...(rows.length ? rows.map(rowFor) : [el('li', { class: 'adm-mail-empty' },
        el('span', { class: 'adm-tile adm-tone-primary' }, icon('inbox')),
        el('strong', { text: state.q ? 'No messages match your search' : `Nothing in ${label ? label.name : FOLDER_TITLES[state.folder]}` }),
        el('span', { text: state.folder === 'inbox' && !state.q ? 'Contact-form messages and new membership applications arrive here.' : '' }))]));
      renderBulk();
      renderFooter();
      if (state.open) await showDetail(state.open); else showList();
    }

    function renderFooter() {
      const last = Math.max(1, Math.ceil(total / state.pageSize));
      const from = total ? (state.page - 1) * state.pageSize + 1 : 0;
      $('#mail-count').textContent = total ? `Showing ${from}–${Math.min(total, state.page * state.pageSize)} of ${total}` : 'No messages';
      const go = (n) => { state.page = n; selected.clear(); update(); };
      const pager = $('#mail-pager');
      if (last === 1) { pager.replaceChildren(); return; }
      const nav = (name, label, target, disabled) => { const b = iconButton(name, label, () => go(target), 'adm-page'); b.disabled = disabled; return b; };
      pager.replaceChildren(
        nav('chevrons-left', 'First page', 1, state.page === 1), nav('chevron-left', 'Previous page', state.page - 1, state.page === 1),
        ...pageNumbers(state.page, last).map((n) => (n === '…' ? el('span', { class: 'adm-page-gap', text: '…', 'aria-hidden': 'true' })
          : el('button', { type: 'button', class: `adm-page${n === state.page ? ' current' : ''}`, 'aria-label': `Page ${n}`, ...(n === state.page ? { 'aria-current': 'page' } : {}), onclick: () => go(n) }, String(n)))),
        nav('chevron-right', 'Next page', state.page + 1, state.page === last), nav('chevrons-right', 'Last page', last, state.page === last),
      );
    }

    function showList() {
      current = null;
      $('#mail-detail').hidden = true;
      $('#mail-list-view').hidden = false;
    }

    function openEmail(id) {
      const row = rows.find((r) => r.id === id);
      if (row && row.folder === 'draft') { state.open = 0; composer.openDraft(id); return; }
      state.open = id;
      setTabUrl('email', params());
      showDetail(id).catch((err) => toast(err.message, 'error'));
    }

    async function showDetail(id) {
      const d = await api('GET', `/api/admin/emails/${id}`);
      current = d;
      const e = d.email;
      const row = rows.find((r) => r.id === id);
      if (row && !row.is_read) { row.is_read = 1; refreshBadges(); }
      $('#mail-list-view').hidden = true;
      $('#mail-detail').hidden = false;
      $('#mail-subject').textContent = e.subject || '(no subject)';
      $('#mail-chips').replaceChildren(...d.labels.map(labelById).filter(Boolean).map((l) => el('span', { class: `adm-label-chip adm-chip-${l.color}` }, labelDot(l), l.name)),
        e.category === 'bulk' ? el('span', { class: 'adm-label-chip', text: 'Bulk' }) : '');
      const idx = rows.findIndex((r) => r.id === id);
      $('#mail-prev').disabled = idx <= 0;
      $('#mail-next').disabled = idx < 0 || idx >= rows.length - 1;
      const act = (action, value, done, after) => async () => {
        try { await api('POST', '/api/admin/emails/bulk', { ids: [id], action, value }); toast(done); if (after) after(); else showDetail(id); load(); } catch (err) { toast(err.message, 'error'); }
      };
      const back = () => { state.open = 0; setTabUrl('email', params()); showList(); };
      $('#mail-actions').replaceChildren(
        iconButton('trash', e.folder === 'trash' ? 'Delete permanently' : 'Delete', async () => {
          if (e.folder === 'trash' && !confirm('Delete this message permanently?')) return;
          await act('delete', null, e.folder === 'trash' ? 'Deleted permanently.' : 'Moved to Trash.', back)();
        }, 'danger'),
        iconButton('mail', 'Mark as unread', act('unread', null, 'Marked as unread.', back)),
        e.direction === 'in' ? rowMenu('Move to', [
          e.folder !== 'inbox' && { icon: 'inbox-in', text: 'Inbox', onClick: act('move', 'inbox', 'Moved to Inbox.') },
          e.folder !== 'spam' && { icon: 'ban', text: 'Spam', onClick: act('move', 'spam', 'Moved to Spam.', back) },
        ], 'folder-move') : '',
        e.folder === 'trash' ? iconButton('rotate', 'Restore', act('restore', null, 'Restored.')) : '',
        rowMenu('Label', mailLabels.map((l) => (d.labels.includes(l.id)
          ? { icon: 'x', text: `Remove “${l.name}”`, onClick: act('unlabel', l.id, `Removed label ${l.name}.`) }
          : { icon: 'tag', text: `Add “${l.name}”`, onClick: act('label', l.id, `Labelled ${l.name}.`) })), 'tag'),
        el('button', {
          type: 'button', class: `adm-icon-btn adm-star${e.is_starred ? ' on' : ''}`, 'aria-pressed': String(Boolean(e.is_starred)), 'aria-label': e.is_starred ? 'Unstar' : 'Star',
          onclick: act(e.is_starred ? 'unstar' : 'star', null, e.is_starred ? 'Unstarred.' : 'Starred.'),
        }, icon('star')),
      );

      const outbound = e.direction === 'out';
      const whoName = outbound ? (e.from_name || 'DCP UK') : (e.from_name || e.from_email);
      const body = el('div', { class: 'adm-mail-body' });
      if (e.body_html) body.innerHTML = e.body_html; // sanitised on the server (sanitize-html); the CSP also blocks inline script
      else body.textContent = e.body_text || '';
      if (!e.body_html) body.classList.add('plain');
      const totals = d.recipientTotals || {};
      const recipientList = outbound && d.recipients.length ? el('details', { class: 'adm-mail-recipients', ...(totals.failed ? { open: '' } : {}) },
        el('summary', {}, `Delivery: ${Object.entries(totals).map(([k, n]) => `${n} ${(RECIPIENT_STATUS[k] || [k])[0].toLowerCase()}`).join(', ')}`,
          e.excluded_count ? ` · ${e.excluded_count} excluded before sending (no chapter-news consent, or unsubscribed)` : ''),
        el('ul', {}, ...d.recipients.map((r) => el('li', {},
          el('span', { class: 'adm-break', text: `${r.kind !== 'to' ? `${r.kind.toUpperCase()}: ` : ''}${r.name ? `${r.name} <${r.address}>` : r.address}` }),
          badge(RECIPIENT_STATUS[r.status] || [r.status, '']),
          r.last_error ? el('span', { class: 'adm-mail-error', text: r.last_error }) : ''))),
        d.recipients.length < (Object.values(totals).reduce((s, n) => s + n, 0)) ? el('p', { class: 'adm-muted', text: 'Showing the first 500 recipients.' }) : '') : '';
      $('#mail-thread').replaceChildren(el('div', { class: 'adm-mail-card' },
        el('div', { class: 'adm-mail-card-head' },
          el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initials(String(whoName).replace(/\s+/g, '.')) }),
          el('div', { class: 'adm-mail-from' },
            el('strong', { text: whoName }),
            el('span', { text: outbound ? `to ${e.to_summary || ''}` : `<${e.from_email}>${e.reply_to && e.reply_to !== e.from_email ? ` · reply to ${e.reply_to}` : ''}` })),
          el('span', { class: 'adm-mail-when', text: when(e.sent_at || e.created_at) }),
          outbound ? badge(SEND_STATUS[e.status] || [e.status, '']) : ''),
        body,
        d.attachments.length ? el('div', { class: 'adm-mail-files' }, el('p', { class: 'adm-mail-heading', text: `${d.attachments.length} attachment${d.attachments.length === 1 ? '' : 's'}` }),
          ...d.attachments.map((a) => el('a', { class: 'adm-file', href: `/api/admin/email-attachments/${a.id}`, download: a.filename }, icon('paperclip'), el('span', { text: a.filename }), el('span', { class: 'adm-muted', text: fileSize(a.size) })))) : '',
        recipientList,
        e.member_id ? el('p', { class: 'adm-mail-member' }, el('button', { type: 'button', class: 'adm-link-btn', onclick: () => openMember(e.member_id) }, 'Open this member’s record')) : '',
      ));
      $('#mail-replybar').hidden = e.folder === 'draft';
      $('#mail-reply').hidden = outbound && e.source !== 'reply' && e.category === 'bulk';
    }

    // Reply goes to the sender's reply address (the contact form's email).
    function replyTarget() {
      const e = current.email;
      if (e.direction === 'in') return { address: e.reply_to || e.from_email, name: e.from_name || '', memberId: e.member_id || null };
      const to = current.recipients.find((r) => r.kind === 'to');
      return to ? { address: to.address, name: to.name || '', memberId: to.member_id || null } : null;
    }
    function quoted() {
      const e = current.email;
      const original = e.body_html || escapeHtml(e.body_text || '').replace(/\n/g, '<br>');
      return `<p><br></p><p>On ${escapeHtml(when(e.created_at))}, ${escapeHtml(e.from_name || e.from_email || 'DCP UK')} wrote:</p><blockquote>${original}</blockquote>`;
    }
    $('#mail-reply').addEventListener('click', () => {
      const t = replyTarget();
      if (!t) return;
      const e = current.email;
      composer.open({
        to: [t.memberId ? { type: 'member', id: t.memberId, label: t.name || t.address, email: t.address } : { type: 'address', address: t.address, name: t.name }],
        subject: /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`, html: quoted(), inReplyTo: e.id,
      });
    });
    $('#mail-forward').addEventListener('click', () => {
      const e = current.email;
      composer.open({ subject: /^fwd:/i.test(e.subject) ? e.subject : `Fwd: ${e.subject}`, html: `<p><br></p><p>---------- Forwarded message ----------</p>${quoted()}` });
      if (current.attachments.length) toast('Attachments are not forwarded. Download and attach them if needed.', 'info');
    });
    $('#mail-back').addEventListener('click', () => { state.open = 0; setTabUrl('email', params()); showList(); $('#mail-list .adm-mail-row')?.focus(); });
    const step = (dir) => () => {
      const idx = rows.findIndex((r) => r.id === current?.email.id);
      const next = rows[idx + dir];
      if (next) openEmail(next.id);
    };
    $('#mail-prev').addEventListener('click', step(-1));
    $('#mail-next').addEventListener('click', step(1));

    // Side panel (folders and labels) is off-canvas on phones.
    const closeSide = () => { $('#mail-side').classList.remove('open'); $('#mail-scrim').hidden = true; $('#mail-side-toggle').setAttribute('aria-expanded', 'false'); };
    $('#mail-side-toggle').addEventListener('click', () => { $('#mail-side').classList.add('open'); $('#mail-scrim').hidden = false; $('#mail-side-toggle').setAttribute('aria-expanded', 'true'); $('#mail-side button').focus(); });
    $('#mail-scrim').addEventListener('click', closeSide);
    $$('#mail-side [data-folder]').forEach((b) => b.addEventListener('click', () => {
      state.folder = b.dataset.folder; state.label = ''; state.page = 1; state.open = 0; selected.clear(); closeSide(); update();
    }));
    $('#mail-search').addEventListener('input', debounce(() => { state.q = $('#mail-search').value.trim(); state.page = 1; state.open = 0; update(true); }, 300));
    $('#mail-size').addEventListener('change', () => { state.pageSize = Number($('#mail-size').value); state.page = 1; update(); });
    $('#mail-refresh').addEventListener('click', () => { load().then(() => toast('Mailbox refreshed.', 'info')).catch((err) => toast(err.message, 'error')); });
    $('#mail-select-all').addEventListener('change', (ev) => { rows.forEach((r) => (ev.target.checked ? selected.add(r.id) : selected.delete(r.id))); load(); });
    $('#mail-compose').addEventListener('click', () => composer.open({}));

    return { name: 'email', load, params, setFromParams, reload: () => load() };
  })();

  const shortDate = (sqlDate) => {
    if (!sqlDate) return '';
    const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ------------------------------------------------------------ compose

  const composer = (() => {
    const dlg = $('#compose-dialog');
    const form = $('#cp-form');
    const toBox = $('#cp-to');
    const toInput = $('#cp-to-input');
    const suggest = $('#cp-to-list');
    const bodyEl = $('#cp-body');
    const CHAPTERS = ['London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow', 'Cardiff', 'Nottingham', 'Belfast', 'None nearby'];
    const SEG_VALUES = {
      chapter: CHAPTERS.map((c) => [c, c]),
      status: [['approved', 'Approved'], ['pending', 'Pending review'], ['rejected', 'Rejected']],
      payment: [['paid', 'Paid (confirmed)'], ['payment_reported', 'Reported paid'], ['pending_payment', 'Not paid']],
    };
    let tokens = [];
    let attachments = [];
    let templates = [];
    let draftId = null;
    let inReplyTo = null;
    let audience = null;
    let dirty = false;
    let confirmArmed = false;
    let options = [];
    let active = -1;

    const csv = (s) => String(s || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    const payload = () => ({
      to: tokens.filter((t) => t.type !== 'segment').map((t) => (t.type === 'member' ? { memberId: t.id } : { address: t.address, name: t.name || '' })),
      segments: tokens.filter((t) => t.type === 'segment').map((t) => ({ type: t.segType, value: t.value })),
      cc: csv($('#cp-cc').value), bcc: csv($('#cp-bcc').value),
    });

    function renderTokens() {
      $$('.adm-token', toBox).forEach((n) => n.remove());
      tokens.forEach((t, i) => {
        const label = t.type === 'segment' ? t.label : t.type === 'member' ? `${t.label}` : (t.name ? `${t.name} <${t.address}>` : t.address);
        toBox.insertBefore(el('span', { class: `adm-token${t.type === 'segment' ? ' seg' : ''}`, title: t.type === 'member' ? t.email : '' },
          t.type === 'segment' ? icon('users') : '', label,
          el('button', { type: 'button', 'aria-label': `Remove ${label}`, onclick: () => { tokens.splice(i, 1); dirty = true; renderTokens(); toInput.focus(); } }, icon('x'))), toInput);
      });
      toInput.placeholder = tokens.length ? '' : 'Name, email or reference';
      refreshAudience();
    }

    async function computeAudience(keepConfirm = false) {
      if (!keepConfirm) confirmArmed = false;
      setSendLabel();
      const box = $('#cp-audience');
      const p = payload();
      if (!p.to.length && !p.segments.length) { audience = null; box.replaceChildren(); box.className = 'adm-cp-audience'; return; }
      try { audience = await api('POST', '/api/admin/emails/audience', p); } catch (err) { box.textContent = err.message; return; }
      const a = audience;
      const parts = [];
      box.className = `adm-cp-audience ${a.errors.length || a.bulkBlocked ? 'bad' : a.category === 'bulk' ? 'bulk' : ''}`;
      if (a.errors.length) parts.push(el('strong', { text: a.errors[0] }));
      else if (a.category === 'bulk') {
        parts.push(icon('users'), el('span', {}, el('strong', { text: `Bulk email to ${a.recipients} member${a.recipients === 1 ? '' : 's'}.` }), ' Each copy is personalised and has an unsubscribe link.'));
        const ex = [];
        if (a.excluded.noMarketingConsent) ex.push(`${a.excluded.noMarketingConsent} haven't agreed to chapter news`);
        if (a.excluded.optedOut) ex.push(`${a.excluded.optedOut} unsubscribed`);
        if (a.excluded.notMember) ex.push(`${a.excluded.notMember} non-member address${a.excluded.notMember === 1 ? '' : 'es'} (bulk email goes to members only)`);
        if (ex.length) parts.push(el('span', { class: 'adm-cp-excluded', text: `${a.excludedTotal} excluded: ${ex.join(', ')}.` }));
        if (a.bulkBlocked) parts.push(el('strong', { text: 'Bulk sending is disabled until APP_SECRET is set.' }));
      } else parts.push(icon('user'), el('span', {}, el('strong', { text: `To ${a.recipients} person.` }), ' Service message: no newsletter footer or unsubscribe link.'));
      box.replaceChildren(...parts);
      setSendLabel();
    }
    const refreshAudience = debounce(() => computeAudience(), 250);

    function setSendLabel() {
      const label = $('#cp-send span');
      if (confirmArmed && audience?.category === 'bulk') label.textContent = `Confirm: send to ${audience.recipients}`;
      else label.textContent = audience?.category === 'bulk' ? `Send to ${audience.recipients} members` : 'Send';
    }

    // ---- recipient autocomplete
    function closeSuggest() { suggest.hidden = true; toInput.setAttribute('aria-expanded', 'false'); toInput.removeAttribute('aria-activedescendant'); active = -1; }
    function choose(i) {
      const o = options[i];
      if (!o) return;
      if (!tokens.some((t) => (o.type === 'member' ? t.id === o.id : t.address === o.address))) tokens.push(o);
      toInput.value = '';
      dirty = true;
      closeSuggest();
      renderTokens();
    }
    const lookup = debounce(async () => {
      const q = toInput.value.trim();
      if (q.length < 2) { closeSuggest(); return; }
      const { members } = await api('GET', `/api/admin/members/lookup?q=${encodeURIComponent(q)}`).catch(() => ({ members: [] }));
      options = members.map((m) => ({ type: 'member', id: m.id, label: m.full_name, email: m.email, consent: Boolean(m.consent), optedOut: Boolean(m.opted_out) }));
      if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(q) && !options.some((o) => o.email === q.toLowerCase())) options.push({ type: 'address', address: q.toLowerCase(), name: '' });
      suggest.replaceChildren(...(options.length ? options.map((o, i) => el('div', {
        class: 'adm-gsearch-item', role: 'option', id: `cp-opt-${i}`, 'aria-selected': 'false', onmousedown: (ev) => { ev.preventDefault(); choose(i); },
      }, icon(o.type === 'member' ? 'user' : 'mail'), el('div', {},
        el('strong', { text: o.type === 'member' ? o.label : `Send to ${o.address}` }),
        el('span', { text: o.type === 'member' ? `${o.email}${o.optedOut ? ' · unsubscribed from chapter news' : !o.consent ? ' · no chapter-news consent (one-to-one only)' : ''}` : 'Not a member: one-to-one messages only' })))) : [el('p', { class: 'adm-gsearch-empty', text: 'No matching members. Type a full email address to send to someone else.' })]));
      suggest.hidden = false;
      toInput.setAttribute('aria-expanded', 'true');
      active = options.length ? 0 : -1;
      markActive();
    }, 200);
    function markActive() {
      $$('.adm-gsearch-item', suggest).forEach((n, j) => n.setAttribute('aria-selected', String(j === active)));
      if (active >= 0) toInput.setAttribute('aria-activedescendant', `cp-opt-${active}`);
    }
    toInput.addEventListener('input', lookup);
    toInput.addEventListener('keydown', (ev) => {
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !suggest.hidden && options.length) {
        ev.preventDefault();
        active = (active + (ev.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
        markActive();
      } else if (ev.key === 'Enter' || ev.key === ',' || ev.key === 'Tab') {
        if (!suggest.hidden && active >= 0) { ev.preventDefault(); choose(active); }
        else if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(toInput.value.trim())) { ev.preventDefault(); options = [{ type: 'address', address: toInput.value.trim().toLowerCase(), name: '' }]; choose(0); }
      } else if (ev.key === 'Backspace' && !toInput.value && tokens.length) { tokens.pop(); renderTokens(); }
      else if (ev.key === 'Escape' && !suggest.hidden) { ev.preventDefault(); ev.stopPropagation(); closeSuggest(); }
    });
    toInput.addEventListener('blur', () => setTimeout(closeSuggest, 120));
    toBox.addEventListener('click', (ev) => { if (ev.target === toBox) toInput.focus(); });

    // ---- segments and cc/bcc
    const segType = $('#cp-seg-type');
    const segValue = $('#cp-seg-value');
    function syncSegValues() {
      const values = SEG_VALUES[segType.value];
      segValue.hidden = !values;
      segValue.replaceChildren(...(values || []).map(([v, l]) => el('option', { value: v, text: l })));
    }
    segType.addEventListener('change', syncSegValues);
    $('#cp-seg-btn').addEventListener('click', () => {
      const seg = $('#cp-seg');
      seg.hidden = !seg.hidden;
      $('#cp-seg-btn').setAttribute('aria-expanded', String(!seg.hidden));
      if (!seg.hidden) segType.focus();
    });
    $('#cp-seg-add').addEventListener('click', () => {
      const type = segType.value;
      const value = SEG_VALUES[type] ? segValue.value : null;
      const label = type === 'all' ? 'All members' : `${segType.selectedOptions[0].textContent.replace(/^By /, '').replace(/^./, (c) => c.toUpperCase())}: ${segValue.selectedOptions[0].textContent}`;
      if (!tokens.some((t) => t.type === 'segment' && t.segType === type && t.value === value)) tokens.push({ type: 'segment', segType: type, value, label });
      dirty = true;
      $('#cp-seg').hidden = true;
      $('#cp-seg-btn').setAttribute('aria-expanded', 'false');
      renderTokens();
    });
    $('#cp-ccbcc-btn').addEventListener('click', () => {
      const show = $('#cp-cc-row').hidden;
      $('#cp-cc-row').hidden = !show; $('#cp-bcc-row').hidden = !show;
      $('#cp-ccbcc-btn').setAttribute('aria-expanded', String(show));
      if (show) $('#cp-cc').focus();
    });
    ['#cp-cc', '#cp-bcc'].forEach((s) => $(s).addEventListener('input', () => { dirty = true; refreshAudience(); }));
    ['#cp-subject'].forEach((s) => $(s).addEventListener('input', () => { dirty = true; }));

    // ---- editor (contenteditable, cleaned on the server)
    $$('.adm-editor-bar [data-cmd]').forEach((b) => b.addEventListener('click', () => {
      bodyEl.focus();
      if (b.dataset.cmd === 'link') {
        const url = prompt('Link address (https://…)');
        if (!url) return;
        if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) { toast('Links must start with https://, http:// or mailto:', 'error'); return; }
        document.execCommand('createLink', false, url.trim());
      } else document.execCommand(b.dataset.cmd, false, null);
      dirty = true;
    }));
    $$('.adm-editor-bar [data-merge]').forEach((b) => b.addEventListener('click', () => { bodyEl.focus(); document.execCommand('insertText', false, `{{${b.dataset.merge}}}`); dirty = true; }));
    bodyEl.addEventListener('input', () => { dirty = true; });
    bodyEl.addEventListener('paste', (ev) => {
      // Paste as plain text: pasted HTML from Word or web pages carries styles the email would not keep.
      ev.preventDefault();
      document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
    });

    // ---- templates
    async function loadTemplates() {
      if (templates.length) return;
      templates = (await api('GET', '/api/admin/email-templates')).templates;
      $('#cp-template').replaceChildren(el('option', { value: '', text: 'Blank message' }), ...templates.map((t) => {
        const o = el('option', { value: t.key, text: `${t.name}${t.systemOnly ? ' (sent automatically)' : t.bulkOnly ? ' (bulk only)' : ''}` });
        if (t.systemOnly) o.disabled = true;
        return o;
      }));
    }
    $('#cp-template').addEventListener('change', (ev) => {
      const t = templates.find((x) => x.key === ev.target.value);
      if (!t) return;
      if (bodyEl.textContent.trim() && !confirm('Replace the current message with this template?')) { ev.target.value = ''; return; }
      $('#cp-subject').value = t.subject;
      bodyEl.innerHTML = t.html;
      dirty = true;
    });

    // ---- attachments (uploaded straight away, attached on send)
    function renderAttachments() {
      $('#cp-att').replaceChildren(...attachments.map((a, i) => el('li', { class: 'adm-file' }, icon('paperclip'), el('span', { text: a.filename }),
        el('span', { class: 'adm-muted', text: a.uploading ? 'uploading…' : fileSize(a.size) }),
        a.uploading ? '' : el('button', { type: 'button', class: 'adm-icon-btn', 'aria-label': `Remove ${a.filename}`, onclick: () => {
          attachments.splice(i, 1);
          renderAttachments();
          if (!draftId) api('DELETE', `/api/admin/email-attachments/${a.id}`).catch(() => {});
        } }, icon('x')))));
    }
    $('#cp-files').addEventListener('change', async (ev) => {
      const files = [...ev.target.files];
      ev.target.value = '';
      for (const file of files) {
        const total = attachments.reduce((s, a) => s + a.size, 0);
        if (file.size > 5 * 1048576) { toast(`${file.name} is over 5 MB.`, 'error'); continue; }
        if (total + file.size > 20 * 1048576) { toast('Attachments on one email can total at most 20 MB.', 'error'); break; }
        const entry = { filename: file.name, size: file.size, uploading: true };
        attachments.push(entry);
        renderAttachments();
        try {
          const res = await fetch('/api/admin/email-attachments', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }, body: file });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(res.status === 413 ? `${file.name} is over 5 MB.` : data.error || 'Upload failed.');
          Object.assign(entry, { id: data.id, uploading: false });
          dirty = true;
        } catch (err) {
          attachments.splice(attachments.indexOf(entry), 1);
          toast(err.message, 'error');
        }
        renderAttachments();
      }
    });

    // ---- open, save, send, close
    function reset() {
      tokens = []; attachments = []; draftId = null; inReplyTo = null; audience = null; dirty = false; confirmArmed = false;
      form.reset();
      bodyEl.innerHTML = '';
      $('#cp-cc-row').hidden = true; $('#cp-bcc-row').hidden = true; $('#cp-seg').hidden = true;
      syncSegValues();
      alertIn(dlg, '');
      renderAttachments();
    }
    async function open(opts) {
      await loadTemplates();
      reset();
      tokens = opts.to || [];
      for (const s of opts.segments || []) tokens.push(s);
      $('#cp-subject').value = opts.subject || '';
      bodyEl.innerHTML = opts.html || '';
      inReplyTo = opts.inReplyTo || null;
      draftId = opts.draftId || null;
      attachments = opts.attachments || [];
      if (opts.cc?.length || opts.bcc?.length) { $('#cp-cc-row').hidden = false; $('#cp-bcc-row').hidden = false; $('#cp-cc').value = (opts.cc || []).join(', '); $('#cp-bcc').value = (opts.bcc || []).join(', '); }
      if (opts.template) $('#cp-template').value = opts.template;
      $('#cp-title').textContent = draftId ? 'Edit draft' : inReplyTo ? 'Reply' : 'New message';
      renderTokens();
      renderAttachments();
      if (!dlg.open) dlg.showModal();
      (tokens.length ? bodyEl : toInput).focus();
    }
    async function openDraft(id) {
      try {
        const d = await api('GET', `/api/admin/emails/${id}`);
        const s = d.email.draft || {};
        const lookups = (s.to || []).filter((t) => t.memberId);
        const members = await Promise.all(lookups.map((t) => api('GET', `/api/admin/members/${t.memberId}`).then((r) => r.member).catch(() => null)));
        const to = (s.to || []).map((t) => {
          if (!t.memberId) return { type: 'address', address: t.address, name: t.name || '' };
          const m = members.find((x) => x && x.id === Number(t.memberId));
          return m ? { type: 'member', id: m.id, label: m.full_name, email: m.email } : null;
        }).filter(Boolean);
        const segLabel = (sg) => (sg.type === 'all' ? 'All members' : `${{ chapter: 'Chapter', status: 'Membership status', payment: 'Payment state' }[sg.type]}: ${(SEG_VALUES[sg.type].find(([v]) => v === sg.value) || [0, sg.value])[1]}`);
        await open({
          to, segments: (s.segments || []).map((sg) => ({ type: 'segment', segType: sg.type, value: sg.value, label: segLabel(sg) })),
          cc: s.cc, bcc: s.bcc, subject: d.email.subject, html: d.email.body_html, template: s.template, inReplyTo: s.inReplyTo, draftId: id,
          attachments: d.attachments.map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
        });
      } catch (err) { toast(err.message, 'error'); }
    }
    const body = () => ({
      ...payload(), subject: $('#cp-subject').value, html: bodyEl.innerHTML, template: $('#cp-template').value || null,
      attachmentIds: attachments.filter((a) => a.id).map((a) => a.id), inReplyTo, draftId,
    });
    function afterChange() { if (currentTab === 'email') emailApp.reload().catch(() => {}); refreshBadges(); }
    $('#cp-draft').addEventListener('click', async () => {
      try {
        const r = await api('POST', '/api/admin/emails', { ...body(), action: 'draft' });
        draftId = r.id;
        dirty = false;
        toast('Draft saved.');
        afterChange();
      } catch (err) { alertIn(dlg, err.message); }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (attachments.some((a) => a.uploading)) { alertIn(dlg, 'Wait for the attachments to finish uploading.'); return; }
      await computeAudience(true);
      if (audience?.errors?.length) { confirmArmed = false; setSendLabel(); alertIn(dlg, audience.errors[0]); return; }
      if (audience?.category === 'bulk' && !confirmArmed) {
        // Bulk sends need a second, deliberate click.
        confirmArmed = true;
        setSendLabel();
        alertIn(dlg, `This will email ${audience.recipients} members${audience.excludedTotal ? ` (${audience.excludedTotal} excluded)` : ''}. Press the button again to confirm.`, true);
        return;
      }
      const btn = $('#cp-send');
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/admin/emails', { ...body(), action: 'send' });
        dirty = false;
        dlg.close();
        toast(r.category === 'bulk' ? `Queued for ${r.recipients} members. It sends at the configured rate.` : mailStatus?.transport === 'log' ? 'Saved to Sent (log mode: not delivered).' : 'Sent.');
        afterChange();
      } catch (err) {
        confirmArmed = false;
        setSendLabel();
        alertIn(dlg, err.message);
      } finally { btn.disabled = false; }
    });
    const tryClose = () => { if (dirty && !confirm('Discard this message? Unsaved changes will be lost.')) return; dirty = false; dlg.close(); };
    $('#cp-close').addEventListener('click', tryClose);
    $('#cp-discard').addEventListener('click', tryClose);
    dlg.addEventListener('cancel', (ev) => { if (dirty) { ev.preventDefault(); tryClose(); } });

    return { open, openDraft };
  })();

  // ------------------------------------------------------------ roles in the UI (the API enforces them too)

  let me = null;
  const canDo = (perm) => Boolean(me && (me.perms.includes('*') || me.perms.includes(perm)));
  function applyPerms() {
    $$('[data-perm]').forEach((node) => node.classList.toggle('adm-noperm', !canDo(node.dataset.perm)));
  }
  const tabAllowed = (name) => { const b = $(`.adm-nav [data-tab="${name}"]`); return !b || !b.dataset.perm || canDo(b.dataset.perm); };
  function lockForm(form, locked) {
    $$('input, select, textarea, button[type="submit"]', form).forEach((c) => { c.disabled = locked; });
  }

  // ------------------------------------------------------------ finance: shared helpers

  let finOpts = null;
  async function financeOptions(force = false) {
    if (!finOpts || force) {
      finOpts = await api('GET', '/api/admin/finance/options');
      for (const id of ['#m-tier', '#out-tier']) {
        const s = $(id);
        const v = s.value;
        s.replaceChildren(el('option', { value: '', text: 'All tiers' }), ...finOpts.tiers.map((t) => el('option', { value: String(t.id), text: t.name })));
        s.value = v;
      }
    }
    return finOpts;
  }
  const TX_STATUS = { pending: ['Pending verification', 'warn'], verified: ['Verified', 'good'], reconciled: ['Reconciled', 'good'], rejected: ['Rejected', 'bad'], void: ['Void', ''] };
  const KENYAN = { yes: ['Kenyan: yes', 'good'], no: ['Kenyan: no', 'bad'], unknown: ['Kenyan: unknown', 'warn'] };
  const typeLabel = (t) => finOpts?.types[t]?.label || t;
  const methodLabel = (m) => finOpts?.methods[m] || m;
  const isOut = (t) => Boolean(finOpts?.types[t]?.out);
  const isFeeType = (t) => Boolean(finOpts?.types[t]?.fee);
  const txAmount = (x) => `${isOut(x.type) ? '−' : ''}${money(x.amount, x.currency)}`;
  const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const ACCOUNT_SHORT = { fee_account: 'Fee account', donations_account: 'Donations account', other: 'Other / cash' };

  function rowNode(dl, label, node) {
    if (!node) return;
    dl.append(el('dt', { text: label }), el('dd', {}, node));
  }

  // After any change to money: refresh whatever is showing it.
  function afterTxChange() {
    if (currentTab === 'transactions') tables.transactions.load().catch(() => {});
    if (currentTab === 'reports') loadReports().catch(() => {});
    if (currentTab === 'donations') tables.donations.load().catch(() => {});
    if (currentTab === 'members') tables.members.load().catch(() => {});
    if (currentTab === 'overview') loadOverview().catch(() => {});
    if (dialog.open && currentMember) loadMemberFinance(currentMember).catch(() => {});
    if (donationDialog.open && currentDonation) loadDonationPayments(currentDonation).catch(() => {});
    if (txDrawer.open && currentTx) openTx(currentTx.id).catch(() => {});
    refreshBadges();
  }

  // ------------------------------------------------------------ transactions: actions

  async function verifyTx(x) {
    if (x.recorded_by === me.username && finOpts?.settings?.requireSecondVerifier !== false) {
      toast('You recorded this payment, so another admin must verify it (four-eyes check).', 'error');
      return;
    }
    try {
      const r = await api('POST', `/api/admin/transactions/${x.id}/verify`);
      toast(`Verified.${r.receipt ? ` Receipt ${r.receipt}${r.emailed ? ' emailed to the payer' : ' issued'}.` : ''}`);
      if (r.selfVerified) toast('You verified a payment you recorded. This is flagged in the audit log.', 'info');
      afterTxChange();
    } catch (err) { toast(err.message, 'error'); }
  }
  async function txStatusAction(x, action, label, reasonPrompt) {
    const body = {};
    if (reasonPrompt) {
      body.reason = await askReason(reasonPrompt);
      if (!body.reason) return;
    }
    try {
      await api('POST', `/api/admin/transactions/${x.id}/${action}`, body);
      toast(label);
      afterTxChange();
    } catch (err) { toast(err.message, 'error'); }
  }
  function txActions(x, inDrawer = false) {
    const write = canDo('finance.write');
    return [
      !inDrawer && { icon: 'eye', text: 'View details', onClick: () => openTx(x.id) },
      write && x.status === 'pending' && { icon: 'check', text: 'Verify', primary: true, onClick: () => verifyTx(x) },
      write && x.status === 'pending' && { icon: 'pencil', text: 'Edit', onClick: () => editTx(x.id) },
      write && x.status === 'verified' && { icon: 'bank', text: 'Mark reconciled', onClick: () => txStatusAction(x, 'reconcile', 'Marked as reconciled with the bank statement.') },
      x.receipt_no && { icon: 'receipt', text: 'Open receipt', onClick: () => window.open(`/api/admin/transactions/${x.id}/receipt`, '_blank', 'noopener') },
      write && x.status === 'pending' && { icon: 'x', text: 'Reject', danger: true, onClick: () => txStatusAction(x, 'reject', 'Rejected.', { title: 'Reject this payment?', sub: `${x.payer_name}, ${txAmount(x)}. The reason is kept with the transaction and in the audit log.`, confirm: 'Reject payment' }) },
      write && x.status !== 'void' && { icon: 'ban', text: 'Void', danger: true, onClick: () => txStatusAction(x, 'void', 'Voided. It stays on the ledger, marked void.', { title: 'Void this transaction?', sub: `${x.payer_name}, ${txAmount(x)}${x.receipt_no ? `, receipt ${x.receipt_no}` : ''}. Voided entries stay visible with the reason; balances and pledges are updated.`, confirm: 'Void transaction' }) },
    ].filter(Boolean);
  }

  function txRow(x) {
    const flags = [];
    if (x.self_verified) flags.push(el('span', { class: 'adm-badge bad', title: 'Verified by the admin who recorded it', text: 'Self-verified' }));
    if (x.amount_gbp == null) flags.push(el('span', { class: 'adm-badge warn', text: 'Needs rate' }));
    if (x.type === 'donation' && x.donor_kenyan !== 'yes') flags.push(badge(KENYAN[x.donor_kenyan || 'unknown']));
    return el('tr', {
      class: `clickable${x.status === 'void' ? ' adm-void' : ''}`, tabindex: '0',
      onclick: () => openTx(x.id),
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openTx(x.id); },
    },
      el('td', { class: 'when', text: fmtDate(x.date_received) }),
      el('td', {}, el('div', {}, el('strong', { text: x.payer_name }),
        el('span', { class: 'sub', text: [x.member_reference, x.donation_reference, x.source === 'member_report' ? 'reported by member' : ''].filter(Boolean).join(' · ') }))),
      el('td', { class: 'col-contact' }, el('div', {}, typeLabel(x.type), el('span', { class: 'sub', text: ACCOUNT_SHORT[x.account] || x.account }))),
      el('td', { class: `amount${isOut(x.type) ? ' adm-out' : ''}` }, el('div', {}, txAmount(x),
        x.currency !== 'GBP' ? el('span', { class: 'sub', text: x.amount_gbp == null ? 'rate not entered' : `${gbp(x.amount_gbp)} at ${Number(x.fx_rate)}` }) : null)),
      el('td', { class: 'col-reg', text: methodLabel(x.method) }),
      el('td', { class: 'mono col-pledged', text: x.receipt_no || '—' }),
      el('td', {}, el('div', { class: 'adm-badges' }, badge(TX_STATUS[x.status] || [x.status, '']), ...flags)),
      el('td', { class: 'actions' }, rowMenu(`Actions for ${x.payer_name}`, txActions(x))),
    );
  }

  // ------------------------------------------------------------ transaction details (drawer)

  const txDrawer = $('#tx-drawer');
  let currentTx = null;
  async function openTx(id) {
    let d;
    try { d = await api('GET', `/api/admin/transactions/${id}`); } catch (err) { toast(err.message, 'error'); return; }
    await financeOptions();
    const x = d.transaction;
    currentTx = x;
    $('#txd-title').textContent = `${typeLabel(x.type)} · ${txAmount(x)}`;
    $('#txd-sub').textContent = `${TX_STATUS[x.status]?.[0] || x.status}${x.receipt_no ? ` · receipt ${x.receipt_no}` : ''}`;
    const flags = [];
    const alertBox = (tone, text) => el('div', { class: `adm-alert adm-alert-${tone}` }, icon(tone === 'danger' ? 'alert' : 'info'), el('p', { text }));
    if (x.status === 'void') flags.push(alertBox('danger', `Void: ${x.void_reason} (${x.voided_by}, ${when(x.voided_at)})`));
    if (x.self_verified) flags.push(alertBox('danger', 'Verified by the same admin who recorded it (four-eyes check was off). Flagged in the audit log.'));
    if (x.status === 'pending' && x.recorded_by === me.username && d.requireSecondVerifier) flags.push(alertBox('info', 'You recorded this payment, so another admin must verify it.'));
    if (x.amount_gbp == null) flags.push(alertBox('warning', `No exchange rate yet. Edit the payment and enter how many ${x.currency} made £1 on ${fmtDate(x.date_received)}.`));
    if (x.type === 'donation' && x.donor_kenyan !== 'yes') flags.push(alertBox('warning', `The donor has not declared they are a Kenyan citizen (declaration: ${x.donor_kenyan || 'unknown'}).`));
    $('#txd-flags').replaceChildren(...flags);
    const dl = $('#txd-details');
    dl.replaceChildren();
    row(dl, 'Received', fmtDate(x.date_received));
    row(dl, 'Paid by', `${x.payer_name}${x.payer_email ? ` <${x.payer_email}>` : ''}`);
    if (x.member_id) rowNode(dl, 'Member', el('button', { type: 'button', class: 'adm-link-btn', onclick: () => { txDrawer.close(); openMember(x.member_id); } }, `${x.member_name || ''} (${x.member_reference})`));
    if (x.donation_id) rowNode(dl, 'Pledge', el('button', { type: 'button', class: 'adm-link-btn', onclick: () => { txDrawer.close(); openDonationById(x.donation_id); } }, x.donation_reference));
    row(dl, 'Amount', txAmount(x));
    if (x.currency !== 'GBP') {
      row(dl, 'Exchange rate', x.fx_rate ? `1 GBP = ${Number(x.fx_rate)} ${x.currency} (entered by hand)` : 'Not entered yet');
      row(dl, 'GBP equivalent', x.amount_gbp == null ? '–' : `${gbp(x.amount_gbp)} (fixed when recorded)`);
    }
    row(dl, 'Method', methodLabel(x.method));
    row(dl, 'Paid into', x.account_label || ACCOUNT_SHORT[x.account]);
    row(dl, 'Reference', x.external_ref);
    if (x.type === 'donation') row(dl, 'Kenyan citizen (declared)', x.donor_kenyan || 'unknown');
    row(dl, 'Notes', x.notes);
    row(dl, 'Recorded', `${x.recorded_by}, ${when(x.recorded_at)}${x.source === 'member_report' ? ' (reported by the member)' : ''}`);
    if (x.verified_by) row(dl, 'Verified', `${x.verified_by}, ${when(x.verified_at)}`);
    if (x.reconciled_by) row(dl, 'Reconciled', `${x.reconciled_by}, ${when(x.reconciled_at)}`);
    if (x.rejected_reason) row(dl, 'Rejected because', x.rejected_reason);
    $('#txd-history').replaceChildren(...d.history.map((h) => el('li', {},
      el('span', { class: 'adm-timeline-when', text: when(h.at) }),
      el('span', {}, el('strong', { text: h.actor }), ` ${h.summary || h.action}`),
      h.flags ? el('span', { class: 'adm-badge bad', text: h.flags.replace(/_/g, ' ') }) : '')));
    $('#txd-actions').replaceChildren(el('span', { class: 'adm-spacer' }), ...txActions(x, true).map((a) => el('button', {
      type: 'button', class: `adm-btn ${a.primary ? 'adm-btn-primary' : a.danger ? 'adm-btn-danger' : 'adm-btn-outline'}`, onclick: a.onClick,
    }, icon(a.icon), a.text)));
    alertIn(txDrawer, '');
    if (!txDrawer.open) txDrawer.showModal();
  }

  // ------------------------------------------------------------ record payment (drawer)

  const rpd = $('#rp-drawer');
  const rpf = $('#rpd-form');
  let rp = { editId: null, member: null, accountTouched: false, pledges: null };
  const RP_FIELDS = { type: 'rpd-type', memberId: 'rpd-member-input', donationId: 'rpd-pledge', payerName: 'rpd-payer', payerEmail: 'rpd-payer-email',
    amount: 'rpd-amount', currency: 'rpd-currency', fxRate: 'rpd-rate', method: 'rpd-method', account: 'rpd-account', dateReceived: 'rpd-date',
    externalRef: 'rpd-ref', donorKenyan: 'rpd-kenyan', notes: 'rpd-notes' };
  function rpErrors(fields = {}) {
    $$('.adm-field', rpf).forEach((f) => { f.classList.remove('invalid'); $('.adm-field-error', f)?.remove(); });
    let first = null;
    for (const [key, message] of Object.entries(fields)) {
      const input = document.getElementById(RP_FIELDS[key] || '');
      const wrap = input?.closest('.adm-field');
      if (!wrap) continue;
      wrap.classList.add('invalid');
      wrap.append(el('span', { class: 'adm-field-error', text: message }));
      first ||= input;
    }
    first?.focus();
  }
  const defaultAccount = (type) => (isFeeType(type) || type === 'refund' ? 'fee_account' : type === 'donation' ? 'donations_account' : 'other');
  function syncRp() {
    const type = $('#rpd-type').value;
    const cur = $('#rpd-currency').value;
    const show = {
      member: isFeeType(type) || type === 'refund',
      pledge: type === 'donation',
      payer: !rp.member,
      kenyan: type === 'donation',
      fx: cur !== 'GBP',
    };
    $$('[data-show]', rpf).forEach((n) => { n.hidden = !show[n.dataset.show]; });
    $('#rpd-rate-cur').textContent = cur;
    const amount = Number($('#rpd-amount').value);
    const rate = Number($('#rpd-rate').value);
    $('#rpd-gbp').textContent = cur === 'GBP' ? '' : amount > 0 && rate > 0 ? gbp(Math.round((amount / rate) * 100) / 100) : 'Enter the amount and rate';
    if (!rp.accountTouched) $('#rpd-account').value = defaultAccount(type);
    if (show.pledge && !rp.pledges) loadPledgeOptions();
  }
  async function loadPledgeOptions(selectedId) {
    rp.pledges = (await api('GET', '/api/admin/donations?status=pledged&pageSize=100&sort=pledged&dir=desc').catch(() => ({ donations: [] }))).donations;
    const s = $('#rpd-pledge');
    const keep = selectedId || s.value;
    s.replaceChildren(el('option', { value: '', text: 'Not linked to a pledge' }), ...rp.pledges.map((p) => el('option', { value: String(p.id), text: `${p.reference} · ${p.full_name} · ${gbp(p.amount_gbp)}` })));
    if (keep && !rp.pledges.some((p) => String(p.id) === String(keep)) && rp.extraPledge) {
      s.append(el('option', { value: String(rp.extraPledge.id), text: `${rp.extraPledge.reference} · ${rp.extraPledge.full_name} · ${gbp(rp.extraPledge.amount_gbp)}` }));
    }
    s.value = keep ? String(keep) : '';
  }
  $('#rpd-pledge').addEventListener('change', () => {
    const p = (rp.pledges || []).find((x) => String(x.id) === $('#rpd-pledge').value);
    if (!p) return;
    if (!$('#rpd-payer').value) $('#rpd-payer').value = p.full_name;
    if (!$('#rpd-payer-email').value) $('#rpd-payer-email').value = p.email;
    if (!$('#rpd-amount').value) $('#rpd-amount').value = p.amount_gbp;
    $('#rpd-kenyan').value = p.donor_kenyan || 'unknown';
    syncRp();
  });
  ['#rpd-type', '#rpd-currency', '#rpd-amount', '#rpd-rate'].forEach((s) => $(s).addEventListener('input', syncRp));
  $('#rpd-account').addEventListener('change', () => { rp.accountTouched = true; });

  // Member picker
  const mInput = $('#rpd-member-input');
  const mList = $('#rpd-member-list');
  let mOptions = [];
  async function setRpMember(m) {
    rp.member = m;
    mInput.value = m ? `${m.full_name} (${m.reference})` : '';
    mList.hidden = true;
    mInput.setAttribute('aria-expanded', 'false');
    $('#rpd-member-balance').textContent = '';
    if (m) {
      const { finance: f } = await api('GET', `/api/admin/members/${m.id}/finance`).catch(() => ({}));
      if (f) {
        $('#rpd-member-balance').textContent = `${f.tier ? f.tier.name : 'No tier'} · ${f.balance > 0 ? `${gbp(f.balance)} due` : 'nothing due'}${f.pending ? ` · ${gbp(f.pending)} already pending` : ''}`;
        if (f.tier && isFeeType($('#rpd-type').value) && !rp.editId) $('#rpd-type').value = f.tier.txType;
        if (!$('#rpd-amount').value && f.balance > 0 && !rp.editId) $('#rpd-amount').value = f.balance;
      }
    }
    syncRp();
  }
  mInput.addEventListener('input', debounce(async () => {
    if (rp.member) { rp.member = null; syncRp(); }
    const q = mInput.value.trim();
    if (q.length < 2) { mList.hidden = true; return; }
    const { members } = await api('GET', `/api/admin/members?q=${encodeURIComponent(q)}&pageSize=8`).catch(() => ({ members: [] }));
    mOptions = members;
    mList.replaceChildren(...(members.length ? members.map((m, i) => el('div', {
      class: 'adm-gsearch-item', role: 'option', id: `rpm-${i}`, 'aria-selected': String(i === 0), onmousedown: (e) => { e.preventDefault(); setRpMember(m); },
    }, icon('user'), el('div', {}, el('strong', { text: m.full_name }), el('span', { text: `${m.reference} · ${m.tier_name || 'no tier'} · ${m.chapter || ''}` })))) : [el('p', { class: 'adm-gsearch-empty', text: 'No matching members.' })]));
    mList.hidden = false;
    mInput.setAttribute('aria-expanded', 'true');
  }, 200));
  mInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !mList.hidden && mOptions[0]) { e.preventDefault(); setRpMember(mOptions[0]); }
    if (e.key === 'Escape' && !mList.hidden) { e.preventDefault(); e.stopPropagation(); mList.hidden = true; }
  });
  mInput.addEventListener('blur', () => setTimeout(() => { mList.hidden = true; }, 150));

  async function openRecordPayment(pre = {}) {
    await financeOptions();
    rpf.reset();
    rp = { editId: pre.editId || null, member: null, accountTouched: Boolean(pre.account), pledges: null, extraPledge: pre.donation || null };
    alertIn(rpd, '');
    rpErrors();
    const opt = (v, t) => el('option', { value: v, text: t });
    $('#rpd-type').replaceChildren(...Object.entries(finOpts.types).map(([k, t]) => opt(k, t.label)));
    $('#rpd-method').replaceChildren(...Object.entries(finOpts.methods).map(([k, t]) => opt(k, t)));
    $('#rpd-account').replaceChildren(...Object.entries(finOpts.accounts).map(([k, t]) => opt(k, t)));
    $('#rpd-type').value = pre.type || (pre.donation ? 'donation' : 'membership_fee');
    $('#rpd-currency').value = pre.currency || 'GBP';
    $('#rpd-amount').value = pre.amount ?? '';
    $('#rpd-rate').value = pre.fxRate ?? '';
    $('#rpd-method').value = pre.method || 'bank_transfer';
    $('#rpd-account').value = pre.account || defaultAccount($('#rpd-type').value);
    $('#rpd-date').value = pre.dateReceived || todayIso();
    $('#rpd-date').max = todayIso();
    $('#rpd-ref').value = pre.externalRef || '';
    $('#rpd-notes').value = pre.notes || '';
    $('#rpd-payer').value = pre.payerName || pre.donation?.full_name || '';
    $('#rpd-payer-email').value = pre.payerEmail || pre.donation?.email || '';
    $('#rpd-kenyan').value = pre.donorKenyan || pre.donation?.donor_kenyan || 'unknown';
    if (pre.donation && pre.amount == null) $('#rpd-amount').value = pre.donation.amount_gbp;
    $('#rpd-title').textContent = rp.editId ? 'Edit pending payment' : 'Record payment';
    $('#rpd-save').textContent = rp.editId ? 'Save changes' : 'Save as pending';
    $('#rpd-sub').textContent = finOpts.settings.requireSecondVerifier
      ? 'Saved as pending. A different admin must verify it before it counts.'
      : 'Saved as pending until it is verified. Four-eyes check is off: verifying your own entry is flagged.';
    syncRp();
    if ($('#rpd-type').value === 'donation') await loadPledgeOptions(pre.donation?.id || pre.donationId);
    await setRpMember(pre.member || null);
    if (!rpd.open) rpd.showModal();
    (pre.member ? $('#rpd-amount') : $('#rpd-type')).focus();
  }
  async function editTx(id) {
    try {
      const { transaction: x } = await api('GET', `/api/admin/transactions/${id}`);
      if (txDrawer.open) txDrawer.close();
      await openRecordPayment({
        editId: x.id, type: x.type, amount: x.amount, currency: x.currency, fxRate: x.fx_rate ?? '', method: x.method, account: x.account,
        dateReceived: String(x.date_received).slice(0, 10), externalRef: x.external_ref, notes: x.notes, payerName: x.payer_name, payerEmail: x.payer_email,
        donorKenyan: x.donor_kenyan, donationId: x.donation_id,
        member: x.member_id ? { id: x.member_id, full_name: x.member_name || x.payer_name, reference: x.member_reference } : null,
      });
    } catch (err) { toast(err.message, 'error'); }
  }
  rpf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      type: $('#rpd-type').value, memberId: rp.member?.id || null, donationId: $('#rpd-type').value === 'donation' ? $('#rpd-pledge').value || null : null,
      payerName: rp.member ? '' : $('#rpd-payer').value, payerEmail: rp.member ? '' : $('#rpd-payer-email').value,
      amount: $('#rpd-amount').value, currency: $('#rpd-currency').value, fxRate: $('#rpd-currency').value === 'GBP' ? 1 : $('#rpd-rate').value,
      method: $('#rpd-method').value, account: $('#rpd-account').value, dateReceived: $('#rpd-date').value,
      externalRef: $('#rpd-ref').value, donorKenyan: $('#rpd-kenyan').value, notes: $('#rpd-notes').value,
    };
    rpErrors();
    try {
      await busy(rpf, () => api(rp.editId ? 'PUT' : 'POST', rp.editId ? `/api/admin/transactions/${rp.editId}` : '/api/admin/transactions', body));
      rpd.close();
      toast(rp.editId ? 'Pending payment updated.' : finOpts.settings.requireSecondVerifier ? 'Recorded as pending. Another admin must verify it.' : 'Recorded as pending.');
      afterTxChange();
    } catch (err) {
      alertIn(rpd, err.message);
      const res = err.fields || {};
      rpErrors(res);
    }
  });
  $('#rpd-close').addEventListener('click', () => rpd.close());
  $('#rpd-cancel').addEventListener('click', () => rpd.close());
  $('#tx-record').addEventListener('click', () => openRecordPayment());

  // ------------------------------------------------------------ member dialog: fees

  async function loadMemberFinance(m) {
    const { finance: f, transactions } = await api('GET', `/api/admin/members/${m.id}/finance`);
    const fig = (label, value, tone) => el('div', { class: `adm-fig${tone ? ` ${tone}` : ''}` }, el('span', { text: label }), el('strong', { text: value }));
    $('#md-figures').replaceChildren(
      fig('Tier', f.tier ? `${f.tier.name} (${gbp(f.tier.amount)}${f.tier.renewal === 'yearly' ? ' a year' : ', once'})` : 'None'),
      fig(f.tier?.renewal === 'yearly' ? `Due (${f.periods} year${f.periods === 1 ? '' : 's'})` : 'Due', gbp(f.due)),
      fig('Paid (verified)', gbp(f.paid)),
      fig('Balance', f.balance > 0 ? `${gbp(f.balance)} due` : f.balance < 0 ? `${gbp(-f.balance)} in credit` : 'Up to date', f.balance > 0 ? 'bad' : 'good'),
      fig(f.paidUntil ? 'Paid until' : f.nextRenewal ? 'Renews' : 'Membership start', f.paidUntil ? fmtDate(f.paidUntil) : f.nextRenewal ? fmtDate(f.nextRenewal) : fmtDate(f.membershipStart) || '–'),
      f.pending ? fig('Awaiting verification', gbp(f.pending), 'warn') : '',
    );
    const review = $('#md-review');
    review.hidden = !f.feeReview;
    review.replaceChildren(icon('alert'), el('p', {}, el('strong', { text: 'Fee needs review. ' }), f.feeReviewReason || ''),
      canDo('finance.write') ? el('button', { type: 'button', class: 'adm-btn adm-btn-outline adm-btn-sm', onclick: async () => {
        const note = await askReason({ title: 'Clear the fee review?', sub: 'Say what you checked. It is added to the notes and the audit log.', confirm: 'Clear review' });
        if (!note) return;
        try { await api('PATCH', `/api/admin/members/${m.id}`, { feeReviewResolved: true, feeReviewNote: note }); toast('Fee review cleared.'); loadMemberFinance(m); tables.members.load().catch(() => {}); } catch (err) { toast(err.message, 'error'); }
      } }, 'Mark reviewed') : '');
    $('#md-tx').replaceChildren(...(transactions.length ? transactions.map((x) => el('li', {}, el('button', { type: 'button', onclick: () => openTx(x.id) },
      el('span', { text: fmtDate(x.date_received) }), el('span', { text: typeLabel(x.type) }), el('strong', { text: txAmount(x) }),
      badge(TX_STATUS[x.status] || [x.status, '']), x.receipt_no ? el('span', { class: 'mono', text: x.receipt_no }) : ''))) : [el('li', { class: 'adm-muted', text: 'No payments recorded yet.' })]));
    $('#md-pay').onclick = () => openRecordPayment({ member: m, type: f.tier?.txType, amount: f.balance > 0 ? f.balance : undefined });
  }

  // ------------------------------------------------------------ donation dialog: payments

  async function loadDonationPayments(d) {
    const { transactions } = await api('GET', `/api/admin/donations/${d.id}`);
    $('#dd-tx').replaceChildren(...(transactions.length ? transactions.map((x) => el('li', {}, el('button', { type: 'button', onclick: () => openTx(x.id) },
      el('span', { text: fmtDate(x.date_received) }), el('strong', { text: money(x.amount, x.currency) }), badge(TX_STATUS[x.status] || [x.status, '']),
      x.receipt_no ? el('span', { class: 'mono', text: x.receipt_no }) : ''))) : [el('li', { class: 'adm-muted', text: 'No payment recorded yet. The pledge becomes Received when one is verified.' })]));
    const pay = $('#dd-pay');
    pay.hidden = d.status === 'cancelled';
    pay.onclick = () => openRecordPayment({ donation: d });
  }

  // ------------------------------------------------------------ reports

  function reportQuery(extra = {}) {
    const p = new URLSearchParams();
    for (const [k, id] of [['from', '#rp-from'], ['to', '#rp-to'], ['type', '#rp-type'], ['method', '#rp-method'], ['chapter', '#rp-chapter']]) if ($(id).value) p.set(k, $(id).value);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    return p;
  }
  function setRange(kind) {
    const t = new Date();
    const y = t.getUTCFullYear();
    const m = t.getUTCMonth();
    const iso = (d) => d.toISOString().slice(0, 10);
    const from = kind === 'month' ? new Date(Date.UTC(y, m, 1)) : kind === 'quarter' ? new Date(Date.UTC(y, m - (m % 3), 1)) : kind === 'year' ? new Date(Date.UTC(y, 0, 1)) : new Date(Date.UTC(y - 1, m, t.getUTCDate() + 1));
    $('#rp-from').value = iso(from);
    $('#rp-to').value = iso(t);
  }
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => { setRange(b.dataset.range); loadReports().catch((err) => toast(err.message, 'error')); }));
  ['#rp-from', '#rp-to', '#rp-type', '#rp-method', '#rp-chapter'].forEach((s) => $(s).addEventListener('change', () => loadReports().catch((err) => toast(err.message, 'error'))));
  $('#rp-period').addEventListener('change', () => setExportLinks());

  function setExportLinks() {
    $$('a[data-export]').forEach((a) => {
      const kind = a.dataset.export;
      const p = kind === 'outstanding' ? tables.reports.params({ paging: false }) : reportQuery(kind === 'donors' ? { period: $('#rp-period').value } : {});
      p.set('kind', kind);
      p.set('format', a.dataset.format);
      a.href = `/api/admin/reports/export?${p}`;
    });
  }

  const miniTable = (target, rows, labelOf) => $(target).replaceChildren(
    el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { text: 'Count' }), el('th', { text: 'GBP' }))),
    el('tbody', {}, ...(rows.length ? rows.map((r) => el('tr', {}, el('td', { text: labelOf(r) }), el('td', { text: String(r.n) }), el('td', { class: r.gbp < 0 ? 'adm-out' : '', text: gbp(r.gbp) })))
      : [el('tr', {}, el('td', { colspan: '3', class: 'adm-muted', text: 'Nothing in this period.' }))])));

  async function loadReports() {
    await financeOptions();
    if (!$('#rp-from').value) setRange('year');
    const s = await api('GET', `/api/admin/reports/summary?${reportQuery()}`);
    const kpi = (label, value, sub, tone) => el('div', { class: 'adm-card adm-kpi' }, el('span', { class: 'adm-kpi-label', text: label }), el('strong', { class: tone || '', text: value }), el('span', { class: 'adm-kpi-sub', text: sub }));
    $('#rp-kpis').replaceChildren(
      kpi('Money in', gbp(s.totals.income), `${s.totals.n} verified transactions`),
      kpi('Money out', gbp(s.totals.out), 'Refunds and expenses', s.totals.out ? 'adm-out' : ''),
      kpi('Net', gbp(s.totals.net), `${fmtDate(s.from)} – ${fmtDate(s.to)}`),
      kpi('Awaiting verification', gbp(s.pending.gbp), `${s.pending.n} pending${s.pending.noRate ? `, ${s.pending.noRate} without a rate` : ''}`, s.pending.n ? 'warn' : ''),
    );
    drawChart('rp-month', $('#chart-rp-month'), (t) => ({
      chart: baseChart(t, { type: 'bar', height: 280, stacked: false }),
      series: [{ name: 'Money in', data: s.byMonth.map((r) => r.income) }, { name: 'Money out', data: s.byMonth.map((r) => r.out) }],
      xaxis: { categories: s.byMonth.map((r) => new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })), labels: { style: { colors: t.muted } } },
      yaxis: { labels: { style: { colors: t.muted }, formatter: (v) => `£${Math.round(v)}` } },
      colors: [t.bar, cssVar('--accent-2')],
      plotOptions: { bar: { columnWidth: '55%', borderRadius: 4 } },
      grid: { borderColor: t.border, strokeDashArray: 4 },
      dataLabels: { enabled: false }, legend: { labels: { colors: t.text } },
      tooltip: { theme: t.dark ? 'dark' : 'light', y: { formatter: (v) => gbp(v) } },
      noData: { text: 'No verified money in this period', style: { color: t.muted } },
    }));
    miniTable('#rp-by-type', s.byType, (r) => r.label);
    miniTable('#rp-by-method', s.byMethod, (r) => r.label);
    miniTable('#rp-by-chapter', s.byChapter, (r) => r.k);
    const dec = Object.fromEntries(s.donations.byDeclaration.map((r) => [r.k, r]));
    $('#rp-donations').replaceChildren(el('dl', { class: 'adm-details' },
      el('dt', { text: 'Pledges made' }), el('dd', { text: `${s.donations.pledges} (${gbp(s.donations.pledgedGbp)})` }),
      el('dt', { text: 'Received / still open' }), el('dd', { text: `${s.donations.received} / ${s.donations.open}` }),
      el('dt', { text: 'Verified: Kenyan "yes"' }), el('dd', { text: `${dec.yes?.n || 0} (${gbp(dec.yes?.gbp || 0)})` }),
      el('dt', { text: 'Verified: flagged' }), el('dd', { class: (dec.no?.n || dec.unknown?.n) ? 'adm-flagged' : '', text: `${(dec.no?.n || 0) + (dec.unknown?.n || 0)} (${gbp((dec.no?.gbp || 0) + (dec.unknown?.gbp || 0))}): ${dec.no?.n || 0} no, ${dec.unknown?.n || 0} unknown` })));
    setExportLinks();
    await tables.reports.load();
  }

  // Outstanding fees table + reminders
  const outSelected = new Set();
  function outRow(m) {
    const box = el('input', { type: 'checkbox', class: 'adm-check', 'aria-label': `Select ${m.full_name}`, onclick: (e) => e.stopPropagation(),
      onchange: (e) => { if (e.target.checked) outSelected.add(m.id); else outSelected.delete(m.id); syncRemind(); } });
    box.checked = outSelected.has(m.id);
    return el('tr', { class: 'clickable', tabindex: '0', onclick: () => openMember(m.id), onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) openMember(m.id); } },
      el('td', {}, box),
      el('td', {}, el('div', {}, el('strong', { text: m.full_name }), el('span', { class: 'sub', text: `${m.reference} · ${m.status}` }))),
      el('td', { class: 'col-contact', text: m.chapter || '—' }),
      el('td', { text: m.tier_name || '—' }),
      el('td', { class: 'amount adm-out', text: gbp(m.balance) }),
      el('td', { class: 'when col-reg', text: m.last_paid ? fmtDate(m.last_paid) : 'Never' }),
      el('td', { class: 'actions' }, rowMenu(`Actions for ${m.full_name}`, [
        { icon: 'eye', text: 'Open member', onClick: () => openMember(m.id) },
        canDo('finance.write') && { icon: 'cash', text: 'Record payment', onClick: () => openRecordPayment({ member: m, amount: m.balance }) },
      ])));
  }
  function syncRemind() {
    const b = $('#out-remind');
    b.disabled = !outSelected.size;
    b.lastChild.textContent = outSelected.size ? `Send reminders (${outSelected.size})` : 'Send reminders';
    const pageBoxes = $$('#out-body .adm-check');
    $('#out-all').checked = pageBoxes.length > 0 && pageBoxes.every((c) => c.checked);
  }
  $('#out-all').addEventListener('change', (e) => { $$('#out-body .adm-check').forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event('change')); }); });
  $('#out-remind').addEventListener('click', async () => {
    const n = outSelected.size;
    if (!n || !confirm(`Email a payment reminder to ${n} member${n === 1 ? '' : 's'}? Each gets one service email about their own balance.`)) return;
    try {
      const r = await api('POST', '/api/admin/reports/outstanding/remind', { memberIds: [...outSelected] });
      toast(`Reminders queued for ${r.sent} member${r.sent === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped: nothing due)` : ''}. They appear in Email → Sent.`);
      outSelected.clear();
      syncRemind();
      tables.reports.load();
    } catch (err) { toast(err.message, 'error'); }
  });

  // ------------------------------------------------------------ audit log

  const ACTION_TEXT = {
    'transaction.recorded': 'Recorded a payment', 'transaction.edited': 'Edited a pending payment', 'transaction.verified': 'Verified a payment',
    'transaction.reconciled': 'Reconciled a payment', 'transaction.rejected': 'Rejected a payment', 'transaction.voided': 'Voided a transaction',
    'member.updated': 'Updated a member', 'member.rejected': 'Rejected a member', 'member.deleted': 'Deleted a member', 'member.payment_synced': 'Payment status updated',
    'donation.updated': 'Updated a pledge', 'donation.cancelled': 'Cancelled a pledge', 'donation.status_synced': 'Pledge status updated',
    'settings.finance': 'Changed finance settings', 'settings.payment_account': 'Changed a payment account', 'tier.updated': 'Changed a tier',
    'admin.created': 'Added an admin', 'admin.role_changed': 'Changed an admin role', 'admin.password_changed': 'Changed password', 'reminders.sent': 'Sent payment reminders',
  };
  function auditRow(a) {
    const open = { transaction: () => openTx(a.entity_id), member: () => openMember(a.entity_id), donation: () => openDonationById(a.entity_id) }[a.entity];
    let details = '';
    if (a.before_json || a.after_json) {
      const before = a.before_json ? JSON.parse(a.before_json) : {};
      const after = a.after_json ? JSON.parse(a.after_json) : {};
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
      details = el('details', { class: 'adm-audit-diff' }, el('summary', { text: `${keys.length} field${keys.length === 1 ? '' : 's'}` }),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Field' }), el('th', { text: 'Before' }), el('th', { text: 'After' }))),
          el('tbody', {}, ...keys.map((k) => el('tr', {}, el('td', { text: k }), el('td', { text: before[k] == null ? '–' : String(before[k]) }), el('td', { text: after[k] == null ? '–' : String(after[k]) }))))));
    }
    return el('tr', { class: a.flags ? 'adm-flag-row' : '' },
      el('td', { class: 'when', text: when(a.at) }),
      el('td', {}, el('div', {}, el('span', { class: 'adm-email', title: a.actor, text: a.actor }), a.actor_type !== 'admin' ? el('span', { class: 'sub', text: a.actor_type }) : null)),
      el('td', {}, el('div', {}, el('strong', { text: ACTION_TEXT[a.action] || a.action }), el('span', { class: 'sub', text: a.summary || '' }),
        a.flags ? el('span', { class: 'adm-badge bad', text: a.flags.replace(/_/g, ' ') }) : null)),
      el('td', { class: 'col-contact' }, open ? el('button', { type: 'button', class: 'adm-link-btn', onclick: open }, `${a.entity} #${a.entity_id}`) : `${a.entity}${a.entity_id ? ` ${a.entity_id}` : ''}`),
      el('td', {}, details),
    );
  }

  // ------------------------------------------------------------ payment accounts: tiers and finance settings

  function tierRow(t) {
    const f = el('form', { class: 'adm-tier', novalidate: '' },
      el('div', { class: 'adm-field' }, el('label', { for: `tier-name-${t.id}`, text: 'Name' }), el('input', { id: `tier-name-${t.id}`, name: 'name', value: t.name, maxlength: '80' })),
      el('div', { class: 'adm-field' }, el('label', { for: `tier-amount-${t.id}`, text: 'Amount (£)' }), el('input', { id: `tier-amount-${t.id}`, name: 'amount', type: 'number', min: '0.01', step: '0.01', value: String(t.amount) })),
      el('div', { class: 'adm-field' }, el('label', { for: `tier-renewal-${t.id}`, text: 'Renewal' }),
        el('select', { id: `tier-renewal-${t.id}`, name: 'renewal' }, el('option', { value: 'yearly', text: 'Every year' }), el('option', { value: 'one_off', text: 'One-off' }))),
      el('div', { class: 'adm-field' }, el('label', { for: `tier-kes-${t.id}`, text: 'About (KES)' }), el('input', { id: `tier-kes-${t.id}`, name: 'displayKes', type: 'number', min: '1', step: '1', placeholder: 'Optional', value: t.display_kes === null ? '' : String(Math.round(t.display_kes)), title: 'Approximate, for M-Pesa payers. Display only; never used for billing.' })),
      el('button', { type: 'submit', class: 'adm-btn adm-btn-outline adm-btn-sm' }, 'Save'),
    );
    f.elements.renewal.value = t.renewal;
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await busy(f, () => api('PUT', `/api/admin/tiers/${t.id}`, { name: f.elements.name.value, amount: Number(f.elements.amount.value), renewal: f.elements.renewal.value, displayKes: f.elements.displayKes.value }));
        toast(`${f.elements.name.value} saved.`);
        await financeOptions(true);
      } catch (err) { toast(err.message, 'error'); }
    });
    if (!canDo('finance.settings')) lockForm(f, true);
    return f;
  }
  async function loadFinanceSettings() {
    const o = await financeOptions(true);
    $('#tiers-list').replaceChildren(...o.tiers.map(tierRow), el('p', { class: 'adm-hint', text: 'Payments for each tier are recorded as that tier\'s type. Ordinary and Stakeholder renew yearly from the date fees are counted; Visit contribution is paid once.' }));
    const fsForm = $('#finance-settings-form');
    $('#fs-four-eyes').checked = o.settings.requireSecondVerifier;
    $('#fs-meta').textContent = o.settings.updatedBy ? `Last changed ${when(o.settings.updatedAt)} by ${o.settings.updatedBy}.` : 'Default: on.';
    alertIn(fsForm, '');
    lockForm(fsForm, !canDo('finance.settings'));
    lockForm($('#fee-form'), !canDo('finance.settings'));
    lockForm($('#donation-form'), !canDo('finance.settings'));
  }
  $('#finance-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const on = $('#fs-four-eyes').checked;
    if (!on && !confirm('Turn off the four-eyes check? Admins will be able to verify payments they recorded themselves (each one is flagged).')) return;
    try {
      await busy(f, () => api('PUT', '/api/admin/finance-settings', { requireSecondVerifier: on }));
      toast(on ? 'Four-eyes check is on.' : 'Four-eyes check is off. Self-verified payments will be flagged.', on ? 'success' : 'info');
      loadFinanceSettings();
    } catch (err) { alertIn(f, err.message); }
  });

  // ------------------------------------------------------------ admin users: roles

  const ROLE_LABELS = { super_admin: 'Super admin', treasurer: 'Treasurer', membership_secretary: 'Membership secretary' };
  async function changeRole(a, role) {
    if (!confirm(`Make ${a.username} a ${ROLE_LABELS[role]}?`)) return;
    try { await api('PATCH', `/api/admin/admins/${a.id}`, { role }); toast(`${a.username} is now a ${ROLE_LABELS[role]}.`); tables.users.load(); } catch (err) { toast(err.message, 'error'); }
  }

  // ------------------------------------------------------------ table instances

  const tables = {
    email: emailApp,
    members: createTable({
      name: 'members', prefix: 'm', endpoint: '/api/admin/members', listKey: 'members', noun: 'member',
      body: $('#members-body'), countId: 'members-count', pagerId: 'members-pager', render: memberRow,
      fields: { q: $('#m-search'), status: $('#m-status'), payment: $('#m-payment'), chapter: $('#m-chapter'), tier: $('#m-tier'), review: $('#m-review'), from: $('#m-from'), to: $('#m-to') },
      labels: { q: 'Search', status: 'Status', payment: 'Payment', chapter: 'Chapter', tier: 'Tier', review: 'Fee', from: 'From', to: 'To' },
      defaultSort: 'registered', exportLink: $('#m-export'), exportPath: '/api/admin/members.csv',
      empty: { title: 'No registrations yet', filteredTitle: 'No matching members', text: 'New registrations from the Membership page appear here.' },
    }),
    donations: createTable({
      name: 'donations', prefix: 'd', endpoint: '/api/admin/donations', listKey: 'donations', noun: 'pledge',
      body: $('#donations-body'), countId: 'donations-count', pagerId: 'donations-pager', render: donationRow,
      fields: { q: $('#d-search'), status: $('#d-status'), kenyan: $('#d-kenyan'), from: $('#d-from'), to: $('#d-to') },
      labels: { q: 'Search', status: 'Status', kenyan: 'Declaration', from: 'From', to: 'To' },
      defaultSort: 'pledged', exportLink: $('#d-export'), exportPath: '/api/admin/donations.csv',
      empty: { title: 'No donation pledges yet', filteredTitle: 'No matching pledges', text: 'Pledges made on the Donate page appear here.' },
    }),
    transactions: createTable({
      name: 'transactions', prefix: 'tx', endpoint: '/api/admin/transactions', listKey: 'transactions', noun: 'transaction',
      body: $('#tx-body'), countId: 'tx-count', pagerId: 'tx-pager', render: txRow,
      fields: { q: $('#tx-search'), type: $('#tx-type'), method: $('#tx-method'), status: $('#tx-status'), account: $('#tx-account'), flag: $('#tx-flag'), from: $('#tx-from'), to: $('#tx-to'), min: $('#tx-min'), max: $('#tx-max') },
      labels: { q: 'Search', type: 'Type', method: 'Method', status: 'Status', account: 'Account', flag: 'Flag', from: 'From', to: 'To', min: 'Min £', max: 'Max £' },
      defaultSort: 'date', exportLinks: [[$('#tx-export'), '/api/admin/transactions/export'], [$('#tx-export-xlsx'), '/api/admin/transactions/export?format=xlsx']],
      empty: { title: 'No transactions yet', filteredTitle: 'No matching transactions', text: 'Use Record payment when money arrives.' },
      afterLoad: (d) => {
        $('#tx-totals').textContent = `Net ${gbp(d.totals.net_gbp)} verified in this view${Number(d.totals.pending_gbp) ? ` · ${gbp(d.totals.pending_gbp)} awaiting verification` : ''}`;
        $('#tx-four-eyes-off').hidden = d.requireSecondVerifier;
        if (finOpts) finOpts.settings.requireSecondVerifier = d.requireSecondVerifier;
      },
    }),
    reports: createTable({
      name: 'reports', prefix: 'out', endpoint: '/api/admin/reports/outstanding', listKey: 'members', noun: 'member',
      body: $('#out-body'), countId: 'out-count', pagerId: 'out-pager', render: outRow,
      fields: { q: $('#out-search'), chapter: $('#out-chapter'), tier: $('#out-tier'), status: $('#out-status') },
      labels: { q: 'Search', chapter: 'Chapter', tier: 'Tier', status: 'Status' },
      defaultSort: 'balance',
      empty: { title: 'Nobody owes anything', filteredTitle: 'No matching members', text: 'Every member is up to date.' },
      afterLoad: (d) => { $('#out-total').textContent = `${plural(d.total, 'member')} owe ${gbp(d.owed)} in total`; syncRemind(); setExportLinks(); },
    }),
    audit: createTable({
      name: 'audit', prefix: 'au', endpoint: '/api/admin/audit', listKey: 'entries', noun: 'entry', nounPlural: 'entries',
      body: $('#au-body'), countId: 'au-count', pagerId: 'au-pager', render: auditRow,
      fields: { q: $('#au-search'), entity: $('#au-entity'), flagged: $('#au-flagged'), actor: $('#au-actor'), from: $('#au-from'), to: $('#au-to') },
      labels: { q: 'Search', entity: 'Record', flagged: 'Flag', actor: 'Who', from: 'From', to: 'To' },
      defaultSort: 'at',
      empty: { title: 'Nothing logged yet', filteredTitle: 'No matching entries', text: '' },
    }),
    users: createTable({
      name: 'users', prefix: 'u', endpoint: '/api/admin/admins', listKey: 'admins', noun: 'admin',
      body: $('#admin-list'), countId: 'admins-count', pagerId: 'admins-pager', render: adminRow,
      fields: { q: $('#u-search') }, labels: { q: 'Search' },
      defaultSort: 'username', defaultDir: 'asc',
      empty: { title: 'No admins', filteredTitle: 'No matching admins', text: '' },
    }),
  };

  syncRail();
  boot().catch((err) => { showView('login'); alertIn($('#login-form'), err.message); });
})();
