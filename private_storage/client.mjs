/** Same-origin, authenticated private storage. No browser mirror or replay. */
export function createPrivateStorage({ app, fetch = globalThis.fetch } = {}) {
  let session;
  let conflict = null;
  const events = new EventTarget();
  const readErrors = new Map();
  const revisions = new Map();
  const pending = new Map();
  const transactions = new Map();
  let queue = Promise.resolve();
  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  const notify = () => events.dispatchEvent(new Event('state'));
  const protocol = message => Object.assign(new Error(message), { code: 'EPROTOCOL' });
  const invalid = message => Object.assign(new Error(message), { code: 'EINVAL' });
  const validPath = path => typeof path === 'string' && path.length > 0 && !/[\\%?#\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
  const validSize = value => Number.isSafeInteger(value) && value >= 0;
  const validKey = key => typeof key === 'string' && key.length > 0 && !/[\x00-\x1f\x7f]/.test(key);
  const rejectMutation = error => mutation(() => { throw error?.code === 'EINVAL' ? error : invalid(error?.message || 'Invalid mutation'); });
  function serialize(value) {
    return JSON.stringify(value, (_key, item) => {
      if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw invalid('Expected a native JSON value');
      if (item && typeof item === 'object' && !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw invalid('Expected a plain JSON object');
      return item;
    });
  }
  const validTag = etag => typeof etag === 'string' && /^"(0|[1-9]\d*)"$/.test(etag);
  const newer = (a, b) => BigInt(a.slice(1, -1)) > BigInt(b.slice(1, -1));
  function revision(response) {
    const etag = response.headers.get('ETag');
    if (!validTag(etag)) throw protocol('Invalid storage revision');
    return etag;
  }
  function mutation(operation, group) {
    const token = { group };
    pending.set(token, null);
    notify();
    return enqueue(async () => {
      try {
        await getUser();
        if (conflict) throw conflict;
        const result = await operation();
        pending.delete(token);
        if (group) for (const [previous, error] of pending) {
          if (error && previous.group === group) pending.delete(previous);
        }
        notify();
        return result;
      } catch (error) { pending.set(token, error); notify(); throw error; }
    });
  }
  function readOperation(id, operation) {
    return Promise.resolve().then(operation).then(value => {
      if (readErrors.delete(id)) notify();
      return value;
    }, error => { if (error.code !== 'ENOENT') readErrors.set(id, error); else readErrors.delete(id); notify(); throw error; });
  }
  async function request(url, options = {}, format = 'json') {
    const controller = new AbortController();
    const writing = options.method && options.method !== 'GET';
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error('Storage timed out; keep unsaved edits open. The write outcome may be unknown.'), { code: 'ETIMEDOUT', uncertain: Boolean(writing) });
        controller.abort(error);
        reject(error);
      }, 30_000);
    });
    const perform = async () => {
      const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (response.status === 409 || response.status === 412) {
        conflict ??= Object.assign(new Error('Storage changed elsewhere. Keep this tab open and export unsaved edits before manually reloading.'), { code: 'ECONFLICT', status: response.status });
        notify();
        throw conflict;
      }
      if (response.status === 404 && url.startsWith('/api/file?') && !writing) {
        const data = await response.json();
        controller.signal.throwIfAborted();
        if (data?.error === 'ENOENT' || data?.code === 'ENOENT') throw Object.assign(new Error('File does not exist'), { code: 'ENOENT', etag: revision(response), status: 404 });
      }
      if (!response.ok) throw Object.assign(new Error(`Storage request failed (HTTP ${response.status})`), { code: 'ESTORAGE', status: response.status });
      const data = await response[format]();
      controller.signal.throwIfAborted();
      return { response, data };
    };
    try { return await Promise.race([perform(), timeout]); }
    catch (error) { if (error instanceof SyntaxError) throw protocol('Malformed storage JSON response'); throw error; }
    finally { clearTimeout(timer); }
  }
  function getUser() {
    return session ??= readOperation('session', async () => {
      const { data } = await request('/api/session');
      if (!app || data?.app !== app || data.storage !== 'jetson' || !data.username || typeof data.username !== 'string' || !data.uuid || typeof data.uuid !== 'string') throw protocol('Invalid private storage session');
      return data;
    });
  }
  async function getKV(key, missingOnly = false) {
    if (!validKey(key)) throw invalid('Expected a nonempty KV key');
    await getUser();
    const { response, data } = await request(`/api/kv?${new URLSearchParams({ key })}`);
    if (!data || (data.value !== null && typeof data.value !== 'string')) throw protocol('Invalid KV wire value');
    let value;
    try {
      value = data.value === null ? null : JSON.parse(data.value, (_key, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw protocol('Nonfinite JSON value');
        return value;
      });
    } catch { throw protocol('Invalid serialized KV JSON'); }
    const etag = revision(response);
    if (missingOnly && data.value !== null) throw Object.assign(new Error('Read the existing resource before changing it'), { code: 'EUNREAD' });
    if (!revisions.has(`kv:${key}`)) revisions.set(`kv:${key}`, etag);
    return value;
  }
  function mutateKV(key, method, value) {
    let captured;
    try {
      if (!validKey(key)) throw invalid('Expected a nonempty KV key');
      captured = method === 'PUT' ? serialize(value) : undefined;
    } catch (error) { return rejectMutation(error); }
    return mutation(async () => {
      const id = `kv:${key}`;
      if (!revisions.has(id)) await getKV(key, true);
      const { response, data } = await request(`/api/kv?${new URLSearchParams({ key })}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Everything-Request': '1', 'If-Match': revisions.get(id) },
        ...(method === 'PUT' ? { body: JSON.stringify({ value: captured }) } : {}),
      });
      if (data?.ok !== true) throw protocol('Storage did not acknowledge the write');
      const etag = revision(response);
      if (!newer(etag, revisions.get(id))) throw protocol('Write revision did not increase');
      revisions.set(id, etag);
      return true;
    });
  }
  async function readFile(path, stat = false) {
    if (!validPath(path)) throw invalid('Expected a relative file path');
    await getUser();
    let result;
    try {
      result = await request(`/api/file?${new URLSearchParams({ path, ...(stat ? { stat: '1' } : {}) })}`, {}, stat ? 'json' : 'blob');
    } catch (error) {
      if (!stat && error.code === 'ENOENT' && !revisions.has(`file:${path}`)) revisions.set(`file:${path}`, error.etag);
      throw error;
    }
    const { response, data } = result;
    const etag = revision(response);
    if (stat && (!data || data.path !== path || !validSize(data.size) || !validSize(data.modified) || String(data.modified) !== etag.slice(1, -1))) throw protocol('Invalid file metadata');
    if (!stat && !revisions.has(`file:${path}`)) revisions.set(`file:${path}`, etag);
    return data;
  }
  async function ensureBaseline(kind, name) {
    const id = `${kind}:${name}`;
    if (revisions.has(id)) return;
    if (kind === 'kv') { await getKV(name, true); return; }
    try {
      await readFile(name, true);
      throw Object.assign(new Error('Read the existing resource before changing it'), { code: 'EUNREAD' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      revisions.set(id, error.etag);
    }
  }
  async function readdir(path) {
    const root = typeof path === 'string' && path.endsWith('/') ? path.slice(0, -1) : path;
    if (!validPath(root)) throw invalid('Expected a relative directory path');
    const prefix = `${root}/`;
    await getUser();
    const { data } = await request(`/api/files?${new URLSearchParams({ prefix })}`);
    if (!Array.isArray(data?.files)) throw protocol('Invalid file listing');
    const paths = new Set();
    const entries = new Map();
    for (const file of data.files) {
      if (!file || !validPath(file.path) || !file.path.startsWith(prefix) || paths.has(file.path) || !validTag(file.etag) || !validSize(file.size) || !validSize(file.modified) || String(file.modified) !== file.etag.slice(1, -1)) throw protocol('Invalid descendant file');
      paths.add(file.path);
      const tail = file.path.slice(prefix.length);
      const name = tail.split('/')[0];
      const is_dir = tail.includes('/');
      if (entries.has(name) && entries.get(name).is_dir !== is_dir) throw protocol('Ambiguous file/directory listing');
      entries.set(name, is_dir ? { name, path: prefix + name, is_dir: true } : { name, path: file.path, is_dir: false, size: file.size, modified: file.modified, etag: file.etag });
    }
    for (const path of paths) {
      const parts = path.split('/');
      while (parts.pop() && parts.length) if (paths.has(parts.join('/'))) throw protocol('Ambiguous file/directory listing');
    }
    return [...entries.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  function transaction(operations, options = {}) {
    let captured, idempotencyKey;
    try {
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'idempotencyKey')) throw invalid('Invalid transaction options');
      idempotencyKey = options.idempotencyKey === undefined ? globalThis.crypto.randomUUID() : options.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw invalid('Invalid idempotency key');
      if (!Array.isArray(operations) || !operations.length || operations.length > 512) throw invalid('Expected 1–512 operations');
      const seen = new Set();
      captured = Array.from(operations, o => {
        if (!o || !['kv', 'file'].includes(o.kind) || !['PUT', 'DELETE'].includes(o.method)) throw invalid('Invalid transaction operation');
        const field = o.kind === 'kv' ? 'key' : 'path';
        if (!(o.kind === 'kv' ? validKey(o[field]) : validPath(o[field])) || Object.keys(o).some(k => !['kind', field, 'method', ...(o.method === 'PUT' ? ['value'] : [])].includes(k))) throw invalid('Unexpected transaction fields');
        const id = `${o.kind}:${o[field]}`;
        if (seen.has(id)) throw invalid('Duplicate transaction resource');
        seen.add(id);
        if (o.method === 'PUT' && (o.kind === 'file' ? typeof o.value !== 'string' : o.value === undefined)) throw invalid('Invalid transaction value');
        return { kind: o.kind, [field]: o[field], method: o.method,
          ...(o.method === 'PUT' ? { value: o.kind === 'kv' ? serialize(o.value) : o.value } : {}) };
      });
    } catch (error) { return rejectMutation(error); }
    const fingerprint = JSON.stringify(captured);
    let record = transactions.get(idempotencyKey);
    if (record && record.fingerprint !== fingerprint) return mutation(() => {
      throw Object.assign(new Error('Idempotency key already belongs to different operations'), { code: 'IDEMPOTENCY_MISMATCH' });
    });
    if (!record) {
      record = { fingerprint, body: null };
      transactions.set(idempotencyKey, record);
    }
    return mutation(async () => {
      if (!record.body) {
        const wire = [];
        for (const o of captured) {
          const name = o.key ?? o.path;
          await ensureBaseline(o.kind, name);
          wire.push({ ...o, ifMatch: revisions.get(`${o.kind}:${name}`) });
        }
        record.body = JSON.stringify({ idempotencyKey, operations: wire });
      }
      const { data } = await request('/api/transaction', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Everything-Request': '1' },
        body: record.body,
      });
      const expected = JSON.parse(record.body).operations;
      if (data?.ok !== true || !Array.isArray(data.revisions) || data.revisions.length !== expected.length) throw protocol('Incomplete transaction acknowledgement');
      const updates = [];
      for (const [index, r] of data.revisions.entries()) {
        const o = expected[index];
        const field = o.kind === 'kv' ? 'key' : 'path';
        if (!r || Array.isArray(r) || Object.keys(r).length !== 3 || Object.keys(r).some(key => !['kind', field, 'etag'].includes(key)) || r.kind !== o.kind || r[field] !== o[field] || !validTag(r.etag) || !newer(r.etag, o.ifMatch)) throw protocol('Invalid transaction acknowledgement');
        // Derive identity only from the validated operation, never an alternate
        // response field. Complete every check before changing any baseline.
        const id = `${o.kind}:${o[field]}`;
        const baseline = revisions.get(id);
        if (!validTag(baseline)) throw protocol('Invalid transaction baseline');
        if (newer(r.etag, baseline)) updates.push([id, r.etag]);
      }
      for (const [id, etag] of updates) revisions.set(id, etag);
      return data;
    }, record);
  }
  function mutateFile(path, method, body) {
    if (!validPath(path) || (method === 'PUT' && typeof body !== 'string' && !(body instanceof Blob))) return rejectMutation(invalid('Expected a relative path and string or Blob contents'));
    return mutation(async () => {
      const id = `file:${path}`;
      await ensureBaseline('file', path);
      const { response, data } = await request(`/api/file?${new URLSearchParams({ path })}`, {
        method,
        headers: { 'X-Everything-Request': '1', 'If-Match': revisions.get(id), 'Content-Type': typeof body === 'string' ? 'text/plain;charset=UTF-8' : body?.type || 'application/octet-stream' },
        ...(method === 'PUT' ? { body } : {}),
      });
      if (data?.ok !== true) throw protocol('Storage did not acknowledge the write');
      const etag = revision(response);
      if (!newer(etag, revisions.get(id)) || !validSize(Number(etag.slice(1, -1)))) throw protocol('Invalid file write revision');
      revisions.set(id, etag);
      return method === 'DELETE' ? true : { path, size: new Blob([body]).size, modified: Number(etag.slice(1, -1)) };
    });
  }
  return {
    mode: 'private', getUser, events, transaction,
    get conflict() { return conflict; },
    get error() { return conflict ?? [...pending.values()].find(Boolean) ?? readErrors.values().next().value ?? null; },
    get dirty() { return pending.size > 0; },
    auth: { getUser, isSignedIn: async () => { await getUser(); return true; } },
    kv: {
      get: key => enqueue(() => readOperation(`kv:${key}`, () => getKV(key))),
      set: (key, value) => mutateKV(key, 'PUT', value),
      del: key => mutateKV(key, 'DELETE'),
    },
    fs: {
      readdir: path => enqueue(() => readOperation(`list:${path}`, () => readdir(path))),
      read: path => enqueue(() => readOperation(`file:${path}`, () => readFile(path))),
      stat: path => enqueue(() => readOperation(`stat:${path}`, () => readFile(path, true))),
      write: (path, body) => mutateFile(path, 'PUT', body),
      delete: (path, ...options) => options.length ? rejectMutation(invalid('File deletion accepts only a path; recursive/force options are unsupported')) : mutateFile(path, 'DELETE'),
    },
  };
}
