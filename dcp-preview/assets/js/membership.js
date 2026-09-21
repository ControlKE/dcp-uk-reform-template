// Membership registration: 3 form steps, then the fee payment details, then confirmation.
(function () {
  const { request, showAlert, clearErrors, showErrors, addRow, formatMoney, showFee } = window.DCPForms;
  const form = document.getElementById('membership-form');
  if (!form) return;

  const STORAGE_KEY = 'dcpuk-registration';
  const stepEls = [...form.querySelectorAll('[data-step]')];
  const indicator = [...document.querySelectorAll('#membership-steps .step')];
  const backBtn = form.querySelector('[data-action="back"]');
  const laterBtn = form.querySelector('[data-action="pay-later"]');
  const nextBtn = form.querySelector('[data-action="next"]');
  const NEXT_LABELS = { 1: 'Continue →', 2: 'Continue →', 3: 'Submit registration →', 4: "I've paid →" };

  let step = 1;
  let registration = null; // { reference, accessToken, feeAccount }

  const load = () => { try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch (e) { return null; } };
  const save = (v) => { try { v ? sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v)) : sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage unavailable */ } };

  function stepOfField(name) {
    const input = form.querySelector(`[name="${name}"]`) || form.querySelector(`[data-field="${name}"]`);
    const el = input && input.closest('[data-step]');
    return el ? Number(el.dataset.step) : 1;
  }

  function show(n) {
    step = n;
    stepEls.forEach((el) => { el.hidden = Number(el.dataset.step) !== n; });
    indicator.forEach((el, i) => el.classList.toggle('active', i + 1 <= n));
    backBtn.hidden = n >= 4;
    backBtn.disabled = n === 1;
    laterBtn.hidden = n !== 4;
    nextBtn.hidden = n === 5;
    nextBtn.textContent = NEXT_LABELS[n] || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Follow-up boxes that appear only for a particular answer ("Other",
  // "None nearby"). Hidden ones are cleared so a stale answer isn't sent.
  const followUps = [...form.querySelectorAll('[data-when-interest], [data-when-chapter]')].map((wrap) => ({
    wrap,
    select: form.elements[wrap.dataset.whenInterest !== undefined ? 'interest' : 'chapter'],
    value: wrap.dataset.whenInterest ?? wrap.dataset.whenChapter,
    input: wrap.querySelector('input'),
  }));

  function syncFollowUps() {
    followUps.forEach(({ wrap, select, value, input }) => {
      const show = select.value === value;
      wrap.hidden = !show;
      input.required = show;
      if (!show) input.value = '';
    });
  }
  followUps.forEach(({ select }) => select.addEventListener('change', syncFollowUps));
  syncFollowUps();

  // Quick in-browser check of the current step; the server re-checks everything.
  function checkStep(n) {
    const errors = {};
    const panel = form.querySelector(`[data-step="${n}"]`);
    panel.querySelectorAll('input[required], select[required]').forEach((el) => {
      if (el.closest('[hidden]')) return;
      if (!el.value.trim()) errors[el.name] = 'This field is required.';
      else if (el.type === 'email' && !el.checkValidity()) errors[el.name] = 'Enter a valid email address.';
    });
    if (n === 3 && [...panel.querySelectorAll('input[type="checkbox"]')].some((c) => !c.checked)) {
      errors.declarations = 'Please confirm every declaration to continue.';
    }
    return errors;
  }

  function collect() {
    const data = Object.fromEntries(new FormData(form));
    const declarations = {};
    form.querySelectorAll('[data-step="3"] input[type="checkbox"]').forEach((c) => { declarations[c.name] = c.checked; });
    return {
      fullName: data.fullName, phone: data.phone, email: data.email, dateOfBirth: data.dateOfBirth,
      idDocumentType: data.idDocumentType, idDocumentNumber: data.idDocumentNumber, language: data.language,
      occupation: data.occupation,
      interest: data.interest, interestOther: data.interestOther,
      chapter: data.chapter, chapterOther: data.chapterOther,
      addressLine1: data.addressLine1, addressLine2: data.addressLine2, town: data.town,
      county: data.county, postcode: data.postcode, declarations,
    };
  }

  function renderFee(fee, reference) {
    const dl = document.getElementById('fee-details');
    dl.replaceChildren();
    const amount = formatMoney(fee.feeAmount, fee.feeCurrency);
    if (!fee.configured) {
      addRow(dl, 'Amount', amount);
      addRow(dl, 'Your reference', reference, 'ref');
      addRow(dl, 'How to pay', 'Payment details are being finalised. The chapter will contact you with how to pay.');
    } else if (fee.method === 'mpesa_paybill') {
      addRow(dl, 'Pay with', 'M-Pesa Paybill (Lipa na M-Pesa → Pay Bill)');
      addRow(dl, 'Business number', fee.paybillNumber);
      addRow(dl, 'Account number', reference, 'ref');
      addRow(dl, 'Amount', amount);
      addRow(dl, 'Paid to', fee.accountName);
    } else if (fee.method === 'mpesa_till') {
      addRow(dl, 'Pay with', 'M-Pesa Buy Goods (Lipa na M-Pesa → Buy Goods and Services)');
      addRow(dl, 'Till number', fee.tillNumber);
      addRow(dl, 'Amount', amount);
      addRow(dl, 'Paid to', fee.accountName);
      addRow(dl, 'Your reference', reference, 'ref');
    } else {
      addRow(dl, 'Pay by', 'Bank transfer');
      addRow(dl, 'Account name', fee.accountName);
      addRow(dl, 'Bank', fee.bankName);
      addRow(dl, 'Sort code', fee.sortCode);
      addRow(dl, 'Account number', fee.accountNumber);
      addRow(dl, 'IBAN', fee.iban);
      addRow(dl, 'SWIFT / BIC', fee.swift);
      addRow(dl, 'Amount', amount);
      addRow(dl, 'Payment reference', reference, 'ref');
    }
    const extra = document.getElementById('fee-instructions');
    extra.textContent = fee.instructions || '';
    extra.hidden = !fee.instructions;
    if (fee.method === 'mpesa_till' && fee.configured) {
      extra.hidden = false;
      extra.textContent = [fee.instructions, 'Till payments cannot carry a reference, so please enter your M-Pesa confirmation code below.'].filter(Boolean).join(' ');
    }
  }

  function confirm(paidNow) {
    form.querySelector('[data-ref]').textContent = registration.reference;
    form.querySelector('[data-confirm-text]').textContent = paidNow
      ? "We've noted that you have paid. The chapter will check the payment and confirm it."
      : 'You can pay the fee later using the details on the previous screen. Quote your reference so we can match it to your application.';
    save(null);
    show(5);
  }

  backBtn.addEventListener('click', () => { clearErrors(form); if (step > 1 && step < 4) show(step - 1); });
  laterBtn.addEventListener('click', () => confirm(false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);

    if (step < 3) {
      if (showErrors(form, checkStep(step))) return;
      show(step + 1);
      return;
    }

    nextBtn.disabled = true;
    try {
      if (step === 3) {
        if (showErrors(form, checkStep(3))) return;
        const result = await request('POST', '/api/members', collect());
        registration = result;
        save(registration);
        renderFee(result.feeAccount, result.reference);
        show(4);
      } else if (step === 4) {
        await request('POST', `/api/members/${encodeURIComponent(registration.reference)}/payment-reported`, {
          accessToken: registration.accessToken,
          paymentNote: form.elements.paymentNote.value,
        });
        confirm(true);
      }
    } catch (err) {
      const fields = err.fields || {};
      const names = Object.keys(fields);
      if (names.length) show(Math.min(...names.map(stepOfField)));
      showAlert(form, err.message);
      showErrors(form, fields);
    } finally {
      nextBtn.disabled = false;
    }
  });

  // Keep the fee shown on the page in line with what the admin has set.
  request('GET', '/api/payment-details').then(({ feeAccount }) => showFee(feeAccount)).catch(() => {});

  // Returning to the page mid-payment (e.g. after a refresh) shows the payment step again.
  const saved = load();
  if (saved && saved.reference && saved.accessToken) {
    registration = saved;
    renderFee(saved.feeAccount, saved.reference);
    show(4);
  }
})();
