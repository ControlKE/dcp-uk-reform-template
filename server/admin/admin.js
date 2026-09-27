// DCP UK admin area. All data is rendered with textContent, never innerHTML,
// because member-submitted text must not be able to run as code here.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const PAYMENT_LABELS = { pending_payment: ['Not paid', 'bad'], payment_reported: ['Check payment', 'warn'], paid: ['Paid', 'good'] };
  const STATUS_LABELS = { pending: ['Pending', 'warn'], approved: ['Approved', 'good'], rejected: ['Rejected', 'bad'] };
  const DONATION_LABELS = { pledged: ['Pledged', 'warn'], received: ['Received', 'good'], cancelled: ['Cancelled', ''] };
  const TAB_TITLES = { overview: 'Dashboard', members: 'Members', donations: 'Donations', accounts: 'Payment accounts', users: 'Admin users' };

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
    const count = n.pending + n.paymentsToCheck;
    const badgeEl = $('#adm-bell-count');
    badgeEl.textContent = count > 99 ? '99+' : String(count);
    badgeEl.hidden = !count;
    bellBtn.setAttribute('aria-label', count ? `Notifications: ${count} waiting` : 'Notifications');
    $('#adm-bell-summary').textContent = `${count} to review`;
    const item = (tone, iconName, title, meta, go) => el('button', { type: 'button', onclick: () => { closeBell(); go(); } },
      el('span', { class: `adm-tile adm-tone-${tone}`, 'aria-hidden': 'true' }, icon(iconName)),
      el('span', {}, el('strong', { text: title }), el('span', { class: 'adm-bell-meta', text: meta })));
    const items = [];
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

  function rowMenu(label, items) {
    const btn = el('button', { type: 'button', class: 'adm-icon-btn', 'aria-label': label, title: 'Actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('dots'));
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

  // ------------------------------------------------------------ table instances

  const tables = {
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
