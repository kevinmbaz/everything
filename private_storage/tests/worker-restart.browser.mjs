// Isolated real Chromium regression; no apps, builds, backend or live services.
// Run: node --test private_storage/tests/worker-restart.browser.mjs
// Optional PLAYWRIGHT_MODULE (absolute path) and CHROMIUM_EXECUTABLE overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { privateStoragePlugin } from '../vite.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
  : '../../src/documents/node_modules/playwright/index.mjs');
const executablePath = process.env.CHROMIUM_EXECUTABLE || '/home/nadir/.hermes/tools/chromium-1208/chrome-linux/chrome';
const helper = await readFile(new URL('../browser.mjs', import.meta.url), 'utf8');
let privateWorker;
privateStoragePlugin({ cachePrefixes: ['fixture-'] }).generateBundle.call({ emitFile: asset => { privateWorker = asset.source; } });
const legacyWorker = `
self.addEventListener('install', event => event.waitUntil(caches.open('fixture-legacy').then(cache => cache.add('/legacy'))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') event.respondWith(caches.match('/legacy'));
});`;
const pageHtml = `<!doctype html><textarea id="draft">unsaved editor</textarea><script>
window.documentId = crypto.randomUUID(); window.changes = 0;
navigator.serviceWorker.addEventListener('controllerchange', () => { window.changes++; });
window.prepare = async () => {
  try { await (await import('/browser.mjs')).preparePrivateBrowser({cachePrefixes: ['fixture-']}); return 'ready'; }
  catch (error) { return error.code; }
};
</script>`;

async function fixture(t, legacy = false) {
  const errors = [];
  let worker = legacy ? legacyWorker : privateWorker;
  const server = http.createServer((req, res) => {
    const source = req.url === '/sw.js' ? worker : req.url === '/browser.mjs' ? helper : pageHtml;
    res.writeHead(200, { 'Content-Type': req.url.endsWith('.js') || req.url.endsWith('.mjs') ? 'text/javascript' : 'text/html', 'Cache-Control': 'no-store' });
    res.end(source);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const open = async (path = '/') => { const page = await context.newPage(); await page.goto(origin + path); return page; };
  return { context, open, origin, errors, usePrivate: () => { worker = privateWorker; } };
}

async function until(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function stopWorker(context, page) {
  const cdp = await context.newCDPSession(page);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  await until(() => [...versions.values()].some(v => v.status === 'activated' && v.runningStatus === 'running'), 'No running activated worker');
  const version = [...versions.values()].find(v => v.status === 'activated' && v.runningStatus === 'running');
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until(() => versions.get(version.versionId)?.runningStatus === 'stopped', 'Worker did not stop');
  await cdp.detach();
  return version.versionId;
}

const snapshot = page => page.evaluate(() => ({ id: window.documentId, changes: window.changes, draft: document.querySelector('#draft').value }));

test('prepared tab survives worker termination and another tab prepares without reload', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const first = await f.open();
  assert.equal(await first.evaluate(() => window.prepare()), 'ready');
  const before = await snapshot(first);
  const version = await stopWorker(f.context, first);
  t.diagnostic(`Confirmed worker version ${version} stopped with prepared document open`);
  const second = await f.open('/second');
  assert.equal(await second.evaluate(() => window.prepare()), 'ready');
  assert.deepEqual(await snapshot(first), before, 'Existing private draft/document must not reload or change controller');
  assert.equal(await second.evaluate(() => navigator.serviceWorker.controller.scriptURL), `${f.origin}/sw.js`);
  assert.deepEqual(f.errors, []);
});

test('restart never treats an unacknowledged controlled tab as private based on its URL', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const first = await f.open();
  assert.equal(await first.evaluate(() => window.prepare()), 'ready');
  const unacknowledged = await f.open('/legacy');
  assert.ok(await unacknowledged.evaluate(() => navigator.serviceWorker.controller));
  const before = await snapshot(unacknowledged);
  await stopWorker(f.context, first);
  const second = await f.open('/second');
  assert.equal(await second.evaluate(() => window.prepare()), 'EWORKERMIGRATION');
  assert.deepEqual(await snapshot(unacknowledged), before);
  await unacknowledged.close();
  assert.equal(await second.evaluate(() => window.prepare()), 'ready');
  assert.deepEqual(f.errors, []);
});

test('actual cached legacy navigation stays untouched until legacy tabs close naturally', { timeout: 45000 }, async t => {
  const f = await fixture(t, true);
  const legacy = await f.open('/legacy');
  await legacy.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
  await legacy.waitForFunction(() => !!navigator.serviceWorker.controller);
  await legacy.reload();
  await legacy.evaluate(() => {
    document.querySelector('#draft').value = 'legacy draft must survive';
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  });
  const before = await snapshot(legacy);
  f.usePrivate();
  await legacy.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await legacy.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
  assert.equal(await legacy.evaluate(() => window.prepare()), 'EWORKERMIGRATION');
  assert.deepEqual(await snapshot(legacy), before);
  assert.ok((await legacy.evaluate(() => caches.keys())).includes('fixture-legacy'));
  await legacy.close();
  const reopened = await f.open();
  assert.equal(await reopened.evaluate(() => window.prepare()), 'ready');
  assert.deepEqual(await reopened.evaluate(() => caches.keys()), []);
  assert.deepEqual(f.errors, []);
});
