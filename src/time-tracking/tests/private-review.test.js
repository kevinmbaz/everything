// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPuterMock } from './puter-mock.js';

let store, api, disposeStatus;
beforeEach(async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1'); vi.resetModules();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {} }));
  document.body.innerHTML = '<main id="app"></main>';
  api = createPuterMock();
  api.mode = 'private'; api.getUser = api.auth.getUser;
  api.transaction = vi.fn(async ops => {
    for (const op of ops) {
      if (op.kind === 'kv') await api.kv[op.method === 'DELETE' ? 'del' : 'set'](op.key, op.value);
      else await api.fs[op.method === 'DELETE' ? 'delete' : 'write'](op.path, op.value);
    }
    return { ok: true };
  });
  vi.doMock('../src/lib/storage.js', () => ({ storage: api, isPrivateStorage: true }));
  ({ store } = await import('../src/lib/store.js'));
  await store.init();
  await store.addClient({ name: 'Client', currency: 'USD' });
  api.transaction.mockClear();
  const { mountPrivateStatus } = await import('../src/ui/private-status.js');
  disposeStatus = mountPrivateStatus(store);
});
afterEach(() => {
  disposeStatus();
  for (const close of document.querySelectorAll('.modal-root:not(.closing) [aria-label="Close"]')) close.click();
  vi.doUnmock('../src/lib/storage.js');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
const dialog = title => document.querySelector(`.modal-root:not(.closing) [role="dialog"][aria-label="${title}"]`);
function control(root, label) {
  const node = [...root.querySelectorAll('label')].find(n => n.textContent === label);
  return document.getElementById(node.htmlFor);
}
function type(node, value) {
  node.value = value; node.dispatchEvent(new Event('input', { bubbles: true }));
}
function button(root, text) {
  return [...root.querySelectorAll('button')].find(b => b.textContent.includes(text));
}
function expectDirty(dirty) {
  expect(store.pendingWrites() > 0).toBe(dirty);
  expect(document.querySelector('[data-private-storage]').textContent).toContain(dirty ? 'Unsaved changes' : 'Saved to Jetson');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(dirty);
}
async function openInvoice() {
  const { openCreateInvoice } = await import('../src/ui/invoice.js');
  openCreateInvoice({ client: store.clients[0] });
  return dialog('Create invoice');
}
function addLine(parent, label = 'Manual fee', amount = '250') {
  button(parent, 'Add a fee').click();
  const child = dialog('Add a line');
  type(control(child, 'Description'), label);
  type(control(child, 'Unit amount (USD)'), amount);
  child.querySelector('form').requestSubmit();
}

async function openSettings() {
  const { settingsView } = await import('../src/views/settings.js');
  const view = settingsView();
  document.querySelector('#app').append(view);
  return view;
}

it('does not re-dirty an autosaved business name on blur/change or leave a token after navigation', async () => {
  const view = await openSettings();
  const name = control(view, 'Business name');
  type(name, 'Saved business');
  expectDirty(true);
  await vi.waitFor(() => expect(store.settings.businessName).toBe('Saved business'));
  expectDirty(false);
  name.dispatchEvent(new Event('change', { bubbles: true }));
  name.dispatchEvent(new Event('blur'));
  expectDirty(false);
  expect(api.transaction).toHaveBeenCalledTimes(1);
  view.destroy(); view.remove();
  expectDirty(false);
});

it('detaches draft listeners when leaving clean settings', async () => {
  const view = await openSettings();
  const name = control(view, 'Business name');
  view.destroy(); view.remove();
  name.value = 'An event on a discarded control';
  name.dispatchEvent(new Event('change', { bubbles: true }));
  expect(store.privateDrafts?.size || 0).toBe(0);
});

it('keeps invalid unsaved settings reachable after navigation instead of dropping their token or input', async () => {
  const view = await openSettings();
  type(control(view, 'Default hourly rate'), 'not a rate');
  await new Promise(r => setTimeout(r, 650));
  expect(api.transaction).not.toHaveBeenCalled();
  view.destroy(); view.remove();
  expectDirty(true);
  const reopened = await openSettings();
  expect(control(reopened, 'Default hourly rate').value).toBe('not a rate');
  expect(store.privateDrafts.size).toBe(1);
  type(control(reopened, 'Default hourly rate'), '125');
  await vi.waitFor(() => expect(store.pendingWrites()).toBe(0));
  expect(api.transaction).toHaveBeenCalledTimes(1);
  expectDirty(false);
  reopened.destroy(); reopened.remove();
});

it('finishes a pending debounce after navigation and releases the acknowledged detached view', async () => {
  const view = await openSettings();
  type(control(view, 'Business name'), 'Pending when leaving');
  view.destroy(); view.remove();
  expectDirty(true);
  await vi.waitFor(() => expect(store.pendingWrites()).toBe(0));
  expect((await api.kv.get('hourly:settings:v1')).businessName).toBe('Pending when leaving');
  await store.updateSettings({ businessName: 'Subsequent saved name' });
  const reopened = await openSettings();
  expect(control(reopened, 'Business name').value).toBe('Subsequent saved name');
  expect(reopened).not.toBe(view);
  expectDirty(false);
  reopened.destroy(); reopened.remove();
});

it.each([
  ['Business name', 'businessName'], ['Address', 'businessAddress'],
])('keeps newer %s input through an older acknowledgement and navigation', async (label, key) => {
  const view = await openSettings();
  let release;
  const commit = api.transaction.getMockImplementation();
  api.transaction.mockImplementationOnce(async ops => {
    await commit(ops);
    await new Promise(r => release = r);
    return { ok: true };
  });
  type(control(view, 'Business name'), 'First name');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  type(control(view, label), 'Newer draft');
  control(view, label).dispatchEvent(new Event('change', { bubbles: true }));
  view.destroy(); view.remove();
  release();
  // Only the draft token remains once the older command has acknowledged.
  await vi.waitFor(() => expect(store.pendingWrites()).toBe(1));
  expect(store.settings.businessName).toBe('First name');
  expectDirty(true);
  expect(store.privateDrafts.size).toBe(1);
  const reopened = await openSettings();
  expect(control(reopened, label).value).toBe('Newer draft');
  await vi.waitFor(() => expect(store.pendingWrites()).toBe(0));
  expect((await api.kv.get('hourly:settings:v1'))[key]).toBe('Newer draft');
  expect(api.transaction).toHaveBeenCalledTimes(2);
  control(reopened, label).dispatchEvent(new Event('change', { bubbles: true }));
  expectDirty(false);
  reopened.destroy(); reopened.remove();
});

it('retains rejected settings for copying on return without acknowledging or retrying them', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const view = await openSettings();
  api.transaction.mockRejectedValueOnce(new Error('denied'));
  type(control(view, 'Business name'), 'Rejected name');
  await vi.waitFor(() => expect(store.storageError?.message).toBe('denied'));
  view.destroy(); view.remove();
  expect(store.privateDrafts.size).toBe(1);
  expect(document.querySelector('[data-private-storage]').textContent).toContain('Not saved');
  const reopened = await openSettings();
  expect(control(reopened, 'Business name').value).toBe('Rejected name');
  expect(store.privateDrafts.size).toBe(1);
  expect((await api.kv.get('hourly:settings:v1'))?.businessName).not.toBe('Rejected name');
  expect(api.transaction).toHaveBeenCalledTimes(1);
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  reopened.destroy(); reopened.remove();
});

it('tracks manual line input and transfers its unsaved status to the invoice collection', async () => {
  const parent = await openInvoice();
  expectDirty(false);
  button(parent, 'Add a fee').click();
  const child = dialog('Add a line');
  type(control(child, 'Description'), 'Manual fee');
  type(control(child, 'Unit amount (USD)'), '250');
  expectDirty(true);
  child.querySelector('form').requestSubmit();
  expect(parent.textContent).toContain('Manual fee');
  expectDirty(true);
  parent.querySelector('[aria-label="Close"]').click();
  expectDirty(false);
});

it('keeps an unsubmitted line editor and its parent open when issuance acknowledges', async () => {
  let release;
  const create = vi.spyOn(store, 'createInvoice').mockImplementation(() => new Promise(r => release = r));
  const parent = await openInvoice();
  addLine(parent);
  parent.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  button(parent, 'Add a fee').click();
  const child = [...document.querySelectorAll('.modal-root:not(.closing) [aria-label="Add a line"]')].at(-1);
  type(control(child, 'Description'), 'Newer unsaved expense');
  type(control(child, 'Unit amount (USD)'), '99');
  release({ id: 'invoice', number: 1, entries: [], lines: [], business: {}, billTo: {}, currency: 'USD', issueDate: '2026-11-08', total: 250 });
  await vi.waitFor(() => expect(parent.textContent).toContain('copy newer'));
  expect(parent.closest('.modal-root').classList.contains('closing')).toBe(false);
  expect(child.closest('.modal-root').classList.contains('closing')).toBe(false);
  expect(control(child, 'Description').value).toBe('Newer unsaved expense');
  expectDirty(true);
  child.querySelector('form').requestSubmit();
  parent.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  expect(create).toHaveBeenCalledTimes(1);
  expect(parent.textContent).toContain('Newer unsaved expense');
  expectDirty(true);
});

it('closes a clean issued invoice and reads back exactly one saved manual fee', async () => {
  const parent = await openInvoice();
  addLine(parent);
  parent.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(parent.closest('.modal-root')?.classList.contains('closing') ?? !parent.isConnected).toBe(true));
  const invoices = await api.kv.get('hourly:invoices:v1');
  expect(invoices).toHaveLength(1);
  expect(invoices[0].lines).toEqual([expect.objectContaining({ label: 'Manual fee', unitAmount: 250 })]);
  expectDirty(false);
});

it.each(['add', 'edit', 'remove'])('retains a newer line %s across delayed issuance without issuing twice', async action => {
  const parent = await openInvoice();
  addLine(parent);
  let release;
  const commit = api.transaction.getMockImplementation();
  api.transaction.mockImplementationOnce(async ops => {
    await commit(ops);
    await new Promise(r => release = r);
    return { ok: true };
  });
  parent.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  if (action === 'add') addLine(parent, 'Newer fee', '99');
  else {
    parent.querySelector('[aria-label="Edit line: Manual fee"]').click();
    const child = dialog('Edit line');
    if (action === 'remove') button(child, 'Remove line').click();
    else {
      type(control(child, 'Description'), 'Newer fee');
      type(control(child, 'Unit amount (USD)'), '99');
      child.querySelector('form').requestSubmit();
    }
  }
  release();
  await vi.waitFor(() => expect(parent.textContent).toContain('copy newer'));
  expect(parent.closest('.modal-root').classList.contains('closing')).toBe(false);
  expect(parent.querySelectorAll('.entry-main')).toHaveLength(action === 'add' ? 2 : action === 'edit' ? 1 : 0);
  if (action !== 'remove') expect(parent.textContent).toContain('Newer fee');
  expectDirty(true);
  parent.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  expect(api.transaction).toHaveBeenCalledTimes(1);
  const invoices = await api.kv.get('hourly:invoices:v1');
  expect(invoices).toHaveLength(1);
  expect(invoices[0].lines).toEqual([expect.objectContaining({ label: 'Manual fee', unitAmount: 250 })]);
  expectDirty(true);
});
