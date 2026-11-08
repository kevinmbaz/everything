/**
 * Add / edit expense sheet. Used on its own (manual entry, edit) and as the
 * confirmation step after OCR, where `prefill` carries what the model read
 * and `receiptFile` the image to store alongside the saved expense.
 */

import { el, field, inlineError, fieldId } from './dom.js';
import { icon } from './icons.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { parseAmount, formatMoney } from '../lib/money.js';
import { todayISO, isValidISO } from '../lib/dates.js';
import { CURRENCIES } from '../lib/currencies.js';
import { PAYMENT_METHODS } from '../lib/ocr.js';
import { isEditable } from '../lib/reports.js';
import { previewURL, receiptURL, invalidateReceipt, isPdf, openReceiptViewer } from './receipt.js';
import { formatBytes } from '../lib/util.js';

export function openExpenseForm({ expense = null, prefill = {}, receiptFile = null, ocr = null, onSaved = null, onDeleted = null } = {}) {
  let editing = !!expense;
  const base = { date: todayISO(), currency: store.settings.baseCurrency, paymentMethod: 'Card', ...(expense || {}), ...prefill };
  let pendingFile = receiptFile;
  let removeReceipt = false;

  const merchant = el('input.input', { type: 'text', value: base.merchant || '', placeholder: 'Where was this?', autocomplete: 'off', maxlength: 120 });
  const merchantErr = inlineError(merchant);
  const amount = el('input.input.amount', { type: 'text', inputmode: 'decimal', value: base.amount != null && base.amount !== '' ? Number(base.amount).toFixed(2) : '', placeholder: '0.00', autocomplete: 'off' });
  const amountErr = inlineError(amount);
  const currency = el('select.select', { 'aria-label': 'Currency' },
    CURRENCIES.map((c) => el('option', { value: c.code, selected: c.code === base.currency }, c.code)));
  const date = el('input.input', { type: 'date', value: base.date || todayISO(), max: todayISO() });
  const dateErr = inlineError(date);
  const category = el('select.select', {},
    el('option', { value: '', selected: !base.categoryId }, 'Uncategorised'),
    store.categories.map((c) => el('option', { value: c.id, selected: c.id === base.categoryId }, c.name)));
  const method = el('select.select', {},
    PAYMENT_METHODS.map((m) => el('option', { value: m, selected: m === base.paymentMethod }, m)));
  const tax = el('input.input', { type: 'text', inputmode: 'decimal', value: base.tax != null && base.tax !== '' ? Number(base.tax).toFixed(2) : '', placeholder: 'Optional' });
  const notes = el('textarea.textarea', { rows: 2, placeholder: 'Attendees, purpose, project' }, base.notes || '');

  const draftReports = store.reports.filter((r) => isEditable(r));
  const currentReport = base.reportId ? store.report(base.reportId) : null;
  const reportLocked = currentReport && !isEditable(currentReport);
  const report = el('select.select', { disabled: !!reportLocked },
    el('option', { value: '', selected: !base.reportId }, 'Not in a report'),
    reportLocked && el('option', { value: currentReport.id, selected: true }, currentReport.title),
    draftReports.map((r) => el('option', { value: r.id, selected: r.id === base.reportId }, r.title)));

  /* Receipt panel: preview of the pending file or the stored receipt. */
  const receiptPanel = el('div.receipt-panel');
  const fileInput = el('input', {
    type: 'file', accept: 'image/*,application/pdf', className: 'visually-hidden', tabindex: -1,
    onchange: () => {
      const f = fileInput.files?.[0];
      if (f) { pendingFile = f; removeReceipt = false; renderReceipt(); }
      fileInput.value = '';
    },
  });
  const cameraInput = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', className: 'visually-hidden', tabindex: -1,
    onchange: () => {
      const f = cameraInput.files?.[0];
      if (f) { pendingFile = f; removeReceipt = false; renderReceipt(); }
      cameraInput.value = '';
    },
  });

  function renderReceipt() {
    receiptPanel.replaceChildren();
    const hasStored = editing && expense.receiptPath && !removeReceipt;
    if (pendingFile || hasStored) {
      const name = pendingFile ? pendingFile.name : (expense.receiptName || 'Receipt');
      const size = pendingFile ? formatBytes(pendingFile.size) : '';
      const thumb = el('div.receipt-preview');
      const pdf = pendingFile ? /pdf$/i.test(pendingFile.type) : isPdf(expense);
      if (pdf) thumb.append(el('span.receipt-pdf-mark', { html: icon('file', 26, 1.6) }));
      else if (pendingFile) thumb.append(el('img', { src: previewURL(pendingFile), alt: '' }));
      else receiptURL(expense).then((url) => { if (url) thumb.append(el('img', { src: url, alt: '' })); });
      receiptPanel.append(
        el('div.receipt-attached', {},
          thumb,
          el('div.grow', {},
            el('div.title.truncate', {}, name),
            el('div.sub', {}, [pendingFile ? 'Ready to upload' : store.sdk?.mode === 'private' ? 'Stored on Jetson' : 'Stored in your Puter drive', size].filter(Boolean).join(', '))
          ),
          hasStored && !pendingFile && el('button.icon-btn', { type: 'button', html: icon('eye', 18, 2), 'aria-label': 'View receipt', onclick: () => openReceiptViewer(expense) }),
          el('button.icon-btn', { type: 'button', html: icon('swap', 18, 2), 'aria-label': 'Replace receipt', title: 'Replace', onclick: () => fileInput.click() }),
          el('button.icon-btn.danger', {
            type: 'button', html: icon('x', 18, 2), 'aria-label': 'Remove receipt', title: 'Remove',
            onclick: () => { pendingFile = null; removeReceipt = true; renderReceipt(); receiptPanel.dispatchEvent(new Event('change', { bubbles: true })); },
          })
        )
      );
    } else {
      receiptPanel.append(
        el('div.receipt-add', {},
          el('button.btn.btn-outline.btn-sm', { type: 'button', html: icon('camera', 15, 2.2), onclick: () => cameraInput.click() }, 'Take photo'),
          el('button.btn.btn-outline.btn-sm', { type: 'button', html: icon('upload', 15, 2.2), onclick: () => fileInput.click() }, 'Attach file'),
          el('span.small.muted', {}, 'Image or PDF')
        )
      );
    }
  }
  renderReceipt();

  const ocrNote = ocr && el('div.ocr-note', { html: icon(ocr.source === 'vision' ? 'sparkle' : 'scan', 15, 2.2) },
    el('span', {}, ocr.confidence >= 0.75 ? 'Read by AI. Check the amount and date before saving.'
      : 'AI wasn’t sure about this receipt. Please check every field.'),
    ocr.confidence != null && el('span.badge', { className: `badge ${ocr.confidence >= 0.75 ? 'ok' : 'warn'}` }, `${Math.round(ocr.confidence * 100)}%`));

  const itemsBlock = Array.isArray(base.items) && base.items.length > 0 && el('details.items-details', {},
    el('summary', {}, `${base.items.length} line item${base.items.length === 1 ? '' : 's'} read from the receipt`),
    el('ul.items-list', {}, base.items.map((it) => el('li', {}, el('span.grow.truncate', {}, it.name), it.amount != null && el('span.num', {}, formatMoney(it.amount, base.currency)))))
  );

  const saveBtn = el('button.btn.btn-primary', { type: 'submit' }, editing ? 'Save changes' : 'Save expense');
  const deleteBtn = editing && el('button.btn.btn-danger', {
    type: 'button',
    onclick: async () => {
      const ok = await confirmDialog({ title: 'Delete this expense?', message: 'The expense and its receipt are removed. This cannot be undone.', confirmLabel: 'Delete' });
      if (!ok) return;
      try {
        await store.deleteExpense(expense.id);
        modal.close();
        toast('Expense deleted', { icon: 'trash' });
        onDeleted?.();
      } catch (err) {
        console.error(err);
        toast('Couldn’t delete. Check your connection', { icon: 'wifiOff' });
      }
    },
  }, 'Delete');

  const form = el('form.expense-form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (saveBtn.disabled) return;
      const amt = parseAmount(amount.value);
      let bad = false;
      merchantErr.show(merchant.value.trim() ? null : 'Enter a merchant name');
      amountErr.show(amt === null || amt <= 0 ? 'Enter an amount greater than zero' : null);
      dateErr.show(isValidISO(date.value) && date.value <= todayISO() ? null : 'Enter a date, today or earlier');
      bad = !merchant.value.trim() || amt === null || amt <= 0 || !isValidISO(date.value) || date.value > todayISO();
      if (bad) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }

      saveBtn.disabled = true;
      const generation = modal.editGeneration;
      const submittedFile = pendingFile;
      const submittedRemoval = removeReceipt;
      saveBtn.textContent = pendingFile ? 'Uploading receipt' : 'Saving';
      const taxVal = parseAmount(tax.value);
      const data = {
        merchant: merchant.value.trim(), amount: amt, currency: currency.value, date: date.value,
        categoryId: category.value || null, paymentMethod: method.value, tax: taxVal === null ? null : taxVal,
        notes: notes.value.trim(), items: base.items || [], ocr: base.ocr || (ocr ? { source: ocr.source, confidence: ocr.confidence, at: Date.now() } : null),
        reportId: reportLocked ? base.reportId : (report.value || null),
      };
      try {
        let saved;
        if (store.sdk?.mode === 'private') {
          saved = await store.saveExpenseWithReceipt({ id: expense?.id, data, file: submittedFile, removeReceipt: submittedRemoval });
          if (expense?.receiptPath && (submittedFile || submittedRemoval)) invalidateReceipt(expense.receiptPath);
          // The acknowledged create becomes the target for any newer draft.
          expense = saved;
          if (pendingFile === submittedFile && removeReceipt === submittedRemoval) {
            pendingFile = null;
            removeReceipt = false;
          }
        } else if (editing) {
          const patch = { ...data };
          if (removeReceipt && expense.receiptPath) {
            await store.deleteReceipt(expense.receiptPath);
            invalidateReceipt(expense.receiptPath);
            Object.assign(patch, { receiptPath: null, receiptMime: null, receiptName: null });
          }
          if (pendingFile) {
            if (expense.receiptPath) invalidateReceipt(expense.receiptPath);
            Object.assign(patch, await store.saveReceipt(expense.id, pendingFile));
          }
          saved = await store.updateExpense(expense.id, patch);
        } else {
          saved = await store.addExpense(data);
          if (pendingFile) {
            try {
              const meta = await store.saveReceipt(saved.id, pendingFile);
              saved = await store.updateExpense(saved.id, meta);
            } catch (err) {
              console.error(err);
              toast('Expense saved, but the receipt didn’t upload', { icon: 'warn' });
            }
          }
        }
        if (!modal.closeIfUnchanged(generation)) {
          editing = true;
          renderReceipt();
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save changes';
          return;
        }
        toast(editing ? 'Expense updated' : 'Expense saved');
        onSaved?.(saved);
      } catch (err) {
        console.error(err);
        saveBtn.disabled = false;
        saveBtn.textContent = editing ? 'Save changes' : 'Save expense';
        toast('Couldn’t save. Check your connection', { icon: 'wifiOff' });
      }
    },
  },
    ocrNote,
    fileInput, cameraInput,
    el('div.field', {}, el('span.field-label', {}, 'Receipt'), receiptPanel),
    field('Merchant', merchant, { error: merchantErr }),
    el('div.field', {},
      el('label.field-label', { for: (amount.id = fieldId()) }, 'Amount'),
      el('div.input-group', {}, el('div.select-wrap', {}, currency), amount),
      amountErr.node),
    el('div.field-row', {},
      field('Date', date, { error: dateErr }),
      field('Category', el('div.select-wrap', {}, category))),
    el('div.field-row', {},
      field('Paid with', el('div.select-wrap', {}, method)),
      field('Tax', tax, { hint: '(optional)' })),
    field('Report', el('div.select-wrap', {}, report), reportLocked ? { hint: '(locked: report already submitted)' } : {}),
    field('Notes', notes, { hint: '(optional)' }),
    itemsBlock,
    el('div.row.end', {}, deleteBtn, el('span.grow'), saveBtn)
  );
  // field() sets ids on the wrapper's control; the selects inside .select-wrap need the label to point at them.
  for (const wrap of form.querySelectorAll('.field > .select-wrap')) {
    const label = wrap.previousElementSibling;
    const sel = wrap.querySelector('select');
    if (label && sel) { sel.id = sel.id || fieldId(); label.setAttribute('for', sel.id); wrap.removeAttribute('id'); }
  }

  const modal = openModal({ title: editing ? 'Edit expense' : 'New expense', content: form });
  if (store.sdk?.mode === 'private' && (receiptFile || Object.keys(prefill).length)) {
    modal.panel.dataset.privateDirty = '1';
    store.dispatchEvent(new Event('storage-state'));
  }
  if (!editing && !merchant.value && globalThis.matchMedia?.('(min-width: 640px)').matches) merchant.focus();
  return modal;
}
