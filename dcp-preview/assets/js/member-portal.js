// Member Portal sign-in. UI only for now: the lookup is a stub.
(function () {
  const form = document.getElementById('portal-form');
  if (!form) return;

  const input = form.elements.email;
  const submit = document.getElementById('portal-submit');
  const label = submit.querySelector('[data-label]');
  const error = document.getElementById('portal-error');

  function showError(message) {
    error.textContent = message || '';
    error.hidden = !message;
  }

  function setLoading(loading) {
    submit.disabled = loading;
    label.textContent = loading ? 'Checking…' : 'Continue';
  }

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
})();
