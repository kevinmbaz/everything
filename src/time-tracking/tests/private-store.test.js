import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '../src/lib/store.js';
import { createPuterMock } from './puter-mock.js';

function backend() {
  const api = createPuterMock();
  api.mode = 'private';
  api.getUser = api.auth.getUser;
  api.transaction = vi.fn(async (ops) => {
    for (const o of ops) {
      if (o.kind === 'kv') await api.kv[o.method === 'DELETE' ? 'del' : 'set'](o.key, o.value);
      else await api.fs[o.method === 'DELETE' ? 'delete' : 'write'](o.path, o.value);
    }
    return { ok: true };
  });
  return api;
}
afterEach(() => { delete globalThis.puter; delete globalThis.localStorage; });

describe('explicit private store', () => {
  it.each(['move', 'invoice', 'rate-lock', 'archive', 'import'])('a rejected %s batch leaves durable resources unchanged and visible work dirty', async action => {
    const api = backend(); const s = createStore(api); await s.init();
    const c = await s.addClient({ name: 'Client', rate: 100 });
    const p = await s.addProject({ clientId: c.id, name: 'Project' });
    const e = await s.addEntry({ date: '2026-09-30', projectId: p.id, seconds: 3600 });
    const before = { kv: [...api._kv], files: [...api._files] };
    api.transaction.mockClear(); api.transaction.mockRejectedValueOnce(new Error('denied batch'));
    const actions = {
      move: () => s.updateEntry(e.id, e.date, { date: '2026-10-01' }),
      invoice: () => s.createInvoice({ clientId: c.id, entries: [e] }),
      'rate-lock': () => s.markInvoiced([e]),
      archive: () => s.archiveClient(c.id),
      import: () => s.importAll({ app: 'hourly', entries: {}, clients: [], projects: [] }),
    };
    await expect(actions[action]()).rejects.toThrow('denied batch');
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect({ kv: [...api._kv], files: [...api._files] }).toEqual(before);
    expect(s.pendingWrites()).toBeGreaterThan(0);
    expect(s.storageError.message).toBe('denied batch');
    await s.flushPending(); await s.refresh();
    expect(api.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('server 500'), new SyntaxError('corrupt JSON')])('does not substitute an empty month after a read error', async error => {
    const api = backend(); const s = createStore(api); await s.init();
    api.fs.read = vi.fn(async () => { throw error; });
    await expect(s.loadMonth('2026-10')).rejects.toBe(error);
    expect(api.transaction).not.toHaveBeenCalled();
  });
  it('does not reread/merge loaded documents before a mutation', async () => {
    const api = backend(); const s = createStore(api); await s.init();
    const e = await s.addEntry({ date: '2026-10-01', projectId: 'p', seconds: 60 });
    api.fs.read = vi.fn(async () => { throw new Error('unexpected reread'); });
    api.kv.get = vi.fn(async () => { throw new Error('unexpected reread'); });
    await s.updateEntry(e.id, e.date, { task: 'local' });
    await s.updateSettings({ businessName: 'local' });
    expect(api.fs.read).not.toHaveBeenCalled(); expect(api.kv.get).not.toHaveBeenCalled();
  });
  it('retains a discarded timer when the atomic write fails', async () => {
    const api = backend(); const s = createStore(api); await s.init();
    await s.startTimer({ projectId: 'p', task: 'do not lose' });
    const timer = s.timer;
    api.transaction.mockRejectedValueOnce(new Error('denied'));
    await expect(s.discardTimer()).rejects.toThrow('denied');
    expect(s.timer).toEqual(timer);
    expect(s.pendingWrites()).toBeGreaterThan(0);
  });
  it('persists a timer identity, refuses replacing a running timer and preserves late timer edits as rejected drafts', async () => {
    const api = backend(); const s = createStore(api); await s.init();
    await s.startTimer({ projectId: 'p', task: 'first' });
    expect(s.timer.id).toMatch(/^[\w-]+$/);
    const id = s.timer.id;
    await expect(s.startTimer({ projectId: 'p', task: 'overwrite' })).rejects.toThrow(/running/i);
    await s.retagTimer({ task: 'edited' });
    expect(s.timer.id).toBe(id);
    let release; const real = api.transaction.getMockImplementation();
    api.transaction.mockImplementationOnce(async (...args) => { await new Promise(r => release = r); return real(...args); });
    const stopped = s.stopTimer();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const edited = s.retagTimer({ notes: 'late draft' });
    const rejection = expect(edited).rejects.toThrow(/timer.*changed|no.*timer/i);
    release(); await stopped; await rejection;
    expect(s.timer).toBeNull();
  });
  it('stores immutable binary logos and conditional indexed snapshots on the adapter; restores atomically', async () => {
    const api = backend(); const s = createStore(api); await s.init();
    const bytes = new Blob([new Uint8Array([0, 255, 12])], { type: 'image/png' });
    const path = await s.saveLogo(bytes);
    expect(path).toMatch(/^hourly-data\/logo-\d+-[\w-]+\.png$/);
    expect(new Uint8Array(await (await s.readLogo(path)).arrayBuffer())).toEqual(new Uint8Array([0, 255, 12]));
    const e = await s.addEntry({ date: '2026-10-02', projectId: 'p', seconds: 60 });
    api.transaction.mockClear();
    const backup = await s.writeBackup(1790802000000);
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect(api.transaction.mock.calls[0][0].some(o => o.key === 'hourly:backups:v1')).toBe(true);
    const data = await s.readBackup(backup.date);
    expect(data.entries['2026-10'][0].id).toBe(e.id);
    api.transaction.mockClear();
    await s.importAll({ ...data, entries: { '2026-11': [{ ...e, date: '2026-11-02' }] } });
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect(api.transaction.mock.calls[0][0].some(o => o.method === 'DELETE' && o.path.endsWith('2026-10.json'))).toBe(true);
    expect(s.months).toEqual(['2026-11']);
    expect(api._files.has('hourly-data/entries-2026-10.json')).toBe(false);
  });
  it('serializes edits and atomically commits cross-month moves and invoice locks without reconciliation', async () => {
    const api = backend(); const s = createStore(api); await s.init();
    const c = await s.addClient({ name: 'Client', rate: 100 });
    const p = await s.addProject({ clientId: c.id, name: 'Project' });
    const e = await s.addEntry({ date: '2026-09-30', projectId: p.id, seconds: 3600 });
    api.transaction.mockClear();
    const moved = await s.updateEntry(e.id, e.date, { date: '2026-10-01', task: 'moved' });
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect(api.transaction.mock.calls[0][0].filter(o => o.kind === 'file')).toHaveLength(2);
    api.transaction.mockClear();
    const invoice = await s.createInvoice({ clientId: c.id, entries: [moved] });
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect(api.transaction.mock.calls[0][0].map(o => o.key || o.path)).toEqual(expect.arrayContaining(['hourly:invoices:v1', 'hourly-data/entries-2026-10.json']));
    expect(invoice.total).toBe(100);
    expect((await s.loadMonth('2026-10'))[0].lockedRate).toBe(100);
    api.transaction.mockClear();
    await s.voidInvoice(invoice.id);
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect((await s.loadMonth('2026-10'))[0].invoicedAt).toBeNull();
    let release;
    const real = api.transaction.getMockImplementation();
    api.transaction.mockImplementationOnce(async (...args) => { await new Promise(r => release = r); return real(...args); });
    const one = s.updateSettings({ businessName: 'first' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const two = s.updateSettings({ businessAddress: 'second' });
    release(); await Promise.all([one, two]);
    expect(s.settings).toMatchObject({ businessName: 'first', businessAddress: 'second' });
    expect(api._kv.get('hourly:settings:v1')).toMatchObject({ businessName: 'first', businessAddress: 'second' });
  });
  it('stops a reloaded timer atomically with deterministic entry and identical explicit retry after lost acknowledgement', async () => {
    const api = backend();
    api._kv.set('hourly:timer:v1', { id: 'timer-a', startedAt: 1790802000000, projectId: 'p', task: 'timed', notes: '', billable: true });
    const s = createStore(api); await s.init();
    const commit = api.transaction.getMockImplementation();
    api.transaction.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('lost response'); });
    await expect(s.stopTimer({ capSeconds: 60 })).rejects.toThrow('lost response');
    expect(s.running).toBe(true);
    expect(s.pendingWrites()).toBeGreaterThan(0);
    const first = api.transaction.mock.calls[0];
    expect(first[0].some(o => o.key === 'hourly:timer:v1' && o.value === null)).toBe(true);
    expect(first[1].idempotencyKey).toBe('timer-stop-timer-a');
    const e = await s.stopTimer({ capSeconds: 60 });
    expect(api.transaction.mock.calls[1]).toEqual(first);
    expect(e.id).toBe('timer-timer-a');
    expect(s.running).toBe(false);
    expect(await s.stopTimer()).toBeNull();
    expect((await s.loadMonth(e.date.slice(0, 7)))).toHaveLength(1);
  });
  it('commits entry plus index in one transaction; failure stays visible and dirty without retry duplication', async () => {
    const api = backend(); const s = createStore(api); await s.init();
    api.transaction.mockRejectedValueOnce(new Error('disk full'));
    await expect(s.addEntry({ date: '2026-10-01', projectId: 'p', task: 'keep me', seconds: 60 })).rejects.toThrow('disk full');
    expect(api.transaction).toHaveBeenCalledTimes(1);
    expect(api.transaction.mock.calls[0][0].map(o => o.key || o.path)).toEqual(expect.arrayContaining(['hourly:months:v1', 'hourly-data/entries-2026-10.json']));
    expect((await s.loadMonth('2026-10'))[0].task).toBe('keep me');
    expect(s.pendingWrites()).toBeGreaterThan(0);
    await expect(s.addEntry({ date: '2026-10-01', projectId: 'p', seconds: 60 })).rejects.toThrow();
    expect((await s.loadMonth('2026-10'))).toHaveLength(1);
    expect(api._kv.size).toBe(0);
  });
  it('authenticates the injected adapter before reads, never accesses cloud or browser mirror', async () => {
    const api = backend();
    api.getUser = vi.fn(async () => { throw new Error('unauthorized'); });
    api.kv.get = vi.fn(api.kv.get);
    globalThis.localStorage = { getItem: vi.fn(() => { throw new Error('mirror forbidden'); }) };
    const s = createStore(api);
    await expect(s.init()).rejects.toThrow('unauthorized');
    expect(api.kv.get).not.toHaveBeenCalled();
    api.getUser = vi.fn(async () => ({ uuid: 'owner', username: 'Jetson storage' }));
    await s.init();
    expect(s.user.username).toBe('Jetson storage');
    expect(globalThis.localStorage.getItem).not.toHaveBeenCalled();
    await s.refresh(); await s.flushPending();
    expect(api.kv.get).toHaveBeenCalledTimes(7);
  });
});
