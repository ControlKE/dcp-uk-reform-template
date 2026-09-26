// Member Portal sign-in on the standalone /member-portal page. The lookup is
// a stub (see handleMemberLookup below). The navbar icon links to the admin
// login (/admin/) instead of opening this as a popup.
(function () {
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
})();
