// Shared helpers for the live Membership and Donate forms.
window.DCPForms = (function () {
  const SERVER_DOWN = 'We could not reach the DCP UK server. If you opened this page as a file, start the server (see server/README.md) and use http://localhost:3000 instead.';

  async function request(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw Object.assign(new Error(SERVER_DOWN), { fields: {} });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { fields: data.fields || {} });
    return data;
  }

  function showAlert(form, message, kind) {
    const box = form.querySelector('.form-alert');
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('success', kind === 'success');
    box.hidden = !message;
    if (message) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function clearErrors(form) {
    form.querySelectorAll('.field-error').forEach((el) => el.remove());
    form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
    showAlert(form, '');
  }

  // fields: { fieldName: message }. Errors attach to the input's .field wrapper,
  // or to an element marked data-field="name" for grouped inputs.
  function showErrors(form, fields) {
    let first = null;
    for (const [name, message] of Object.entries(fields || {})) {
      const input = form.querySelector(`[name="${name}"]`);
      const wrap = form.querySelector(`[data-field="${name}"]`) || (input && input.closest('.field'));
      if (!wrap) continue;
      wrap.classList.add('invalid');
      const err = document.createElement('span');
      err.className = 'field-error';
      err.textContent = message;
      wrap.appendChild(err);
      first = first || input || wrap;
    }
    if (first && first.focus) first.focus();
    return first;
  }

  function addRow(dl, label, value, className) {
    if (value === undefined || value === null || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (className) dd.className = className;
    dl.append(dt, dd);
  }

  // £20 / KES 100.00 — whole amounts lose the trailing zeros.
  function formatMoney(amount, currency = 'GBP') {
    const value = Number(amount);
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  }

  const formatGbp = (amount) => formatMoney(amount, 'GBP');

  // Keeps the fee shown in the page copy in step with the admin settings.
  function showFee(feeAccount) {
    const text = formatMoney(feeAccount.feeAmount, feeAccount.feeCurrency);
    document.querySelectorAll('[data-fee-amount]').forEach((el) => { el.textContent = text; });
  }

  return { request, showAlert, clearErrors, showErrors, addRow, formatMoney, formatGbp, showFee };
})();
