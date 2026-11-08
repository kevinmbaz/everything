/**
 * Receipt capture: choose or shoot an image, run OCR through Puter AI while
 * the preview shows progress, then hand the result to the expense form for
 * confirmation. Several files at once queue up and are confirmed one by one.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { runReceiptOcr } from '../lib/ocr.js';
import { openExpenseForm } from './expenseform.js';
import { previewURL } from './receipt.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = /^(image\/|application\/pdf)/;

export function openCapture({ onSaved = null } = {}) {
  const fileInput = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, className: 'visually-hidden', tabindex: -1 });
  const cameraInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', className: 'visually-hidden', tabindex: -1 });
  fileInput.addEventListener('change', () => { start([...fileInput.files]); fileInput.value = ''; });
  cameraInput.addEventListener('change', () => { start([...cameraInput.files]); cameraInput.value = ''; });

  const drop = el('div.dropzone', {
    role: 'button', tabindex: 0, 'aria-label': 'Choose receipt files',
    onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); start([...(e.dataTransfer?.files || [])]); },
  },
    el('div.empty-icon', { html: icon('scan', 26) }),
    el('h3', {}, 'Drop receipts here'),
    el('p', {}, 'Photos, scans, or PDFs up to 10 MB. Several at once is fine.'),
    el('div.dropzone-actions', {},
      el('button.btn.btn-primary', { type: 'button', html: icon('camera', 16, 2.2), onclick: (e) => { e.stopPropagation(); cameraInput.click(); } }, 'Take photo'),
      el('button.btn.btn-outline', { type: 'button', html: icon('upload', 16, 2.2), onclick: (e) => { e.stopPropagation(); fileInput.click(); } }, 'Choose files')
    )
  );

  const manual = el('button.btn.btn-ghost.btn-block', {
    type: 'button', style: { marginTop: '12px' },
    onclick: () => { modal.close(); openExpenseForm({ onSaved }); },
  }, 'Enter an expense without a receipt');

  const body = el('div', {}, fileInput, cameraInput, drop, manual);
  if (store.sdk?.mode === 'private') body.prepend(el('p', {}, 'Manual entry — cloud OCR is unavailable in private mode. Receipt bytes stay on Jetson.'));
  const modal = openModal({ title: 'Capture receipt', content: body });

  // Pasting an image from the clipboard also works.
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); start(files); }
  };
  document.addEventListener('paste', onPaste);
  const origClose = modal.close;
  modal.close = () => { document.removeEventListener('paste', onPaste); origClose(); };

  async function start(files) {
    const ok = files.filter((f) => ACCEPT.test(f.type || '') || /\.(jpe?g|png|webp|heic|gif|pdf)$/i.test(f.name));
    const tooBig = ok.filter((f) => f.size > MAX_BYTES);
    const usable = ok.filter((f) => f.size <= MAX_BYTES);
    if (files.length && !ok.length) { toast('Only images and PDFs can be read', { icon: 'warn' }); return; }
    if (tooBig.length) toast(`${tooBig.length} file${tooBig.length === 1 ? ' is' : 's are'} over 10 MB and skipped`, { icon: 'warn' });
    if (!usable.length) return;
    modal.close();
    await processQueue(usable, { onSaved });
  }
}

/** Run OCR on each file in turn and open the confirmation form for each. */
async function processQueue(files, { onSaved }) {
  let index = 0;
  for (const file of files) {
    index += 1;
    const label = files.length > 1 ? ` (${index} of ${files.length})` : '';
    // eslint-disable-next-line no-await-in-loop
    await captureOne(file, { label, onSaved });
  }
}

function captureOne(file, { label, onSaved }) {
  return new Promise((resolve) => {
    const preview = el('div.capture-preview', {},
      /pdf$/i.test(file.type) ? el('span.receipt-pdf-mark', { html: icon('file', 34, 1.5) }) : el('img', { src: previewURL(file), alt: '' }),
      el('div.capture-scan', { 'aria-hidden': 'true' })
    );
    const status = el('p.capture-status', { role: 'status' }, 'Reading the receipt with AI');
    const skip = el('button.btn.btn-ghost', { type: 'button' }, 'Skip AI, fill in manually');
    const cancel = el('button.btn.btn-outline', { type: 'button' }, 'Cancel');
    const body = el('div.capture-body', {}, preview, status, el('div.row', { style: { justifyContent: 'center', marginTop: '14px' } }, cancel, skip));

    let settled = false;
    let aborted = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const modal = openModal({ title: `Reading receipt${label}`, content: body, onClose: () => { if (!settled) { aborted = true; finish(); } } });

    skip.onclick = () => {
      aborted = true;
      settled = true;
      modal.close();
      openExpenseForm({ receiptFile: file, onSaved, prefill: {} });
      resolve();
    };
    cancel.onclick = () => { aborted = true; modal.close(); };

    if (store.sdk?.mode === 'private' || !store.settings.autoOcr) { skip.click(); return; }

    runReceiptOcr(file, { categories: store.categories, baseCurrency: store.settings.baseCurrency, model: store.settings.ocrModel })
      .then(({ result, source }) => {
        if (aborted) return;
        settled = true;
        modal.close();
        const prefill = {
          merchant: result.merchant || '', amount: result.total, currency: result.currency, date: result.date || undefined,
          categoryId: result.categoryId, paymentMethod: result.paymentMethod || 'Card', tax: result.tax,
          notes: result.notes || '', items: result.items,
        };
        openExpenseForm({ prefill, receiptFile: file, ocr: { source, confidence: result.confidence }, onSaved });
        resolve();
      })
      .catch((err) => {
        if (aborted) return;
        console.error(err);
        status.textContent = err.message || 'Couldn’t read the receipt.';
        status.classList.add('is-error');
        preview.classList.add('done');
        skip.textContent = 'Fill in manually';
        skip.classList.remove('btn-ghost');
        skip.classList.add('btn-primary');
      });
  });
}
