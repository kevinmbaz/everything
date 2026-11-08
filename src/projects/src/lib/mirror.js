/**
 * A durable local mirror of what this device knows, in IndexedDB.
 *
 * Two jobs:
 *
 *  1. Work in progress survives the tab. Saves are debounced and can fail;
 *     without this, closing the laptop on a train loses whatever had not
 *     reached Puter, which is why the app used to hang a beforeunload
 *     warning off `store.dirty`.
 *  2. Reading offline. A project opened with no connection shows the last
 *     version this device saw — clearly labelled as such, never passed off
 *     as current.
 *
 * Deliberately a plain key/value store: the app writes whole documents, so
 * a mutation log would be a more fragile way to say the same thing.
 *
 * Every call is safe to make when IndexedDB is unavailable (private modes,
 * embedded views): the mirror simply reports that it has nothing.
 */

import { isPrivateStorage } from './storage.js';

const DB_NAME = 'pm-mirror';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;

function hasIndexedDB() {
  if (isPrivateStorage) return false;
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb() {
  if (!hasIndexedDB()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, mode);
      } catch {
        resolve(null);
        return;
      }
      const request = fn(tx.objectStore(STORE));
      tx.onabort = () => resolve(null);
      tx.onerror = () => resolve(null);
      if (request) {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      } else {
        tx.oncomplete = () => resolve(null);
      }
    });
  }).catch(() => null);
}

export const mirror = {
  available: hasIndexedDB,
  get: (key) => run('readonly', (s) => s.get(key)),
  set: (key, value) => run('readwrite', (s) => s.put(value, key)),
  del: (key) => run('readwrite', (s) => s.delete(key)),
  keys: () => run('readonly', (s) => s.getAllKeys()).then((k) => k ?? []),
  all: () => run('readonly', (s) => s.getAll()).then((v) => v ?? []),
  clear: () => run('readwrite', (s) => s.clear()),
};

/** Keys, in one place so nothing has to guess at the shape. */
export const MIRROR_META = 'meta:v1';
export const mirrorDocKey = (projectId) => `doc:${projectId}`;

/**
 * Is this the shape of failure that means "no connection", rather than a
 * real answer from the server? Offline fetches reject with a TypeError, and
 * the Puter SDK surfaces its own network errors; anything that names a
 * missing subject is a genuine answer and must not be treated as offline.
 */
export function looksOffline(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err) return false;
  const code = String(err.code ?? err.error?.code ?? '');
  if (/does_not_exist|not_found|permission|forbidden/i.test(code)) return false;
  const message = String(err.message ?? err.error?.message ?? err);
  return err instanceof TypeError
    || /network|failed to fetch|load failed|offline|timeout|connection/i.test(message);
}
