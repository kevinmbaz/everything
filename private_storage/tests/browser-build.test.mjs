import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getEventListeners } from 'node:events';

test('migration reuses the stable worker URL after legacy tabs have closed', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const sw = new EventTarget(), registration = new EventTarget();
  const worker = { scriptURL: 'https://app.test/sw.js', state: 'activated', postMessage(_message, [port]) {
    port.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: true });
    port.close();
  } };
  sw.controller = worker;
  registration.active = worker;
  sw.register = async url => {
    assert.equal(url, worker.scriptURL, 'Changing the URL installs another waiting worker and demands a second close/reopen');
    return registration;
  };
  browserGlobals(t, sw, { keys: async () => [] });
  await preparePrivateBrowser({ cachePrefixes: ['tasks-'] });
});

test('prepared-page restart responder is scoped to the verified controller and does not accumulate', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const sw = new EventTarget(), registration = new EventTarget();
  let rechecks = 0;
  const worker = { scriptURL: 'https://app.test/sw.js', state: 'activated', postMessage(_message, ports) {
    if (!ports) { rechecks++; return; }
    ports[0].postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: true });
    ports[0].close();
  } };
  sw.controller = worker; registration.active = worker;
  sw.register = async () => registration;
  browserGlobals(t, sw, { keys: async () => [] });
  const request = (source = worker, version = 1) => {
    const event = new Event('message');
    event.source = source; event.data = { type: 'EVERYTHING_PRIVATE_RECHECK', version };
    sw.dispatchEvent(event);
  };
  request();
  assert.equal(rechecks, 0, 'Importing the helper alone does not opt a page in');
  await preparePrivateBrowser({ cachePrefixes: ['tasks-'] });
  await preparePrivateBrowser({ cachePrefixes: ['tasks-'] });
  assert.equal(getEventListeners(sw, 'message').length, 1);
  request({ ...worker }); request(worker, 2);
  assert.equal(rechecks, 0, 'A matching script URL is not proof of verified worker identity');
  request();
  assert.equal(rechecks, 1);
  sw.controller = { ...worker };
  request();
  assert.equal(rechecks, 1, 'Do not consent for a replaced controller');
  sw.controller = worker; registration.active = { ...worker };
  request();
  assert.equal(rechecks, 1, 'Do not consent for a replaced registration');
});

test('browser never reports ready if control changes while caches are being cleared', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const sw = new EventTarget(), registration = new EventTarget();
  const worker = { state: 'activated', scriptURL: 'https://app.test/sw.js', postMessage(_message, [port]) {
    sw.controller = worker;
    port.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: true }); port.close();
  } };
  registration.active = worker; sw.register = async () => registration;
  browserGlobals(t, sw, { keys: async () => { sw.controller = { scriptURL: 'https://app.test/unknown.js' }; return []; } });
  await assert.rejects(preparePrivateBrowser({ cachePrefixes: ['tasks-'] }), { code: 'EWORKERMIGRATION' });
});

test('a worker that disappears during activation rejects without uncaught event errors', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = new EventTarget(), registration = new EventTarget(), worker = new EventTarget();
  worker.scriptURL = 'https://app.test/sw.js'; worker.state = 'activating';
  worker.postMessage = () => { throw new Error('worker disappeared'); };
  registration.active = worker; sw.register = async () => registration;
  browserGlobals(t, sw, null);
  const outcome = preparePrivateBrowser({ cachePrefixes: ['tasks-'] }).catch(error => error);
  await new Promise(setImmediate);
  worker.state = 'activated';
  assert.doesNotThrow(() => getEventListeners(worker, 'statechange')[0]());
  const error = await outcome;
  assert.equal(error.code, 'EWORKERMIGRATION');
  assert.equal(getEventListeners(sw, 'controllerchange').length, 0);
});

test('worker registration failure is a useful fail-closed migration error', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  browserGlobals(t, { register: async () => { throw new Error('network denied'); } }, null);
  await assert.rejects(preparePrivateBrowser({ cachePrefixes: ['tasks-'] }), error => error.code === 'EWORKERMIGRATION' && error.cause?.message === 'network denied');
});

test('first install may briefly wait before natural activation without a legacy controller', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const sw = new EventTarget(), worker = new EventTarget(), registration = new EventTarget();
  worker.state = 'installed'; worker.scriptURL = 'https://app.test/sw.js';
  worker.postMessage = (_message, [port]) => { sw.controller = worker; sw.dispatchEvent(new Event('controllerchange')); port.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: true }); port.close(); };
  registration.waiting = worker;
  sw.register = async () => registration;
  browserGlobals(t, sw, { keys: async () => [] });
  let outcome = 'pending';
  const pending = preparePrivateBrowser({ cachePrefixes: ['tasks-'] }).then(() => { outcome = 'ready'; }, e => { outcome = e.code; });
  await new Promise(setImmediate);
  assert.equal(outcome, 'pending');
  registration.waiting = null; registration.active = worker; worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  await pending;
  assert.equal(outcome, 'ready');
});

test('browser and build reject unsafe cache prefixes before touching browser state', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const { privateStoragePlugin } = await import('../vite.mjs');
  let registered = 0;
  browserGlobals(t, { register() { registered++; throw new Error('unsafe registration'); } }, { keys() { throw new Error('unsafe cache clearing'); } });
  for (const cachePrefixes of [undefined, [], Array(1), [''], [' '], [' x'], ['*'], ['a/b'], ['a\n'], ['a', 1]]) {
    assert.throws(() => privateStoragePlugin({ cachePrefixes }), TypeError);
    await assert.rejects(preparePrivateBrowser({ cachePrefixes }), { code: 'EINVAL' });
  }
  assert.equal(registered, 0);
});

test('unsupported workers and out-of-origin worker URLs fail closed', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  browserGlobals(t, undefined, { keys() { throw new Error('must not clear caches'); } });
  await assert.rejects(preparePrivateBrowser({ cachePrefixes: ['tasks-'] }), { code: 'EWORKERMIGRATION' });
});

test('worker URLs must be same-origin and cover this page', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  let calls = 0;
  browserGlobals(t, { register() { calls++; throw new Error('unexpected register'); } }, null);
  for (const serviceWorkerUrl of ['http://[', 'https://elsewhere.test/sw.js', '/elsewhere/sw.js', 'https://name:pass@app.test/sw.js', '/sw.js#fragment']) {
    await assert.rejects(preparePrivateBrowser({ cachePrefixes: ['tasks-'], serviceWorkerUrl }), { code: 'EINVAL' });
  }
  assert.equal(calls, 0);
});

test('migration timeout releases channels and listeners and ignores late unknown-worker signals', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = new EventTarget(), registration = new EventTarget();
  let posted = 0, deleted = 0;
  const worker = { state: 'activated', scriptURL: 'https://app.test/sw.js', postMessage(_message, [port]) { posted++; port.close(); } };
  registration.active = worker;
  sw.register = async () => registration;
  browserGlobals(t, sw, { keys: async () => [], delete: async () => { deleted++; } });
  const outcome = preparePrivateBrowser({ cachePrefixes: ['tasks-'] }).catch(error => error);
  await new Promise(setImmediate);
  assert.equal(getEventListeners(sw, 'controllerchange').length, 1);
  t.mock.timers.tick(15_001);
  assert.equal((await outcome).code, 'EWORKERMIGRATION');
  assert.equal(getEventListeners(sw, 'controllerchange').length, 0);
  assert.equal(getEventListeners(registration, 'updatefound').length, 0);
  sw.controller = worker; sw.dispatchEvent(new Event('controllerchange'));
  assert.equal(posted, 1); assert.equal(deleted, 0);
});

test('private HTML preserves local analytics-named app modules', async () => {
  const { privateStoragePlugin } = await import('../vite.mjs');
  const plugin = privateStoragePlugin({ cachePrefixes: ['tasks-'] });
  const html = '<script src="/analytics.js"></script><script src="https://static.cloudflareinsights.com/beacon.min.js"></script>';
  assert.equal(plugin.transformIndexHtml.handler(html), '<script src="/analytics.js"></script>');
});

test('private HTML parses real attribute names and quoted values, not data siblings', async () => {
  const { privateStoragePlugin } = await import('../vite.mjs');
  const transform = privateStoragePlugin({ cachePrefixes: ['tasks-'] }).transformIndexHtml.handler;
  for (const tag of [
    '<script data-src="/placeholder.js" src="https://js.puter.com/v2/"></script>',
    "<script data-src='/placeholder.js' SRC='https://js.puter.com/v2/'></script>",
    '<script data-src=/placeholder.js src=//js.puter.com/v2/ ></script>',
    '<script title="src=\'local.js\' > placeholder" src="https://js.puter.com/v2/"></script>',
    '<script data-src="/analytics.js" src="https://plausible.io/js/script.js"></script>',
    '<link data-href="/placeholder" href="https://api.puter.com" rel="preconnect">',
    "<link data-rel='stylesheet' rel='dns-prefetch' data-href='/placeholder' href='//js.puter.com'>",
    '<link title="href=\'local\' > placeholder" rel=preconnect href=//api.puter.com >',
  ]) assert.equal(transform(tag), '', tag);
  for (const tag of [
    '<script data-src="https://js.puter.com/v2/" src="/analytics.js"></script>',
    '<script title="src=\'https://js.puter.com/v2/\'" src="/analytics.js"></script>',
    '<link data-href="https://api.puter.com" rel="preconnect" href="/analytics.css">',
    '<link data-rel="preconnect" rel="stylesheet" href="https://api.puter.com/style.css">',
  ]) assert.equal(transform(tag), tag, tag);
});

async function emittedWorker() {
  const { privateStoragePlugin } = await import('../vite.mjs');
  const plugin = privateStoragePlugin({ cachePrefixes: ['tasks-shell-'] });
  const assets = [];
  plugin.generateBundle.call({ emitFile: asset => assets.push(asset) });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].fileName, 'sw.js');
  return assets[0].source;
}

test('retirement worker never force-activates or claims another legacy editor', async () => {
  const source = await emittedWorker();
  const handlers = {};
  let skip = 0, claim = 0;
  const removed = [];
  const own = { id: 'private', url: 'https://app.test/' };
  const legacy = { id: 'legacy', url: 'https://app.test/edit' };
  const self = {
    registration: { scope: 'https://app.test/' },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    skipWaiting: () => { skip++; },
    clients: { claim: async () => { claim++; }, matchAll: async () => [own, legacy] },
  };
  vm.runInNewContext(source, { self, URL, caches: { keys: async () => ['tasks-shell-v1', 'other-cache'], delete: async name => removed.push(name) } });
  async function fire(name, extra = {}) { let pending; handlers[name]?.({ ...extra, waitUntil: promise => { pending = promise; } }); await pending; }
  await fire('install');
  await fire('activate');
  await fire('message', { data: { type: 'EVERYTHING_PRIVATE_READY', version: 1 }, source: own, ports: [{ postMessage() {} }] });
  assert.equal(skip, 0);
  assert.equal(claim, 0);
  assert.deepEqual(removed, ['tasks-shell-v1']);
  assert.equal(handlers.fetch, undefined, 'network only: no cached fetch handler');
});

test('active network worker claims only after every scoped window explicitly opts in', async () => {
  const source = await emittedWorker();
  const handlers = {};
  let claims = 0;
  const windows = [{ id: 'a', url: 'https://app.test/' }, { id: 'b', url: 'https://app.test/editor' }, { id: 'outside', url: 'https://other.test/' }];
  const replies = [];
  const self = { registration: { scope: 'https://app.test/' }, addEventListener: (name, fn) => { handlers[name] = fn; }, clients: { matchAll: async () => windows, claim: async () => { claims++; } } };
  vm.runInNewContext(source, { self, URL, caches: { keys: async () => [] } });
  assert.equal(typeof handlers.message, 'function');
  async function ready(source) { let pending; handlers.message({ source, data: { type: 'EVERYTHING_PRIVATE_READY', version: 1 }, ports: [{ postMessage: data => replies.push(data) }], waitUntil: p => { pending = p; } }); await pending; }
  await ready(windows[0]);
  assert.equal(claims, 0);
  await ready(windows[1]);
  assert.equal(claims, 1);
  assert.equal(replies.at(-1).type, 'EVERYTHING_PRIVATE_NETWORK_ONLY');
  assert.equal(replies.at(-1).version, 1);
  assert.equal(replies.at(-1).ready, true);
});

test('private HTML strips Puter and analytics but keeps app scripts and cosmetic preferences', async () => {
  const { privateStoragePlugin } = await import('../vite.mjs');
  const plugin = privateStoragePlugin({ cachePrefixes: ['tasks-shell-'] });
  const html = `<head><link crossorigin href='https://api.puter.com' rel='preconnect'><link rel="dns-prefetch" href="//js.puter.com"><script defer src='https://js.puter.com/v2/'></script><script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script><script>window.dataLayer=[];gtag('config','G-X')</script><script>localStorage.getItem('theme')</script><script type="module" src="/src/main.js"></script><link rel="stylesheet" href="/style.css"></head>`;
  const result = plugin.transformIndexHtml.handler(html);
  assert.doesNotMatch(result, /puter\.com|googletagmanager|gtag\(/);
  assert.match(result, /localStorage.getItem/);
  assert.match(result, /\/src\/main.js/);
  assert.match(result, /style.css/);
  for (const cachePrefixes of [undefined, [''], ['safe', ''], 'all']) assert.throws(() => privateStoragePlugin({ cachePrefixes }));
});

function browserGlobals(t, serviceWorker, caches) {
  for (const [name, value] of Object.entries({ navigator: { serviceWorker }, location: { href: 'https://app.test/' }, caches })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
}

test('browser preparation waits for acknowledged network control and clears only owned caches', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const serviceWorker = new EventTarget();
  const deleted = [];
  let registered;
  const worker = { scriptURL: 'https://app.test/sw.js', state: 'activated', postMessage(message, [port]) {
    assert.equal(message.type, 'EVERYTHING_PRIVATE_READY');
    serviceWorker.controller = worker;
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    port.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: true });
    port.close();
  } };
  serviceWorker.controller = null;
  serviceWorker.register = async (url, options) => { registered = { url, options }; return { active: worker, addEventListener() {}, removeEventListener() {} }; };
  browserGlobals(t, serviceWorker, { keys: async () => ['tasks-shell-1', 'expense-shell-1'], delete: async key => { deleted.push(key); return true; } });
  await preparePrivateBrowser({ cachePrefixes: ['tasks-shell-'] });
  assert.equal(registered.url, worker.scriptURL);
  assert.equal(registered.options.updateViaCache, 'none');
  assert.deepEqual(deleted, ['tasks-shell-1']);
  assert.equal(serviceWorker.controller, worker);
});

test('legacy waiting worker fails closed without claiming, unregistering, deleting caches or reloading', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const serviceWorker = new EventTarget();
  let messages = 0;
  const old = { scriptURL: 'https://app.test/sw.js', postMessage(message, ports) { messages++; ports[0].close(); } };
  serviceWorker.controller = old;
  serviceWorker.register = async () => ({ active: old, waiting: { scriptURL: 'https://app.test/sw.js' }, addEventListener() {}, removeEventListener() {} });
  browserGlobals(t, serviceWorker, { keys() { throw new Error('must not clear legacy cache before safety gate'); } });
  const outcome = preparePrivateBrowser({ cachePrefixes: ['tasks-shell-'] }).catch(error => error);
  const error = await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve(new Error('STILL_PENDING'))))]);
  assert.match(error.message, /save\/export.*close.*tabs.*reopen/i);
  assert.equal(error.code, 'EWORKERMIGRATION');
  assert.equal(serviceWorker.controller, old);
  assert.equal(messages, 0);
});

test('browser waits through installation and delayed controllerchange before resolving', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  const serviceWorker = new EventTarget();
  const worker = new EventTarget();
  const registration = new EventTarget();
  worker.scriptURL = 'https://app.test/sw.js';
  worker.state = 'installing';
  let resolvePosted;
  const posted = new Promise(resolve => { resolvePosted = resolve; });
  worker.postMessage = (message, [port]) => { port.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: true }); port.close(); resolvePosted(); };
  registration.installing = worker;
  registration.active = null;
  serviceWorker.register = async () => registration;
  browserGlobals(t, serviceWorker, { keys: async () => [] });
  let done = false;
  const preparing = preparePrivateBrowser({ cachePrefixes: ['tasks-shell-'] });
  const outcome = preparing.then(() => { done = true; }, error => { done = error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  registration.active = worker;
  registration.installing = null;
  worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  await posted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  serviceWorker.controller = worker;
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  await outcome;
  assert.equal(done, true);
});

test('browser migration has a bounded fail-closed deadline even for a hanging registration', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = new EventTarget();
  sw.register = () => new Promise(() => {});
  browserGlobals(t, sw, { keys: async () => [] });
  const outcome = preparePrivateBrowser({ cachePrefixes: ['tasks-shell-'] }).catch(error => error);
  t.mock.timers.tick(15_001);
  const error = await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve({ code: 'STILL_PENDING' })))]);
  assert.equal(error.code, 'EWORKERMIGRATION');
  assert.match(error.message, /save\/export.*close.*tabs.*reopen/i);
});

test('browser waits for activation and retries a not-ready handshake without leaking listeners', async t => {
  const { preparePrivateBrowser } = await import('../browser.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sw = new EventTarget(), worker = new EventTarget(), registration = new EventTarget();
  let posts = 0;
  worker.scriptURL = 'https://app.test/sw.js';
  worker.state = 'activating';
  worker.postMessage = (message, [port]) => {
    posts++;
    if (posts > 1) { sw.controller = worker; sw.dispatchEvent(new Event('controllerchange')); }
    port.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready: posts > 1 });
    port.close();
  };
  registration.active = worker;
  sw.register = async () => registration;
  browserGlobals(t, sw, { keys: async () => [] });
  const preparing = preparePrivateBrowser({ cachePrefixes: ['tasks-shell-'] });
  await new Promise(setImmediate);
  assert.equal(posts, 0, 'do not handshake before activation completes');
  worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  t.mock.timers.tick(501);
  await preparing;
  assert.equal(posts, 2);
  sw.dispatchEvent(new Event('controllerchange'));
  t.mock.timers.tick(20_000);
  assert.equal(posts, 2);
});
