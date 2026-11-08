// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let store, openEntryForm;
beforeEach(async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1'); vi.resetModules();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {} }));
  document.body.innerHTML = '<main id="app"></main>';
  ({ store } = await import('../src/lib/store.js'));
  ({ openEntryForm } = await import('../src/ui/entryform.js'));
  store.clients = [{ id: 'c', name: 'Client' }];
  store.projects = [{ id: 'p', clientId: 'c', name: 'Project', billable: true }];
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function control(label) {
  const node = [...document.querySelectorAll('label')].find(n => n.textContent === label);
  return document.getElementById(node.htmlFor);
}
it('keeps newer form text after an acknowledged save and updates that entry instead of adding a duplicate', async () => {
  let release;
  const add = vi.spyOn(store, 'addEntry').mockImplementation(data => new Promise(r => { release = () => r({ ...data, id: 'saved' }); }));
  const update = vi.spyOn(store, 'updateEntry').mockResolvedValue({ id: 'saved' });
  openEntryForm();
  control('Project').value = 'p'; control('Duration').value = '1';
  control('Task').value = 'original'; control('Task').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  control('Task').value = 'newer'; control('Task').dispatchEvent(new Event('input', { bubbles: true }));
  release();
  await vi.waitFor(() => expect(document.querySelector('button[type=submit]').disabled).toBe(false));
  expect(document.querySelector('.modal-root').classList.contains('closing')).toBe(false);
  expect(control('Task').value).toBe('newer');
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith('saved', expect.any(String), expect.objectContaining({ task: 'newer' })));
  expect(add).toHaveBeenCalledTimes(1);
});
it.each(['Client', 'Project'])('retains %s drafts edited during an awaited save without creating a second record', async kind => {
  const forms = await import('../src/ui/projectforms.js');
  let release;
  const add = vi.spyOn(store, `add${kind}`).mockImplementation(data => new Promise(r => { release = () => r({ ...data, id: 'saved-record' }); }));
  const update = vi.spyOn(store, `update${kind}`).mockResolvedValue();
  forms[`open${kind}Form`]();
  control('Name').value = 'first'; control('Name').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  control('Name').value = 'newer'; control('Name').dispatchEvent(new Event('input', { bubbles: true }));
  release();
  await vi.waitFor(() => expect(document.querySelector('button[type=submit]')?.disabled).toBe(false));
  expect(control('Name').value).toBe('newer');
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith('saved-record', expect.objectContaining({ name: 'newer' })));
  expect(add).toHaveBeenCalledTimes(1);
});

it('retains timer edits typed during the save', async () => {
  store.timer = { id: 't', projectId: 'p', startedAt: Date.now() - 60000, task: 'old', billable: true };
  const { openTimerEdit } = await import('../src/ui/timeredit.js');
  let release; vi.spyOn(store, 'retagTimer').mockImplementation(() => new Promise(r => release = r));
  openTimerEdit(); document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  control('Task').value = 'newer'; control('Task').dispatchEvent(new Event('input', { bubbles: true }));
  release();
  await vi.waitFor(() => expect(document.querySelector('button[type=submit]')?.disabled).toBe(false));
  expect(control('Task').value).toBe('newer');
});

it('private onboarding retains setup on failed acknowledgement and names Jetson', async () => {
  const { openOnboarding } = await import('../src/ui/onboarding.js');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(store, 'updateSettings').mockRejectedValue(new Error('denied'));
  openOnboarding();
  expect(document.body.textContent).toContain('Jetson');
  [...document.querySelectorAll('button')].find(b => b.textContent === 'Set up tracking').click();
  control('Default hourly rate').value = '125';
  const start = [...document.querySelectorAll('button')].find(b => b.textContent === 'Start tracking');
  start.click();
  await vi.waitFor(() => expect(start.disabled).toBe(false));
  expect(document.querySelector('.modal-root').classList.contains('closing')).toBe(false);
  expect(control('Default hourly rate').value).toBe('125');
  error.mockRestore();
});

it('keeps invoice draft text typed during issuance and prevents a second invoice submission', async () => {
  const { openCreateInvoice } = await import('../src/ui/invoice.js');
  let release; const create = vi.spyOn(store, 'createInvoice').mockImplementation(() => new Promise(r => release = r));
  openCreateInvoice({ client: store.clients[0], entries: [{ id: 'e', date: '2026-10-01', projectId: 'p', seconds: 60, billable: true }] });
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  control('Notes').value = 'newer invoice draft'; control('Notes').dispatchEvent(new Event('input', { bubbles: true }));
  release({ id: 'invoice', number: 1 });
  await vi.waitFor(() => expect(document.body.textContent).toContain('copy newer'));
  expect(control('Notes').value).toBe('newer invoice draft');
  expect(document.querySelector('.modal-root').classList.contains('closing')).toBe(false);
  document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  expect(create).toHaveBeenCalledTimes(1);
});

it('preserves the next timer draft typed while Start is awaiting acknowledgement', async () => {
  const { timerView } = await import('../src/views/timer.js');
  let release;
  vi.spyOn(store, 'startTimer').mockImplementation(data => new Promise(r => { release = () => { store.timer = { ...data, startedAt: Date.now() }; store.dispatchEvent(new Event('change')); r(); }; }));
  const view = timerView(); document.querySelector('#app').append(view);
  control('Project').value = 'p'; control('Task').value = 'first';
  control('Task').dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  control('Task').value = 'next task'; control('Task').dispatchEvent(new Event('input', { bubbles: true }));
  release(); await new Promise(r => setTimeout(r, 0));
  store.timer = null; store.dispatchEvent(new Event('change'));
  expect(control('Task').value).toBe('next task');
  view.destroy();
});

it('private settings name Jetson, omit cloud sign-out and mark text dirty before debounce', async () => {
  const saved = vi.spyOn(store, 'updateSettings').mockResolvedValue();
  const { settingsView } = await import('../src/views/settings.js');
  const view = settingsView(); document.querySelector('#app').append(view);
  expect(view.textContent).toContain('Jetson');
  expect(view.textContent).not.toContain('Synced with your Puter cloud');
  expect([...view.querySelectorAll('button')].some(b => b.textContent === 'Sign out')).toBe(false);
  const name = control('Business name');
  name.value = 'unsaved business'; name.dispatchEvent(new Event('input', { bubbles: true }));
  expect(store.pendingWrites()).toBeGreaterThan(0);
  await vi.waitFor(() => expect(saved).toHaveBeenCalledWith({ businessName: 'unsaved business' }));
  expect(store.pendingWrites()).toBe(0);
  view.destroy();
});

it('acknowledges only the saved settings fields, never another pending debounce or intervening edit', async () => {
  const { trackPrivateDraft } = await import('../src/ui/private-status.js');
  const root = document.createElement('div'); root.innerHTML = '<input data-storage-key="name"><input data-storage-key="address">';
  const [name, address] = root.children;
  const tracker = trackPrivateDraft(root, store);
  name.value = 'first name'; address.value = 'first address';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  address.dispatchEvent(new Event('input', { bubbles: true }));
  expect(tracker.acknowledge(tracker.capture(['name']))).toBe(false);
  expect(store.pendingWrites()).toBeGreaterThan(0);
  const before = tracker.capture(['address']);
  address.value = 'newer address';
  address.dispatchEvent(new Event('input', { bubbles: true }));
  expect(tracker.acknowledge(before)).toBe(false);
  expect(tracker.acknowledge(tracker.capture(['address']))).toBe(true);
  expect(store.pendingWrites()).toBe(0);
});

it('shows a persistent Jetson error and warns before leaving unsaved work', async () => {
  const path = '../src/ui/private-status.js';
  const { mountPrivateStatus } = await import(/* @vite-ignore */ path);
  const dispose = mountPrivateStatus(store);
  expect(document.body.textContent).toContain('Jetson');
  store.storageError = new Error('denied'); store.dispatchEvent(new Event('storage-state'));
  expect(document.body.textContent).toContain('Not saved');
  expect(document.body.textContent).not.toContain('Saved to Jetson');
  const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  dispose();
});
