/**
 * Puter's own file pickers, wrapped so the app can ask for them without
 * knowing whether they exist.
 *
 * They behave differently inside the Puter desktop (a native window) and on
 * a standalone web page (a popup), and older SDK builds do not have them at
 * all — so every entry point is feature-detected, and a UI that cannot be
 * offered simply is not rendered.
 *
 * Cancelling a picker is not an error: the SDK signals it by rejecting or by
 * returning nothing, and both come back here as null.
 */

import { cloudUI, isPrivateStorage } from './storage.js';

export function canPickFiles() {
  return typeof cloudUI()?.showOpenFilePicker === 'function';
}

export function canSaveFiles() {
  return typeof cloudUI()?.showSaveFilePicker === 'function';
}

/** Everything a picked item needs to become an attachment reference. */
function toItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const path = raw.path ?? raw.fullPath ?? raw.uid ?? null;
  if (!path) return null;
  return {
    path,
    name: raw.name ?? String(path).split('/').pop(),
    size: raw.size ?? 0,
    type: raw.type ?? raw.mime ?? '',
  };
}

/** pickFiles() → an array of items (possibly empty when cancelled). */
export async function pickFiles({ multiple = true } = {}) {
  if (isPrivateStorage) throw new Error('Puter Drive is unavailable; upload a file from your device');
  if (!canPickFiles()) return [];
  let result;
  try {
    result = await cloudUI().showOpenFilePicker({ multiple });
  } catch {
    return []; // cancelled, or the picker could not open
  }
  const list = Array.isArray(result) ? result : [result];
  return list.map(toItem).filter(Boolean);
}

/**
 * saveToPuter(blob, name) → the saved item, or null when cancelled.
 * The SDK writes the file itself; this only reports what happened.
 */
export async function saveToPuter(blob, suggestedName) {
  if (isPrivateStorage) throw new Error('Puter Drive is unavailable; download the file instead');
  if (!canSaveFiles()) return null;
  try {
    const saved = await cloudUI().showSaveFilePicker(blob, suggestedName);
    return toItem(saved) ?? { path: suggestedName, name: suggestedName };
  } catch {
    return null;
  }
}
