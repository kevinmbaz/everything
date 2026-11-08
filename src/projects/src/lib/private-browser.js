import { isPrivateStorage } from './storage.js';
import { debounce } from './util.js';

// Keep the model and unload warning current on each keystroke. The Store
// still debounces network writes; no browser-local draft is used privately.
export const persistInput = (fn, delay) => isPrivateStorage ? fn : debounce(fn, delay);

/** Private mode never replays writes or reloads an editor automatically. */
export function warnBeforeUnload(event, store) {
  if (!store.dirty) return;
  event.preventDefault();
  event.returnValue = '';
}

export function privateSaveState(store, storage) {
  if (storage.conflict) return 'Conflict — not saved. Export your edits before manually reloading.';
  if (storage.error) return 'Not saved — keep this tab open. Check your connection and retry, or export your edits.';
  if (store.dirty) return 'Saving to Jetson… Keep this tab open.';
  return 'Saved to Jetson';
}

/**
 * An old cloud worker can cache JSON-looking API URLs and serve an old shell.
 * Replace it with the build's network-only retirement worker before auth/data.
 * No reload: existing tabs may contain unsaved edits. Never touch other caches.
 */
export async function preparePrivateBrowser({
  serviceWorker = globalThis.navigator?.serviceWorker,
  caches = globalThis.caches,
  baseURL = new URL('./', globalThis.location?.href).href,
} = {}) {
  if (serviceWorker) {
    const registrations = await serviceWorker.getRegistrations();
    const previous = registrations.find(r => r.scope === baseURL);
    if (previous || serviceWorker.controller) {
      const scriptURL = new URL('sw.js?private=1', baseURL).href;
      await serviceWorker.register(scriptURL, { scope: baseURL, updateViaCache: 'none' });
      // Claim happens in activate, not when registration resolves.
      await new Promise((resolve, reject) => {
        let timer;
        const check = () => {
          if (serviceWorker.controller?.scriptURL !== scriptURL) return;
          clearTimeout(timer);
          serviceWorker.removeEventListener('controllerchange', check);
          resolve();
        };
        timer = setTimeout(() => {
          serviceWorker.removeEventListener('controllerchange', check);
          reject(new Error('Could not retire the old offline worker. Close other Projects tabs, then manually reload. No data was loaded.'));
        }, 15_000);
        serviceWorker.addEventListener('controllerchange', check);
        check();
      });
    }
  }
  if (caches) {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('pm-shell-')).map(name => caches.delete(name)));
  }
}
