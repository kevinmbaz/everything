import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateStorage } from '../client.mjs';
const json = (body, etag, status = 200) => new Response(JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });
const session = () => json({ username: 'Jetson storage', uuid: 'jetson-owner', storage: 'jetson', app: 'tasks' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('transactions and single writes serialize globally and capture caller values immediately', async () => {
  const gate = deferred();
  const started = deferred();
  const calls = [];
  let revision = 0;
  const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (url === '/api/session') return session();
    if (options.method === 'GET') return json({ value: null }, '"0"');
    if (options.method === 'PUT') { started.resolve(); await gate.promise; return json({ ok: true }, `"${++revision}"`); }
    const body = JSON.parse(options.body);
    return json({ ok: true, revisions: body.operations.map(o => ({ kind: o.kind, [o.kind === 'kv' ? 'key' : 'path']: o.key ?? o.path, etag: `"${++revision}"` })) });
  } });
  const first = storage.kv.set('a', 1);
  await started.promise;
  const native = { n: 2 };
  const operations = [{ kind: 'kv', key: 'a', method: 'PUT', value: native }, { kind: 'kv', key: 'b', method: 'PUT', value: null }];
  const transaction = storage.transaction(operations);
  native.n = 99;
  operations.reverse();
  const third = storage.kv.set('a', 3);
  assert.equal(calls.filter(c => c.method !== 'GET').length, 1);
  gate.resolve();
  await first;
  const result = await transaction;
  assert.equal(result.ok, true);
  await third;
  const mutations = calls.filter(c => c.method !== 'GET');
  assert.deepEqual(mutations.map(c => c.method), ['PUT', 'POST', 'PUT']);
  const body = JSON.parse(mutations[1].body);
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.operations, [{ kind: 'kv', key: 'a', method: 'PUT', ifMatch: '"1"', value: '{"n":2}' }, { kind: 'kv', key: 'b', method: 'PUT', ifMatch: '"0"', value: 'null' }]);
  assert.equal(mutations[1].headers['X-Everything-Request'], '1');
  assert.equal(mutations[1].headers['If-Match'], undefined);
  assert.equal(mutations[2].headers['If-Match'], '"2"');
  assert.equal(storage.dirty, false);
});

test('explicit transaction retries replay captured CAS and never lower newer baselines', async () => {
  const requests = [];
  let fail = true;
  let singleRevision = 5;
  const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, options) => {
    if (url === '/api/session') return session();
    if (options.method === 'GET') return json({ value: '0' }, '"2"');
    if (options.method === 'PUT') { requests.push(options); return json({ ok: true }, `"${++singleRevision}"`); }
    requests.push(options);
    if (fail) { fail = false; throw new TypeError('network lost after commit'); }
    return json({ ok: true, revisions: [{ kind: 'kv', key: 'a', etag: '"3"' }] });
  } });
  await storage.kv.get('a');
  const operations = [{ kind: 'kv', key: 'a', method: 'PUT', value: 1 }];
  await assert.rejects(storage.transaction(operations, { idempotencyKey: 'stable' }));
  assert.equal(storage.dirty, true);
  await storage.transaction(operations, { idempotencyKey: 'stable' });
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(storage.dirty, false);
  assert.equal(storage.error, null);
  await storage.kv.set('a', 2);
  await storage.transaction(operations, { idempotencyKey: 'stable' });
  assert.equal(requests[0].body, requests[3].body);
  await storage.kv.set('a', 3);
  assert.equal(requests[4].headers['If-Match'], '"6"');
  await assert.rejects(storage.transaction([{ ...operations[0], value: 9 }], { idempotencyKey: 'stable' }), { code: 'IDEMPOTENCY_MISMATCH' });
  assert.equal(requests.length, 5);
});

test('transaction response validates completely before any baseline is acknowledged', async () => {
  for (const bad of [
    { ok: false, revisions: [] },
    { ok: true, revisions: [{ kind: 'kv', key: 'a', etag: '"8"' }] },
    { ok: true, revisions: [{ kind: 'kv', key: 'a', etag: '"8"' }, { kind: 'kv', key: 'wrong', etag: '"9"' }] },
    { ok: true, revisions: [{ kind: 'kv', key: 'a', etag: '"8"' }, { kind: 'kv', key: 'b', etag: 'bad' }] },
    { ok: true, revisions: [{ kind: 'kv', key: 'a', etag: '"8"' }, { kind: 'kv', key: 'b', etag: '"2"' }] },
  ]) {
    const writes = [];
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => {
      if (url === '/api/session') return session();
      if (o.method === 'GET') return json({ value: '0' }, '"2"');
      if (o.method === 'POST') return json(bad);
      writes.push(o);
      return json({ ok: true }, '"10"');
    } });
    await storage.kv.get('a');
    await storage.kv.get('b');
    await assert.rejects(storage.transaction(['a', 'b'].map(key => ({ kind: 'kv', key, method: 'PUT', value: 1 }))), { code: 'EPROTOCOL' });
    await storage.kv.set('a', 2);
    assert.equal(writes[0].headers['If-Match'], '"2"');
    assert.equal(storage.dirty, true);
    assert.ok(storage.error);
  }
});

test('mixed transaction acknowledgements reject extra identity fields without changing any baseline', async () => {
  const good = [{ kind: 'kv', key: 'a', etag: '"3"' }, { kind: 'file', path: 'b', etag: '"4"' }];
  for (const revisions of [
    [good[0], { ...good[1], key: 'unexpected' }],
    [{ ...good[0], path: 'unexpected' }, good[1]],
    [good[0], { ...good[1], extra: true }],
    [good[0], { kind: 'file', key: 'b', etag: '"4"' }],
    [good[0], null],
    [good[0], { ...good[1], etag: '"2"' }],
    [good[0], good[0]],
  ]) {
    const writes = [];
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, options) => {
      if (url === '/api/session') return session();
      if (options.method === 'GET') return url.startsWith('/api/file?')
        ? new Response('old', { headers: { ETag: '"2"' } }) : json({ value: '0' }, '"2"');
      if (options.method === 'POST') return json({ ok: true, revisions });
      writes.push(options);
      return json({ ok: true }, '"10"');
    } });
    await storage.kv.get('a');
    await storage.fs.read('b');
    // Inspect both baselines even when the rejection itself has the wrong code.
    const error = await storage.transaction([
      { kind: 'kv', key: 'a', method: 'PUT', value: 1 },
      { kind: 'file', path: 'b', method: 'PUT', value: 'new' },
    ]).then(() => null, error => error);
    await storage.kv.set('a', 2);
    await storage.fs.write('b', 'later');
    assert.deepEqual(writes.map(write => write.headers['If-Match']), ['"2"', '"2"']);
    assert.equal(error?.code, 'EPROTOCOL');
    assert.equal(storage.dirty, true);
    assert.equal(storage.error, error);
  }
});

test('invalid transaction proposals fail locally while remaining unsaved', async () => {
  const valid = { kind: 'kv', key: 'a', method: 'PUT', value: 1 };
  for (const operations of [[], [valid, valid], [{ ...valid, ifMatch: '"0"' }], [{ ...valid, method: 'PATCH' }], [{ ...valid, kind: 'other' }], [{ kind: 'file', path: 'x', method: 'PUT', value: new Blob(['x']) }], [{ ...valid, value: undefined }], Array.from({ length: 513 }, (_, i) => ({ ...valid, key: String(i) }))]) {
    const calls = [];
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => { calls.push({ url, ...o }); return url === '/api/session' ? session() : json({ value: null }, '"0"'); } });
    await assert.rejects(storage.transaction(operations), { code: 'EINVAL' });
    assert.equal(calls.some(c => c.method === 'POST'), false);
    assert.equal(storage.dirty, true);
    assert.ok(storage.error);
  }
});
