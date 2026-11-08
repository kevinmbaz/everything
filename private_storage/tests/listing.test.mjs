import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateStorage } from '../client.mjs';
const json = (data, etag) => new Response(JSON.stringify(data), { headers: etag ? { ETag: etag } : {} });
const user = { username: 'Jetson storage', uuid: 'jetson-owner', storage: 'jetson', app: 'expense' };
const file = (path, n = 7) => ({ path, size: 12, modified: n, etag: `"${n}"` });
function adapter(files) {
  const calls = [];
  const storage = createPrivateStorage({ app: 'expense', fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (url === '/api/session') return json(user);
    if (url.startsWith('/api/files?')) return json({ files });
    if (options.method !== 'GET') return json({ ok: true }, '"10"');
    if (url.includes('stat=1')) return json({ path: 'root/a.json', size: 12, modified: 7 }, '"7"');
    return new Response('data', { headers: { ETag: '"2"' } });
  } });
  return { storage, calls };
}

test('readdir projects flat descendants to immediate files and unique virtual directories', async () => {
  const { storage, calls } = adapter([file('root/z/two'), file('root/a.json'), file('root/z/deeper/one')]);
  assert.deepEqual(await storage.fs.readdir('root'), [
    { name: 'a.json', path: 'root/a.json', is_dir: false, size: 12, modified: 7, etag: '"7"' },
    { name: 'z', path: 'root/z', is_dir: true },
  ]);
  assert.equal(calls[1].url, '/api/files?prefix=root%2F');
  assert.equal(storage.error, null);
});

test('listing never establishes or advances a document write baseline', async () => {
  const { storage, calls } = adapter([file('root/a.json')]);
  await storage.fs.readdir('root/');
  await assert.rejects(storage.fs.write('root/a.json', 'new'), { code: 'EUNREAD' });
  await storage.fs.read('root/a.json');
  await storage.fs.readdir('root/');
  await storage.fs.write('root/a.json', 'new');
  assert.equal(calls.at(-1).headers['If-Match'], '"2"');
  assert.equal(storage.dirty, true, 'unrelated successful write cannot hide earlier rejected mutation');
});

test('malformed or escaping descendant listings fail visibly without partial results', async () => {
  for (const files of [null, {}, [file('elsewhere/a')], [file('root/../a')], [file('root//a')], [file('root/a/./b')], [file('root/a\\b')], [file('root/a%2fb')], [file('root/a?b')], [file('root/a'), file('root/a')], [file('root/a'), file('root/a/b')], [{ ...file('root/a'), size: -1 }], [{ ...file('root/a'), etag: 'bad' }], [{ ...file('root/a'), modified: 8 }]]) {
    const { storage } = adapter(files);
    await assert.rejects(storage.fs.readdir('root/'), { code: 'EPROTOCOL' });
    assert.equal(storage.error.code, 'EPROTOCOL');
    assert.equal(storage.dirty, false);
  }
});
