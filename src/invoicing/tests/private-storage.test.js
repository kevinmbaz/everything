import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPrivateStorage } from '../src/lib/private-storage.js';
const json = (body, { status = 200, etag } = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) },
});
const session = () => json({ username: 'Jetson storage', storage: 'jetson' });
const header = (options, name) => new Headers(options.headers).get(name);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('private HTTP storage', () => {
  it.each([
    ['kv', 'network'], ['write', 'network'], ['delete', 'network'],
    ['kv', 'http'], ['write', 'http'], ['delete', 'http'],
  ])('propagates %s mutation %s failures without retrying or adopting a failed revision', async (kind, failure) => {
    const path = 'invoicing-data/docs-2026.json';
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(kind === 'kv' ? { value: null } : { path, size: 2 }, { etag: '"5"' }))
      .mockImplementationOnce(() => failure === 'network'
        ? Promise.reject(new TypeError('Connection lost'))
        : Promise.resolve(new Response('Disk write failed', { status: 503, headers: { ETag: '"999"' } })))
      .mockResolvedValueOnce(json({ ok: true }, { etag: '"6"' }));
    const storage = createPrivateStorage({ fetch });
    const mutate = () => kind === 'kv' ? storage.kv.set('invc:settings:v1', '{}')
      : kind === 'write' ? storage.fs.write(path, '[]') : storage.fs.delete(path);
    await expect(mutate()).rejects.toThrow(failure === 'network' ? 'Connection lost' : 'Disk write failed');
    expect(fetch).toHaveBeenCalledTimes(2);
    await mutate(); // A separate, explicit application attempt, never an automatic retry.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.slice(1).map(([, opts]) => header(opts, 'If-Match'))).toEqual(['"5"', '"5"']);
  });

  it('stops recursive deletion on a changed snapshot entry instead of deleting later entries', async () => {
    const folder = 'invoicing-data/attachments/D1';
    const path = `${folder}/a.pdf`;
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ path, size: 1 }, { etag: '"1"' }))
      .mockResolvedValueOnce(json({ files: [{ path, etag: '"2"' }, { path: `${folder}/b.pdf`, etag: '"7"' }] }))
      .mockResolvedValueOnce(json({ error: 'Changed after listing', code: 'CONFLICT' }, { status: 409, etag: '"3"' }));
    const storage = createPrivateStorage({ fetch });
    await storage.fs.stat(path);
    await expect(storage.fs.delete(folder, { recursive: true })).rejects.toThrow('Changed after listing');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(header(fetch.mock.calls[2][1], 'If-Match')).toBe('"2"');
    await expect(storage.fs.write(path, 'stale')).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('treats URL-looking resource names as encoded data, never as network destinations', async () => {
    const path = 'https://outside.invalid/file?path=other&x=1#fragment';
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ path, size: 5 }, { etag: '"1"' }))
      .mockResolvedValueOnce(json({ path }, { etag: '"2"' }));
    const storage = createPrivateStorage({ fetch });
    await storage.fs.write(path, 'bytes');
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe(`/api/file?${new URLSearchParams({ path, ...(options.method === 'GET' ? { stat: '1' } : {}) })}`);
      expect(options).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
      expect(header(options, 'Origin')).toBeNull();
    }
  });

  it.each(['returns', 'throws', 'rejects'])('notifies once per conflict latch even when onConflict %s', async (behavior) => {
    const onConflict = vi.fn(() => {
      if (behavior === 'throws') throw new Error('Banner failed');
      if (behavior === 'rejects') return Promise.reject(new Error('Async banner failed'));
    });
    const conflictResponse = () => json({ error: 'Edited on another device', code: 'CONFLICT' }, { status: 409, etag: '"9"' });
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ value: 'old' }, { etag: '"1"' }))
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(conflictResponse())
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(json({ value: 'reloaded' }, { etag: '"2"' }))
      .mockResolvedValueOnce(conflictResponse());
    const storage = createPrivateStorage({ fetch, onConflict });
    const attempts = await Promise.allSettled([
      storage.kv.set('invc:settings:v1', 'stale'),
      storage.kv.set('invc:settings:v1', 'queued stale'),
    ]);
    for (const result of attempts) {
      expect(result.status).toBe('rejected');
      expect(result.reason).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Edited on another device' });
    }
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onConflict.mock.calls[0][0].status).toBe(409);
    await expect(storage.kv.get('invc:settings:v1')).rejects.toMatchObject({ status: 409 });
    expect(onConflict).toHaveBeenCalledTimes(1);
    await storage.getUser();
    await expect(storage.kv.set('invc:settings:v1', 'fresh')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(onConflict).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each(['kv', 'file'])('orders %s reads with writes so delayed reads cannot rewind the saved revision', async (kind) => {
    const started = deferred();
    const release = deferred();
    const path = 'invoicing-data/docs-2026.json';
    let reads = 0;
    let revision = 1;
    const fetch = vi.fn(async (_url, options) => {
      if (options.method === 'GET') {
        if (++reads === 2) { started.resolve(); await release.promise; }
        return kind === 'kv' ? json({ value: 'old' }, { etag: '"1"' })
          : new Response('old', { headers: { ETag: '"1"' } });
      }
      return json({ ok: true }, { etag: `"${++revision}"` });
    });
    const storage = createPrivateStorage({ fetch });
    const read = () => kind === 'kv' ? storage.kv.get('invc:settings:v1') : storage.fs.read(path);
    const write = () => kind === 'kv' ? storage.kv.set('invc:settings:v1', 'new') : storage.fs.write(path, 'new');
    await read();
    const pendingRead = read();
    await started.promise;
    const pendingWrite = write();
    try {
      await Promise.resolve();
      expect(fetch.mock.calls.map(([, opts]) => opts.method)).toEqual(['GET', 'GET']);
    } finally {
      release.resolve();
      await Promise.allSettled([pendingRead, pendingWrite]);
    }
    await write();
    expect(fetch.mock.calls.slice(2).map(([, opts]) => header(opts, 'If-Match'))).toEqual(['"1"', '"2"']);
  });

  it('latches a 409 immediately even when its error body has not arrived', async () => {
    const started = deferred();
    const release = deferred();
    const response = json({ error: 'Changed elsewhere' }, { status: 409, etag: '"9"' });
    response.text = vi.fn(() => { started.resolve(); return release.promise; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ value: 'old' }, { etag: '"1"' }))
      .mockResolvedValueOnce(response);
    const storage = createPrivateStorage({ fetch });
    const first = storage.kv.set('invc:settings:v1', 'stale').catch((error) => error);
    await started.promise;
    try {
      await expect(storage.kv.set('invc:clients:v1', 'other')).rejects.toMatchObject({ status: 409 });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve('{"error":"Changed elsewhere"}');
      await first;
    }
    expect(await first).toMatchObject({ status: 409, message: 'Changed elsewhere' });
  });

  it.each([null, {}, { username: 'Cloud user', storage: 'puter' }])('does not unlock conflict on an invalid session payload (%j)', async (payload) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ value: 'old' }, { etag: '"1"' }))
      .mockResolvedValueOnce(json({ error: 'Conflict' }, { status: 409, etag: '"2"' }))
      .mockResolvedValueOnce(json(payload));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.kv.set('invc:settings:v1', 'stale')).rejects.toMatchObject({ status: 409 });
    await expect(storage.getUser()).rejects.toMatchObject({ code: 'EPROTOCOL' });
    await expect(storage.kv.set('invc:settings:v1', 'stale')).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(['headers', 'body'])('aborts and rejects a hung response %s after 30 seconds', async (phase) => {
    vi.useFakeTimers();
    const forever = new Promise(() => {});
    const response = session();
    response.json = vi.fn(() => forever);
    const fetch = vi.fn(() => phase === 'headers' ? forever : Promise.resolve(response));
    const storage = createPrivateStorage({ fetch });
    const settled = vi.fn();
    storage.getUser().then(settled, settled);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0]).toMatchObject({ code: 'ETIMEDOUT' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { path: 'invoicing-data/attachments/D10/keep.pdf', etag: '"1"' },
    { path: 'invoicing-data/docs-2026.json', etag: '"1"' },
    { path: 'invoicing-data/attachments/D1/../keep.pdf', etag: '"1"' },
    { path: 'invoicing-data/attachments/D1/a.pdf', etag: '*' },
    { path: 'invoicing-data/attachments/D1/a.pdf' },
    null,
  ])('validates the entire recursive snapshot before deleting anything (%j)', async (entry) => {
    const fetch = vi.fn(async (_url, options) => options.method === 'GET'
      ? json({ files: [{ path: 'invoicing-data/attachments/D1/good.pdf', etag: '"1"' }, entry] })
      : json({ ok: true }, { etag: '"2"' }));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.fs.delete('invoicing-data/attachments/D1/', { recursive: true })).rejects.toMatchObject({ code: 'EPROTOCOL' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['', '/', 'invoicing-data', 'other-app/files', '../invoicing-data/attachments',
    'https://outside.test/files', 'invoicing-data/attachments/../docs', 'invoicing-data//attachments',
    'invoicing-data/attachments\\outside'])('rejects unsafe recursive prefix %s before making requests', async (folder) => {
    const fetch = vi.fn(async () => json({ files: [] }));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.fs.delete(folder, { recursive: true })).rejects.toMatchObject({ code: 'EINVAL' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['empty', 'populated'])('recursively deletes only an %s listing snapshot using its exact ETags', async (mode) => {
    const folder = 'invoicing-data/attachments/D1';
    const prefix = `${folder}/`;
    const snapshot = mode === 'empty' ? [] : [
      { path: `${prefix}a.pdf`, etag: '"4"' },
      { path: `${prefix}nested/b.pdf`, etag: '"9"' },
    ];
    const sibling = `${folder}-other/keep.pdf`;
    const concurrent = `${prefix}created-after-list.pdf`;
    const existing = new Map([...snapshot.map(({ path, etag }) => [path, etag]), [sibling, '"3"']]);
    const fetch = vi.fn(async (url, options) => {
      const parsed = new URL(url, 'http://storage.test');
      if (parsed.pathname === '/api/files') {
        expect(parsed.searchParams.get('prefix')).toBe(prefix);
        existing.set(concurrent, '"1"');
        return json({ files: snapshot });
      }
      expect(options.method).toBe('DELETE');
      const path = parsed.searchParams.get('path');
      expect(header(options, 'If-Match')).toBe(existing.get(path));
      expect(header(options, 'X-Invoicing-Request')).toBe('1');
      expect(header(options, 'Content-Type')).toBe('application/octet-stream');
      existing.delete(path);
      return json({ ok: true }, { etag: '"10"' });
    });
    const storage = createPrivateStorage({ fetch });
    await expect(storage.fs.delete(folder, { recursive: true })).resolves.toBe(true);
    expect([...existing.keys()].sort()).toEqual([sibling, concurrent].sort());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `/api/files?${new URLSearchParams({ prefix })}`,
      ...snapshot.map(({ path }) => `/api/file?${new URLSearchParams({ path })}`),
    ]);
  });

  it.each([undefined, '4', 'W/"4"', '*', '"not-a-revision"'])('refuses unsafe or missing ETags instead of sending If-Match %s', async (etag) => {
    const fetch = vi.fn(async () => json({ value: null }, { etag }));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.kv.set('invc:settings:v1', '{}')).rejects.toMatchObject({ code: 'EPROTOCOL' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('invalidates pre-reload queued mutations and in-flight revision lookups', async () => {
    const started = deferred();
    const release = deferred();
    const fetch = vi.fn(async (url, options) => {
      if (url === '/api/session') return session();
      if (options.method === 'GET') {
        started.resolve();
        await release.promise;
        return json({ value: 'old' }, { etag: '"1"' });
      }
      return json({ ok: true }, { etag: '"2"' });
    });
    const storage = createPrivateStorage({ fetch });
    const operations = Promise.allSettled([
      storage.kv.set('invc:settings:v1', 'old pending'),
      storage.kv.set('invc:settings:v1', 'old queued'),
    ]);
    await started.promise;
    await storage.getUser();
    release.resolve();
    const results = await operations;
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(results.map((result) => result.reason.code)).toEqual(['ESTALE', 'ESTALE']);
    expect(fetch.mock.calls.map(([, opts]) => opts.method)).toEqual(['GET', 'GET']);
  });

  it('only a successful explicit getUser reload clears conflict and cached revisions', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ value: 'old' }, { etag: '"1"' }))
      .mockResolvedValueOnce(json({ error: 'Conflict' }, { status: 409, etag: '"99"' }))
      .mockResolvedValueOnce(json({ error: 'Session unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(json({ value: 'reloaded' }, { etag: '"7"' }))
      .mockResolvedValueOnce(json({ ok: true }, { etag: '"8"' }));
    const storage = createPrivateStorage({ fetch });
    await expect(storage.kv.set('invc:settings:v1', 'stale')).rejects.toMatchObject({ status: 409 });
    await expect(storage.getUser()).rejects.toThrow('Session unavailable');
    await expect(storage.kv.set('invc:settings:v1', 'still stale')).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(3);

    await storage.getUser(); // Store.init's explicit discard-and-reload boundary.
    await expect(storage.kv.set('invc:settings:v1', 'fresh data')).resolves.toBe(true);
    expect(fetch.mock.calls.map(([, opts]) => opts.method)).toEqual(['GET', 'PUT', 'GET', 'GET', 'GET', 'PUT']);
    expect(header(fetch.mock.calls[5][1], 'If-Match')).toBe('"7"');
  });

  it('latches the whole adapter after 409; queued writes and later reads cannot unlock it', async () => {
    const path = 'invoicing-data/docs-2026.json';
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ value: 'old' }, { etag: '"1"' }))
      .mockResolvedValueOnce(json({ error: 'Changed on another device' }, { status: 409, etag: '"2"' }))
      .mockResolvedValueOnce(json({ value: 'other device' }, { etag: '"2"' }))
      .mockResolvedValueOnce(new Response('new file', { headers: { ETag: '"5"' } }))
      .mockResolvedValueOnce(json({ path, size: 8 }, { etag: '"5"' }));
    const storage = createPrivateStorage({ fetch });
    await storage.kv.get('invc:settings:v1');
    const attempts = await Promise.allSettled([
      storage.kv.set('invc:settings:v1', 'stale'),
      storage.kv.set('invc:settings:v1', 'queued stale'),
    ]);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected');
      expect(attempt.reason).toMatchObject({ status: 409, code: 'ECONFLICT', message: 'Changed on another device' });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(header(fetch.mock.calls[1][1], 'If-Match')).toBe('"1"');
    await expect(storage.kv.get('invc:settings:v1')).resolves.toBe('other device');
    expect(await (await storage.fs.read(path)).text()).toBe('new file');
    await storage.fs.stat(path);
    for (const mutate of [
      () => storage.kv.set('invc:settings:v1', 'stale'),
      () => storage.kv.set('invc:clients:v1', 'stale other resource'),
      () => storage.fs.write(path, 'stale'),
      () => storage.fs.delete(path),
      () => storage.fs.delete('invoicing-data/attachments/D1', { recursive: true }),
    ]) {
      await expect(mutate()).rejects.toMatchObject({ status: 409, code: 'ECONFLICT' });
    }
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each(['kv', 'file'])('serializes overlapping mutations to the same %s resource', async (kind) => {
    const started = deferred();
    const release = deferred();
    const path = 'invoicing-data/docs-2026.json';
    let mutations = 0;
    const fetch = vi.fn(async (_url, options) => {
      if (options.method === 'GET') {
        return json(kind === 'kv' ? { value: 'old' } : { path, size: 3 }, { etag: '"3"' });
      }
      const number = ++mutations;
      if (number === 1) {
        started.resolve();
        await release.promise;
      }
      return json({ ok: true }, { etag: `"${3 + number}"` });
    });
    const storage = createPrivateStorage({ fetch });
    const operations = Promise.allSettled(kind === 'kv'
      ? [storage.kv.set('invc:settings:v1', 'first'), storage.kv.set('invc:settings:v1', 'second')]
      : [storage.fs.write(path, 'first'), storage.fs.delete(path)]);
    try {
      await started.promise;
      expect(fetch.mock.calls.map(([, opts]) => opts.method)).toEqual(['GET', 'PUT']);
    } finally {
      release.resolve();
      await operations;
    }
    expect((await operations).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(fetch.mock.calls.slice(1).map(([, opts]) => header(opts, 'If-Match'))).toEqual(['"3"', '"4"']);
  });

  it('deletes and recreates files without forgetting the deletion revision', async () => {
    const path = 'invoicing-data/docs-2026.json';
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ path, size: 2 }, { etag: '"12"' }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { ETag: '"13"' } }))
      .mockResolvedValueOnce(json({ path }, { etag: '"14"' }))
      .mockResolvedValueOnce(json({ ok: true }, { etag: '"15"' }));
    const storage = createPrivateStorage({ fetch });

    await expect(storage.fs.delete(path)).resolves.toBe(true);
    await storage.fs.write(path, '[]');
    await expect(storage.fs.delete(path, { unknownOption: true })).resolves.toBe(true);
    expect(fetch.mock.calls.map(([, opts]) => opts.method)).toEqual(['GET', 'DELETE', 'PUT', 'DELETE']);
    expect(fetch.mock.calls.slice(1).map(([, opts]) => header(opts, 'If-Match'))).toEqual(['"12"', '"13"', '"14"']);
    for (const [, options] of [fetch.mock.calls[1], fetch.mock.calls[3]]) {
      expect(header(options, 'X-Invoicing-Request')).toBe('1');
      expect(header(options, 'Content-Type')).toBe('application/octet-stream');
      expect(options.body).toBeUndefined();
    }
  });

  it.each(['read', 'stat', 'preflight'])('recreates a missing file using its tombstone revision from %s', async (first) => {
    const path = 'invoicing-data/docs-2026.json';
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Stored object missing', code: 'ENOENT' }, { status: 404, etag: '"7"' }))
      .mockResolvedValueOnce(json({ path }, { etag: '"8"' }));
    const storage = createPrivateStorage({ fetch });
    if (first !== 'preflight') {
      const error = await storage.fs[first](path).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ status: 404, code: 'ENOENT' });
      expect(error.message).toContain('Stored object missing');
      // Compatibility with the existing Store's missing-file predicate.
      expect(error.message).toMatch(/no such file|not found|does not exist/i);
    }
    await expect(storage.fs.write(path, '[]')).resolves.toEqual({ path });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].method).toBe('PUT');
    expect(header(fetch.mock.calls[1][1], 'If-Match')).toBe('"7"');
  });

  it.each([
    [new Blob([new Uint8Array([0, 255, 128, 13, 10])], { type: 'application/pdf' }), 'application/pdf'],
    ['{"note":"Café ☕"}', 'text/plain;charset=UTF-8'],
    [new Blob([new Uint8Array([0, 255])]), 'application/octet-stream'],
  ])('round-trips raw file bytes without JSON-wrapping the body (%s)', async (data, type) => {
    const path = 'invoicing-data/attachments/D1/receipt & original.pdf';
    const bytes = new Uint8Array(await new Blob([data]).arrayBuffer());
    const metadata = { path, size: bytes.length };
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(metadata, { etag: '"8"' }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { ETag: '"9"' } }))
      .mockResolvedValueOnce(new Response(bytes, { headers: { ETag: '"9"', 'Content-Type': type } }))
      .mockResolvedValueOnce(json(metadata, { etag: '"9"' }));
    const storage = createPrivateStorage({ fetch });

    await expect(storage.fs.write(path, data, { createMissingParents: true, unknownOption: true })).resolves.toEqual({ path });
    const result = await storage.fs.read(path);
    expect(result).toBeInstanceOf(Blob);
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
    await expect(storage.fs.stat(path)).resolves.toEqual(metadata);
    expect(fetch.mock.calls.map(([url, opts]) => [url, opts.method])).toEqual([
      [`/api/file?${new URLSearchParams({ path, stat: '1' })}`, 'GET'],
      [`/api/file?${new URLSearchParams({ path })}`, 'PUT'],
      [`/api/file?${new URLSearchParams({ path })}`, 'GET'],
      [`/api/file?${new URLSearchParams({ path, stat: '1' })}`, 'GET'],
    ]);
    const options = fetch.mock.calls[1][1];
    expect(options.body).toBe(data);
    expect(header(options, 'Content-Type')).toBe(type);
    expect(header(options, 'If-Match')).toBe('"8"');
    expect(header(options, 'X-Invoicing-Request')).toBe('1');
  });

  it.each([
    [401, { error: 'Local session required', code: 'EAUTH' }, 'Local session required', 'EAUTH'],
    [503, { error: { message: 'Disk unavailable', code: 'EIO' } }, 'Disk unavailable', 'EIO'],
    [400, { message: 'Invalid request', code: 'EINVAL' }, 'Invalid request', 'EINVAL'],
    [404, { error: 'File not found', code: 'not_found' }, 'File not found', 'ENOENT'],
  ])('rejects HTTP %i using the real JSON error', async (status, body, message, code) => {
    const storage = createPrivateStorage({ fetch: vi.fn(async () => json(body, { status })) });
    const error = await storage.getUser().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message, status, code });
  });

  it('bootstraps a KV revision and keeps JSON values as strings across consecutive writes', async () => {
    const value = JSON.stringify({ name: 'Café', nested: [1, true] });
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ value: null }, { etag: '"0"' }))
      .mockResolvedValueOnce(json({ ok: true }, { etag: '"1"' }))
      .mockResolvedValueOnce(json({ ok: true }, { etag: '"2"' }))
      .mockResolvedValueOnce(json({ value }, { etag: '"2"' }));
    const storage = createPrivateStorage({ fetch });
    const key = 'invc:settings:v1 &nested=yes#hash';

    await expect(storage.kv.set(key, value)).resolves.toBe(true);
    await expect(storage.kv.set(key, value)).resolves.toBe(true);
    await expect(storage.kv.get(key)).resolves.toBe(value);
    expect(fetch.mock.calls.map(([, opts]) => opts.method)).toEqual(['GET', 'PUT', 'PUT', 'GET']);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe(`/api/kv?${new URLSearchParams({ key })}`);
      expect(options.credentials).toBe('same-origin');
      expect(header(options, 'Origin')).toBeNull();
    }
    for (const [index, etag] of [[1, '"0"'], [2, '"1"']]) {
      const options = fetch.mock.calls[index][1];
      expect(header(options, 'If-Match')).toBe(etag);
      expect(header(options, 'X-Invoicing-Request')).toBe('1');
      expect(header(options, 'Content-Type')).toBe('application/json');
      expect(JSON.parse(options.body)).toEqual({ value });
    }
  });

  it('reads the real local session with default fetch and no external redirects', async () => {
    const fetch = vi.fn(async () => session());
    vi.stubGlobal('fetch', fetch);
    const storage = createPrivateStorage();

    await expect(storage.getUser()).resolves.toEqual({ username: 'Jetson storage', storage: 'jetson' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/session');
    expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(header(options, 'Origin')).toBeNull();
  });
});
