import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMockPuter } from './helpers/mock-puter.js';

const f = vi.hoisted(() => ({ store: null, nodes: [], modal: null }));
vi.mock('../src/lib/store.js', async importOriginal => ({
  ...await importOriginal(), get store() { return f.store; },
}));
// Node-only UI harness: exercise the real quick-add, parser, form and tracker.
vi.mock('../src/lib/dom.js', () => ({
  el: (tag, attrs = {}, ...children) => {
    const n = Object.assign(new EventTarget(), {
      tag, value: '', children: [], ...attrs,
      append(...xs) { this.children.push(...xs.flat(Infinity).filter(Boolean)); },
      setAttribute(k, v) { this[k] = v; }, removeAttribute(k) { delete this[k]; },
      focus() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    });
    n.append(...children); f.nodes.push(n); return n;
  }, clear: n => { n.children = []; },
}));
vi.mock('../src/ui/icons.js', () => ({ icon: () => '' }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
vi.mock('../src/ui/modal.js', () => ({
  openModal: options => (f.modal = { ...options, close: vi.fn(() => options.onClose?.()) }),
  confirmDialog: vi.fn(),
}));

let storage, windowEvents, documentEvents;
beforeEach(async () => {
  installMockPuter();
  f.nodes = []; f.modal = null;
  storage = {
    mode: 'private', events: new EventTarget(),
    getUser: async () => ({ username: 'Test owner', uuid: 'test-owner' }),
    kv: { get: async key => ({
      'tasks:settings:v1': { onboarded: true },
      'tasks:lists:v1': { lists: [{ id: 'l', name: 'Personal' }] },
      'tasks:items:v1': { tasks: [], logMonths: [] },
    })[key] },
    transaction: vi.fn(async () => ({ ok: true })),
  };
  const { Store } = await import('../src/lib/store.js');
  f.store = new Store({ storage }); await f.store.init();
  windowEvents = new EventTarget();
  documentEvents = Object.assign(new EventTarget(), {
    body: { append() {} },
    getElementById: id => f.nodes.find(n => n.id === id),
  });
  // Execute the actual status/unload implementation, without boot/network/timers.
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const setup = main.slice(main.indexOf('function setupOfflineBanner()'), main.indexOf('// Dev-only handle'));
  const { el } = await import('../src/lib/dom.js');
  new Function('isPrivateStorage', 'el', 'document', 'window', 'navigator', 'store',
    `${setup}\nsetupOfflineBanner();`)(true, el, documentEvents, windowEvents, { onLine: true }, f.store);
});
afterEach(() => { vi.restoreAllMocks(); });

const field = label => f.nodes.find(n => n['aria-label'] === label);
const button = label => f.nodes.find(n => n.tag.startsWith('button') && n.children.includes(label));
const banner = () => f.nodes.find(n => n.tag === 'div.offline-banner').textContent;
function warnsOnUnload() {
  const event = new Event('beforeunload', { cancelable: true });
  windowEvents.dispatchEvent(event);
  return event.defaultPrevented;
}
async function transfer(text = 'Keep this unsaved task') {
  const { quickAddBar } = await import('../src/ui/quickadd.js');
  quickAddBar();
  const input = field('Add a task');
  input.value = text; input.oninput();
  documentEvents.dispatchEvent(new Event('input'));
  field('More options').onclick();
  expect(input.value).toBe('');
  expect(storage.transaction).not.toHaveBeenCalled();
}

it('opens an empty quick-add form clean while preserving view defaults', async () => {
  const { quickAddBar } = await import('../src/ui/quickadd.js');
  quickAddBar({ listId: 'l', defaultDue: '2026-11-09' });
  field('More options').onclick();
  expect(field('Task title').value).toBe('');
  expect(field('Due date').value).toBe('2026-11-09');
  expect(f.store.pendingWrites()).toBe(0);
  expect(warnsOnUnload()).toBe(false);
  expect(storage.transaction).not.toHaveBeenCalled();
});

it('explicit Cancel discards the transferred draft and clears status/unload protection', async () => {
  await transfer();
  expect(warnsOnUnload()).toBe(true);
  button('Cancel').onclick();
  expect(f.modal.close).toHaveBeenCalledOnce();
  expect(f.store.pendingWrites()).toBe(0);
  expect(banner()).toContain('Saved to Jetson');
  expect(warnsOnUnload()).toBe(false);
  expect(storage.transaction).not.toHaveBeenCalled();
  // Detached form events cannot resurrect a discarded token.
  f.modal.content.dispatchEvent(new Event('click'));
  expect(f.store.pendingWrites()).toBe(0);
});

it('a rejected save keeps transferred text, status and unload protection', async () => {
  await transfer();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  storage.transaction.mockRejectedValueOnce(new Error('Denied'));
  await button('Add task').onclick();
  expect(f.modal.close).not.toHaveBeenCalled();
  expect(field('Task title').value).toBe('Keep this unsaved task');
  expect(f.store.pendingWrites()).toBeGreaterThan(0);
  expect(banner()).toContain('Save not confirmed');
  expect(warnsOnUnload()).toBe(true);
});

it('acknowledges only the submitted transfer when the user edits during save', async () => {
  await transfer();
  let resolve;
  storage.transaction.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const saving = button('Add task').onclick();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  const title = field('Task title');
  title.value = 'Later unsaved edit'; title.oninput({ target: title });
  f.modal.content.dispatchEvent(new Event('input'));
  resolve({ ok: true }); await saving;
  expect(f.modal.close).not.toHaveBeenCalled();
  expect(f.store.pendingWrites()).toBe(1);
  expect(banner()).toContain('Unsaved changes');
  expect(warnsOnUnload()).toBe(true);
  // The acknowledged content is now the clean baseline, not permanently dirty.
  title.value = 'Keep this unsaved task'; title.oninput({ target: title });
  f.modal.content.dispatchEvent(new Event('input'));
  expect(f.store.pendingWrites()).toBe(0);
  expect(warnsOnUnload()).toBe(false);
});

it.each([
  ['existing saved task', { task: { id: 'saved', title: 'Saved task', listId: 'l' } }],
  ['new form with view defaults', { listId: 'l', due: '2026-11-09' }],
])('initializes %s clean and still tracks later edits', async (_label, options) => {
  const { openTaskForm } = await import('../src/ui/taskform.js');
  openTaskForm(options);
  expect(f.store.pendingWrites()).toBe(0);
  expect(warnsOnUnload()).toBe(false);
  const title = field('Task title');
  title.value = 'Unsaved edit'; title.oninput({ target: title });
  f.modal.content.dispatchEvent(new Event('input'));
  expect(f.store.pendingWrites()).toBe(1);
  expect(warnsOnUnload()).toBe(true);
  button('Cancel').onclick();
  expect(f.store.pendingWrites()).toBe(0);
});

it('does not install private draft tracking in default Puter mode', async () => {
  const { Store } = await import('../src/lib/store.js');
  f.store = new Store();
  expect(f.store.isPrivate).toBe(false);
  const dirty = vi.spyOn(f.store, 'setDraftDirty');
  await transfer();
  expect(field('Task title').value).toBe('Keep this unsaved task');
  f.modal.content.dispatchEvent(new Event('click'));
  expect(dirty).not.toHaveBeenCalled();
  expect(f.store.pendingWrites()).toBe(0);
  button('Cancel').onclick();
  expect(f.store.pendingWrites()).toBe(0);
});

it('protects a metadata-only transfer even without a parsed title', async () => {
  await transfer('!high #home');
  expect(field('Task title').value).toBe('');
  expect(f.store.pendingWrites()).toBe(1);
  expect(warnsOnUnload()).toBe(true);
  await button('Add task').onclick();
  expect(storage.transaction).not.toHaveBeenCalled();
  expect(f.modal.close).not.toHaveBeenCalled();
  expect(warnsOnUnload()).toBe(true);
  button('Cancel').onclick();
  expect(warnsOnUnload()).toBe(false);
});

it('keeps transferred quick-add content unsaved until save acknowledgement', async () => {
  await transfer();
  expect(field('Task title').value).toBe('Keep this unsaved task');
  expect(f.store.pendingWrites()).toBe(1);
  expect(banner()).toContain('Unsaved changes');
  expect(warnsOnUnload()).toBe(true);
  // A click/no-op edit must not promote the initial prefill to a saved baseline.
  f.modal.content.dispatchEvent(new Event('click'));
  expect(f.store.pendingWrites()).toBe(1);
  let resolve;
  storage.transaction.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const saving = button('Add task').onclick();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(warnsOnUnload()).toBe(true);
  expect(f.modal.close).not.toHaveBeenCalled();
  resolve({ ok: true }); await saving;
  expect(storage.transaction).toHaveBeenCalledOnce();
  expect(f.modal.close).toHaveBeenCalledOnce();
  expect(f.store.pendingWrites()).toBe(0);
  expect(banner()).toContain('Saved to Jetson');
  expect(warnsOnUnload()).toBe(false);
});
