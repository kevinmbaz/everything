/**
 * First-run onboarding: one decision (set up / sample data / skip) and one
 * setting (base currency). Gated on an empty dataset; closing at any point
 * marks onboarding done.
 */

import { el, clear, append } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { CURRENCIES } from '../lib/currencies.js';
import { sampleDataset, renderSampleReceipt } from '../lib/sample.js';

export function shouldOnboard(s = store) {
  return !s.settings.onboarded && !s.settings.sampleData && s.months.length === 0 && s.reports.length === 0;
}

export function openOnboarding({ onCapture } = {}) {
  const body = el('div');

  const markDone = () => {
    if (!store.settings.onboarded) store.updateSettings({ onboarded: true }).catch(() => {});
  };
  const modal = openModal({ title: 'Welcome', content: body, onClose: markDone });

  const skipBtn = () => el('button.btn.btn-ghost.btn-block', {
    type: 'button', style: { marginTop: '8px' },
    onclick: () => { markDone(); modal.close(); },
  }, 'Skip for now');

  function renderWelcome() {
    clear(body);
    append(body, [
      el('div.empty', { style: { padding: '8px 8px 4px' } },
        el('div.empty-icon', { html: icon('scan', 28), style: { background: 'var(--accent-wash)', color: 'var(--accent-strong)' } }),
        el('h3', {}, 'Receipts in, reports out'),
        el('p', {}, store.sdk?.mode === 'private' ? 'Upload receipts, enter their fields manually, and reconcile statements. Primary storage is on Jetson; cloud OCR is unavailable.' : 'Capture receipts and let AI read them, bundle them into reports, and reconcile against your statement. Stored in your own Puter account.')
      ),
      el('button.btn.btn-primary.btn-block.btn-lg', { type: 'button', onclick: renderCurrency }, 'Set up my expenses'),
      el('button.btn.btn-outline.btn-block', {
        type: 'button', style: { marginTop: '10px' }, html: icon('sparkle', 15, 2),
        onclick: useSampleData,
      }, 'Explore with sample data'),
      skipBtn(),
    ]);
  }

  async function useSampleData(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Loading sample data';
    const generation = modal.editGeneration;
    try {
      const data = sampleDataset(store);
      await store.importAll(data);
      // A few receipts so the viewer has something to show. Best effort.
      attachSampleReceipts(data).catch(() => {});
    } catch (err) {
      console.error(err);
      toast('Couldn’t load the sample data. Check your connection', { icon: 'wifiOff' });
      btn.disabled = false;
      btn.textContent = 'Explore with sample data';
      return;
    }
    modal.closeIfUnchanged(generation);
    toast('Sample data loaded. Wipe it anytime from the banner', { icon: 'sparkle' });
  }

  async function attachSampleReceipts(data) {
    const all = Object.values(data.expenses).flat().filter((e) => e.paymentMethod === 'Card').slice(0, 6);
    for (const exp of all) {
      const blob = await renderSampleReceipt(exp, store.category(exp.categoryId)?.name);
      if (!blob) return;
      const file = new File([blob], `${exp.merchant.toLowerCase().replace(/\s+/g, '-')}.png`, { type: 'image/png' });
      const meta = await store.saveReceipt(exp.id, file);
      await store.updateExpense(exp.id, meta);
    }
  }

  function renderCurrency() {
    clear(body);
    let picked = store.settings.baseCurrency;
    append(body, [
      el('h3.onboard-h', {}, 'Which currency do you report in?'),
      el('p.onboard-p', {}, 'Totals and reports use this currency. Individual receipts can be in any currency.'),
      el('div.field', {},
        el('div.select-wrap', {},
          el('select.select', { 'aria-label': 'Base currency', onchange: (ev) => { picked = ev.target.value; } },
            CURRENCIES.map((c) => el('option', { value: c.code, selected: c.code === picked }, `${c.code}  ${c.name}`)))
        )
      ),
      el('button.btn.btn-primary.btn-block.btn-lg', {
        type: 'button',
        onclick: async (ev) => {
          const button = ev.currentTarget;
          button.disabled = true;
          const generation = modal.editGeneration;
          try { await store.updateSettings({ baseCurrency: picked, onboarded: true }); }
          catch (err) {
            if (store.sdk?.mode === 'private') { button.disabled = false; toast('Couldn’t save setup. Your choices are still here.', { icon: 'warn' }); return; }
          }
          if (!modal.closeIfUnchanged(generation)) { button.disabled = false; return; }
          if (onCapture) setTimeout(onCapture, 250);
        },
      }, 'Capture my first receipt'),
      el('button.btn.btn-ghost.btn-block', {
        type: 'button', style: { marginTop: '8px' },
        onclick: async (ev) => {
          const button = ev.currentTarget;
          button.disabled = true;
          const generation = modal.editGeneration;
          try { await store.updateSettings({ baseCurrency: picked, onboarded: true }); }
          catch (err) {
            if (store.sdk?.mode === 'private') { button.disabled = false; toast('Couldn’t save setup. Your choices are still here.', { icon: 'warn' }); return; }
          }
          if (!modal.closeIfUnchanged(generation)) button.disabled = false;
        },
      }, 'I’ll add expenses later'),
    ]);
  }

  renderWelcome();
}
