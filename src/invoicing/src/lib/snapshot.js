/**
 * The optional copy of the account kept on this device.
 *
 * This is the one place the app would put billing data on a device rather
 * than in the user's cloud, so it is opt-in, disclosed plainly, and cleared
 * both when it is switched off and when the user signs out. With it, the app
 * opens on a train, on a plane, or in a client's basement office and shows
 * what it last loaded — read-only, because inventing a merge story for
 * offline writes is a much larger and riskier feature than reading is.
 *
 * The serialiser is deliberately the same shape as store.exportAll(), which
 * is the shape the store already knows how to be filled from.
 */

import { isPrivate } from './storage.js';

const prefix = isPrivate ? 'invoicing:private' : 'invoicing';
export const SNAPSHOT_KEY = `${prefix}:snapshot:v1`;
export const SNAPSHOT_ENABLED_KEY = `${prefix}:offline:v1`;
export const SNAPSHOT_VERSION = 1;

/**
 * How much of the browser's storage this may take. localStorage gives about
 * 5 MB and refuses the write that crosses it; a logo data URI alone can be a
 * few hundred KB, so the cap is checked before writing rather than caught
 * afterwards, when the old snapshot may already be gone.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The snapshot payload for an account, ready to stringify. */
export function serializeSnapshot(data, { at = Date.now(), user = '' } = {}) {
  return {
    app: 'invoicing',
    kind: 'snapshot',
    version: SNAPSHOT_VERSION,
    savedAt: at,
    // Whose data this is: a snapshot left by one account must never open
    // under another, and signing out clears it anyway.
    user: String(user || ''),
    data,
  };
}

/**
 * parseSnapshot(text) -> { ok: true, savedAt, user, data } | { ok: false, error }
 *
 * A payload from another version, another app, or a corrupt one is discarded
 * rather than repaired: the network path is right there, and half-restored
 * billing data is worse than none.
 */
export function parseSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (!isPlainObject(raw) || raw.app !== 'invoicing' || raw.kind !== 'snapshot') {
    return { ok: false, error: 'not a snapshot' };
  }
  if (Number(raw.version) !== SNAPSHOT_VERSION) return { ok: false, error: 'version mismatch' };
  if (!isPlainObject(raw.data) || !isPlainObject(raw.data.settings)) {
    return { ok: false, error: 'no settings in it' };
  }
  const docs = isPlainObject(raw.data.docs) ? raw.data.docs : {};
  for (const [year, list] of Object.entries(docs)) {
    if (!/^\d{4}$/.test(year) || !Array.isArray(list)) return { ok: false, error: 'unreadable documents' };
  }
  const list = (v) => (Array.isArray(v) ? v.filter(isPlainObject) : []);
  return {
    ok: true,
    savedAt: Number(raw.savedAt) || 0,
    user: String(raw.user || ''),
    data: {
      settings: raw.data.settings,
      clients: list(raw.data.clients),
      items: list(raw.data.items),
      recurring: list(raw.data.recurring),
      docs: Object.fromEntries(Object.entries(docs).map(([y, l]) => [y, l.filter(isPlainObject)])),
    },
  };
}

/* ---------- The device side ---------- */

/** localStorage, or null where it is unavailable (private modes, embeds). */
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function offlineEnabled() {
  try {
    return storage()?.getItem(SNAPSHOT_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setOfflineEnabled(on) {
  const store = storage();
  if (!store) return false;
  try {
    if (on) store.setItem(SNAPSHOT_ENABLED_KEY, '1');
    else store.removeItem(SNAPSHOT_ENABLED_KEY);
    if (!on) store.removeItem(SNAPSHOT_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the snapshot. Returns { ok, bytes } or { ok: false, error } — a
 * refusal is reported rather than thrown, because this runs quietly after
 * every change and must never take a save down with it.
 */
export function writeSnapshot(payload) {
  const store = storage();
  if (!store) return { ok: false, error: 'no storage' };
  let text;
  try {
    text = JSON.stringify(payload);
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (text.length > MAX_SNAPSHOT_BYTES) {
    // An account that has outgrown the copy is refused the same way a full
    // browser is: the copy already there is months old the moment it is the
    // one that opens offline, and it opened as if it were current.
    try { store.removeItem(SNAPSHOT_KEY); } catch { /* nothing else to try */ }
    return { ok: false, error: 'too large' };
  }
  try {
    store.setItem(SNAPSHOT_KEY, text);
    return { ok: true, bytes: text.length };
  } catch {
    // Out of room: drop what is there rather than leaving a stale copy that
    // would open as if it were current.
    try { store.removeItem(SNAPSHOT_KEY); } catch { /* nothing else to try */ }
    return { ok: false, error: 'no room' };
  }
}

/** The snapshot on this device, parsed, or null. */
export function readSnapshot() {
  const store = storage();
  if (!store) return null;
  let text;
  try {
    text = store.getItem(SNAPSHOT_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  const parsed = parseSnapshot(text);
  if (!parsed.ok) {
    clearSnapshot();
    return null;
  }
  return { ...parsed, bytes: text.length };
}

export function clearSnapshot() {
  try {
    storage()?.removeItem(SNAPSHOT_KEY);
  } catch { /* nothing else to try */ }
}
