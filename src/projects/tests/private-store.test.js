import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let resources, requests, failure, Store;
const response = (data, rev = 0, status = 200) => new Response(JSON.stringify(data), { status, headers: { ETag: `"${rev}"` } });
function seed(kind, name, value) { resources.set(`${kind}:${name}`, { value, rev: 1 }); }
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
  vi.stubGlobal('puter', undefined);
  vi.stubGlobal('BroadcastChannel', undefined);
  resources = new Map(); requests = []; failure = null;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    requests.push({ url, ...options });
    if (failure?.(url, options)) throw new TypeError('Failed to fetch');
    if (url === '/api/session') return response({ username: 'Jetson storage', storage: 'jetson' });
    const u = new URL(url, 'http://test');
    if (u.pathname === '/api/files') return response({ files: [] });
    const kind = u.pathname.slice(5);
    const name = u.searchParams.get(kind === 'kv' ? 'key' : 'path');
    const id = `${kind}:${name}`;
    const item = resources.get(id) ?? { rev: 0, value: null };
    if (options.method === 'PUT' || options.method === 'DELETE') {
      if (options.headers['If-Match'] !== `"${item.rev}"`) return response({ error: 'conflict' }, item.rev, 409);
      item.rev++;
      item.value = options.method === 'DELETE' ? null : kind === 'kv' ? JSON.parse(options.body).value : options.body;
      resources.set(id, item);
      return response({ ok: true }, item.rev);
    }
    if (kind === 'kv') return response({ value: item.value }, item.rev);
    if (item.value === null) return response({ code: 'ENOENT' }, item.rev, 404);
    if (u.searchParams.has('stat')) return response({ path: name, modified: item.rev, size: new Blob([item.value]).size }, item.rev);
    return new Response(item.value, { headers: { ETag: `"${item.rev}"` } });
  }));
  ({ Store } = await import('../src/lib/store.js'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openStore() { const store = new Store(); await store.init(); return store; }
async function project(store) { return store.createProject({ name: 'Private project', color: '#8833eb' }); }

describe('private Projects store', () => {
  it('initializes without a global SDK and authenticates before every initial storage read', async () => {
    const store = await openStore();
    expect(store.user.username).toBe('Jetson storage');
    expect(requests[0].url).toBe('/api/session');
    expect(requests.filter(r => r.url === '/api/session')).toHaveLength(1);
    expect(store.projects).toEqual([]);
  });

  it('keeps edited documents dirty on network failure without mirror/outbox replay', async () => {
    const store = await openStore();
    const doc = await project(store);
    const onError = vi.fn(); const saved = vi.fn();
    store.addEventListener('save-error', onError); store.addEventListener('saved', saved);
    failure = (url, opts) => url.includes('project-') && opts.method === 'PUT';
    store.setProjectBrief(doc.id, 'Unsaved local work');
    await store.flushAll();
    expect(store.getDoc(doc.id).brief).toBe('Unsaved local work');
    expect(store.dirty).toBe(true);
    expect(store.pendingUploads).toBe(0);
    expect(onError).toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled();
    const writes = requests.filter(r => r.method === 'PUT').length;
    failure = null;
    await store.syncOutbox();
    expect(requests.filter(r => r.method === 'PUT')).toHaveLength(writes);
    expect(store.dirty).toBe(true);
  });

  it('does not refresh stale CAS through daily snapshots or index merge and prohibits keep-mine', async () => {
    const store = await openStore();
    const doc = await project(store);
    const item = resources.get(`file:projects-data/project-${doc.id}.json`);
    item.rev++;
    item.value = JSON.stringify({ ...doc, brief: 'Other device' });
    store.setProjectBrief(doc.id, 'My draft');
    await store.flushAll();
    expect(store.hasConflict(doc.id)).toBe(true);
    expect(store.getDoc(doc.id).brief).toBe('My draft');
    expect(store.dirty).toBe(true);
    await expect(store.forceSave(doc.id)).rejects.toThrow(/reload|unsupported|disabled/i);
    await expect(store.reloadProject(doc.id)).rejects.toThrow(/reload|unsaved|export/i);
    expect(JSON.parse(item.value).brief).toBe('Other device');
  });

  it('round-trips uploaded binary bytes through a full ZIP backup without Puter', async () => {
    const store = await openStore(); const doc = await project(store);
    const task = store.addTask(doc.id, doc.columns[0].id, { title: 'Binary backup' });
    const bytes = new Uint8Array([0, 255, 1, 2, 128]);
    const file = Object.assign(new Blob([bytes]), { name: 'payload.bin' });
    await store.addAttachment(doc.id, task.id, file); await store.flushAll();
    const bundle = await store.exportBundle();
    expect(bundle.missing).toBe(0);
    const { parseBackupFile } = await import('../src/lib/backup.js');
    const parsed = await parseBackupFile(Object.assign(bundle.blob, { name: 'backup.zip' }));
    const imported = await store.importBackup(parsed);
    expect(imported).toMatchObject({ projects: 1, tasks: 1, attachments: 1, failed: [] });
    const copy = await store.loadProject(store.projects.at(-1).id);
    const restored = await store.readAttachment(copy.id, copy.tasks[0].id, copy.tasks[0].attachments[0]);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
  });

  it('recognizes ENOENT when checking missing uploaded attachments', async () => {
    const store = await openStore();
    expect(await store.attachmentExists('p', 't', { id: 'missing', name: 'missing.bin' })).toBe(false);
  });

  it('does not silently omit a missing indexed project from a full backup', async () => {
    seed('kv', 'pm:projects:v1', JSON.stringify([{ id: 'gone', name: 'Missing' }]));
    const store = await openStore();
    await expect(store.exportAll()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains failed settings edits and flags them as unsaved', async () => {
    const store = await openStore();
    failure = (url, opts) => url.includes('settings') && opts.method === 'PUT';
    await expect(store.updateSettings({ theme: 'dark' })).rejects.toThrow();
    expect(store.settings.theme).toBe('dark');
    expect(store.dirty).toBe(true);
  });

  it('rejects malformed data instead of onboarding into an empty workspace', async () => {
    seed('kv', 'pm:projects:v1', 'broken json');
    await expect(openStore()).rejects.toThrow();
  });

  it('does not turn an invalid index object into an empty workspace', async () => {
    seed('kv', 'pm:projects:v1', '{}');
    await expect(openStore()).rejects.toThrow(/invalid/i);
  });

  it('refuses deletion while a project has unsaved edits', async () => {
    const store = await openStore(); const doc = await project(store);
    store.setProjectBrief(doc.id, 'Keep this work');
    failure = (url, options) => options.method === 'PUT';
    await expect(store.deleteProject(doc.id)).rejects.toThrow();
    expect(store.getDoc(doc.id)?.brief).toBe('Keep this work');
    expect(store.hasPendingSave(doc.id)).toBe(true);
    await expect(store.purgeProject(doc.id)).rejects.toThrow(/unsaved/i);
    expect(store.getDoc(doc.id)?.brief).toBe('Keep this work');
  });

  it('preserves the current document when restoring a snapshot fails', async () => {
    const store = await openStore(); const doc = await project(store);
    const path = `projects-data/snapshots/project-${doc.id}/2026-11-08.json`;
    seed('file', path, JSON.stringify({ doc: { ...doc, brief: 'Old snapshot' } }));
    failure = (url, options) => options.method === 'PUT';
    await expect(store.restoreSnapshot(doc.id, '2026-11-08.json')).rejects.toThrow();
    expect(store.getDoc(doc.id)).toBe(doc);
    expect(store.getDoc(doc.id).brief).not.toBe('Old snapshot');
    expect(store.dirty).toBe(true);
  });

  it.each([false, true])('preserves edits during a delayed restore response (write fails: %s)', async (writeFails) => {
    vi.useFakeTimers();
    try {
      const store = await openStore(); const doc = await project(store);
      const docPath = `projects-data/project-${doc.id}.json`;
      const name = '2026-11-08.json';
      seed('file', `projects-data/snapshots/project-${doc.id}/${name}`, JSON.stringify({ doc: { ...doc, brief: 'Old snapshot' } }));
      let releaseRestore, restoreStarted;
      const restoring = new Promise(resolve => { restoreStarted = resolve; });
      const gate = new Promise(resolve => { releaseRestore = resolve; });
      const original = globalThis.fetch.getMockImplementation();
      globalThis.fetch.mockImplementation(async (url, options) => {
        if (options.method === 'PUT' && new URL(url, 'http://test').searchParams.get('path') === docPath) {
          const result = writeFails ? response({ error: 'unavailable' }, 0, 503) : await original(url, options);
          restoreStarted();
          await gate;
          return result;
        }
        return original(url, options);
      });
      const saved = vi.fn(); store.addEventListener('saved', saved);
      const restore = store.restoreSnapshot(doc.id, name);
      await restoring;
      store.setProjectBrief(doc.id, 'Edit made while restoring');
      releaseRestore();
      const outcome = await restore.then(() => null, error => error);
      expect(store.getDoc(doc.id)).toBe(doc);
      expect(store.getDoc(doc.id).brief).toBe('Edit made while restoring');
      expect(store.hasPendingSave(doc.id)).toBe(true);
      expect(store.dirty).toBe(true);
      expect(saved).not.toHaveBeenCalled();
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome.message).toMatch(writeFails ? /503/ : /changed.*restoring/i);
      expect(JSON.parse(resources.get(`file:${docPath}`).value).brief).toBe(writeFails ? '' : 'Old snapshot');
      globalThis.fetch.mockImplementation(original);
      // The edit's debounce must survive the restore, not just its dirty flag.
      await vi.advanceTimersByTimeAsync(500);
      expect(JSON.parse(resources.get(`file:${docPath}`).value).brief).toBe('Edit made while restoring');
      await store.flushAll();
      expect(store.hasPendingSave(doc.id)).toBe(false);
      expect(store.dirty).toBe(false);
      expect(saved).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('never deletes attachment bytes before the edited document is accepted', async () => {
    const store = await openStore(); const doc = await project(store);
    const task = store.addTask(doc.id, doc.columns[0].id, { title: 'With attachment' });
    const file = Object.assign(new Blob(['binary data']), { name: 'test.bin' });
    const att = await store.addAttachment(doc.id, task.id, file);
    await store.flushAll();
    failure = (url, options) => options.method === 'PUT';
    store.deleteAttachment(doc.id, task.id, att);
    await store.flushAll();
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
  });

  it('keeps newly queued attachment bytes until their own document removal commits', async () => {
    vi.useFakeTimers();
    try {
      const store = await openStore(); const doc = await project(store);
      const task = store.addTask(doc.id, doc.columns[0].id, { title: 'Two attachments' });
      const a = await store.addAttachment(doc.id, task.id, Object.assign(new Blob(['a']), { name: 'a.bin' }));
      const b = await store.addAttachment(doc.id, task.id, Object.assign(new Blob(['b']), { name: 'b.bin' }));
      await store.flushAll();
      const docPath = `projects-data/project-${doc.id}.json`;
      const aPath = store.attachmentPath(doc.id, task.id, a);
      const bPath = store.attachmentPath(doc.id, task.id, b);
      let releaseDelete, deleteStarted;
      const deleting = new Promise(resolve => { deleteStarted = resolve; });
      const gate = new Promise(resolve => { releaseDelete = resolve; });
      const original = globalThis.fetch.getMockImplementation();
      globalThis.fetch.mockImplementation(async (url, options) => {
        if (options.method === 'DELETE' && new URL(url, 'http://test').searchParams.get('path') === aPath) {
          deleteStarted();
          await gate;
        }
        return original(url, options);
      });
      const saved = vi.fn(); store.addEventListener('saved', saved);
      store.deleteAttachment(doc.id, task.id, a);
      const firstSave = store.flushAll();
      await deleting;
      expect(JSON.parse(resources.get(`file:${docPath}`).value).tasks[0].attachments).toEqual([b]);
      store.deleteAttachment(doc.id, task.id, b);
      failure = (url, options) => options.method === 'PUT' && new URL(url, 'http://test').searchParams.get('path') === docPath;
      releaseDelete();
      await firstSave;
      await store.flushAll();
      expect(JSON.parse(resources.get(`file:${docPath}`).value).tasks[0].attachments).toEqual([b]);
      expect(resources.get(`file:${aPath}`).value).toBeNull();
      expect(await store.readAttachment(doc.id, task.id, b).then(blob => blob.text())).toBe('b');
      expect(requests.filter(r => r.method === 'DELETE').map(r => new URL(r.url, 'http://test').searchParams.get('path'))).toEqual([aPath]);
      expect(store.hasPendingSave(doc.id)).toBe(true);
      expect(store.dirty).toBe(true);
      expect(saved).not.toHaveBeenCalled();
      failure = null;
      await store.flushAll();
      expect(JSON.parse(resources.get(`file:${docPath}`).value).tasks[0].attachments).toEqual([]);
      expect(resources.get(`file:${bPath}`).value).toBeNull();
      expect(store.hasPendingSave(doc.id)).toBe(false);
      expect(store.dirty).toBe(false);
      expect(saved).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps edits made during attachment cleanup dirty until their own write commits', async () => {
    const store = await openStore(); const doc = await project(store);
    const task = store.addTask(doc.id, doc.columns[0].id, { title: 'Before' });
    const att = await store.addAttachment(doc.id, task.id, Object.assign(new Blob(['a']), { name: 'a.bin' }));
    await store.flushAll();
    const original = globalThis.fetch.getMockImplementation();
    globalThis.fetch.mockImplementation(async (url, options) => {
      if (options.method === 'DELETE') store.updateTask(doc.id, task.id, { title: 'Edited during cleanup' });
      return original(url, options);
    });
    store.deleteAttachment(doc.id, task.id, att);
    await store.flushAll();
    expect(store.hasPendingSave(doc.id)).toBe(true);
    await store.flushAll();
    expect(store.hasPendingSave(doc.id)).toBe(false);
    const persisted = resources.get(`file:projects-data/project-${doc.id}.json`);
    expect(JSON.parse(persisted.value).tasks[0].title).toBe('Edited during cleanup');
  });

  it('does not swallow snapshot listing failures or enable Puter Drive links', async () => {
    const store = await openStore();
    failure = url => url.startsWith('/api/files');
    await expect(store.listSnapshotProjects()).rejects.toThrow('Failed to fetch');
    expect(() => store.addLinkedAttachment('p', 't', { path: '/drive/a' })).toThrow(/Drive.*unavailable|unsupported/i);
  });
});
