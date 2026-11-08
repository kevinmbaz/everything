import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateStorage } from '../client.mjs';
const json = (body, etag, status = 200) => new Response(JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });
const session = () => json({ username: 'Jetson storage', uuid: 'jetson-owner', storage: 'jetson', app: 'tasks' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('conflicts latch for life and block queued writes or explicit stale retries', async () => {
  for (const status of [409, 412]) {
    let writes = 0;
    const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => {
      if (url === '/api/session') return session();
      if (o.method === 'GET') return json({ value: null }, '"0"');
      writes++;
      return json({ error: 'CONFLICT' }, '"8"', status);
    } });
    const outcomes = await Promise.allSettled([storage.kv.set('a', 1), storage.kv.set('b', 2)]);
    assert.ok(outcomes.every(r => r.status === 'rejected'));
    assert.equal(writes, 1);
    assert.equal(storage.conflict?.code, 'ECONFLICT');
    await storage.getUser();
    await storage.kv.get('a');
    await assert.rejects(storage.transaction([{ kind: 'kv', key: 'a', method: 'PUT', value: 1 }], { idempotencyKey: 'retry' }), { code: 'ECONFLICT' });
    assert.equal(writes, 1);
    assert.equal(storage.dirty, true);
    assert.equal(storage.error, storage.conflict);
  }
});

test('timed out writes stay uncertain and late success cannot acknowledge them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = deferred();
  const gate = deferred();
  let signal;
  const storage = createPrivateStorage({ app: 'tasks', fetch: async (url, o) => {
    if (url === '/api/session') return session();
    if (o.method === 'GET') return json({ value: null }, '"0"');
    signal = o.signal;
    started.resolve();
    return gate.promise;
  } });
  const writing = storage.kv.set('a', 1);
  const outcome = writing.then(() => ({ code: 'SUCCESS' }), error => error);
  await started.promise;
  t.mock.timers.tick(30_001);
  const error = await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve({ code: 'STILL_PENDING' })))]);
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(error.uncertain, true);
  assert.equal(signal.aborted, true);
  gate.resolve(json({ ok: true }, '"1"'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(storage.dirty, true);
  assert.equal(storage.error.code, 'ETIMEDOUT');
});
