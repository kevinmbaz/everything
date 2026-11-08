/**
 * First-run onboarding: one decision (set up / sample data / skip) and one
 * short form (business name, email, currency). Everything else lives in
 * Settings, so skipping loses nothing. Gated on an empty dataset; closing
 * at any point marks onboarding done.
 */

import { el, clear, append } from './dom.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { refocus } from './bits.js';
import { store } from '../lib/store.js';
import { isPrivate } from '../lib/storage.js';
import { CURRENCIES } from '../lib/money.js';
import { sampleDataset } from '../lib/sample.js';

export function shouldOnboard(store) {
  return !store.settings.onboarded && !store.settings.sampleData
    && store.docs().length === 0 && store.clients.length === 0;
}

export function openOnboarding() {
  const body = el('div');

  const markDone = () => {
    if (!store.settings.onboarded) store.updateSettings({ onboarded: true }).catch(() => {});
  };
  const modal = openModal({ title: 'Welcome', content: body, onClose: markDone });

  const skipBtn = () => el('button.btn.btn-ghost.btn-block', {
    type: 'button', style: { marginTop: '10px' },
    onclick: () => { markDone(); modal.close(); },
  }, 'Skip for now');

  function renderWelcome() {
    clear(body);
    append(body, [
      el('div.onboard-hero', {},
        el('img.onboard-icon', { src: './icon-192.png', alt: '', 'aria-hidden': 'true' }),
        el('h3', {}, 'Get paid without the busywork'),
        el('p', {}, isPrivate
          ? 'Estimates, invoices, recurring billing, receipts, and payment links. Your records and attachments stay on your Jetson. No Puter account or subscription is used.'
          : 'Estimates, invoices, recurring billing, receipts, and payment links. Everything lives in your own Puter cloud.')
      ),
      el('button.btn.btn-primary.btn-block', {
        type: 'button', style: { minHeight: '44px' },
        onclick: renderBusiness,
      }, 'Set up my business'),
      el('button.btn.btn-block', {
        type: 'button', style: { marginTop: '10px', minHeight: '44px' },
        html: icon('sparkle', 15, 1.6),
        onclick: useSampleData,
      }, ' Explore with sample data'),
      skipBtn(),
    ]);
  }

  async function useSampleData(e) {
    // currentTarget, not target: a click on the icon inside the button
    // would otherwise "disable" the svg and leave the button clickable
    // while the import is still running.
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await store.importAll(sampleDataset(store));
    } catch (err) {
      console.error(err);
      toast('Could not load the sample data. Check your connection', { icon: 'wifiOff' });
      btn.disabled = false;
      refocus(btn);
      return;
    }
    modal.close();
    toast('Sample data loaded. Wipe it anytime from the banner', { icon: 'sparkle' });
  }

  function renderBusiness() {
    clear(body);
    const name = el('input.input', { id: 'ob-name', autocomplete: 'organization', placeholder: 'Aurora Studio' });
    const email = el('input.input', { id: 'ob-email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    let picked = store.settings.currency;
    append(body, [
      el('h3.onboard-h', {}, 'Who is sending the invoices?'),
      el('p.onboard-p', {}, 'This appears on every document you create. You can refine it later in Settings.'),
      el('div.field', {},
        el('label.field-label', { for: 'ob-name' }, 'Business or personal name'),
        name),
      el('div.field', {},
        el('label.field-label', { for: 'ob-email' }, 'Email (optional)'),
        email),
      el('div.field', {},
        el('label.field-label', { for: 'ob-currency' }, 'Default currency'),
        el('div.select-wrap', {},
          el('select.select', { id: 'ob-currency', onchange: (ev) => { picked = ev.target.value; } },
            CURRENCIES.map((cur) =>
              el('option', { value: cur.code, selected: cur.code === picked }, `${cur.code} · ${cur.name}`))))),
      el('button.btn.btn-primary.btn-block', {
        type: 'button', style: { padding: '13px' },
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          // Only the email is marked optional, and there is no preview here
          // to show what a blank name prints ("Your business" on every
          // document). "Skip for now" is the way to leave it for later.
          if (!name.value.trim()) {
            toast('Enter the name that goes on your documents', { icon: 'alert' });
            name.focus();
            return;
          }
          btn.disabled = true;
          try {
            await store.updateSettings({
              business: { ...store.settings.business, name: name.value.trim(), email: email.value.trim() },
              currency: picked,
              onboarded: true,
            });
          } catch {
            btn.disabled = false;
            toast('Could not save. Check your connection', { icon: 'wifiOff' });
            refocus(btn);
            return;
          }
          modal.close();
          toast('You are set. Create your first invoice or estimate');
        },
      }, 'Start invoicing'),
      skipBtn(),
    ]);
    // The step that was on screen went out with the button that was pressed,
    // and keyboard focus went with it — on <body>, outside the dialog, with
    // nothing on screen to say the form had arrived. Land where the sheet
    // itself lands when it opens: the first field on a desktop, the panel on
    // a phone, where a keyboard popping up would cover the form.
    if (matchMedia('(min-width: 640px)').matches) name.focus();
    else modal.panel.focus({ preventScroll: true });
  }

  renderWelcome();
}
