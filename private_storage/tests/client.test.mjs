import test from 'node:test';
import assert from 'node:assert/strict';

const json = (body, etag, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(etag ? { ETag: etag } : {}) } });
const user = { username: 'Jetson storage', uuid: 'jetson-owner', storage: 'jetson', app: 'tasks' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function adapter(handler) {
  const { createPrivateStorage } = await import('../client.mjs');
  const calls = [];
  const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, options) => {
    calls.push({ url, ...options });
    return handler(url, options, calls);
  } });
  return { storage, calls };
}

test('native KV reads share a real same-origin app-scoped session', async () => {
  const gate = deferred();
  const { storage, calls } = await adapter(url => url === '/api/session' ? gate.promise : json({ value: '{"n":2}' }, '"4"'));
  const a = storage.kv.get('a');
  const b = storage.kv.get('b');
  gate.resolve(json(user));
  assert.deepEqual(await a, { n: 2 });
  assert.deepEqual(await b, { n: 2 });
  assert.equal(await storage.auth.isSignedIn(), true);
  assert.deepEqual(await storage.getUser(), user);
  assert.equal(storage.mode, 'private');
  assert.equal(calls.filter(c => c.url === '/api/session').length, 1);
  for (const c of calls) {
    assert.equal(c.credentials, 'same-origin');
    assert.equal(c.cache, 'no-store');
    assert.equal(c.redirect, 'error');
  }
});

test('invalid or denied session is memoized and remains a visible read error', async () => {
  for (const reply of [json({ ...user, app: 'expense' }), json({ ...user, storage: 'cloud' }), json({ ...user, uuid: '' }), json({ error: 'denied' }, null, 403)]) {
    const { storage, calls } = await adapter(() => reply);
    await assert.rejects(storage.kv.get('a'));
    await assert.rejects(storage.auth.isSignedIn());
    assert.equal(calls.length, 1);
    assert.ok(storage.error);
    assert.equal(storage.dirty, false);
  }
});

test('writes capture native JSON once and retain first read revision across later reads', async () => {
  let reads = 0;
  let writes = 0;
  const { storage, calls } = await adapter((url, options) => {
    if (url === '/api/session') return json(user);
    if (options.method === 'GET') return json({ value: '{"old":true}' }, ++reads === 1 ? '"2"' : '"7"');
    return json({ ok: true }, ++writes === 1 ? '"8"' : '"9"');
  });
  await storage.kv.get('a');
  await storage.kv.get('a');
  const value = { native: [1, null, true] };
  const writing = storage.kv.set('a', value);
  value.native.push('late');
  assert.equal(storage.dirty, true);
  assert.equal(await writing, true);
  await storage.kv.del('a');
  const mutations = calls.filter(c => c.method !== 'GET');
  assert.equal(mutations[0].headers['If-Match'], '"2"');
  assert.equal(mutations[0].headers['X-Everything-Request'], '1');
  assert.deepEqual(JSON.parse(mutations[0].body), { value: '{"native":[1,null,true]}' });
  assert.equal(mutations[1].headers['If-Match'], '"8"');
  assert.equal(mutations[1].method, 'DELETE');
  assert.equal(storage.dirty, false);
});

test('only missing resources can be written without an actual document read', async () => {
  for (const method of ['set', 'del']) {
    const { storage, calls } = await adapter(url => url === '/api/session' ? json(user) : json({ value: 'null' }, '"5"'));
    await assert.rejects(storage.kv[method]('existing', null), { code: 'EUNREAD' });
    await assert.rejects(storage.kv[method]('existing', null), { code: 'EUNREAD' });
    assert.equal(calls.some(c => c.method !== 'GET'), false);
    assert.equal(storage.dirty, true);
  }
  const { storage, calls } = await adapter((url, o) => url === '/api/session' ? json(user) : o.method === 'GET' ? json({ value: null }, '"6"') : json({ ok: true }, '"7"'));
  await storage.kv.set('new', null);
  assert.equal(calls.at(-1).headers['If-Match'], '"6"');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { value: 'null' });
});

test('binary files preserve bytes and stat never changes a read baseline', async () => {
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const { storage, calls } = await adapter((url, o) => {
    if (url === '/api/session') return json(user);
    if (o.method !== 'GET') return json({ ok: true }, o.method === 'DELETE' ? '"10"' : '"9"');
    if (url.includes('stat=1')) return json({ path: 'p.bin', size: 4, modified: 8 }, '"8"');
    return new Response(bytes, { headers: { ETag: '"3"', 'Content-Type': 'image/png' } });
  });
  const blob = await storage.fs.read('p.bin');
  assert.ok(blob instanceof Blob);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal((await storage.fs.stat('p.bin')).modified, 8);
  assert.deepEqual(await storage.fs.write('p.bin', blob), { path: 'p.bin', size: 4, modified: 9 });
  assert.equal(calls.at(-1).headers['If-Match'], '"3"');
  assert.equal(calls.at(-1).headers['Content-Type'], 'image/png');
  await storage.fs.delete('p.bin');
  assert.equal(calls.at(-1).headers['If-Match'], '"9"');
});

test('missing file reads are expected and unread existing file mutations are refused', async () => {
  for (const method of ['write', 'delete']) {
    const { storage, calls } = await adapter(url => url === '/api/session' ? json(user) : json({ path: 'x', size: 1, modified: 4 }, '"4"'));
    await storage.fs.stat('x');
    await assert.rejects(method === 'write' ? storage.fs.write('x', 'new') : storage.fs.delete('x'), { code: 'EUNREAD' });
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  }
  const { storage, calls } = await adapter((url, o) => url === '/api/session' ? json(user) : o.method === 'GET' ? json({ error: 'ENOENT' }, '"5"', 404) : json({ ok: true }, '"6"'));
  await assert.rejects(storage.fs.read('missing'), { code: 'ENOENT' });
  assert.equal(storage.error, null);
  await storage.fs.write('missing', 'é');
  assert.equal(calls.at(-1).headers['If-Match'], '"5"');
  assert.equal(storage.dirty, false);
});
