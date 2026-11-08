/**
 * Same-origin private storage; no cloud SDK or cloud authentication.
 *
 * API (all methods return promises):
 *   getUser() -> the server's { username, storage: 'jetson' } session
 *   kv.get(key) -> string | null; kv.set(key, string) -> true
 *   fs.read(path) -> Blob; fs.stat(path) -> { path, size }
 *   fs.write(path, Blob|string, options?) -> { path }
 *   fs.delete(path, { recursive?: boolean }?) -> true
 * Unknown options, including createMissingParents, are ignored: these are
 * logical resources, not host filesystem paths. Recursive deletion accepts
 * subfolders of invoicing-data and deletes only the listed snapshot's files.
 *
 * A 409 locks ALL mutations until a successful explicit getUser() call.
 * Reads never unlock it. Store.init must discard its cached/unsaved data and
 * reload after getUser(), before permitting edits; never poll getUser() as a
 * background health check. Reload invalidates old queued/in-flight results,
 * but cannot undo requests already committed by the server.
 *
 * Optional onConflict(error) is notified once per latch, immediately upon
 * receiving 409 headers (before the detailed server error body arrives).
 * Callback exceptions/rejections are ignored; there is no automatic reload
 * or retry. Requests time out after 30 seconds, including body consumption.
 */
export function createPrivateStorage({ fetch = globalThis.fetch, onConflict } = {}) {
  const revisions = new Map();
  const queues = new Map();
  let conflict = null;
  let generation = 0;
  const urlFor = (kind, params) => `/api/${kind}?${new URLSearchParams(params)}`;
  function checkGeneration(epoch) {
    if (epoch !== generation) {
      throw Object.assign(new Error('Storage was reloaded; discard stale data and reload before saving.'), { code: 'ESTALE' });
    }
  }
  function remember(id, response, epoch) {
    checkGeneration(epoch);
    revisions.set(id, validETag(response.headers.get('ETag')));
  }
  function validETag(etag) {
    if (typeof etag !== 'string' || !/^"\d+"$/.test(etag)) {
      throw Object.assign(new Error('Storage response is missing a valid quoted revision ETag.'), { code: 'EPROTOCOL' });
    }
    return etag;
  }

  function enqueue(id, operation, epoch = generation) {
    const result = (queues.get(id) || Promise.resolve()).then(() => {
      checkGeneration(epoch);
      return operation(epoch);
    });
    const settled = result.then(() => {}, () => {});
    queues.set(id, settled);
    void settled.then(() => {
      if (queues.get(id) === settled) queues.delete(id);
    });
    return result;
  }

  async function getKV(key, epoch = generation) {
    const { response, data: { value } } = await request(urlFor('kv', { key }), {}, undefined, epoch, 'json');
    remember(`kv:${key}`, response, epoch);
    return value;
  }

  async function setKV(key, value, epoch) {
    if (conflict) throw conflict;
    const id = `kv:${key}`;
    if (!revisions.has(id)) await getKV(key, epoch);
    const { response } = await request(urlFor('kv', { key }), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Invoicing-Request': '1',
        'If-Match': revisions.get(id),
      },
      body: JSON.stringify({ value }),
    }, undefined, epoch);
    remember(id, response, epoch);
    return true;
  }

  async function readFile(path, stat = false, epoch = generation) {
    const { response, data } = await request(urlFor('file', { path, ...(stat ? { stat: '1' } : {}) }), {}, `file:${path}`, epoch, stat ? 'json' : 'blob');
    remember(`file:${path}`, response, epoch);
    return data;
  }

  async function mutateFile(path, method, data, epoch, snapshotETag) {
    if (conflict) throw conflict;
    const id = `file:${path}`;
    if (snapshotETag === undefined && !revisions.has(id)) {
      try { await readFile(path, true, epoch); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const { response } = await request(urlFor('file', { path }), {
      method,
      headers: {
        'Content-Type': typeof data === 'string' ? 'text/plain;charset=UTF-8' : data?.type || 'application/octet-stream',
        'X-Invoicing-Request': '1',
        'If-Match': snapshotETag ?? revisions.get(id),
      },
      body: data,
    }, undefined, epoch);
    remember(id, response, epoch);
    return method === 'PUT' ? { path } : true;
  }

  function validDataPath(path) {
    return typeof path === 'string' && path.startsWith('invoicing-data/')
      && !/[\\\u0000-\u001f\u007f]/.test(path)
      && path.split('/').every((part) => part && part !== '.' && part !== '..');
  }

  async function deleteFiles(path, options) {
    const epoch = generation;
    if (conflict) throw conflict;
    if (!options?.recursive) {
      return enqueue(`file:${path}`, () => mutateFile(path, 'DELETE', undefined, epoch), epoch);
    }
    const folder = typeof path === 'string' && path.endsWith('/') ? path.slice(0, -1) : path;
    if (!validDataPath(folder)) {
      throw Object.assign(new Error('Recursive deletion requires a subfolder of invoicing-data.'), { code: 'EINVAL' });
    }
    const prefix = `${folder}/`;
    const { data: { files } } = await request(urlFor('files', { prefix }), {}, undefined, epoch, 'json');
    for (const file of files) {
      if (!validDataPath(file?.path) || !file.path.startsWith(prefix)) {
        throw Object.assign(new Error('Storage listing contains a file outside the requested folder.'), { code: 'EPROTOCOL' });
      }
      validETag(file.etag);
    }
    for (const file of files) {
      await enqueue(`file:${file.path}`, () => mutateFile(file.path, 'DELETE', undefined, epoch, file.etag), epoch);
    }
    return true;
  }

  async function request(url, options = {}, missingId, epoch = generation, read) {
    checkGeneration(epoch);
    if (options.method && options.method !== 'GET' && conflict) throw conflict;
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error('Storage request timed out after 30 seconds.'), { code: 'ETIMEDOUT' });
        controller.abort(error);
        reject(error);
      }, 30_000);
    });
    const checkCurrent = () => {
      checkGeneration(epoch);
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const perform = async () => {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
      });
      checkCurrent();
      if (!response.ok) {
        // Lock as soon as the status arrives, even if reading its body fails.
        if (response.status === 409 && !conflict) {
          conflict = Object.assign(new Error('Storage changed on another device; reload before saving.'), {
            code: 'ECONFLICT', status: 409,
          });
          if (typeof onConflict === 'function') {
            try {
              // Neither a throwing UI handler nor an async rejection may hide
              // the storage conflict, and notification must never block I/O.
              Promise.resolve(onConflict(conflict)).catch(() => {});
            } catch { /* The request still rejects with its actual error. */ }
          }
        }
        const text = await response.text();
        checkCurrent();
        if (response.status === 404 && missingId) remember(missingId, response, epoch);
        let body;
        try { body = JSON.parse(text); } catch { /* Non-JSON server error. */ }
        const message = (typeof body?.error === 'string' ? body.error : body?.error?.message)
          || body?.message || text || `Storage request failed (HTTP ${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        error.code = response.status === 404 ? 'ENOENT' : body?.code || body?.error?.code;
        if (response.status === 409) {
          error.code ||= 'ECONFLICT';
          conflict = error;
        }
        if (error.code === 'ENOENT' && !/no such file|not found|does not exist/i.test(message)) {
          error.message = `File not found: ${message}`;
        }
        throw error;
      }
      const data = read ? await response[read]() : undefined;
      checkCurrent();
      return { response, data };
    };
    try {
      return await Promise.race([perform(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kv: {
      get: (key) => enqueue(`kv:${key}`, (epoch) => getKV(key, epoch)),
      set: (key, value) => enqueue(`kv:${key}`, (epoch) => setKV(key, value, epoch)),
    },
    fs: {
      read: (path) => enqueue(`file:${path}`, (epoch) => readFile(path, false, epoch)),
      write: (path, data) => enqueue(`file:${path}`, (epoch) => mutateFile(path, 'PUT', data, epoch)),
      delete: deleteFiles,
      stat: (path) => enqueue(`file:${path}`, (epoch) => readFile(path, true, epoch)),
    },
    async getUser() {
      const epoch = generation;
      const { data: user } = await request('/api/session', {}, undefined, epoch, 'json');
      if (typeof user?.username !== 'string' || !user.username || user.storage !== 'jetson') {
        throw Object.assign(new Error('Invalid private storage session response.'), { code: 'EPROTOCOL' });
      }
      checkGeneration(epoch);
      generation++;
      revisions.clear();
      conflict = null;
      return user;
    },
  };
}
