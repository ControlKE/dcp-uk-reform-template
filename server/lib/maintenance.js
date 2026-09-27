// Maintenance mode: the public site answers "back shortly" (HTTP 503) while the
// admin sign-in and the Super admin's Database page keep working.
// It switches on by itself when the app starts in production with database
// migrations waiting (so a Super admin can take a backup and apply them from the
// admin), or by hand with MAINTENANCE_MODE=true.
const state = { on: false, reason: null, message: null, since: null };

function set(reason, message) {
  Object.assign(state, { on: true, reason, message, since: new Date().toISOString() });
}
function clear() {
  Object.assign(state, { on: false, reason: null, message: null, since: null });
}
const on = () => state.on;
const info = () => ({ ...state });

// Requests that still work in maintenance mode.
const ADMIN_API_ALLOWED = ['/api/admin/session', '/api/admin/login', '/api/admin/logout'];
function allowed(p) {
  if (p === '/api/health' || p === '/favicon.ico') return true;
  if (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/shared/') || p.startsWith('/assets/')) return true;
  if (ADMIN_API_ALLOWED.includes(p) || p === '/api/admin/database' || p.startsWith('/api/admin/database/')) return true;
  return false;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Back shortly · DCP UK</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/assets/css/tokens.css"><link rel="stylesheet" href="/assets/css/style.css">
<style>body{min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;background:var(--bg-light-tint,#eef4ee);font-family:var(--font-body,system-ui,sans-serif);color:var(--text-on-light,#132016)}
main{max-width:520px;text-align:center}img{display:block;width:140px;height:auto;margin:0 auto}h1{font-family:var(--font-display,inherit);margin:18px 0 8px}p{color:var(--text-on-light-muted,#4b5f52);line-height:1.6}</style></head>
<body><main><img src="/assets/img/dcp-logo.png" alt="DCP UK" width="322" height="156"><h1>Back shortly</h1>
<p>The DCP UK site is being updated. Please try again in a few minutes.</p></main></body></html>`;

// Express middleware.
function middleware(req, res, next) {
  if (!state.on || allowed(req.path)) return next();
  res.set({ 'Retry-After': '300', 'Cache-Control': 'no-store' });
  if (req.path.startsWith('/api/') || req.path.startsWith('/internal/')) {
    return res.status(503).json({ error: 'The site is being updated. Please try again in a few minutes.', maintenance: true });
  }
  res.status(503).type('html').send(PAGE);
}

module.exports = { set, clear, on, info, middleware, allowed };
