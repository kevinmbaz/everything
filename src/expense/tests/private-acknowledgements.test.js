import { it, expect, vi, afterEach } from 'vitest';
import { store, DEFAULT_SETTINGS } from '../src/lib/store.js';
import { openExpenseForm } from '../src/ui/expenseform.js';
import { openReportForm, reportsView } from '../src/views/reports.js';
import { expensesView } from '../src/views/expenses.js';
import { openImport } from '../src/views/reconcile.js';
import { settingsView } from '../src/views/settings.js';
import { openOnboarding } from '../src/ui/onboarding.js';
import { mountPrivateStatus, hasPrivateDrafts } from '../src/ui/private-status.js';
import { closeAllModals } from '../src/ui/modal.js';

const originalSdk = store.getSdk;
let dispose;
let pendingGates = [];
const views = [];
afterEach(async () => {
  await vi.waitFor(() => {
    for (const gate of pendingGates) gate.resolve();
    store.error = null;
    expect(store.dirty).toBe(false);
  });
  pendingGates = [];
  dispose?.(); dispose = null;
  for (const view of views.splice(0)) view.destroy?.();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  closeAllModals(); vi.restoreAllMocks(); store.getSdk = originalSdk;
  document.body.replaceChildren();
});

// Real UI + real serialized store commands; only the remote I/O is gated.
async function setup() {
  const kv = new Map(), files = new Map(), gates = [];
  pendingGates = gates;
  const sdk = {
    mode: 'private', events: new EventTarget(),
    auth: { getUser: async () => ({ username: 'Test' }) },
    kv: { get: async key => kv.get(key) ?? null },
    fs: {
      read: async path => {
        if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        const value = files.get(path);
        return value instanceof Blob ? value : { text: async () => value };
      },
      write: vi.fn(async (path, value) => files.set(path, value)),
      delete: vi.fn(async path => files.delete(path)),
    },
    transaction: vi.fn(ops => new Promise((resolve, reject) => gates.push({
      ops, reject, resolve: () => {
        for (const op of ops) {
          const map = op.kind === 'kv' ? kv : files, key = op.key ?? op.path;
          if (op.method === 'DELETE') map.delete(key); else map.set(key, op.value);
        }
        resolve({ ok: true });
      },
    }))),
  };
  store.getSdk = () => sdk; store._months = new Map(); store._statements = null;
  store.settings = { ...DEFAULT_SETTINGS }; store.error = null;
  await store.init(); dispose = mountPrivateStatus();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { sdk, gates, files };
}
const edit = (control, value, type = 'input') => {
  control.value = value; control.dispatchEvent(new Event(type, { bubbles: true }));
};
const submit = form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const closing = modal => modal.panel.closest('.modal-root').classList.contains('closing');
const idle = () => vi.waitFor(() => expect(store.dirty).toBe(false));
const warning = () => {
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
};

const button = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent === label);

it.each(['success', 'failure'])('locks report batch selection until %s, retaining choices on rejection', async outcome => {
  const { sdk, gates } = await setup();
  store.months = ['2026-01'];
  store._months.set('2026-01', ['e1', 'e2'].map(id => ({ id, merchant: id, date: '2026-01-01', amount: 10, currency: 'USD' })));
  store.reports = [{ id: 'r1', title: 'Trip', status: 'draft', createdAt: 1 }];
  const view = reportsView({ navigate: vi.fn(), params: { id: 'r1' } }); views.push(view); document.body.append(view);
  await vi.waitFor(() => expect(button(view, 'Add expenses')).toBeTruthy());
  button(view, 'Add expenses').click();
  const panel = document.querySelector('[aria-label="Add expenses"]'), modal = { panel };
  panel.querySelector('[aria-label="Select e1"]').click(); button(panel, 'Add 1').click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  expect(panel.querySelector('[aria-label="Select e2"]').disabled).toBe(true);
  expect([...panel.querySelectorAll('.list-row')].every(control => control.disabled)).toBe(true);
  if (outcome === 'failure') {
    gates[0].reject(new Error('denied assignment'));
    await vi.waitFor(() => expect(panel.querySelector('[aria-label="Select e2"]').disabled).toBe(false));
    expect(panel.querySelector('[aria-label="Select e1"]').checked).toBe(true);
    expect(closing(modal)).toBe(false);
  } else {
    gates[0].resolve(); await idle(); expect(closing(modal)).toBe(true);
    expect(store.getExpense('e1').reportId).toBe('r1'); expect(store.getExpense('e2').reportId).toBeUndefined();
  }
});

it.each(['success', 'failure'])('locks statement import controls during a pending batch, then handles %s', async outcome => {
  const { sdk, gates } = await setup();
  const modal = openImport();
  edit(modal.panel.querySelector('textarea'), 'Date,Description,Amount\n2026-01-01,Merchant,10');
  button(modal.panel, 'Use pasted text').click();
  const source = modal.panel.querySelector('input[type="text"]'); edit(source, 'My card');
  button(modal.panel, 'Import 1 line').click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  expect(source.disabled).toBe(true);
  expect(button(modal.panel, 'Back').disabled).toBe(true);
  expect([...modal.panel.querySelectorAll('select')].every(control => control.disabled)).toBe(true);
  if (outcome === 'failure') {
    gates[0].reject(new Error('denied import'));
    await vi.waitFor(() => expect(source.disabled).toBe(false));
    expect(source.value).toBe('My card'); expect(closing(modal)).toBe(false); warning();
  } else {
    gates[0].resolve(); await idle(); expect(closing(modal)).toBe(true);
    expect(await store.loadStatements()).toHaveLength(1);
    expect((await store.loadStatements())[0].source).toBe('My card');
  }
});

it('keeps the newer bulk-create report title and reuses its acknowledged ID', async () => {
  const { sdk, gates } = await setup();
  store.months = ['2026-01'];
  store._months.set('2026-01', [{ id: 'e1', merchant: 'Merchant', date: '2026-01-01', amount: 10, currency: 'USD' }]);
  const view = expensesView({ navigate: vi.fn() }); views.push(view); document.body.append(view);
  await vi.waitFor(() => expect(view.querySelector('[aria-busy="false"]')).not.toBeNull());
  button(view, 'Select').click(); button(view, 'Select all').click(); button(view, 'Add to report').click();
  const title = document.querySelector('[aria-label="New report title"]');
  const modal = { panel: title.closest('.modal-panel') };
  edit(title, 'submitted bulk title'); button(modal.panel, 'Create').click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  edit(title, 'newer bulk title'); gates[0].resolve();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(closing(modal)).toBe(false); warning();
  const id = store.reports[0].id;
  button(modal.panel, 'Create').click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(3)); gates[2].resolve();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(4)); gates[3].resolve(); await idle();
  expect(store.reports).toHaveLength(1); expect(store.reports[0]).toMatchObject({ id, title: 'newer bulk title' });
  expect(store.allExpenses()[0].reportId).toBe(id); expect(closing(modal)).toBe(true);
});

it.each(['private', 'puter'])('names the actual %s storage in delete-all confirmation', async mode => {
  const { sdk } = await setup(); sdk.mode = mode;
  const view = settingsView(); views.push(view); document.body.append(view);
  [...view.querySelectorAll('button')].find(node => node.textContent.includes('Delete all data')).click();
  const message = document.querySelector('[aria-label="Delete everything?"] .modal-text').textContent;
  expect(message).toBe(mode === 'private'
    ? 'All expenses, receipts, reports and statements in this app are permanently deleted from your private Jetson storage.'
    : 'All expenses, receipts, reports and statements in this app are permanently deleted from your Puter account.');
});

it('does not let sample-data acknowledgement discard a newer onboarding currency', async () => {
  const { sdk, gates } = await setup();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  openOnboarding(); button(document, 'Explore with sample data').click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  button(document, 'Set up my expenses').click();
  const select = document.querySelector('[aria-label="Base currency"]'), modal = { panel: select.closest('.modal-panel') };
  edit(select, 'GBP', 'change'); gates[0].resolve(); await idle();
  expect(closing(modal)).toBe(false); expect(select.value).toBe('GBP'); warning();
  button(modal.panel, 'I’ll add expenses later').click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(store.settings.baseCurrency).toBe('GBP'); expect(closing(modal)).toBe(true);
});

it.each(['Capture my first receipt', 'I’ll add expenses later'])('keeps newer onboarding currency after %s acknowledges', async label => {
  const { sdk, gates } = await setup();
  const onCapture = vi.fn(); openOnboarding({ onCapture });
  button(document, 'Set up my expenses').click();
  const select = document.querySelector('[aria-label="Base currency"]');
  const modal = { panel: select.closest('.modal-panel') };
  edit(select, 'EUR', 'change'); button(modal.panel, label).click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  edit(select, 'GBP', 'change'); gates[0].resolve(); await idle();
  expect(closing(modal)).toBe(false); expect(select.value).toBe('GBP');
  expect(hasPrivateDrafts()).toBe(true); warning(); expect(onCapture).not.toHaveBeenCalled();
  button(modal.panel, label).click();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(store.settings.baseCurrency).toBe('GBP'); expect(closing(modal)).toBe(true);
  expect(hasPrivateDrafts()).toBe(false);
});

it.each(['name', 'icon', 'color'])('keeps a newer category %s draft and updates rather than duplicates', async changed => {
  const { sdk, gates } = await setup();
  const view = settingsView(); views.push(view); document.body.append(view);
  [...view.querySelectorAll('button')].find(node => node.textContent.includes('Categories')).click();
  button(document, 'New category').click();
  const panel = document.querySelector('[aria-label="New category"]');
  const modal = { panel }, form = panel.querySelector('form'), name = form.querySelector('input');
  const initialCount = store.categories.length;
  edit(name, 'Submitted category'); submit(form);
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  if (changed === 'name') edit(name, 'Newer category');
  else {
    const picker = panel.querySelector(changed === 'icon' ? '.icon-grid' : '.swatches');
    picker.querySelector('button:not([aria-checked])').click();
  }
  const icon = changed === 'icon' ? panel.querySelector('.icon-grid [aria-checked]').getAttribute('aria-label') : 'tag';
  const slot = changed === 'color' ? Number(panel.querySelector('.swatches [aria-checked]').getAttribute('aria-label').split(' ')[1]) : ((initialCount % 8) + 1);
  gates[0].resolve(); await idle();
  expect(closing(modal)).toBe(false); expect(hasPrivateDrafts()).toBe(true); warning();
  const id = store.categories.at(-1).id;
  submit(form); await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(store.categories).toHaveLength(initialCount + 1);
  expect(store.category(id)).toMatchObject({ name: name.value, icon, slot });
  expect(closing(modal)).toBe(true); expect(hasPrivateDrafts()).toBe(false);
});

it.each(['success', 'failure'])('preserves a newer currency control after the older acknowledgement and newer %s', async outcome => {
  const { sdk, gates } = await setup();
  const view = settingsView(); views.push(view); document.body.append(view);
  const select = view.querySelector('[aria-label="Base currency"]');
  edit(select, 'EUR', 'change');
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  edit(select, 'GBP', 'change'); gates[0].resolve();
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  expect(select.closest('.settings-row').dataset.privateDirty).toBe('1');
  store.emit('expenses');
  expect(view.querySelector('[aria-label="Base currency"]')).toBe(select);
  expect(select.value).toBe('GBP'); warning();
  if (outcome === 'failure') {
    gates[1].reject(new Error('denied GBP'));
    await vi.waitFor(() => expect(store.error).toBeTruthy());
    store.emit('expenses');
    expect(view.querySelector('[aria-label="Base currency"]')).toBe(select);
    expect(select.value).toBe('GBP'); expect(hasPrivateDrafts()).toBe(true);
    expect(store.settings.baseCurrency).toBe('EUR'); warning();
  } else {
    gates[1].resolve(); await idle();
    expect(store.settings.baseCurrency).toBe('GBP'); expect(hasPrivateDrafts()).toBe(false);
    store.emit('expenses'); expect(view.querySelector('[aria-label="Base currency"]').value).toBe('GBP');
  }
});

it('keeps a newer report title until a second save updates the same report', async () => {
  const { sdk, gates } = await setup();
  const onSaved = vi.fn(), modal = openReportForm({ onSaved });
  const form = modal.panel.querySelector('form'), title = form.querySelector('input');
  edit(title, 'submitted title'); submit(form);
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  edit(title, 'newer title'); gates[0].resolve(); await idle();
  expect(closing(modal)).toBe(false); expect(hasPrivateDrafts()).toBe(true); warning();
  expect(onSaved).not.toHaveBeenCalled();
  expect(store.reports).toHaveLength(1);
  const id = store.reports[0].id;
  expect(store.reports[0].title).toBe('submitted title');
  expect(form.querySelector('[type="submit"]').disabled).toBe(false);
  submit(form); await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(store.reports).toHaveLength(1); expect(store.reports[0]).toMatchObject({ id, title: 'newer title' });
  expect(closing(modal)).toBe(true); expect(hasPrivateDrafts()).toBe(false); expect(onSaved).toHaveBeenCalledTimes(1);
});

it.each(['keep', 'remove'])('retains the acknowledged receipt without re-uploading while newer edits %s it', async action => {
  const { sdk, gates } = await setup();
  const file = new File(['receipt'], 'receipt.pdf', { type: 'application/pdf' });
  const modal = openExpenseForm({ prefill: { merchant: 'Merchant', amount: 10, date: '2026-01-01' }, receiptFile: file });
  const form = modal.panel.querySelector('form'); submit(form);
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  edit(form.querySelector('textarea'), 'new notes');
  if (action === 'remove') form.querySelector('[aria-label="Remove receipt"]').click();
  gates[0].resolve(); await idle();
  const id = store.allExpenses()[0].id, path = store.allExpenses()[0].receiptPath;
  expect(closing(modal)).toBe(false); warning();
  if (action === 'keep') expect(form.textContent).toContain('Stored on Jetson');
  submit(form); submit(form); // Enter/repeated submit must not duplicate the pending command.
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(sdk.transaction).toHaveBeenCalledTimes(2); expect(sdk.fs.write).toHaveBeenCalledTimes(1);
  expect(store.allExpenses()).toHaveLength(1);
  expect(store.allExpenses()[0]).toMatchObject({ id, notes: 'new notes', receiptPath: action === 'keep' ? path : null });
  expect(closing(modal)).toBe(true); expect(hasPrivateDrafts()).toBe(false);
});

it('keeps newer expense notes and receipt selection, then updates the acknowledged record', async () => {
  const { sdk, gates } = await setup();
  const onSaved = vi.fn();
  const first = new File(['first'], 'first.pdf', { type: 'application/pdf' });
  const second = new File(['second'], 'second.pdf', { type: 'application/pdf' });
  const modal = openExpenseForm({ prefill: { merchant: 'Merchant', amount: 10, date: '2026-01-01', notes: 'submitted' }, receiptFile: first, onSaved });
  const form = modal.panel.querySelector('form'), notes = form.querySelector('textarea');
  submit(form);
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(1));
  edit(notes, 'newer notes');
  const file = form.querySelector('input[type="file"]');
  Object.defineProperty(file, 'files', { value: [second], configurable: true });
  file.dispatchEvent(new Event('change', { bubbles: true }));
  gates[0].resolve(); await idle();
  expect(closing(modal)).toBe(false);
  expect(notes.value).toBe('newer notes'); expect(form.textContent).toContain('second.pdf');
  expect(hasPrivateDrafts()).toBe(true); warning(); expect(onSaved).not.toHaveBeenCalled();
  expect(store.allExpenses()).toHaveLength(1);
  const id = store.allExpenses()[0].id;
  expect(store.allExpenses()[0]).toMatchObject({ notes: 'submitted', receiptName: 'first.pdf' });
  expect(form.querySelector('[type="submit"]').disabled).toBe(false);
  submit(form);
  await vi.waitFor(() => expect(sdk.transaction).toHaveBeenCalledTimes(2));
  gates[1].resolve(); await idle();
  expect(store.allExpenses()).toHaveLength(1);
  expect(store.allExpenses()[0]).toMatchObject({ id, notes: 'newer notes', receiptName: 'second.pdf' });
  expect(sdk.fs.write).toHaveBeenCalledTimes(2);
  expect(sdk.fs.write.mock.calls[0][1]).toBe(first);
  expect(sdk.fs.write.mock.calls[1][1]).toBe(second);
  expect(closing(modal)).toBe(true); expect(hasPrivateDrafts()).toBe(false);
  expect(onSaved).toHaveBeenCalledTimes(1);
});
