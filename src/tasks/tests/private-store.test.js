import { beforeAll, expect, it, vi } from 'vitest';
import { installMockPuter } from './helpers/mock-puter.js';
let Store;
beforeAll(async () => { installMockPuter(); ({ Store } = await import('../src/lib/store.js')); });
function backend() {
  const docs = new Map([
    ['tasks:settings:v1', { onboarded: true }],
    ['tasks:lists:v1', { lists: [{ id: 'personal', name: 'Personal' }] }],
    ['tasks:items:v1', { tasks: [], logMonths: [] }],
  ]);
  const files = new Map();
  return {
    mode: 'private', docs, files,
    getUser: vi.fn(async () => ({ username: 'Jetson storage', uuid: 'jetson-owner' })),
    kv: { get: vi.fn(async k => structuredClone(docs.get(k) ?? null)), set: vi.fn() },
    fs: { read: vi.fn(async p => { if (!files.has(p)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return new Blob([files.get(p)]); }) },
    transaction: vi.fn(async ops => { for (const o of ops) { const map = o.kind === 'kv' ? docs : files; const key = o.key ?? o.path; o.method === 'DELETE' ? map.delete(key) : map.set(key, structuredClone(o.value)); } return { ok: true }; }),
  };
}
async function setup() { const storage = backend(); const s = new Store({ storage }); await s.init(); return { s, storage }; }
it('authenticates the injected private session without reading a browser mirror', async () => {
  const storage = backend();
  const get = vi.spyOn(localStorage, 'getItem'); const set = vi.spyOn(localStorage, 'setItem');
  const s = new Store({ storage }); await s.init();
  expect(s.isPrivate).toBe(true);
  expect(storage.getUser).toHaveBeenCalledOnce();
  expect(s.user.uuid).toBe('jetson-owner');
  expect(get.mock.calls.filter(([k]) => /mirror|account|device/.test(k))).toEqual([]);
  expect(set.mock.calls.filter(([k]) => /mirror|account|device/.test(k))).toEqual([]);
  get.mockRestore(); set.mockRestore();
});
it('atomically saves list deletion and propagates failure without mirror or replay', async () => {
  const { s, storage } = await setup();
  await s.addTask({ title: 'Keep draft', listId: 'personal' });
  await s.updateSettings({ defaultListId: 'personal' });
  storage.transaction.mockClear();
  storage.transaction.mockRejectedValueOnce(new Error('Denied'));
  await expect(s.deleteList('personal')).rejects.toThrow('Denied');
  expect(storage.transaction).toHaveBeenCalledOnce();
  expect(storage.transaction.mock.calls[0][0].map(o => o.key).sort()).toEqual(Object.keys({ 'tasks:items:v1': 1, 'tasks:lists:v1': 1, 'tasks:settings:v1': 1 }).sort());
  expect(storage.docs.get('tasks:lists:v1').lists).toHaveLength(1);
  expect(s.pendingWrites()).toBe(3);
  await s.flushPending(); await s.refreshFromCloud({ force: true });
  expect(storage.transaction).toHaveBeenCalledOnce();
  expect(storage.kv.get).toHaveBeenCalledTimes(3);
  expect(storage.kv.set).not.toHaveBeenCalled();
});
it('archives a month and its hot items atomically, rejecting denied writes without losing tasks', async () => {
  const { s, storage } = await setup();
  s.tasks = [{ id: 'old', listId: 'personal', title: 'History', done: true, completedAt: new Date('2025-01-10T12:00:00Z').getTime(), updatedAt: 1 }];
  storage.transaction.mockRejectedValueOnce(new Error('Denied archive'));
  await expect(s.archiveOldCompleted()).rejects.toThrow('Denied archive');
  expect(s.taskById('old').title).toBe('History');
  expect(s.logMonths).toEqual([]);
  expect(s.pendingWrites()).toBeGreaterThan(0);
  const ops = storage.transaction.mock.calls[0][0];
  expect(ops.map(o => o.kind).sort()).toEqual(['file', 'kv']);
  expect(ops.find(o => o.kind === 'file').path).toBe('tasks-data/log-2025-01.json');
  expect(ops.find(o => o.kind === 'kv').value.data.tasks).toEqual([]);
  expect(storage.files.size).toBe(0);
});
it('imports same-owner data as personal-only and exposes archive export limitations', async () => {
  const { s, storage } = await setup();
  await s.importAll({ kind: 'tasks.export', account: s.user.username,
    settings: { calFeed: { url: 'https://example.test/feed' } },
    lists: [{ id: 'x', shared: { url: 'https://example.test/share' }, collab: { memberId: s.user.username, manifestUrl: 'https://example.test/manifest' }, pastCollab: { ownerId: 'old' } }],
    items: { tasks: [{ id: 't', listId: 'x', title: 'Imported' }], logMonths: [] } });
  expect(s.lists[0]).toMatchObject({ shared: null, collab: null, pastCollab: null });
  expect(s.settings.calFeed).toBeNull();
  expect(storage.transaction.mock.calls.at(-1)[0]).toHaveLength(3);
  expect(s.exportAll().archiveNotice).toMatch(/not included/i);
});
it.each(['enableShare', 'disableShare', 'enableCollab', 'inviteMember', 'disableCollab', 'joinCollab', 'confirmLinkFor', 'leaveCollab', 'collabMembers', 'approveMember', 'removeMember', 'enableCalendarFeed', 'disableCalendarFeed'])('rejects %s before any public request', async method => {
  const { s, storage } = await setup();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  await expect(s[method]('personal')).rejects.toThrow(/unavailable in private mode/);
  expect(fetcher).not.toHaveBeenCalled();
  expect(storage.transaction).not.toHaveBeenCalled();
  fetcher.mockRestore();
});
it('never falls back to link collaboration or polls after private boot', async () => {
  const { s, storage } = await setup();
  expect(s.collabMode()).toBe('unavailable');
  await s.syncShares(); await s.syncCollab(); await s.discoverShares(); await s.startCollabWatch();
  expect(storage.kv.get).toHaveBeenCalledTimes(3);
  expect(storage.transaction).not.toHaveBeenCalled();
});
it.each(['import', 'wipe'])('%s removes archive bytes and three KV documents in one transaction', async action => {
  const { s, storage } = await setup();
  s.logMonths = ['2025-01']; storage.files.set('tasks-data/log-2025-01.json', '[]');
  if (action === 'wipe') await s.wipeAll();
  else await s.importAll({ kind: 'tasks.export', lists: [], items: { tasks: [], logMonths: [] } });
  const ops = storage.transaction.mock.calls.at(-1)[0];
  expect(ops).toHaveLength(4);
  expect(ops).toContainEqual({ kind: 'file', path: 'tasks-data/log-2025-01.json', method: 'DELETE' });
  expect(storage.files.size).toBe(0);
});
it('rejects archive references without bytes before replacing any personal data', async () => {
  const { s, storage } = await setup();
  await expect(s.importAll({ kind: 'tasks.export', lists: [], items: { tasks: [], logMonths: ['2025-01'] } })).rejects.toThrow(/archive bytes/i);
  expect(s.lists).toHaveLength(1);
  expect(storage.transaction).not.toHaveBeenCalled();
});
it('creates the first list and task in one transaction after a wipe', async () => {
  const { s, storage } = await setup(); await s.wipeAll(); storage.transaction.mockClear();
  const task = await s.addTask({ title: 'First task' });
  expect(s.listById(task.listId)).not.toBeNull();
  expect(storage.transaction).toHaveBeenCalledOnce();
  expect(storage.transaction.mock.calls[0][0].map(o => o.key).sort()).toEqual(['tasks:items:v1', 'tasks:lists:v1']);
});
it('strips inherited sharing on load and refuses to persist it through ordinary edits', async () => {
  const storage = backend();
  storage.docs.set('tasks:lists:v1', { lists: [{ id: 'x', shared: { url: 'https://example.test' } }] });
  storage.docs.set('tasks:settings:v1', { calFeed: { url: 'https://example.test/feed' } });
  const s = new Store({ storage }); await s.init();
  expect(s.settings.calFeed).toBeNull(); expect(s.lists[0].shared).toBeNull();
  await s.updateList('x', { shared: { url: 'https://example.test/new' } });
  expect(storage.docs.get('tasks:lists:v1').data.lists[0].shared).toBeNull();
});
it('counts unsent form drafts separately from acknowledged transport writes', async () => {
  const { s } = await setup(); const token = {};
  s.setDraftDirty(token, true);
  await s.updateSettings({ reminders: true });
  expect(s.pendingWrites()).toBe(1);
  s.setDraftDirty(token, false);
  expect(s.pendingWrites()).toBe(0);
});
it.each(['Task', 'List'])('does not duplicate a failed new %s when Save is pressed again', async kind => {
  const { s, storage } = await setup();
  const before = kind === 'Task' ? s.tasks.length : s.lists.length;
  storage.transaction.mockRejectedValueOnce(new Error('Uncertain write'));
  await expect(s['add' + kind]({ title: 'Draft', name: 'Draft' })).rejects.toThrow();
  await expect(s['add' + kind]({ title: 'Draft', name: 'Draft' })).rejects.toThrow();
  expect(kind === 'Task' ? s.tasks : s.lists).toHaveLength(before + 1);
});
it('aborts archival if an earlier month changes while a later month is loading', async () => {
  const { s, storage } = await setup();
  s.tasks = ['01', '02'].map((m, i) => ({ id: 'old' + i, listId: 'personal', title: 'History', done: true, completedAt: new Date(`2025-${m}-10T12:00:00Z`).getTime(), updatedAt: 1 }));
  let release;
  storage.fs.read.mockImplementation(async path => {
    if (path.endsWith('-02.json')) await new Promise(r => { release = r; });
    return new Blob(['[]']);
  });
  const pending = s.archiveOldCompleted();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await s.uncompleteTask('old0'); release(); await pending;
  expect(s.taskById('old0')?.done).toBe(false);
  expect(storage.files.has('tasks-data/log-2025-01.json')).toBe(false);
});
it('does not send a later snapshot behind a failed transaction', async () => {
  const { s, storage } = await setup(); let reject;
  storage.transaction.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const first = s.addTask({ title: 'First' }).catch(e => e);
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  const second = s.updateSettings({ reminders: true }).catch(e => e);
  expect(storage.transaction).toHaveBeenCalledOnce();
  reject(new Error('Denied'));
  expect(await first).toBeInstanceOf(Error); expect(await second).toBeInstanceOf(Error);
  expect(storage.transaction).toHaveBeenCalledOnce();
  expect(s.pendingWrites()).toBe(2);
});
it('refuses corrupt archive shape rather than overwriting it with an empty history', async () => {
  const { s, storage } = await setup();
  storage.files.set('tasks-data/log-2025-01.json', '{}');
  await expect(s.loadLog('2025-01')).rejects.toThrow(/archive/i);
});
it('never acknowledges an edit to a task moved out of the hot document', async () => {
  const { s, storage } = await setup();
  await expect(s.updateTask('archived-task', { title: 'Unsaved edit' })).rejects.toThrow(/copy.*edit/i);
  expect(storage.transaction).not.toHaveBeenCalled();
});
it.each(['init', 'wipeAll', 'importAll'])('%s cannot discard a failed private edit', async method => {
  const { s, storage } = await setup();
  storage.transaction.mockRejectedValueOnce(new Error('Denied'));
  await expect(s.addTask({ title: 'Keep me' })).rejects.toThrow();
  await expect(s[method]({ kind: 'tasks.export', lists: [], items: { tasks: [] } })).rejects.toThrow();
  expect(s.tasks[0]?.title).toBe('Keep me');
});
it('an older acknowledgement cannot clear a newer unsaved generation', async () => {
  const { s, storage } = await setup(); const task = await s.addTask({ title: 'Initial' });
  let firstDone; let secondDone;
  storage.transaction.mockImplementationOnce(() => new Promise(r => { firstDone = r; }))
    .mockImplementationOnce(() => new Promise(r => { secondDone = r; }));
  const first = s.updateTask(task.id, { title: 'First' });
  await vi.waitFor(() => expect(firstDone).toBeTypeOf('function'));
  const second = s.updateTask(task.id, { title: 'Second' });
  expect(storage.transaction.mock.calls.at(-1)[0][0].value.data.tasks[0].title).toBe('First');
  firstDone({ ok: true }); await first;
  expect(s.pendingWrites()).toBe(1); expect(s.taskById(task.id).title).toBe('Second');
  await vi.waitFor(() => expect(secondDone).toBeTypeOf('function'));
  secondDone({ ok: true }); await second;
  expect(s.pendingWrites()).toBe(0);
});
it('does not start housekeeping archival over an open unsaved editor', async () => {
  const { s, storage } = await setup();
  s.tasks = [{ id: 'old', title: 'Editing this', done: true, completedAt: 1, updatedAt: 1 }];
  s.setDraftDirty({}, true);
  expect(await s.archiveOldCompleted()).toBe(0);
  expect(storage.fs.read).not.toHaveBeenCalled(); expect(s.tasks).toHaveLength(1);
});
it('does not archive after a form becomes dirty during the archive read', async () => {
  const { s, storage } = await setup();
  s.tasks = [{ id: 'old', title: 'Editing this', done: true, completedAt: 1, updatedAt: 1 }];
  let release; storage.fs.read.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const pending = s.archiveOldCompleted();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  s.setDraftDirty({}, true); release(new Blob(['[]']));
  expect(await pending).toBe(0); expect(s.tasks).toHaveLength(1);
  expect(storage.transaction).not.toHaveBeenCalled();
});
export { setup, backend };
