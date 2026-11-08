import { describe, it, expect, vi } from 'vitest';
import { createPrivateStorage } from '../src/lib/private-storage.js';

const json = (data, revision = '0', status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ETag: `"${revision}"` },
});
const session = () => json({ username: 'Jetson storage', storage: 'jetson' });

describe('private storage', () => {
  it('authenticates once before any storage reads, including concurrent startup', async () => {
    let release;
    const fetch = vi.fn((url) => url === '/api/session'
      ? new Promise(resolve => { release = () => resolve(session()); })
      : Promise.resolve(json({ value: null })));
    const storage = createPrivateStorage({ fetch });
    const user = storage.getUser();
    const read = storage.kv.get('pm:settings:v1');
    await Promise.resolve();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/session']);
    release();
    expect(await user).toEqual({ username: 'Jetson storage', storage: 'jetson' });
    expect(await read).toBeNull();
    await storage.getUser();
    expect(fetch.mock.calls.filter(([url]) => url === '/api/session')).toHaveLength(1);
    expect(fetch.mock.calls[1][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  });

  it('never upgrades the write baseline on stat, snapshot read, or a second session check', async () => {
    const fetch = vi.fn(async (url, options) => {
      if (url === '/api/session') return session();
      if (options.method === 'PUT') return json({ ok: true }, '3');
      if (url.includes('stat=1')) return json({ path: 'projects-data/project-a.json', size: 2, modified: 2 }, '2');
      return json({ title: 'original' }, fetch.mock.calls.length === 2 ? '1' : '2');
    });
    const storage = createPrivateStorage({ fetch });
    await storage.fs.read('projects-data/project-a.json');
    await storage.fs.stat('projects-data/project-a.json');
    await storage.fs.read('projects-data/project-a.json');
    await storage.getUser();
    await storage.fs.write('projects-data/project-a.json', 'local edit');
    expect(fetch.mock.calls.at(-1)[1].headers).toMatchObject({ 'If-Match': '"1"', 'X-Projects-Request': '1' });
    expect(storage.dirty).toBe(false);
  });

  it('latches conflicts, keeps unsaved state, and never retries or unlocks through reads', async () => {
    const fetch = vi.fn(async (url, options) => url === '/api/session' ? session()
      : options.method === 'PUT' ? json({ error: 'changed' }, '2', 409) : json({ value: '[]' }, '1'));
    const storage = createPrivateStorage({ fetch });
    await storage.kv.get('pm:projects:v1');
    await expect(storage.kv.set('pm:projects:v1', '[1]')).rejects.toMatchObject({ pmConflict: true });
    expect(storage.dirty).toBe(true);
    await storage.getUser();
    await storage.kv.get('pm:projects:v1');
    await expect(storage.kv.set('pm:settings:v1', '{}')).rejects.toMatchObject({ pmConflict: true });
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'PUT')).toHaveLength(1);
  });

  it('serializes same-resource writes using only acknowledged write revisions', async () => {
    let revision = 1;
    const fetch = vi.fn(async (url, options) => url === '/api/session' ? session()
      : options.method === 'PUT' ? json({ ok: true }, String(++revision)) : json({ value: '{}' }, '1'));
    const storage = createPrivateStorage({ fetch });
    await storage.kv.get('pm:settings:v1');
    await Promise.all([storage.kv.set('pm:settings:v1', 'a'), storage.kv.set('pm:settings:v1', 'b')]);
    expect(fetch.mock.calls.filter(([, o]) => o.method === 'PUT').map(([, o]) => o.headers['If-Match'])).toEqual(['"1"', '"2"']);
  });

  it('uses a missing file tombstone revision and propagates network errors', async () => {
    let fail = false;
    const fetch = vi.fn(async (url, options) => {
      if (url === '/api/session') return session();
      if (fail) throw new TypeError('Failed to fetch');
      return options.method === 'PUT' ? json({ ok: true }, '8') : json({ code: 'ENOENT' }, '7', 404);
    });
    const storage = createPrivateStorage({ fetch });
    await storage.fs.write('projects-data/project-new.json', '{}');
    expect(fetch.mock.calls.at(-1)[1].headers['If-Match']).toBe('"7"');
    fail = true;
    await expect(storage.fs.write('projects-data/project-new.json', 'edit')).rejects.toThrow('Failed to fetch');
    expect(storage.dirty).toBe(true);
  });

  it('projects flat descendants into immediate virtual folders without changing file revisions', async () => {
    const files = [
      { path: 'projects-data/snapshots/project-a/2026-11-08.json', etag: '"1"', size: 20, modified: 1 },
      { path: 'projects-data/snapshots/project-a/2026-11-07.json', etag: '"2"', size: 30, modified: 2 },
      { path: 'projects-data/snapshots/project-b/2026-11-08.json', etag: '"3"', size: 40, modified: 3 },
    ];
    const fetch = vi.fn(async url => url === '/api/session' ? session()
      : json({ files: files.filter(f => f.path.startsWith(new URL(url, 'http://local').searchParams.get('prefix'))) }));
    const storage = createPrivateStorage({ fetch });
    expect(await storage.fs.readdir('projects-data/snapshots')).toEqual([
      { name: 'project-a', path: 'projects-data/snapshots/project-a', is_dir: true },
      { name: 'project-b', path: 'projects-data/snapshots/project-b', is_dir: true },
    ]);
    expect(await storage.fs.readdir('projects-data/snapshots/project-a')).toEqual(files.slice(0, 2).map(f => ({ ...f, name: f.path.split('/').at(-1), is_dir: false })));
  });

  it('recursive deletion uses listed revisions and rejects out-of-folder listings', async () => {
    const fetch = vi.fn(async (url, options) => url === '/api/session' ? session()
      : url.startsWith('/api/files') ? json({ files: [{ path: 'projects-data/attachments/a/t/file', etag: '"4"' }] })
      : json({ ok: true }, '5'));
    const storage = createPrivateStorage({ fetch });
    await storage.fs.delete('projects-data/attachments/a', { recursive: true });
    expect(fetch.mock.calls.at(-1)[1]).toMatchObject({ method: 'DELETE', headers: { 'If-Match': '"4"' } });
    await expect(storage.fs.readdir('projects-data/snapshots')).rejects.toMatchObject({ code: 'EPROTOCOL' });
  });

  it('times out stalled response bodies instead of hanging in saving state', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async url => url === '/api/session' ? session()
        : { ok: true, json: () => new Promise(() => {}) });
      const storage = createPrivateStorage({ fetch });
      const read = storage.kv.get('pm:settings:v1');
      const assertion = expect(read).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      await vi.advanceTimersByTimeAsync(30001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('surfaces failed reads as unavailable rather than a healthy saved state', async () => {
    const fetch = vi.fn(async url => url === '/api/session' ? session() : json({ error: 'disk failure' }, '1', 500));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.kv.get('pm:settings:v1')).rejects.toMatchObject({ status: 500 });
    expect(storage.error).toMatchObject({ status: 500 });
  });

  it('rejects failed session without accessing storage', async () => {
    const fetch = vi.fn(async () => json({ error: 'Forbidden' }, '0', 403));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.kv.get('pm:projects:v1')).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
