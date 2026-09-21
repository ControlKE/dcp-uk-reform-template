// Donate: records the pledge, then shows the chapter's bank details and a reference.
(function () {
  const { request, showAlert, clearErrors, showErrors, addRow, formatGbp, showFee } = window.DCPForms;
  const form = document.getElementById('donate-form');
  if (!form) return;

  const submitBtn = form.querySelector('button[type="submit"]');
  const custom = form.elements.amountGbp;
  let frequency = 'one_off';
  let presetAmount = 25;

  function select(buttons, active) {
    buttons.forEach((b) => {
      b.classList.toggle('selected', b === active);
      b.setAttribute('aria-pressed', String(b === active));
    });
  }

  const freqButtons = [...form.querySelectorAll('[data-frequency]')];
  freqButtons.forEach((btn) => btn.addEventListener('click', () => { frequency = btn.dataset.frequency; select(freqButtons, btn); }));

  const amountButtons = [...form.querySelectorAll('[data-amount]')];
  amountButtons.forEach((btn) => btn.addEventListener('click', () => {
    presetAmount = Number(btn.dataset.amount);
    custom.value = '';
    select(amountButtons, btn);
  }));
  custom.addEventListener('input', () => { if (custom.value) select(amountButtons, null); });

  function closeDonations(message) {
    submitBtn.disabled = true;
    showAlert(form, message);
  }

  request('GET', '/api/payment-details').then(({ donationAccount, feeAccount }) => {
    showFee(feeAccount);
    if (!donationAccount.configured) closeDonations('Donations are not open yet: the chapter is still setting up its bank account. Please check back soon.');
  }).catch((err) => closeDonations(err.message));

  function renderDone(result) {
    const a = result.donationAccount;
    const amount = formatGbp(result.amountGbp);
    form.querySelector('[data-done-intro]').textContent = result.frequency === 'monthly'
      ? `To give ${amount} a month, set up a standing order with your bank using the details below.`
      : `Please transfer ${amount} using the details below.`;
    const dl = document.getElementById('donation-details');
    dl.replaceChildren();
    addRow(dl, 'Account name', a.accountName);
    addRow(dl, 'Bank', a.bankName);
    addRow(dl, 'Sort code', a.sortCode);
    addRow(dl, 'Account number', a.accountNumber);
    addRow(dl, 'IBAN', a.iban);
    addRow(dl, 'SWIFT / BIC', a.swift);
    addRow(dl, 'Amount', result.frequency === 'monthly' ? `${amount} per month` : amount);
    addRow(dl, 'Payment reference', result.reference, 'ref');
    const extra = form.querySelector('[data-done-instructions]');
    extra.textContent = a.instructions || '';
    extra.hidden = !a.instructions;
    form.querySelector('[data-panel="form"]').hidden = true;
    form.querySelector('[data-panel="done"]').hidden = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const data = {
      amountGbp: custom.value ? Number(custom.value) : presetAmount,
      frequency,
      fullName: form.elements.fullName.value,
      email: form.elements.email.value,
      message: form.elements.message.value,
      acknowledged: form.elements.acknowledged.checked,
    };
    submitBtn.disabled = true;
    try {
      renderDone(await request('POST', '/api/donations', data));
    } catch (err) {
      showAlert(form, err.message);
      showErrors(form, err.fields);
      submitBtn.disabled = false;
    }
  });
})();
