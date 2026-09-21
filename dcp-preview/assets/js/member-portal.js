// Member Portal sign-in. Used two ways:
//   1. as a popup dialog, opened by the Member Portal icon in the navbar
//   2. as the standalone /member-portal page (fallback, and for direct links)
// Either way the lookup itself is a stub — see handleMemberLookup below.
(function () {
  const PORTAL_URL = '/member-portal';

  // TODO: wire this up to the real member lookup.
  // It should check whether the email belongs to a member and then either email
  // a magic login link or send the visitor to registration. There is no member
  // login in the backend yet: /api/admin/* is staff-only, and the members table
  // has no portal credentials. Until that exists this resolves to a friendly
  // "not available yet" message.
  async function handleMemberLookup(email) {
    console.info('handleMemberLookup stub called for', email);
    await new Promise((resolve) => setTimeout(resolve, 600));
    throw new Error('The member portal is not connected yet. Please contact the chapter, or join using the link below.');
  }

  // Shared behaviour for whichever copy of the form is on screen.
  function wireForm(form) {
    const input = form.elements.email;
    const submit = form.querySelector('.portal-submit');
    const label = submit.querySelector('[data-label]');
    const error = form.querySelector('.portal-error');

    const showError = (message) => { error.textContent = message || ''; error.hidden = !message; };
    const setLoading = (loading) => {
      submit.disabled = loading;
      label.textContent = loading ? 'Checking…' : 'Continue';
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const email = input.value.trim();
      if (!email || !input.checkValidity()) {
        showError('Enter a valid email address.');
        input.focus();
        return;
      }
      setLoading(true);
      try {
        await handleMemberLookup(email);
      } catch (err) {
        showError(err.message);
      } finally {
        setLoading(false);
      }
    });

    input.addEventListener('input', () => showError(''));
    return { showError, reset: () => { form.reset(); showError(''); } };
  }

  // ---- the standalone page -------------------------------------------------
  const pageForm = document.getElementById('portal-form');
  if (pageForm) wireForm(pageForm);

  // ---- the popup dialog ----------------------------------------------------
  const triggers = document.querySelectorAll(`a[href="${PORTAL_URL}"]`);
  if (!triggers.length || pageForm) return;

  let dialog = null;
  let handle = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'portal-dialog';
    dialog.setAttribute('aria-labelledby', 'portal-dialog-title');
    dialog.innerHTML = `
      <div class="portal-card">
        <button type="button" class="portal-dialog-close" aria-label="Close">&times;</button>
        <div class="portal-card__head">
          <div class="portal-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
          </div>
          <h2 id="portal-dialog-title">Member Portal</h2>
          <p>Enter your email to continue</p>
        </div>
        <form class="portal-form" novalidate>
          <div>
            <label for="portal-dialog-email">Email Address</label>
            <div class="portal-input-wrap">
              <div class="icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 12a4 4 0 10-8 0 4 4 0 008 0zm0 0v1.5a2.5 2.5 0 005 0V12a9 9 0 10-9 9m4.5-1.206a8.959 8.959 0 01-4.5 1.207"/>
                </svg>
              </div>
              <input id="portal-dialog-email" name="email" type="email" required autocomplete="email" placeholder="Enter your email address">
            </div>
            <p class="portal-error" role="alert" hidden></p>
          </div>
          <button type="submit" class="portal-submit">
            <span data-label>Continue</span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
            </svg>
          </button>
        </form>
        <div class="portal-join">
          <p>Not a member yet?</p>
          <a href="membership.html">
            Join DCP UK
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/>
            </svg>
          </a>
        </div>
      </div>`;
    document.body.appendChild(dialog);
    handle = wireForm(dialog.querySelector('form'));
    dialog.querySelector('.portal-dialog-close').addEventListener('click', () => dialog.close());
    // Close when clicking the dimmed backdrop outside the card.
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }

  triggers.forEach((trigger) => trigger.addEventListener('click', (e) => {
    e.preventDefault();
    if (!dialog) build();
    handle.reset();
    dialog.showModal();
    dialog.querySelector('input[type="email"]').focus();
  }));
})();
