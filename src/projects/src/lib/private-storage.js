/**
 * Authenticated same-origin storage, without the Puter SDK.
 * Baselines are sticky: reads (especially stat and daily snapshots) NEVER
 * advance an existing write revision. Only acknowledged writes advance it.
 * A conflict locks this adapter for its lifetime; export edits, then explicitly
 * reload the page to get a fresh adapter. getUser is not a reset operation.
 */
export function createPrivateStorage({ fetch = globalThis.fetch } = {}) {
  let session;
  let conflict = null;
  let lastError = null;
  const readErrors = new Map();
  const revisions = new Map();
  const queues = new Map();
  const pending = new Map();
  const events = new EventTarget();
  const urlFor = (kind, params) => `/api/${kind}?${new URLSearchParams(params)}`;
  const notify = () => events.dispatchEvent(new Event('state'));
  const protocolError = (message) => Object.assign(new Error(message), { code: 'EPROTOCOL' });
  function revision(response) {
    const etag = response.headers.get('ETag');
    if (!/^"\d+"$/.test(etag ?? '')) throw protocolError('Storage response has no valid quoted revision ETag');
    return etag;
  }
  function remember(id, response, written = false) {
    const etag = revision(response);
    if (written || !revisions.has(id)) revisions.set(id, etag);
  }
  function enqueue(id, operation) {
    const result = (queues.get(id) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => {}, () => {});
    queues.set(id, settled);
    void settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return result;
  }
  async function request(url, options = {}, read = 'json', missingId) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error('Jetson storage timed out; changes are not saved'), { code: 'ETIMEDOUT' });
        controller.abort(error);
        reject(error);
      }, 30_000);
    });
    const perform = async () => {
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', ...options,
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        const error = Object.assign(new Error(`Jetson storage request failed (HTTP ${response.status})`), {
          status: response.status, code: response.status === 404 ? 'ENOENT' : 'ESTORAGE',
        });
        if (response.status === 409 || response.status === 412) {
          error.code = 'ECONFLICT';
          error.pmConflict = true;
          error.message = 'Storage changed elsewhere. Keep this tab open and export unsaved edits before manually reloading.';
          conflict ??= error;
          lastError = conflict;
          notify();
        }
        if (response.status === 404 && missingId) remember(missingId, response);
        throw error;
      }
      const data = await response[read]();
      if (controller.signal.aborted) throw controller.signal.reason;
      return { response, data };
    };
    const reading = !options.method || options.method === 'GET';
    try {
      const result = await Promise.race([perform(), timeout]);
      if (reading && readErrors.delete(url)) notify();
      return result;
    } catch (error) {
      if (reading && error.code !== 'ENOENT') { readErrors.set(url, error); notify(); }
      throw error;
    } finally { clearTimeout(timer); }
  }
  function getUser() {
    return session ??= request('/api/session').then(({ data }) => {
      if (typeof data?.username !== 'string' || !data.username || data.storage !== 'jetson') {
        throw protocolError('Invalid private storage session');
      }
      return data;
    });
  }
  async function getKV(key) {
    await getUser();
    const { response, data } = await request(urlFor('kv', { key }));
    if (data.value !== null && typeof data.value !== 'string') throw protocolError('Invalid storage value');
    remember(`kv:${key}`, response);
    return data.value;
  }
  async function readFile(path, stat = false) {
    await getUser();
    const { response, data } = await request(urlFor('file', { path, ...(stat ? { stat: '1' } : {}) }), {}, stat ? 'json' : 'blob', `file:${path}`);
    // Stat is only observation, not the document the editor actually loaded.
    if (!stat) remember(`file:${path}`, response);
    return { response, data };
  }
  function mutation(id, operation) {
    const generation = (pending.get(id) ?? 0) + 1;
    pending.set(id, generation);
    notify();
    return enqueue(id, async () => {
      try {
        await getUser();
        if (conflict) throw conflict;
        const result = await operation();
        if (pending.get(id) === generation) pending.delete(id);
        if (!pending.size) lastError = null;
        notify();
        return result;
      } catch (error) {
        lastError = error;
        notify();
        throw error;
      }
    });
  }
  const headers = (id, type) => ({
    'Content-Type': type, 'X-Projects-Request': '1', 'If-Match': revisions.get(id),
  });
  async function mutateFile(path, method, body) {
    const id = `file:${path}`;
    if (!revisions.has(id)) {
      try {
        const { response } = await readFile(path, true);
        // New uploads must not overwrite an existing document never loaded.
        if (method === 'PUT') throw protocolError('Read the existing file before replacing it');
        remember(id, response);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (conflict) throw conflict;
    const { response, data } = await request(urlFor('file', { path }), {
      method, headers: headers(id, typeof body === 'string' ? 'text/plain;charset=UTF-8' : body?.type || 'application/octet-stream'), body,
    });
    if (data?.ok !== true) throw protocolError('Storage did not acknowledge the write');
    remember(id, response, true);
    return method === 'PUT' ? { path, modified: Number(revision(response).slice(1, -1)), size: new Blob([body]).size } : true;
  }
  function folderPrefix(path) {
    const folder = typeof path === 'string' ? path.replace(/\/$/, '') : '';
    if (!/^projects-data\/(attachments|snapshots)(\/[^/]+)*$/.test(folder)
      || /[\\\u0000-\u001f\u007f]/.test(folder)
      || folder.split('/').some(p => p === '.' || p === '..')) {
      throw protocolError('Only Projects attachment and snapshot folders can be listed');
    }
    return `${folder}/`;
  }
  async function listFiles(path) {
    await getUser();
    const prefix = folderPrefix(path);
    const { data } = await request(urlFor('files', { prefix }));
    if (!Array.isArray(data?.files)) throw protocolError('Invalid storage listing');
    for (const file of data.files) {
      if (typeof file?.path !== 'string' || !file.path.startsWith(prefix)
        || file.path.split('/').some(p => !p || p === '.' || p === '..')
        || /[\\\u0000-\u001f\u007f]/.test(file.path) || !/^"\d+"$/.test(file.etag ?? '')) {
        throw protocolError('Storage listing contains an invalid file or revision');
      }
    }
    return { prefix, files: data.files };
  }
  async function readdir(path) {
    const { prefix, files } = await listFiles(path);
    const children = new Map();
    for (const file of files) {
      const relative = file.path.slice(prefix.length);
      const [name, ...rest] = relative.split('/');
      children.set(name, rest.length
        ? { name, path: `${prefix}${name}`, is_dir: true }
        : { ...file, name, is_dir: false });
    }
    return [...children.values()];
  }
  async function deleteFiles(path, options) {
    if (!options?.recursive) return mutation(`file:${path}`, () => mutateFile(path, 'DELETE'));
    if (conflict) throw conflict;
    const { files } = await listFiles(path);
    for (const file of files) {
      // Existing editor baselines win over newer listing revisions.
      if (!revisions.has(`file:${file.path}`)) revisions.set(`file:${file.path}`, file.etag);
      await mutation(`file:${file.path}`, () => mutateFile(file.path, 'DELETE'));
    }
    return true;
  }
  return {
    getUser, events,
    get dirty() { return pending.size > 0; },
    get conflict() { return conflict; },
    get error() { return lastError ?? readErrors.values().next().value ?? null; },
    kv: {
      get: (key) => enqueue(`kv:${key}`, () => getKV(key)),
      set: (key, value) => mutation(`kv:${key}`, async () => {
        const id = `kv:${key}`;
        if (!revisions.has(id)) await getKV(key);
        if (conflict) throw conflict;
        const { response, data } = await request(urlFor('kv', { key }), {
          method: 'PUT', headers: headers(id, 'application/json'), body: JSON.stringify({ value }),
        });
        if (data?.ok !== true) throw protocolError('Storage did not acknowledge the write');
        remember(id, response, true);
        return true;
      }),
    },
    fs: {
      read: (path) => enqueue(`file:${path}`, async () => (await readFile(path)).data),
      stat: (path) => enqueue(`file:${path}`, async () => (await readFile(path, true)).data),
      write: (path, body) => mutation(`file:${path}`, () => mutateFile(path, 'PUT', body)),
      delete: deleteFiles,
      readdir,
    },
  };
}
