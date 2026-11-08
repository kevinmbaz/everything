// Store + actual shared transport against an in-process HTTP-response fixture.
// This is not the real backend/browser persistence acceptance test.
import { beforeAll, expect, it, vi } from 'vitest';
import { createPrivateStorage } from '../../../private_storage/client.mjs';
import { installMockPuter } from './helpers/mock-puter.js';
let Store;
beforeAll(async () => { installMockPuter(); ({ Store } = await import('../src/lib/store.js')); });
function server() {
  const resources = new Map();
  const response = (data, status = 200, revision) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...(revision === undefined ? {} : { ETag: `"${revision}"` }) },
  });
  const fetch = vi.fn(async (url, options) => {
    if (url === '/api/session') return response({ app: 'tasks', storage: 'jetson', uuid: 'jetson-owner', username: 'Jetson storage' });
    const u = new URL(url, 'https://tasks.example.test');
    if (u.pathname === '/api/kv') {
      const r = resources.get('kv:' + u.searchParams.get('key'));
      return response({ value: r?.value ?? null }, 200, r?.revision ?? 0);
    }
    if (u.pathname === '/api/file') {
      const r = resources.get('file:' + u.searchParams.get('path'));
      return r ? new Response(r.value, { headers: { ETag: `"${r.revision}"` } })
        : response({ error: 'ENOENT' }, 404, 0);
    }
    expect(url).toBe('/api/transaction'); expect(options.method).toBe('POST');
    expect(options.headers['X-Everything-Request']).toBe('1');
    const { operations } = JSON.parse(options.body);
    if (operations.some(o => o.ifMatch !== `"${resources.get(`${o.kind}:${o.key ?? o.path}`)?.revision ?? 0}"`)) return response({ error: 'CONFLICT' }, 409);
    const revisions = operations.map(o => {
      const name = o.key ?? o.path; const id = `${o.kind}:${name}`;
      const revision = (resources.get(id)?.revision ?? 0) + 1;
      resources.set(id, { value: o.method === 'DELETE' ? null : o.value, revision });
      return { kind: o.kind, [o.kind === 'kv' ? 'key' : 'path']: name, etag: `"${revision}"` };
    });
    return response({ ok: true, revisions });
  });
  return { resources, fetch, make: () => new Store({ storage: createPrivateStorage({ app: 'tasks', fetch }) }) };
}
it('stores native envelopes once and reopens personal tasks through the real client', async () => {
  const http = server(); const s = http.make(); await s.init();
  const task = await s.addTask({ title: 'Personal', notes: 'Details', due: '2026-11-10', reminder: 10, subtasks: [{ title: 'Step' }] });
  const value = JSON.parse(http.resources.get('kv:tasks:items:v1').value);
  expect(value.data.tasks[0].title).toBe('Personal');
  const reopened = http.make(); await reopened.init();
  expect(reopened.taskById(task.id)).toMatchObject({ title: 'Personal', notes: 'Details', reminder: 10 });
  expect(http.fetch.mock.calls.filter(([u]) => u === '/api/session')).toHaveLength(2);
});
it('keeps a stale second editor dirty and never merges or automatically retries its conflict', async () => {
  const http = server(); const a = http.make(); const b = http.make();
  await a.init(); await b.init(); await a.addTask({ title: 'Winner' });
  await expect(b.addTask({ title: 'My unsaved edit' })).rejects.toMatchObject({ code: 'ECONFLICT' });
  const calls = http.fetch.mock.calls.length;
  await b.refreshFromCloud({ force: true }); await b.flushPending();
  expect(http.fetch).toHaveBeenCalledTimes(calls);
  expect(b.tasks[0].title).toBe('My unsaved edit'); expect(b.pendingWrites()).toBeGreaterThan(0);
  expect(JSON.parse(http.resources.get('kv:tasks:items:v1').value).data.tasks[0].title).toBe('Winner');
});
it('archives file text and hot items together through the actual shared transaction API', async () => {
  const http = server(); const s = http.make(); await s.init();
  await s.addTask({ title: 'History', done: true, completedAt: new Date('2025-01-10T12:00:00Z').getTime() });
  await s.archiveOldCompleted();
  expect(s.tasks).toHaveLength(0);
  expect((await s.loadLog('2025-01'))[0].title).toBe('History');
  const body = JSON.parse(http.fetch.mock.calls.filter(([u]) => u === '/api/transaction').at(-1)[1].body);
  expect(body.operations.map(o => o.kind).sort()).toEqual(['file', 'kv']);
  expect(JSON.parse(body.operations.find(o => o.kind === 'file').value)[0].title).toBe('History');
});
it('does not use cached identity or make data reads after session rejection', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 403 }));
  const s = new Store({ storage: createPrivateStorage({ app: 'tasks', fetch }) });
  await expect(s.init()).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe('/api/session');
});
