import { el, clear, field } from '../ui/dom.js';
import { icon, CATEGORY_ICON_CHOICES } from '../ui/icons.js';
import { store } from '../lib/store.js';
import { applyTheme, currentTheme } from '../ui/theme.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { CURRENCIES } from '../lib/currencies.js';
import { DEFAULT_OCR_MODEL } from '../lib/ocr.js';
import { exportJSONFile } from '../lib/export.js';
import { catDot, catColor } from '../ui/common.js';
import { wipeSampleData } from '../lib/sample.js';
import { openOnboarding } from '../ui/onboarding.js';
import { openCapture } from '../ui/capture.js';

/** Inside the Puter desktop the host owns the session, so no sign-out is offered. */
export function canSignOut(sdk = store.sdk) {
  return sdk?.mode !== 'private' && sdk?.env !== 'app';
}

export async function confirmSignOut() {
  const ok = await confirmDialog({ title: 'Sign out?', message: 'Your data stays in your Puter account. Sign back in anytime.', confirmLabel: 'Sign out', danger: false });
  if (!ok) return;
  try { puter.auth.signOut(); } catch { /* ignore */ }
  location.reload();
}

export function settingsView() {
  const root = el('section.view', { 'aria-labelledby': 'set-title' });
  root.append(el('div.page-head', {}, el('div', {}, el('h1.page-title', { id: 'set-title' }, 'Settings'))));
  const content = el('div');
  root.append(content);
  const draftGenerations = new WeakMap();
  const markDraft = event => {
    if (store.sdk?.mode !== 'private') return;
    const row = event.target.closest('.settings-row');
    if (row) {
      draftGenerations.set(row, (draftGenerations.get(row) || 0) + 1);
      row.dataset.privateDirty = '1';
      store.dispatchEvent(new Event('storage-state'));
    }
  };
  root.addEventListener('input', markDraft, true);
  root.addEventListener('change', markDraft, true);

  function render() {
    if (store.sdk?.mode === 'private' && content.querySelector('[data-private-dirty]')) return;
    clear(content);
    const s = store.settings;
    const privateMode = store.sdk?.mode === 'private';

    /* Appearance */
    const theme = currentTheme();
    const themeSeg = el('div.segmented.block', { role: 'radiogroup', 'aria-label': 'Theme' },
      [['system', 'System', 'monitor'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([v, label, ic]) =>
        el('button', { type: 'button', role: 'radio', 'aria-checked': theme === v, html: icon(ic, 15, 2), onclick: () => { applyTheme(v); store.updateSettings({ theme: v }).catch(() => {}); render(); } }, label)));

    content.append(
      el('h2.section-title', {}, 'Appearance'),
      el('div.settings-list', {}, el('div.settings-row', {}, el('div.grow', {}, el('div.title', {}, 'Theme'), el('div.sub', {}, 'System follows your device')), themeSeg)),

      el('h2.section-title', {}, 'Expenses'),
      el('div.settings-list', {},
        el('div.settings-row', {},
          el('div.grow', {}, el('div.title', {}, 'Base currency'), el('div.sub', {}, 'Totals and reports are shown in this currency')),
          el('div.select-wrap', {}, el('select.select', { 'aria-label': 'Base currency', style: { width: 'auto' }, onchange: (e) => {
            const row = e.target.closest('.settings-row');
            const generation = draftGenerations.get(row);
            store.updateSettings({ baseCurrency: e.target.value }).then(() => {
              if (draftGenerations.get(row) === generation) delete row.dataset.privateDirty;
              store.dispatchEvent(new Event('storage-state'));
              toast('Currency updated');
            }).catch(() => toast('Couldn’t save', { icon: 'wifiOff' }));
          } },
            CURRENCIES.map((c) => el('option', { value: c.code, selected: c.code === s.baseCurrency }, c.code))))),
        el('button.settings-row.clickable', { type: 'button', onclick: openCategories },
          el('span', { html: icon('layers', 20, 1.8) }),
          el('div.grow', {}, el('div.title', {}, 'Categories'), el('div.sub', {}, `${store.categories.length} categories`)),
          el('span', { html: icon('chevR', 18), style: { color: 'var(--ink-3)' } }))),

      el('h2.section-title', {}, 'AI receipt reading'),
      privateMode ? el('p', {}, 'Cloud OCR is unavailable in private mode. Upload receipts and enter fields manually; no AI calls are made.') : el('div.settings-list', {},
        el('div.settings-row', {},
          el('div.grow', {}, el('div.title', {}, 'Read receipts automatically'), el('div.sub', {}, 'Run OCR when a receipt is captured. Off means every field is typed by hand.')),
          switchEl(s.autoOcr, (v) => store.updateSettings({ autoOcr: v }).then(render))),
        el('div.settings-row', {},
          el('div.grow', {}, el('div.title', {}, 'Vision model'), el('div.sub', {}, 'Any vision-capable model Puter offers. Leave blank for the default.')),
          el('input.input', { type: 'text', value: s.ocrModel === DEFAULT_OCR_MODEL ? '' : s.ocrModel, placeholder: DEFAULT_OCR_MODEL, 'aria-label': 'Vision model', style: { maxWidth: '220px' },
            onchange: (e) => store.updateSettings({ ocrModel: e.target.value.trim() || DEFAULT_OCR_MODEL }).then(() => toast('Model saved')).catch(() => toast('Couldn’t save', { icon: 'wifiOff' })) }))),

      el('h2.section-title', {}, 'Your data'),
      el('div.settings-list', {},
        el('button.settings-row.clickable', { type: 'button', onclick: async () => {
          try { exportJSONFile(await store.exportAll()); } catch (err) { console.error(err); toast('Couldn’t export', { icon: 'wifiOff' }); }
        } }, el('span', { html: icon('fileDown', 20, 1.8) }), el('div.grow', {}, el('div.title', {}, 'Export backup'), el('div.sub', {}, 'Everything except receipt images, as one JSON file'))),
        el('button.settings-row.clickable', { type: 'button', onclick: importBackup }, el('span', { html: icon('fileUp', 20, 1.8) }), el('div.grow', {}, el('div.title', {}, 'Restore backup'), el('div.sub', {}, 'Replaces your current data with a backup file'))),
        s.sampleData
          ? el('button.settings-row.clickable', { type: 'button', onclick: async () => {
            const ok = await confirmDialog({ title: 'Wipe sample data?', message: 'Everything is removed and you set up your own expenses from scratch.', confirmLabel: 'Wipe sample data' });
            if (!ok) return;
            try { await wipeSampleData(store); location.hash = '#/'; openOnboarding({ onCapture: () => openCapture() }); } catch (err) { console.error(err); toast('Couldn’t wipe', { icon: 'wifiOff' }); }
          } }, el('span', { html: icon('sparkle', 20, 1.8) }), el('div.grow', {}, el('div.title', {}, 'Wipe sample data'), el('div.sub', {}, 'Start fresh with your own expenses')))
          : el('button.settings-row.clickable', { type: 'button', onclick: async () => {
            const ok = await confirmDialog({ title: 'Delete everything?', message: privateMode ? 'All expenses, receipts, reports and statements in this app are permanently deleted from your private Jetson storage.' : 'All expenses, receipts, reports and statements in this app are permanently deleted from your Puter account.', confirmLabel: 'Delete everything' });
            if (!ok) return;
            try { await store.wipeAll({ keepSettings: { onboarded: true } }); toast('All data deleted', { icon: 'trash' }); location.hash = '#/'; } catch (err) { console.error(err); toast('Couldn’t delete', { icon: 'wifiOff' }); }
          } }, el('span', { html: icon('trash', 20, 1.8), style: { color: 'var(--critical)' } }), el('div.grow', {}, el('div.title', { style: { color: 'var(--critical)' } }, 'Delete all data'), el('div.sub', {}, 'Cannot be undone')))),

      el('h2.section-title', {}, 'Account'),
      el('div.settings-list', {},
        el('div.settings-row', {}, el('span.user-avatar', { 'aria-hidden': 'true' }, (store.user?.username || 'P').charAt(0).toUpperCase()),
          el('div.grow', {}, el('div.title', {}, store.user?.username || 'Puter user'), el('div.sub', {}, privateMode ? 'Authorized private Jetson session' : store.user?.email || 'Signed in with Puter')),
          canSignOut() && el('button.btn.btn-outline.btn-sm', { type: 'button', html: icon('logout', 14, 2.2), onclick: confirmSignOut }, 'Sign out'))),

      privateMode ? el('p.small.muted', {}, 'Primary data is on Jetson. JSON exports omit receipt bytes. No offline mirror or cloud fallback.') : el('p.small.muted', { style: { textAlign: 'center', margin: '8px 0 24px' } }, 'Expenses stores everything in your own Puter account. Powered by ',
        el('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Puter'), '.')
    );
  }

  function switchEl(on, onChange) {
    const btn = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!on), onclick: () => { const next = btn.getAttribute('aria-checked') !== 'true'; btn.setAttribute('aria-checked', String(next)); onChange(next).catch(() => toast('Couldn’t save', { icon: 'wifiOff' })); } });
    return btn;
  }

  function importBackup() {
    const input = el('input', { type: 'file', accept: 'application/json,.json', className: 'visually-hidden' });
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { toast('That file isn’t a valid backup', { icon: 'warn' }); return; }
      if (data?.app !== 'expenses') { toast('That file isn’t an Expenses backup', { icon: 'warn' }); return; }
      const ok = await confirmDialog({ title: 'Restore this backup?', message: 'Your current expenses, reports and statements are replaced. Receipt files already in your drive are kept.', confirmLabel: 'Restore', danger: false });
      if (!ok) return;
      try { await store.importAll(data); toast('Backup restored'); location.hash = '#/'; } catch (err) { console.error(err); toast('Couldn’t restore', { icon: 'wifiOff' }); }
    };
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  }

  function openCategories() {
    const list = el('div.list');
    const draw = () => {
      clear(list);
      list.append(store.categories.map((c) => el('div.list-row.static', {},
        catDot(c),
        el('div.grow', {}, el('div.title', {}, c.name)),
        el('button.icon-btn', { type: 'button', html: icon('pencil', 17, 2), 'aria-label': `Edit ${c.name}`, onclick: () => openCategoryForm(c, draw) }),
        el('button.icon-btn.danger', { type: 'button', html: icon('trash', 17, 2), 'aria-label': `Delete ${c.name}`, onclick: async () => {
          if (store.categories.length <= 1) { toast('Keep at least one category', { icon: 'info' }); return; }
          const ok = await confirmDialog({ title: `Delete ${c.name}?`, message: 'Expenses in this category become uncategorised.', confirmLabel: 'Delete' });
          if (!ok) return;
          try { await store.deleteCategory(c.id); draw(); render(); } catch (err) { console.error(err); toast('Couldn’t delete', { icon: 'wifiOff' }); }
        } }))));
    };
    draw();
    openModal({ title: 'Categories', content: el('div', {}, list, el('div.row.end', {}, el('button.btn.btn-primary', { type: 'button', html: icon('plus', 15, 2.2), onclick: () => openCategoryForm(null, () => { draw(); render(); }) }, 'New category'))) });
  }

  function openCategoryForm(cat, done) {
    let saving = false;
    let iconName = cat?.icon || 'tag';
    let slot = cat?.slot || ((store.categories.length % 8) + 1);
    const name = el('input.input', { type: 'text', value: cat?.name || '', placeholder: 'Category name', maxlength: 40, required: true });
    const iconGrid = el('div.icon-grid', { role: 'radiogroup', 'aria-label': 'Icon' });
    const colorRow = el('div.swatches', { role: 'radiogroup', 'aria-label': 'Color' });
    const drawPickers = () => {
      clear(iconGrid); clear(colorRow);
      iconGrid.append(...CATEGORY_ICON_CHOICES.map((n) => el('button.icon-pick', { type: 'button', role: 'radio', 'aria-checked': n === iconName, 'aria-label': n, html: icon(n, 18, 1.9), onclick: () => { iconName = n; drawPickers(); iconGrid.dispatchEvent(new Event('change', { bubbles: true })); } })));
      colorRow.append(...Array.from({ length: 8 }, (_, i) => i + 1).map((n) => el('button.swatch', { type: 'button', role: 'radio', 'aria-checked': n === slot, 'aria-label': `Color ${n}`, style: { background: catColor({ slot: n }) }, onclick: () => { slot = n; drawPickers(); colorRow.dispatchEvent(new Event('change', { bubbles: true })); } })));
    };
    drawPickers();
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (saving) return;
      if (!name.value.trim()) { name.focus(); return; }
      const generation = modal.editGeneration;
      saving = true;
      try {
        if (cat) await store.updateCategory(cat.id, { name: name.value.trim(), icon: iconName, slot });
        else {
          const saved = await store.addCategory({ name: name.value.trim(), icon: iconName, slot });
          if (store.sdk?.mode === 'private' && generation !== modal.editGeneration) cat = saved;
        }
        if (modal.closeIfUnchanged(generation)) { done?.(); toast(cat ? 'Category updated' : 'Category added'); }
      } catch (err) { console.error(err); toast('Couldn’t save', { icon: 'wifiOff' }); }
      finally { saving = false; }
    } },
      field('Name', name),
      el('div.field', {}, el('span.field-label', {}, 'Icon'), iconGrid),
      el('div.field', {}, el('span.field-label', {}, 'Color'), colorRow),
      el('div.row.end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, cat ? 'Save' : 'Add')));
    const modal = openModal({ title: cat ? 'Edit category' : 'New category', content: form });
  }

  const onChange = () => render();
  store.addEventListener('change', onChange);
  root.destroy = () => store.removeEventListener('change', onChange);
  render();
  return root;
}
