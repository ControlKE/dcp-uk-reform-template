// Admin sign-in popup, opened by the LOGIN button in the navbar. Without
// JavaScript the button still works as a plain link to /admin/.
(function () {
  const ADMIN_URL = '/admin/';
  let dialog = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'login-modal';
    dialog.setAttribute('aria-labelledby', 'login-modal-title');
    dialog.innerHTML = `
      <form class="login-modal-form" novalidate>
        <button type="button" class="login-modal-close" aria-label="Close">&times;</button>
        <h2 id="login-modal-title">Admin login</h2>
        <div class="form-alert" role="alert" hidden></div>
        <div class="field"><label for="lm-email">Email</label><input id="lm-email" name="username" type="email" autocomplete="username" required></div>
        <div class="field"><label for="lm-pass">Password</label><input id="lm-pass" name="password" type="password" autocomplete="current-password" required></div>
        <button type="submit" class="btn btn-accent login-modal-submit">Sign in</button>
      </form>`;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form');
    const alertBox = dialog.querySelector('.form-alert');
    const submit = dialog.querySelector('.login-modal-submit');
    const showError = (msg) => { alertBox.textContent = msg; alertBox.hidden = !msg; };

    dialog.querySelector('.login-modal-close').addEventListener('click', () => dialog.close());
    // Close when clicking the dimmed backdrop outside the box.
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const username = form.elements.username.value.trim();
      const password = form.elements.password.value;
      if (!username || !password) return showError('Enter your email and password.');
      submit.disabled = true;
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Sign-in failed. Please try again.');
        window.location.href = ADMIN_URL;
      } catch (err) {
        showError(err.message === 'Failed to fetch' ? 'Could not reach the server. Is it running?' : err.message);
        form.elements.password.value = '';
        form.elements.password.focus();
      } finally {
        submit.disabled = false;
      }
    });
  }

  async function open(e) {
    e.preventDefault();
    // Already signed in? Go straight to the dashboard.
    try {
      const s = await (await fetch('/api/admin/session')).json();
      if (s.admin) { window.location.href = ADMIN_URL; return; }
    } catch (err) { /* show the form anyway */ }
    if (!dialog) build();
    dialog.querySelector('.form-alert').hidden = true;
    dialog.showModal();
    dialog.querySelector('#lm-email').focus();
  }

  document.querySelectorAll('a[href="/admin/"]').forEach((a) => a.addEventListener('click', open));
})();
