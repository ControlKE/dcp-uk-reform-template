// Contact form: sends the message to the chapter's admin inbox.
(function () {
  const { request, showAlert, clearErrors, showErrors } = window.DCPForms;
  const form = document.getElementById('contact-form');
  const done = document.getElementById('contact-done');
  if (!form) return;

  const submitBtn = form.querySelector('button[type="submit"]');
  // Filled at load time: submissions faster than a person could type are ignored.
  let startedAt = Date.now();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const f = form.elements;
    const body = {
      name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(), region: f.region.value,
      topic: f.topic.value, message: f.message.value.trim(), consent: f.consent.checked,
      website: f.website.value, startedAt,
    };
    const errors = {};
    if (body.name.length < 2) errors.name = 'Enter your name.';
    if (!f.email.value || !f.email.checkValidity()) errors.email = 'Enter a valid email address so we can reply.';
    if (!body.topic) errors.topic = 'Choose a subject.';
    if (body.message.length < 10) errors.message = 'Write a message of at least 10 characters.';
    if (!body.consent) errors.consent = 'Tick the box so we can use your details to reply.';
    if (Object.keys(errors).length) { showAlert(form, 'Please correct the highlighted fields.'); showErrors(form, errors); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      await request('POST', '/api/contact', body);
      done.querySelector('[data-reply-to]').textContent = body.email;
      form.hidden = true;
      done.hidden = false;
      done.focus();
    } catch (err) {
      showAlert(form, `Your message was not sent. ${err.message}`);
      showErrors(form, err.fields);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = 'Send message &#8594;';
    }
  });

  done.querySelector('[data-again]').addEventListener('click', () => {
    form.reset();
    clearErrors(form);
    startedAt = Date.now();
    done.hidden = true;
    form.hidden = false;
    form.elements.name.focus();
  });
})();
