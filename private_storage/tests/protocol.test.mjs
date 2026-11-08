import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateStorage } from '../client.mjs';
const json = (data, etag = '"2"') => new Response(JSON.stringify(data), { headers: { ETag: etag } });
const session = () => json({ username: 'Jetson storage', uuid: 'jetson-owner', storage: 'jetson', app: 'tasks' });

test('invalid mutation inputs reject as dirty promises without issuing data requests', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  const badValues = [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, { nested: undefined }, new Map([['a', 1]]), new Set([1]), cyclic];
  const cases = [
    ...badValues.map(value => s => s.kv.set('a', value)),
    ...badValues.map(value => s => s.transaction([{ kind: 'kv', key: 'a', method: 'PUT', value }], { idempotencyKey: 'valid' })),
    ...[undefined, null, 1, {}, '', 'a\n'].map(key => s => s.kv.set(key, 1)),
    ...[undefined, null, {}, '/a', 'a/../b', 'a\\b', 'a%2fb', 'a?b'].map(path => s => s.fs.write(path, 'x')),
    ...[undefined, {}, new Uint8Array([1])].map(body => s => s.fs.write('a', body)),
    ...['', 'spaces bad', 'ü', 'x'.repeat(129), null, {}].map(idempotencyKey => s => s.transaction([{ kind: 'kv', key: 'a', method: 'DELETE' }], { idempotencyKey })),
    s => s.transaction([{ kind: 'kv', key: 'a', method: 'DELETE' }], null),
    s => s.transaction([{ kind: 'kv', key: 'a', method: 'DELETE' }], { unexpected: true }),
    s => s.transaction(Array(1)),
    s => s.fs.delete('a', { recursive: true }),
  ];
  for (const invoke of cases) {
    const calls = [];
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => { calls.push(url); return url === '/api/session' ? session() : o.method === 'GET' ? json({ value: null }, '"0"') : json({ ok: true }, '"1"'); } });
    const promise = invoke(storage);
    assert.equal(typeof promise?.then, 'function');
    await assert.rejects(promise, { code: 'EINVAL' });
    assert.ok(calls.every(url => url === '/api/session'));
    assert.equal(storage.dirty, true);
    assert.equal(storage.error.code, 'EINVAL');
  }
});

test('invalid read identifiers fail before any network request', async () => {
  for (const invoke of [s => s.kv.get({}), s => s.kv.get(''), s => s.fs.read('../a'), s => s.fs.stat(null), s => s.fs.readdir('a//')]) {
    let calls = 0;
    const storage = createPrivateStorage({ app: 'tasks', fetch: async () => { calls++; return session(); } });
    await assert.rejects(invoke(storage), { code: 'EINVAL' });
    assert.equal(calls, 0);
  }
});

test('single writes reject non-increasing acknowledgements without changing CAS or clearing failures', async () => {
  for (const kind of ['kv', 'file']) for (const tag of ['"0"', '"2"', '"01"', 'bad', null]) {
    const writes = [];
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => {
      if (url === '/api/session') return session();
      if (o.method === 'GET') return kind === 'kv' ? json({ value: '1' }) : new Response('old', { headers: { ETag: '"2"' } });
      writes.push(o);
      return tag === null ? new Response('{"ok":true}') : json({ ok: true }, writes.length === 1 ? tag : '"3"');
    } });
    if (kind === 'kv') await storage.kv.get('a'); else await storage.fs.read('a');
    const write = () => kind === 'kv' ? storage.kv.set('a', 2) : storage.fs.write('a', 'new');
    await assert.rejects(write(), { code: 'EPROTOCOL' });
    if (tag !== null) await write();
    assert.equal(writes.at(-1).headers['If-Match'], '"2"');
    assert.equal(storage.dirty, true);
    assert.equal(storage.error.code, 'EPROTOCOL');
  }
});

test('stat validates matching path, size and revision without acknowledging a baseline', async () => {
  for (const bad of [null, {}, { path: 'wrong', size: 1, modified: 2 }, { path: 'a', size: -1, modified: 2 }, { path: 'a', size: 1, modified: 3 }]) {
    const storage = createPrivateStorage({ app: 'tasks', fetch: async url => url === '/api/session' ? session() : json(bad) });
    await assert.rejects(storage.fs.stat('a'), { code: 'EPROTOCOL' });
  }
});

test('malformed JSON acknowledgements become visible protocol errors', async () => {
  const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => url === '/api/session' ? session() : o.method === 'GET' ? json({ value: null }, '"0"') : new Response('broken', { headers: { ETag: '"1"' } }) });
  await assert.rejects(storage.kv.set('a', 1), { code: 'EPROTOCOL' });
  assert.equal(storage.dirty, true);
});

test('KV wire values must be serialized JSON strings or missing null, never coerced native values', async () => {
  for (const bad of [{ value: 3 }, { value: false }, { value: {} }, { value: [] }, {}, null, { value: 'broken' }, { value: '1e999' }]) {
    let write;
    let reads = 0;
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => {
      if (url === '/api/session') return session();
      if (o.method === 'GET') return json(++reads === 1 ? bad : { value: null }, reads === 1 ? '"9"' : '"0"');
      write = o; return json({ ok: true }, '"1"');
    } });
    await assert.rejects(storage.kv.get('a'), { code: 'EPROTOCOL' });
    assert.equal(storage.error.code, 'EPROTOCOL');
    await storage.kv.set('a', 1);
    assert.equal(write.headers['If-Match'], '"0"', 'malformed reads never establish a baseline');
  }
});
