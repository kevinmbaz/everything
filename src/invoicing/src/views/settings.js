import { el, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { field, selectWrap, download, refocus, taxNoteControl } from '../ui/bits.js';
import { store } from '../lib/store.js';
import { isPrivate } from '../lib/storage.js';
import { clamp } from '../lib/util.js';
import { CURRENCIES } from '../lib/money.js';
import { MAX_TERM_DAYS, settingsTaxes, termDays } from '../lib/doc.js';
import { LOGO_ACCEPT, isLogoDataUri, logoOf, normalizeHexColor, processLogoFile } from '../lib/brand.js';
import {
  parseBackup, restoreSummary, retireSharePages, missingAttachments,
} from '../lib/backup.js';
import { openImportWizard } from '../ui/import-wizard.js';
import {
  DEFAULT_TEMPLATES, TEMPLATE_KEYS, TEMPLATE_LABELS, allTemplates, placeholdersFor,
} from '../lib/message.js';
import { applyTheme, currentTheme } from '../ui/theme.js';
import { paymentLink } from '../lib/paylink.js';
import { paymentRows, paymentsCsv } from '../lib/acct-csv.js';
import { todayISO } from '../lib/dates.js';
import {
  offlineEnabled, setOfflineEnabled, readSnapshot, clearSnapshot,
  serializeSnapshot, writeSnapshot,
} from '../lib/snapshot.js';
import { fileSize } from '../lib/util.js';

export async function confirmSignOut() {
  const ok = await confirmDialog({
    title: 'Sign out?',
    message: 'Your data stays safe in your Puter account and is here when you sign back in.',
    confirmLabel: 'Sign out',
    danger: false,
  });
  if (!ok) return;
  // The offline copy is the one place this app puts billing data on a device
  // rather than in the cloud; signing out is exactly when it must go.
  clearSnapshot();
  try {
    await puter.auth.signOut();
  } finally {
    location.reload();
  }
}

export function settingsView({ navigate }) {
  const root = el('div.view');
  const s = store.settings;

  const saveCard = (title, controls, collect, onSaved = null) => {
    const btn = el('button.btn.btn-primary', {
      // Offline, this card is a read-only view of what was last loaded.
      disabled: store.readOnly,
      title: store.readOnly ? 'Reconnect to change your settings' : null,
      onclick: async () => {
        // A collector may refuse — with its own explanation — rather than
        // store a state its card does not show; null aborts the save.
        const patch = collect();
        if (!patch) return;
        btn.disabled = true;
        try {
          await store.updateSettings(patch);
          // Only after the write lands: a card whose save failed still
          // shows what the user typed, and must keep it for the retry.
          onSaved?.();
          toast('Saved');
        } catch (err) {
          console.error(err);
          toast('Could not save. Check your connection', { icon: 'wifiOff' });
        }
        btn.disabled = false;
        // Disabling the focused button dropped keyboard focus to <body>;
        // give it back so Tab continues from this card, not the page top.
        if (document.activeElement === document.body) btn.focus();
      },
    }, 'Save');
    return el('section.card.settings-card', {},
      el('h2.card-title', {}, title), ...controls, el('div.settings-save', {}, btn));
  };

  /* ----- Business profile ----- */
  const bizName = el('input.input', { value: s.business.name, autocomplete: 'organization' });
  const bizEmail = el('input.input', { type: 'email', value: s.business.email, autocomplete: 'email' });
  const bizPhone = el('input.input', { type: 'tel', value: s.business.phone, autocomplete: 'tel' });
  const bizAddress = el('textarea.textarea', { rows: 2, value: s.business.address });
  const bizTaxId = el('input.input', { value: s.business.taxId });

  /* Logo and tint. The logo is persisted the moment it is chosen (an upload
     that needs a second Save is an upload people lose), while the rest of
     the card keeps the explicit Save it always had. Every save re-sends the
     current logo, so editing a name can never drop it. */
  let logo = isLogoDataUri(s.business.logo) ? s.business.logo.trim() : '';
  let brandColor = normalizeHexColor(s.brandColor);

  const logoBox = el('div.logo-preview');
  // Disabling the pressed button while the image is processed and stored
  // drops keyboard focus to <body>. Hand it back once the button works
  // again — or to Upload when the action hid it, which removing a logo
  // does: there is nothing left to remove.
  const handBackLogoFocus = (button) => {
    if (document.activeElement !== document.body) return;
    (button.hidden || button.disabled ? logoBtn : button).focus();
  };
  const logoFile = el('input', {
    type: 'file', accept: LOGO_ACCEPT, hidden: true,
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';          // re-picking the same file must still fire
      if (!file) return;
      logoBtn.disabled = true;
      try {
        const next = await processLogoFile(file);
        await store.updateSettings({ business: { ...store.settings.business, logo: next } });
        logo = next;
        renderLogo();
        toast('Logo updated', { icon: 'check' });
      } catch (err) {
        console.error(err);
        toast(err?.message || 'That image could not be used', { icon: 'alert' });
      }
      logoBtn.disabled = false;
      handBackLogoFocus(logoBtn);
    },
  });
  const logoBtnLabel = el('span');
  // Unlike every other control on this card, these two persist the moment
  // they are pressed rather than waiting for Save — so there is no disabled
  // Save button to say they cannot land. A device showing a saved copy would
  // otherwise pick a file, resize it, and only then be refused.
  const logoBtn = el('button.btn', {
    type: 'button', html: icon('upload', 15, 1.6),
    disabled: store.readOnly,
    title: store.readOnly ? 'Reconnect to change your logo' : null,
    onclick: () => logoFile.click(),
  }, logoBtnLabel);
  const logoRemove = el('button.btn.btn-ghost', {
    type: 'button',
    disabled: store.readOnly,
    title: store.readOnly ? 'Reconnect to change your logo' : null,
    onclick: async () => {
      logoRemove.disabled = true;
      try {
        await store.updateSettings({ business: { ...store.settings.business, logo: '' } });
        logo = '';
        renderLogo();
        toast('Logo removed', { icon: 'trash' });
      } catch (err) {
        console.error(err);
        toast('Could not save. Check your connection', { icon: 'wifiOff' });
      }
      logoRemove.disabled = false;
      handBackLogoFocus(logoRemove);
    },
  }, 'Remove');

  function renderLogo() {
    logoBox.replaceChildren(logo
      ? el('img', { src: logo, alt: 'Your logo as it appears on documents' })
      : el('span.logo-empty', { html: icon('building', 18, 1.5) }));
    logoBtnLabel.textContent = logo ? ' Replace' : ' Upload logo';
    logoRemove.hidden = !logo;
  }
  renderLogo();

  const colorInput = el('input.color-input', {
    type: 'color', value: brandColor || '#17181c',
    'aria-label': 'Brand color',
    oninput: (e) => { brandColor = normalizeHexColor(e.target.value); renderTint(); },
  });
  const tintSample = el('span.brand-sample', {},
    el('span.brand-sample-kind', {}, 'INVOICE'),
    el('span.brand-sample-rule'));
  const tintNote = el('span.brand-note');
  const tintClear = el('button.btn.btn-ghost', {
    type: 'button',
    onclick: () => { brandColor = ''; colorInput.value = '#17181c'; renderTint(); },
  }, 'Remove tint');

  function renderTint() {
    tintSample.style.color = brandColor || '#5b5e66';
    tintNote.textContent = brandColor ? 'Tints headings and rules' : 'Headings and rules stay in ink';
    tintClear.hidden = !brandColor;
  }
  renderTint();

  const businessCard = saveCard('Business profile', [
    el('p.card-sub', {}, 'Shown in the header of every invoice, estimate, and receipt.'),
    field('Name', bizName),
    el('div.field-grid', {},
      field('Email', bizEmail, { hint: '(optional)' }),
      field('Phone', bizPhone, { hint: '(optional)' })),
    field('Address', bizAddress, { hint: '(optional)' }),
    field('Tax ID', bizTaxId, { hint: '(VAT number, EIN…)' }),
    // Labelled as a group, not with a for-association: the only labelable
    // control in this row is the file input, which is hidden — so the caption
    // named nothing that is actually on screen or in the accessibility tree,
    // while clicking the word "Logo" quietly opened a file picker, the way a
    // label forwards its clicks to the control it points at.
    field('Logo', el('div.logo-row', {}, logoBox, logoBtn, logoRemove, logoFile),
      { hint: '(optional)', group: true }),
    el('p.card-sub.brand-hint', {}, 'PNG, JPEG, WebP, or SVG. Large images are resized automatically and embedded in your documents, so shared pages need nothing from the internet.'),
    field('Brand color', el('div.color-row', {}, colorInput, tintSample, tintNote, tintClear),
      { hint: '(optional)' }),
  ], () => ({
    business: {
      name: bizName.value.trim(),
      email: bizEmail.value.trim(),
      phone: bizPhone.value.trim(),
      address: bizAddress.value.trim(),
      taxId: bizTaxId.value.trim(),
      // The logo persists the moment it is picked, not on Save, so Save
      // takes it from the store rather than from this card's own copy: that
      // copy was assigned only after the upload's write settled, and a Save
      // pressed meanwhile wrote the previous logo back over the new one —
      // the card showed the new one until a reload brought the old one back.
      logo: logoOf(store.settings) || '',
    },
    brandColor,
  }));

  /* ----- Defaults ----- */
  const currency = el('select.select', {},
    CURRENCIES.map((c) => el('option', { value: c.code, selected: c.code === s.currency }, `${c.code} · ${c.name}`)));
  // The currency reports consolidate into. Empty follows the default above,
  // which is what almost every account wants; it exists for the ones that
  // bill in one currency and file taxes in another.
  const baseCurrency = el('select.select', {},
    el('option', { value: '', selected: !s.baseCurrency }, 'Same as my default'),
    CURRENCIES.map((c) => el('option', {
      value: c.code, selected: c.code === s.baseCurrency,
    }, `${c.code} · ${c.name}`)));

  /* Named tax rates: one row per tax every new document starts with, plus
     the treatments a line item can pick from. GST + PST live here as two
     rows; a reduced VAT rate as another. */
  const taxRows = settingsTaxes(s).map((t) => ({ ...t }));
  const taxesWrap = el('div.tax-rows');
  function renderTaxRows() {
    clear(taxesWrap);
    taxRows.forEach((tx, i) => {
      taxesWrap.append(el('div.tax-row', {},
        el('input.input', {
          value: tx.label, placeholder: 'VAT, GST…',
          'aria-label': `Tax ${i + 1} name`,
          oninput: (e) => { tx.label = e.target.value; },
        }),
        el('input.input', {
          type: 'number', min: '0', max: '100', step: 'any', value: tx.rate,
          placeholder: '0', inputmode: 'decimal',
          'aria-label': `Tax ${i + 1} rate (%)`,
          oninput: (e) => { tx.rate = e.target.value; },
          // Pinned on blur like every other number field: Save stores the
          // clamped rate, so the card must show what will actually apply.
          onchange: (e) => {
            if (e.target.value === '') return;
            e.target.value = clamp(Number(e.target.value) || 0, 0, 100);
            tx.rate = Number(e.target.value);
          },
        }),
        el('button.icon-btn', {
          type: 'button', html: icon('x', 17, 1.6),
          'aria-label': `Remove tax ${i + 1}`,
          onclick: () => {
            taxRows.splice(i, 1);
            renderTaxRows();
            // The re-render destroyed the pressed button: keep focus among
            // the remaining rows, or on Add tax once none are left.
            const removes = taxesWrap.querySelectorAll('.icon-btn');
            (removes[Math.min(i, removes.length - 1)] || taxesWrap.querySelector('.btn-ghost'))?.focus();
          },
        })));
    });
    taxesWrap.append(el('button.btn.btn-ghost', {
      type: 'button', html: icon('plus', 15, 1.8),
      onclick: () => {
        taxRows.push({ label: '', rate: '' });
        renderTaxRows();
        taxesWrap.querySelector('.tax-row:last-of-type input')?.focus();
      },
    }, ' Add tax'));
  }
  renderTaxRows();
  const maxDays = String(MAX_TERM_DAYS);
  // Day counts get the same left-the-field pinning as the tax rate: Save
  // stores termDays(value), so the field must show what will actually apply
  // rather than keeping 99999 on screen while 3650 is what got saved.
  const pinDays = (e) => {
    if (e.target.value === '') return;
    e.target.value = termDays(e.target.value, 0);
  };
  const terms = el('input.input', {
    type: 'number', min: '0', max: maxDays, step: '1', value: s.paymentTermsDays,
    onchange: pinDays,
  });
  const validDays = el('input.input', {
    type: 'number', min: '0', max: maxDays, step: '1', value: s.quoteValidDays,
    onchange: pinDays,
  });
  const defaultNotes = el('textarea.textarea', { rows: 2, value: s.defaultNotes, placeholder: 'e.g. Thank you for your business.' });
  // Browser printing adapts to the printer's own paper; this is only the
  // geometry of the PDFs the app writes itself.
  const paperSize = el('select.select', {},
    el('option', { value: 'a4', selected: s.paperSize !== 'letter' }, 'A4'),
    el('option', { value: 'letter', selected: s.paperSize === 'letter' }, 'US Letter'));
  const taxInclusiveBox = el('input', { type: 'checkbox', checked: !!s.taxInclusive });
  // The sentence a zero-tax document has to carry. Printed only when the
  // document charges no tax on something, so leaving it set does no harm on
  // an ordinary taxed invoice.
  const taxNote = taxNoteControl(s.taxNote);

  const defaultsCard = saveCard('Document defaults', [
    el('p.card-sub', {}, 'Starting points for new documents; each one can still be adjusted.'),
    el('div.field-grid', {},
      field('Currency', selectWrap(currency)),
      field('Reporting currency', selectWrap(baseCurrency), { hint: 'for consolidated totals' }),
      field('Payment terms', terms, { hint: 'days until due' }),
      field('Estimate validity', validDays, { hint: 'days' }),
      field('PDF paper size', selectWrap(paperSize))),
    el('p.card-sub', {},
      'Invoices stay in the currency you billed in. When you bill in another one, the editor asks '
      + 'what it was worth in your reporting currency that day, and Reports adds a consolidated '
      + 'block using the rate stored on each document — nothing is ever fetched from the internet.'),
    field('Taxes', taxesWrap, { hint: 'each prints as its own row on documents', group: true }),
    el('div.field', {},
      // The label and its note go in one box, the way field() writes them.
      // As two boxes they were two items on the row's flex line, and on a
      // phone each wrapped inside its own narrow column: the sentence read
      // "Prices (documents show the tax / include tax portion inside the
      // total)" down two ladders instead of across one line.
      el('label.check-row', {}, taxInclusiveBox,
        el('span', {}, 'Prices include tax',
          el('span.field-hint', {}, ' (documents show the tax portion inside the total)')))),
    field('Tax note', taxNote.node, {
      hint: 'printed when no tax is charged',
      group: true,
    }),
    el('p.card-sub', {},
      'Reverse charge, zero-rated export, an exemption certificate: the words a zero-tax invoice '
      + 'is legally required to carry. Printed under the notes on any document that charges no tax '
      + '(or that has a line charging none), in the document’s own language. A client can carry '
      + 'their own wording, set on their card.'),
    field('Default notes', defaultNotes),
  ], () => {
    // A labelled row without a positive rate is content Save would drop
    // while the card kept showing it; refuse, exactly like the late-fee
    // card. Rows with nothing in them at all leave the card instead, so
    // the card always shows what was stored.
    const bad = taxRows.findIndex((t) => (t.label || '').trim() && !(clamp(Number(t.rate) || 0, 0, 100) > 0));
    if (bad >= 0) {
      toast(`Give “${taxRows[bad].label.trim()}” a rate above zero, or remove it`, { icon: 'alert' });
      taxesWrap.querySelectorAll('.tax-row input[type="number"]')[bad]?.focus();
      return null;
    }
    // The same tax twice is one tax — every new document would inherit both
    // rows and count them once, printing a rate beside twice the money.
    const key = (t) => `${(t.label || '').trim()}|${clamp(Number(t.rate) || 0, 0, 100)}`;
    const dup = taxRows.findIndex((t, i) => clamp(Number(t.rate) || 0, 0, 100) > 0
      && taxRows.slice(0, i).some((u) => clamp(Number(u.rate) || 0, 0, 100) > 0 && key(u) === key(t)));
    if (dup >= 0) {
      toast(`“${(taxRows[dup].label || 'Tax').trim()}” at ${Number(taxRows[dup].rate)}% is already listed`, { icon: 'alert' });
      taxesWrap.querySelectorAll('.tax-row input:not([type="number"])')[dup]?.focus();
      return null;
    }
    const keep = taxRows.filter((t) => (t.label || '').trim() || Number(t.rate) > 0);
    if (keep.length !== taxRows.length) {
      taxRows.splice(0, taxRows.length, ...keep);
      renderTaxRows();
    }
    // Blank day counts have nothing to inherit — settings are the base —
    // and saving the coerced 0 would make every new invoice due the day it
    // is issued while the field kept showing blank.
    const blankDays = [
      [terms, 'Enter payment terms in days, or 0 for due on receipt'],
      [validDays, 'Enter how many days estimates stay valid'],
    ].find(([input]) => String(input.value).trim() === '');
    if (blankDays) {
      toast(blankDays[1], { icon: 'alert' });
      blankDays[0].focus();
      return null;
    }
    // A chosen "Custom wording" with an empty box is a state Save would drop
    // while the card kept showing it, exactly like a labelled tax with no rate.
    const note = taxNote.read();
    if (note.error) {
      toast(note.error, { icon: 'alert' });
      note.focus.focus();
      return null;
    }
    const taxes = taxRows
      .map((t) => ({ label: (t.label || '').trim(), rate: clamp(Number(t.rate) || 0, 0, 100) }))
      .filter((t) => t.rate > 0);
    return {
      taxNote: note.value,
      currency: currency.value,
      baseCurrency: baseCurrency.value,
      taxes,
      // The single rate/label pair stays in step with the list's first entry:
      // it is what per-client overrides, old documents' unnamed rows, and any
      // pre-list reader still key off.
      taxRate: taxes[0]?.rate ?? 0,
      taxLabel: taxes[0]?.label || 'Tax',
      taxInclusive: taxInclusiveBox.checked,
      paymentTermsDays: termDays(terms.value, 0),
      quoteValidDays: termDays(validDays.value, 0),
      paperSize: paperSize.value === 'letter' ? 'letter' : 'a4',
      defaultNotes: defaultNotes.value,
    };
  });

  /* ----- Saved items (the price list) ----- */
  // The list fills itself from every document saved, so this card is about
  // correcting it: the page it opens is where a stale rate or a typo goes.
  const itemsCount = el('p.card-sub');
  const renderItemsCount = () => {
    const n = store.items.length;
    itemsCount.textContent = n
      ? `${n} item${n === 1 ? '' : 's'} remembered so far.`
      : 'Nothing remembered yet. The first document you save starts the list.';
  };
  renderItemsCount();
  const savedItemsCard = el('section.card.settings-card', {},
    el('h2.card-title', {}, 'Saved items'),
    el('p.card-sub', {},
      'Descriptions you bill often, with their latest rate, unit, and tax treatment. '
      + 'The editor suggests them as you type; every document you save keeps the list up to date.'),
    itemsCount,
    el('div.side-actions', {},
      el('button.btn', {
        html: icon('tag', 15, 1.6),
        onclick: () => navigate('#/items'),
      }, ' Manage saved items')));

  /* ----- Numbering ----- */
  // Counters save as max(1, round(n)); pin the field on blur so a typed 0 or
  // -5 doesn't sit on screen while 1 is what the next document will use.
  const pinCounter = (e) => {
    if (e.target.value === '') return;
    e.target.value = Math.max(1, Math.round(Number(e.target.value) || 1));
  };
  // Typing into a Next # is a deliberate choice about where the series goes
  // next, and refreshCounters() below leaves such a field alone from then on.
  const markCounterEdited = (e) => { e.target.dataset.edited = '1'; };
  const invPrefix = el('input.input', { value: s.invoicePrefix, placeholder: 'INV-{YYYY}-' });
  // The Next # fields show the counter the next document created today draws
  // from: the current year's counter when that series restarts yearly, the
  // lifetime counter otherwise. Save writes it back to the same place.
  const counterField = (kind) => el('input.input', {
    type: 'number', min: '1', step: '1',
    value: store.nextNumberValue(kind),
    oninput: markCounterEdited,
    onchange: pinCounter,
  });
  const invNext = counterField('invoice');
  const qPrefix = el('input.input', { value: s.quotePrefix });
  const qNext = counterField('quote');
  const rPrefix = el('input.input', { value: s.receiptPrefix });
  const rNext = counterField('receipt');

  // What the regime a checkbox selects has stored: this year's counter under
  // yearly restart, the lifetime counter otherwise. Toggling the checkbox
  // reloads the Next # field — Save writes the visible value into whichever
  // regime is checked, so carrying the old regime's number across would
  // overwrite this one's position and hand out numbers already used.
  const counterFor = (kind, yearly) => {
    const st = store.settings;
    const raw = yearly
      ? st.yearNext?.[kind]?.[String(new Date().getFullYear())]
      : st[{ invoice: 'nextInvoice', quote: 'nextQuote', receipt: 'nextReceipt' }[kind]];
    return Math.max(1, Math.floor(Number(raw) || 1));
  };
  /**
   * The Next # to show for a kind while its checkbox stands as it does. Under
   * the regime that is saved, that is simply its counter. While a switch is
   * pending, the regime being switched to has a counter of its own — a year
   * nobody has numbered in yet starts at 1 — but every number issued so far
   * this year came from the regime being left, so the field continues from
   * whichever of the two is further along. Seeding it from the new regime
   * alone turned on yearly restart in August and offered INV-0001 to an
   * account that had issued eight invoices this year, the first of them
   * INV-0001; Save then wrote it, and the next invoice repeated a number.
   * From next January the series restarts at 1 as the checkbox promises.
   */
  const shownCounter = (kind, yearly) => {
    if (yearly === !!store.settings.numberYearly?.[kind]) return counterFor(kind, yearly);
    return Math.max(counterFor(kind, yearly), counterFor(kind, !yearly));
  };
  const yearlyCheck = (kind, label, nextInput = null) => {
    const box = el('input', {
      type: 'checkbox', checked: !!s.numberYearly?.[kind],
      onchange: () => {
        if (!nextInput) return;
        // Reloaded from the store, so it tracks the store again.
        delete nextInput.dataset.edited;
        nextInput.value = shownCounter(kind, box.checked);
      },
    });
    return { box, row: el('label.check-row', {}, box, el('span', {}, label)) };
  };
  const invYearly = yearlyCheck('invoice', 'Invoices', invNext);
  const qYearly = yearlyCheck('quote', 'Estimates', qNext);
  const rYearly = yearlyCheck('receipt', 'Receipts', rNext);

  /**
   * A counter can move while this page sits open: the recurring invoices
   * drafted at boot reserve numbers of their own. Save writes each visible
   * Next # straight back into its counter, so a field still showing the value
   * read when the page opened would rewind the series onto numbers already
   * issued — two invoices sharing a number. Untouched fields follow the store;
   * one someone typed into is their decision and is left as they left it —
   * until that decision is saved, at which point the field and the counter
   * agree again and it goes back to following, or the very rewind this
   * guards against returns for every later save from the same visit.
   */
  const counterFields = [
    [invNext, 'invoice', invYearly],
    [qNext, 'quote', qYearly],
    [rNext, 'receipt', rYearly],
  ];
  const refreshCounters = () => {
    for (const [input, kind, yearly] of counterFields) {
      if (input.dataset.edited) continue;
      input.value = shownCounter(kind, yearly.box.checked);
    }
  };
  const countersSaved = () => {
    for (const [input] of counterFields) delete input.dataset.edited;
  };

  const numberingCard = saveCard('Numbering', [
    el('p.card-sub', {},
      'Numbers are assigned when a document is created and never reused. Add {YYYY} to a prefix to include the issue year: INV-{YYYY}- numbers as INV-',
      String(new Date().getFullYear()), '-0001.'),
    el('div.field-grid', {},
      field('Invoice prefix', invPrefix),
      field('Next invoice #', invNext),
      field('Estimate prefix', qPrefix),
      field('Next estimate #', qNext),
      field('Receipt prefix', rPrefix),
      field('Next receipt #', rNext)),
    el('div.field', {},
      el('span.field-label', {}, 'Restart numbering each year',
        el('span.field-hint', {}, ' (each series counts from 1 every January)')),
      el('div.check-group', {}, invYearly.row, qYearly.row, rYearly.row)),
  ], () => {
    // A blank Next # has no meaning to fall back on: the coerced 1 would
    // restart the series onto numbers already issued, while the field kept
    // showing blank — the same refusal the schedule count makes.
    for (const [input, what] of [[invNext, 'invoice'], [qNext, 'estimate'], [rNext, 'receipt']]) {
      if (String(input.value).trim() === '') {
        toast(`Enter the next ${what} number`, { icon: 'alert' });
        input.focus();
        return null;
      }
    }
    // A visible Next # writes back to the counter it was read from — under
    // the yearly regime that is this year's counter, kept beside the others
    // in yearNext so no year's position is ever lost.
    const year = String(new Date().getFullYear());
    const yearly = {
      invoice: invYearly.box.checked,
      quote: qYearly.box.checked,
      receipt: rYearly.box.checked,
    };
    const nextOf = (input) => Math.max(1, Math.round(Number(input.value) || 1));
    const yearNext = { ...(store.settings.yearNext || {}) };
    const patch = {
      invoicePrefix: invPrefix.value,
      quotePrefix: qPrefix.value,
      receiptPrefix: rPrefix.value,
      numberYearly: yearly,
      yearNext,
    };
    if (yearly.invoice) yearNext.invoice = { ...(yearNext.invoice || {}), [year]: nextOf(invNext) };
    else patch.nextInvoice = nextOf(invNext);
    if (yearly.quote) yearNext.quote = { ...(yearNext.quote || {}), [year]: nextOf(qNext) };
    else patch.nextQuote = nextOf(qNext);
    if (yearly.receipt) yearNext.receipt = { ...(yearNext.receipt || {}), [year]: nextOf(rNext) };
    else patch.nextReceipt = nextOf(rNext);
    return patch;
  }, countersSaved);

  /* ----- Payment links ----- */
  const linkPreview = el('p.card-sub.paylink-preview', { 'aria-live': 'polite' });
  const linkValue = el('input.input', {
    value: s.paymentLink.value,
    oninput: updatePreview,
  });
  const linkKind = el('select.select', {
    onchange: () => { syncLinkField(); updatePreview(); },
  },
    el('option', { value: 'none', selected: s.paymentLink.kind === 'none' }, 'Off'),
    el('option', { value: 'paypal', selected: s.paymentLink.kind === 'paypal' }, 'PayPal.me'),
    el('option', { value: 'custom', selected: s.paymentLink.kind === 'custom' }, 'Custom URL template'));
  const linkField = field('PayPal.me username or URL template', linkValue);

  function syncLinkField() {
    const kind = linkKind.value;
    linkField.hidden = kind === 'none';
    linkField.querySelector('label').textContent = kind === 'paypal' ? 'PayPal.me username' : 'URL template';
    linkValue.placeholder = kind === 'paypal'
      ? 'yourname'
      : 'https://pay.example.com/?amount={amount}&ref={number}';
  }
  function updatePreview() {
    // store.settings, not the snapshot this view opened with: saving a new
    // default currency in the card above replaces the settings object, and an
    // example still quoting the old code contradicts what was just stored.
    const url = paymentLink({ kind: linkKind.value, value: linkValue.value },
      { amount: 1234.5, currency: store.settings.currency, number: 'INV-0042' });
    linkPreview.textContent = url ? `Example: ${url}` : linkKind.value === 'none'
      ? '' : 'Enter a value to see an example link.';
  }
  syncLinkField();
  updatePreview();

  const paylinkCard = saveCard('Payment links', [
    el('p.card-sub', {},
      'Adds a "pay online" link to invoices and shared pages, pre-filled with the amount due. Placeholders for custom templates: {amount}, {currency}, {number}.'),
    el('div.field-grid', {},
      field('Provider', selectWrap(linkKind))),
    linkField,
    linkPreview,
  ], () => ({
    paymentLink: { kind: linkKind.value, value: linkValue.value.trim() },
  }));

  /* ----- Payment instructions ----- */
  const payInstructions = el('textarea.textarea', {
    rows: 3, value: s.paymentInstructions || '',
    placeholder: 'Account name: Aurora Studio\nIBAN: DE00 0000 0000 0000 0000 00\nBIC: EXAMPLEX',
  });
  const payInstructionsCard = saveCard('Payment instructions', [
    el('p.card-sub', {},
      'How clients pay you by bank transfer: account name, IBAN, sort code, routing number, whatever they need. '
      + 'Printed under its own heading on every invoice that still has a balance due; settled and void invoices never show it. '
      + 'A client can carry their own version, set on their card.'),
    field('Instructions', payInstructions),
  ], () => ({
    paymentInstructions: payInstructions.value.trim(),
  }));

  /* ----- Late fees ----- */
  const lf = s.lateFee || { type: 'none', value: 0 };
  // Pinned against the currently selected policy — and re-pinned when the
  // policy switches, like the editor's discount: a fixed amount of 150 is
  // out of range the moment the policy becomes a percentage, and Save would
  // store 100 while the field kept showing 150.
  const pinLateFee = () => {
    if (lateFeeValue.value === '') return;
    const max = lateFeeKind.value === 'percent' ? 100 : Infinity;
    lateFeeValue.value = clamp(Number(lateFeeValue.value) || 0, 0, max);
  };
  const lateFeeValue = el('input.input', {
    type: 'number', min: '0', step: 'any', inputmode: 'decimal',
    value: lf.value || '', placeholder: '2',
    onchange: pinLateFee,
  });
  const lateFeeKind = el('select.select', {
    onchange: () => { syncLateFee(); pinLateFee(); },
  },
    el('option', { value: 'none', selected: !lf.type || lf.type === 'none' }, 'No late fee'),
    el('option', { value: 'percent', selected: lf.type === 'percent' }, '% of the balance, per month'),
    el('option', { value: 'fixed', selected: lf.type === 'fixed' }, 'Fixed amount, per month'));
  const lateFeeField = field('Amount', lateFeeValue);
  function syncLateFee() {
    lateFeeField.hidden = lateFeeKind.value === 'none';
    // Read the currency now, not from the snapshot this view opened with: a
    // fee named in a currency the account no longer bills in is worse than
    // no currency at all.
    lateFeeField.querySelector('label').textContent = lateFeeKind.value === 'fixed'
      ? `Amount (${store.settings.currency}, per month)` : 'Percent of balance, per month';
  }
  syncLateFee();

  const lateFeeCard = saveCard('Late fees', [
    el('p.card-sub', {},
      'Disclosed on every unpaid invoice ("A late fee of … per month applies after the due date"), '
      + 'which is what makes it enforceable in many places. The fee is never added automatically: '
      + 'an overdue invoice offers "Add late fee", and each press appends one clearly labelled line. '
      + 'A client can carry their own policy, set on their card.'),
    el('div.field-grid', {},
      field('Policy', selectWrap(lateFeeKind)),
      lateFeeField),
  ], () => {
    const kind = lateFeeKind.value;
    const value = kind === 'percent'
      ? clamp(Number(lateFeeValue.value) || 0, 0, 100)
      : Math.max(0, Number(lateFeeValue.value) || 0);
    if (kind !== 'none' && value <= 0) {
      // Saving here would quietly store "no late fee" while the card kept
      // showing a chosen policy with a blank amount.
      toast('Enter the late-fee amount, or choose "No late fee"', { icon: 'alert' });
      lateFeeValue.focus();
      return null;
    }
    return {
      lateFee: kind === 'none'
        ? { type: 'none', value: 0 }
        : { type: kind, value },
    };
  });

  /* ----- Message templates ----- */
  // All templates are edited in one card with a picker, and saved together:
  // switching between them keeps unsaved edits, because the inputs write
  // straight into the working copy.
  const templates = allTemplates(s);
  let templateKey = TEMPLATE_KEYS[0];

  const tplSubject = el('input.input', {
    oninput: (e) => { templates[templateKey].subject = e.target.value; },
  });
  const tplBody = el('textarea.textarea.compose-body', {
    rows: 9,
    oninput: (e) => { templates[templateKey].body = e.target.value; },
  });
  const tplLegend = el('p.card-sub.tpl-legend');
  const tplPicker = el('select.select', {
    'aria-label': 'Template',
    onchange: (e) => { templateKey = e.target.value; renderTemplate(); },
  }, TEMPLATE_KEYS.map((k) => el('option', { value: k }, TEMPLATE_LABELS[k])));

  function renderTemplate() {
    tplSubject.value = templates[templateKey].subject;
    tplBody.value = templates[templateKey].body;
    tplLegend.replaceChildren(
      el('span', {}, 'Placeholders: '),
      ...placeholdersFor(templateKey).map(([key, label], i) =>
        el('span', {}, i ? ', ' : '', el('code.tpl-ph', {}, `{${key}}`), ` ${label}`)),
      el('span', {}, '. A line whose placeholder has no value is left out.'));
  }
  renderTemplate();

  const templatesCard = saveCard('Message templates', [
    el('p.card-sub', {}, 'The wording used when you email a document. Every message stays editable before it is sent.'),
    field('Template', selectWrap(tplPicker)),
    field('Subject', tplSubject),
    field('Message', tplBody),
    tplLegend,
    el('div.side-actions', {},
      el('button.btn.btn-ghost', {
        type: 'button',
        html: icon('undo', 15, 1.6),
        onclick: () => {
          templates[templateKey] = { ...DEFAULT_TEMPLATES[templateKey] };
          renderTemplate();
          toast('Default wording restored. Save to keep it');
        },
      }, ' Reset this template')),
  ], () => {
    // Only wording that differs from the shipped default is stored.
    // Missing keys fall back to lib/message.js by design, so saving an
    // untouched template verbatim would pin today's default text forever
    // and cut it off from improved wording in future builds. This also
    // makes Reset + Save a true reset rather than a copy of the default.
    // A blank subject or message has no meaning here: templateFor() falls
    // back to the shipped default on blank, so Save reported success for
    // wording the card could never show again — reload, and the default was
    // back. Refuse it, on the template that has it.
    for (const key of TEMPLATE_KEYS) {
      const blank = !templates[key].subject.trim() ? 'subject' : !templates[key].body.trim() ? 'body' : null;
      if (!blank) continue;
      if (templateKey !== key) {
        templateKey = key;
        tplPicker.value = key;
        renderTemplate();
      }
      toast(`Give the ${TEMPLATE_LABELS[key].toLowerCase()} template a ${blank === 'subject' ? 'subject' : 'message'}, or reset it`, { icon: 'alert' });
      (blank === 'subject' ? tplSubject : tplBody).focus();
      return null;
    }
    const next = { ...store.settings.templates };
    for (const key of TEMPLATE_KEYS) {
      const d = DEFAULT_TEMPLATES[key];
      const t = templates[key];
      if (t.subject === d.subject && t.body === d.body) delete next[key];
      else next[key] = { subject: t.subject, body: t.body };
    }
    return { templates: next };
  });

  /* ----- Appearance ----- */
  // Toggle buttons with aria-pressed rather than ARIA radios: the radio
  // pattern demands roving tabindex and arrow-key navigation, and claiming
  // it without those is worse for screen readers than plain buttons.
  const themeSeg = el('div.segmented', { role: 'group', 'aria-label': 'Theme' });
  /**
   * Drawn from the theme that is actually on screen, not from the last value
   * saved: the sidebar carries a light/dark toggle of its own, and pressing
   * it while this page is open used to leave the group showing the theme the
   * app had left behind. `currentTheme()` reads the stamp on the document,
   * which every path — this group, that toggle, a restored backup — goes
   * through, so the two controls cannot disagree.
   */
  let drawnTheme = null;
  const renderTheme = () => {
    const now = currentTheme();
    if (now === drawnTheme) return;
    drawnTheme = now;
    // The repaint below replaces every button in the group, including the
    // pressed one, which drops keyboard focus to <body>. Hand it to the twin
    // that takes its place, exactly as the chip and tax rows do.
    const hadFocus = themeSeg.contains(document.activeElement);
    themeSeg.replaceChildren(...[
      ['system', 'System', 'monitor'],
      ['light', 'Light', 'sun'],
      ['dark', 'Dark', 'moon'],
    ].map(([value, label, ic]) => el('button', {
      type: 'button',
      className: now === value ? 'active' : '',
      'aria-pressed': now === value ? 'true' : 'false',
      html: icon(ic, 15, 1.6),
      onclick: async () => {
        // Repaint from the chosen value immediately; the settings event will
        // confirm it once persisted.
        applyTheme(value);
        renderTheme();
        try {
          await store.updateSettings({ theme: value });
        } catch { /* applied locally; syncs next save */ }
      },
    }, ` ${label}`)));
    if (hadFocus) themeSeg.querySelector('button.active')?.focus();
  };
  renderTheme();

  const appearanceCard = el('section.card.settings-card', {},
    el('h2.card-title', {}, 'Appearance'),
    el('p.card-sub', {}, 'System follows your device setting.'),
    themeSeg);

  /* ----- Personal Finance integration ----- */
  const acctCard = el('section.card.settings-card', {},
    el('h2.card-title', {}, 'Personal Finance'),
    el('p.card-sub', {},
      'Keep your books in step: export every payment received as income rows shaped for the Personal Finance app. In Personal Finance, open Settings, choose Import CSV, and the columns map automatically.'),
    el('div.side-actions', {},
      el('button.btn', {
        html: icon('download', 15, 1.6),
        onclick: () => {
          // Count what the file will actually hold, not what the receipts
          // ledger shows: the export leaves out void invoices' payments, so
          // an invoice paid, refunded and then voided is in the ledger and
          // not in the CSV. Counting the ledger promised rows that were
          // never written — and with every payment on a void invoice, it
          // would hand over a file with nothing but a header in it.
          // Converted into the account's own money where a rate was recorded,
          // exactly as the receipts page exports it.
          const opts = { baseCurrency: store.settings.baseCurrency || store.settings.currency || 'USD' };
          const rows = paymentRows(store.docs(), store.clients, opts);
          if (!rows.length) {
            toast(store.receipts().length
              ? 'Nothing to export: every payment is on a void invoice'
              : 'No payments to export yet', { icon: 'alert' });
            return;
          }
          download('income-for-personal-finance.csv', paymentsCsv(store.docs(), store.clients, opts), 'text/csv');
          toast(`${rows.length} payment${rows.length === 1 ? '' : 's'} exported`, { icon: 'download' });
        },
      }, ' Export payments as CSV')));

  /* ----- Data ----- */
  const isPuterApp = typeof puter !== 'undefined' && puter.env === 'app';

  const restoreFile = el('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';        // re-picking the same file must still fire
      if (file) restore(file);
    },
  });
  // Downloading a backup reads; putting one back writes the whole account.
  // Offline that write is refused after the confirm dialog has already told
  // the user everything they have is about to be replaced — the same reason
  // every Save button on this page is disabled there.
  const restoreBtn = el('button.btn', {
    html: icon('upload', 15, 1.6),
    disabled: store.readOnly,
    title: store.readOnly ? 'Reconnect to restore a backup' : null,
    onclick: () => restoreFile.click(),
  }, ' Restore from backup');

  async function restore(file) {
    restoreBtn.disabled = true;
    try {
      const result = parseBackup(await file.text());
      if (!result.ok) {
        toast(result.error, { icon: 'alert' });
        return;
      }
      const { counts, data, tokens } = result;
      const ok = await confirmDialog({
        title: 'Restore this backup?',
        message: `It holds ${restoreSummary(counts)}. Everything in this account is replaced by it, `
          + 'including your business profile and numbering. '
          + (isPrivate
            ? 'Documents come back unshared. Attachment files must already exist on this Jetson. Any old pages on Puter must be removed there separately.'
            : 'Documents come back unshared, so any published page is taken offline and can be shared again afterwards.'),
        confirmLabel: 'Replace my data',
      });
      if (!ok) return;

      // Replace the data before touching any share page: retiring pages
      // first meant a failed import had already killed every published
      // link while the toast below still claimed nothing was changed.
      // The current tokens are captured now — restored documents come
      // back unshared, so they are gone from the store afterwards.
      const current = store.docs().map((d) => d.shareToken).filter(Boolean);
      // Hosting belongs to the account, not the backup: keeping this
      // account's own subdomain means restored documents publish to a site
      // that actually exists (and a fresh account simply gets one on its
      // first share).
      await store.importAll({
        ...data,
        settings: { ...data.settings, share: store.settings.share || null },
      });
      const failed = await retireSharePages(store, [...tokens, ...current]);
      applyTheme(store.settings.theme || 'system');
      toast(`Restored ${restoreSummary(counts)}`, { icon: 'circleCheck' });
      if (failed) toast(`${failed} old share page${failed === 1 ? '' : 's'} could not be taken offline`, { icon: 'alert' });
      // A backup carries what each document says it has; the files themselves
      // live in the filesystem and may simply not be there any more. Report
      // that rather than letting a download fail later with no explanation.
      if (counts.attachments) {
        const { missing } = await missingAttachments(store).catch(() => ({ missing: 0 }));
        if (missing) {
          toast(`${missing} attached file${missing === 1 ? ' is' : 's are'} no longer in your cloud`, { icon: 'alert' });
        }
      }
      navigate('#/');
    } catch (err) {
      console.error(err);
      toast(isPrivate
        ? 'Restore did not complete. Reload to check your data before trying again; a daily server backup is available.'
        : 'Could not restore that backup. Nothing was changed', { icon: 'wifiOff' });
    } finally {
      restoreBtn.disabled = false;
      // A restore that went through has already navigated away, and the
      // guard inside refocus() sees the button is gone; one that stopped
      // (a bad file, a refused confirm, a failed write) leaves the user
      // right here, so put them back on the button they pressed.
      refocus(restoreBtn);
    }
  }

  /* ----- Import from another app ----- */
  // The way in for someone arriving with forty clients and a folder of
  // unpaid invoices. Two passes, both mapped by hand, both previewed before
  // anything is written.
  const importCard = el('section.card.settings-card', {},
    el('h2.card-title', {}, 'Import from a spreadsheet'),
    el('p.card-sub', {},
      'Coming from another invoicing app, an Excel workbook, or a CSV? Bring your clients over, then your '
      + 'unpaid invoices as opening balances. You map the columns, and you see exactly what will '
      + 'be created — how many rows, how many duplicates, how many unusable and why — before '
      + 'anything is written.'),
    // Both wizards end in a write, so offline they would walk the user
    // through three steps and a preview before refusing every row.
    el('div.side-actions', {},
      el('button.btn', {
        html: icon('clients', 15, 1.6),
        disabled: store.readOnly,
        title: store.readOnly ? 'Reconnect to import' : null,
        onclick: () => openImportWizard('clients'),
      }, ' Import clients'),
      el('button.btn', {
        html: icon('invoice', 15, 1.6),
        disabled: store.readOnly,
        title: store.readOnly ? 'Reconnect to import' : null,
        onclick: () => openImportWizard('invoices'),
      }, ' Import open invoices')));

  /* ----- Offline copy ----- */
  // Off by default and disclosed plainly: everything else in this app lives
  // in the user's own cloud, and this is the one setting that puts a copy of
  // their billing data on the device in front of them.
  const offlineNote = el('p.card-sub', { 'aria-live': 'polite' });
  const offlineBox = el('input', {
    type: 'checkbox', checked: offlineEnabled(),
    onchange: (e) => {
      const on = e.target.checked;
      if (!setOfflineEnabled(on)) {
        e.target.checked = false;
        toast('This browser will not let the app store anything on the device', { icon: 'alert' });
        renderOfflineNote();
        return;
      }
      if (on) {
        const result = writeSnapshot(serializeSnapshot(store.exportAll(), {
          user: store.user?.username || '',
        }));
        toast(result.ok
          ? 'A copy is kept on this device'
          : result.error === 'too large'
            ? 'Your account is larger than this browser will hold; nothing was saved'
            : 'Could not save a copy on this device', { icon: result.ok ? 'check' : 'alert' });
        // A copy that cannot be written is not a setting to leave on: the box
        // stayed ticked over a note promising the copy "as soon as anything
        // changes", while the background writer refused every time.
        if (!result.ok) {
          setOfflineEnabled(false);
          e.target.checked = false;
        }
      } else {
        toast('The copy on this device was removed', { icon: 'trash' });
      }
      renderOfflineNote();
    },
  });
  function renderOfflineNote() {
    const snapshot = offlineEnabled() ? readSnapshot() : null;
    offlineNote.textContent = !offlineEnabled()
      ? 'Nothing about your account is stored on this device.'
      : snapshot
        ? `Saved ${new Date(snapshot.savedAt).toLocaleString()} · ${fileSize(snapshot.bytes)} on this device.`
        : 'Nothing saved yet; the copy is written as soon as anything changes.';
  }
  renderOfflineNote();

  const offlineCard = el('section.card.settings-card', {},
    el('h2.card-title', {}, 'Offline'),
    el('p.card-sub', {},
      'Install the app and it keeps working with no connection: the last data it loaded opens '
      + 'read-only, so invoices, receipts, statements, and reports can all still be read, printed, '
      + (isPrivate ? 'and downloaded as PDFs. Making changes needs a connection to your Jetson through Tailscale.' : 'and downloaded as PDFs. Making changes needs your cloud.')),
    el('div.field', {},
      el('label.check-row', {}, offlineBox,
        el('span', {}, 'Keep a copy on this device for offline use',
          el('span.field-hint', {}, isPrivate ? ' (removed when you switch this off)' : ' (removed when you switch this off, and when you sign out)')))),
    offlineNote);

  const dataCard = el('section.card.settings-card', {},
    el('h2.card-title', {}, 'Your data'),
    el('p.card-sub', {}, isPrivate
      ? 'Invoices, clients, settings and attachments are stored on your Jetson, not Puter or this browser. Access is restricted to your Tailscale account. Daily server backups include attachments. The JSON download below contains records only, not attachment files. Public sharing and paid email sending are disabled; download PDFs and attach them in Gmail or your email app.'
      : 'Everything lives in your own Puter cloud. Download a copy anytime, and put one back if you ever need to.'),
    el('div.side-actions', {},
      el('button.btn', {
        html: icon('download', 15, 1.6),
        onclick: () => {
          download(`invoicing-backup-${todayISO()}.json`,
            JSON.stringify(store.exportAll(), null, 2), 'application/json');
          toast('Backup downloaded', { icon: 'download' });
        },
      }, ' Download backup'),
      restoreBtn,
      restoreFile,
      !isPrivate && !isPuterApp && el('button.btn.btn-danger', {
        html: icon('logout', 15, 1.6),
        onclick: confirmSignOut,
      }, ' Sign out')));

  root.append(
    el('div.page-head', {}, el('div', {},
      el('h1.page-title', {}, 'Settings'),
      el('p.page-sub', {}, isPrivate ? 'Private Jetson storage · Tailscale access' : (store.user?.username ? `Signed in as ${store.user.username}` : 'Your workspace')))),
    el('div.settings-grid', {},
      businessCard, defaultsCard, savedItemsCard, numberingCard, paylinkCard, payInstructionsCard,
      lateFeeCard, templatesCard, appearanceCard, acctCard, importCard, offlineCard, dataCard)
  );

  // Both of these name the account's currency, which the card above them can
  // change without this page ever being rebuilt. Repaint them whenever the
  // settings move so the whole page agrees with what was just saved.
  const onSettingsChange = () => {
    syncLateFee();
    updatePreview();
    refreshCounters();
    renderItemsCount();
    renderTheme();
  };
  store.addEventListener('change', onSettingsChange);
  // The sidebar's toggle stamps the theme before it saves — and offline it
  // never saves, so no store event follows the press.
  document.addEventListener('themechange', renderTheme);
  // The copy is written a moment after the store's event, so the note
  // repaints on the write itself (main.js says when) — on the store event it
  // read the previous copy's time and size, and re-parsed the whole copy
  // for every change on the page.
  document.addEventListener('snapshotchange', renderOfflineNote);
  root.destroy = () => {
    store.removeEventListener('change', onSettingsChange);
    document.removeEventListener('themechange', renderTheme);
    document.removeEventListener('snapshotchange', renderOfflineNote);
  };
  return root;
}
