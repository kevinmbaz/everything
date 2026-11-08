// Document-lifetime consent, not persistent storage or a worker-URL heuristic.
const preparedResponders = new WeakMap();

/** Run before authentication or any data reads; never reload an editor. */
export async function preparePrivateBrowser({ cachePrefixes, serviceWorkerUrl = '/sw.js' } = {}) {
  const invalid = message => Object.assign(new TypeError(message), { code: 'EINVAL' });
  if (!Array.isArray(cachePrefixes) || !cachePrefixes.length || [...cachePrefixes].some(p => typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p))) throw invalid('Explicit nonempty app-owned cache prefixes are required');
  cachePrefixes = [...cachePrefixes];
  const serviceWorker = globalThis.navigator?.serviceWorker;
  if (typeof serviceWorker?.register !== 'function' || typeof globalThis.MessageChannel !== 'function') throw Object.assign(new Error('Private storage requires service workers in a supported secure browser. No data was read.'), { code: 'EWORKERMIGRATION' });
  if (typeof serviceWorkerUrl !== 'string' || !serviceWorkerUrl) throw invalid('Expected a same-origin worker URL');
  let script;
  try { script = new URL(serviceWorkerUrl, globalThis.location.href); }
  catch { throw invalid('Expected a valid same-origin worker URL'); }
  const page = new URL(globalThis.location.href);
  if (!['http:', 'https:'].includes(script.protocol) || script.origin !== page.origin || script.username || script.password || script.hash || !page.href.startsWith(new URL('./', script).href)) throw invalid('Worker URL must be same-origin and cover this page');
  // Keep the existing scope's stable script URL. A new query would install
  // a second waiting worker even after the legacy tabs have safely closed.
  // The message handshake below verifies the active worker's private behavior.
  const cleanup = [];
  let expired = false;
  const migrationError = () => Object.assign(new Error('Save/export your edits, close ALL app tabs, then reopen the app to finish private storage migration.'), { code: 'EWORKERMIGRATION' });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(migrationError()); }, 15_000);
  });
  const prepare = async () => {
    const registration = await serviceWorker.register(script.href, { scope: new URL('./', script).href, updateViaCache: 'none' });
    if (expired) throw migrationError();
    let verifiedWorker;

    await new Promise((resolve, reject) => {
      let finished = false;
      const contacted = new Set();
      const acknowledged = new Set();
      const observed = new Set();
      const listen = (target, type, listener) => {
        target.addEventListener(type, listener);
        cleanup.push(() => target.removeEventListener(type, listener));
      };
      const finish = error => {
        if (finished || expired) return;
        finished = true;
        for (const dispose of cleanup) dispose();
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (finished || expired) return;
        if (registration.waiting && (registration.active || serviceWorker.controller)) return finish(migrationError());
        const installing = registration.installing || registration.waiting;
        if (installing && !observed.has(installing)) {
          observed.add(installing);
          listen(installing, 'statechange', check);
        }
        const worker = registration.active;
        if (!worker || worker.scriptURL !== script.href) return;
        if (worker.state !== 'activated' && !observed.has(worker)) {
          observed.add(worker);
          listen(worker, 'statechange', check);
        }
        if (worker.state !== 'activated') return;
        if (acknowledged.has(worker) && serviceWorker.controller === worker) { verifiedWorker = worker; return finish(); }
        if (contacted.has(worker)) return;
        contacted.add(worker);
        const channel = new MessageChannel();
        cleanup.push(() => { channel.port1.close(); channel.port2.close(); });
        channel.port1.onmessage = event => {
          if (finished || expired) return;
          if (event.data?.type === 'EVERYTHING_PRIVATE_NETWORK_ONLY' && event.data.version === 1 && event.data.ready === true) {
            acknowledged.add(worker);
            check();
          } else if (event.data?.type === 'EVERYTHING_PRIVATE_NETWORK_ONLY' && event.data.version === 1 && event.data.ready === false) {
            channel.port1.close(); channel.port2.close();
            const retry = setTimeout(() => { contacted.delete(worker); check(); }, 250);
            cleanup.push(() => clearTimeout(retry));
          }
        };
        try { worker.postMessage({ type: 'EVERYTHING_PRIVATE_READY', version: 1 }, [channel.port2]); }
        catch (error) { finish(error); }
      };
      listen(serviceWorker, 'controllerchange', check);
      listen(registration, 'updatefound', check);
      check();
    });
    if (globalThis.caches) {
      const names = await globalThis.caches.keys();
      if (expired) throw migrationError();
      await Promise.all(names.filter(name => cachePrefixes.some(prefix => name.startsWith(prefix))).map(name => globalThis.caches.delete(name)));
    }
    if (expired || serviceWorker.controller !== verifiedWorker || verifiedWorker.state !== 'activated') throw migrationError();
    // Keep this one listener after preparation: worker globals can be discarded
    // while this safely prepared document (and its unsaved edits) remains open.
    const respond = event => {
      if (event.data?.type !== 'EVERYTHING_PRIVATE_RECHECK' || event.data.version !== 1 || event.source !== verifiedWorker || serviceWorker.controller !== verifiedWorker || registration.active !== verifiedWorker || verifiedWorker.state !== 'activated') return;
      try { verifiedWorker.postMessage({ type: 'EVERYTHING_PRIVATE_READY', version: 1 }); } catch {}
    };
    const previous = preparedResponders.get(serviceWorker);
    if (previous) serviceWorker.removeEventListener('message', previous);
    serviceWorker.addEventListener('message', respond);
    preparedResponders.set(serviceWorker, respond);
  };
  try { await Promise.race([prepare(), deadline]); }
  catch (error) { throw error?.code === 'EWORKERMIGRATION' ? error : Object.assign(migrationError(), { cause: error }); }
  finally { clearTimeout(timer); for (const dispose of cleanup) dispose(); }
}
