// DCP UK admin area. All data is rendered with textContent, never innerHTML,
// because member-submitted text must not be able to run as code here.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PAYMENT_LABELS = { pending_payment: ['Not paid', 'bad'], payment_reported: ['Check payment', 'warn'], paid: ['Paid', 'good'] };
  const STATUS_LABELS = { pending: ['Pending', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', 'bad'] };
  const DONATION_LABELS = { pledged: ['Pledged', 'warn'], received: ['Received', 'good'], cancelled: ['Cancelled', ''] };
  const TAB_TITLES = { email: 'Email', overview: 'Dashboard', members: 'Members', donations: 'Donations', accounts: 'Payment accounts', users: 'Admin users' };

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
    email: () => tables.email.load(),
    members: () => tables.members.load(),
    donations: () => tables.donations.load(),
    accounts: () => loadAccounts(),
    users: () => tables.users.load(),
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
    if (!loaders[name]) name = 'overview';
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
    $('#dash-verify-n').textContent = String(d.paymentsToCheck);

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
  }

  const onActivate = (node, fn) => {
    node.addEventListener('click', fn);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  onActivate($('#dash-pending'), () => showMembers({ status: 'pending' }));
  onActivate($('#dash-verify'), () => showMembers({ payment: 'payment_reported' }));
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
    await loadLabels().catch(() => {});
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
    if (n.paymentsToCheck) items.push(item('bright', 'cash', `${plural(n.paymentsToCheck, 'payment')} to verify`, 'Members who say they have paid', () => showMembers({ payment: 'payment_reported' })));
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
    alertIn(donationDialog, '');
    donationDialog.showModal();
  }
  async function openDonationById(id) {
    try { openDonation((await api('GET', `/api/admin/donations/${id}`)).donation); } catch (err) { toast(err.message, 'error'); }
  }
  $('#dd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      await busy(f, () => api('PATCH', `/api/admin/donations/${currentDonation.id}`, { adminNotes: f.elements.adminNotes.value }));
      donationDialog.close();
      toast(`Notes saved for ${currentDonation.reference}.`);
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
      el('td', {}, badge(PAYMENT_LABELS[m.payment_status])),
      el('td', {}, badge(STATUS_LABELS[m.status])),
      el('td', { class: 'actions' }, rowMenu(`Actions for ${m.full_name}`, [
        { icon: 'eye', text: 'View details', onClick: () => openMember(m.id) },
        m.status !== 'approved' && { icon: 'check', text: 'Approve', onClick: () => updateMember(m, { status: 'approved' }, 'approved') },
        m.payment_status !== 'paid' && { icon: 'cash', text: 'Mark fee paid', onClick: () => updateMember(m, { paymentStatus: 'paid' }, 'marked as paid') },
        m.status !== 'rejected' && { icon: 'x', text: 'Reject', danger: true, onClick: () => rejectMember(m) },
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
      el('td', {}, el('div', {}, el('strong', { text: d.full_name }), el('span', { class: 'sub adm-email', title: d.email, text: d.email }))),
      el('td', { class: 'amount' }, el('div', {}, gbp(d.amount_gbp), el('span', { class: 'sub', text: d.frequency === 'monthly' ? 'monthly' : 'one-off' }))),
      el('td', { class: 'when col-pledged', title: when(d.created_at), text: day(d.created_at) }),
      el('td', { class: 'msg col-msg', text: d.message || '—' }),
      el('td', {}, badge(DONATION_LABELS[d.status] || [d.status, ''])),
      el('td', { class: 'actions' }, rowMenu(`Actions for ${d.reference}`, [
        { icon: 'eye', text: 'View details', onClick: () => openDonation(d) },
        d.status !== 'received' && { icon: 'check', text: 'Mark received', onClick: () => setDonationStatus(d, 'received') },
        d.status !== 'pledged' && { icon: 'rotate', text: 'Back to pledged', onClick: () => setDonationStatus(d, 'pledged') },
        d.status !== 'cancelled' && { icon: 'x', text: 'Cancel pledge', danger: true, onClick: () => setDonationStatus(d, 'cancelled') },
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
      el('td', { class: 'when', title: when(a.created_at), text: day(a.created_at) }),
      el('td', {}, a.username === $('#who').textContent ? el('span', { class: 'adm-badge good', text: 'You' }) : ''),
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

  // ------------------------------------------------------------ table instances

  const tables = {
    email: emailApp,
    members: createTable({
      name: 'members', prefix: 'm', endpoint: '/api/admin/members', listKey: 'members', noun: 'member',
      body: $('#members-body'), countId: 'members-count', pagerId: 'members-pager', render: memberRow,
      fields: { q: $('#m-search'), status: $('#m-status'), payment: $('#m-payment'), chapter: $('#m-chapter'), from: $('#m-from'), to: $('#m-to') },
      labels: { q: 'Search', status: 'Status', payment: 'Payment', chapter: 'Chapter', from: 'From', to: 'To' },
      defaultSort: 'registered', exportLink: $('#m-export'), exportPath: '/api/admin/members.csv',
      empty: { title: 'No registrations yet', filteredTitle: 'No matching members', text: 'New registrations from the Membership page appear here.' },
    }),
    donations: createTable({
      name: 'donations', prefix: 'd', endpoint: '/api/admin/donations', listKey: 'donations', noun: 'pledge',
      body: $('#donations-body'), countId: 'donations-count', pagerId: 'donations-pager', render: donationRow,
      fields: { q: $('#d-search'), status: $('#d-status'), from: $('#d-from'), to: $('#d-to') },
      labels: { q: 'Search', status: 'Status', from: 'From', to: 'To' },
      defaultSort: 'pledged', exportLink: $('#d-export'), exportPath: '/api/admin/donations.csv',
      empty: { title: 'No donation pledges yet', filteredTitle: 'No matching pledges', text: 'Pledges made on the Donate page appear here.' },
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
