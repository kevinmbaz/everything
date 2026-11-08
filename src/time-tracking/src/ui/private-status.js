import { el } from './dom.js';

/** In-memory only: mark edits on input, not when a debounce finally runs. */
export function trackPrivateDraft(root, store) {
  let generation = 0;
  const token = {};
  const fields = new Map();
  const values = new WeakMap();
  const mark = node => {
    if (!store.privateMode) return;
    fields.set(node, ++generation);
    (store.privateDrafts ||= new Set()).add(token);
    store.dispatchEvent(new Event('storage-state'));
  };
  const changed = ({ target: node }) => {
    const value = node.type === 'checkbox' || node.type === 'radio' ? node.checked : node.value;
    // A text control emits change on blur, often AFTER its input autosave
    // was acknowledged. That is not a new edit or a new generation.
    if (values.has(node) && values.get(node) === value) return;
    values.set(node, value);
    mark(node);
  };
  root.addEventListener('input', changed, true);
  root.addEventListener('change', changed, true);
  return {
    mark,
    capture: (keys = null) => new Map([...fields].filter(([node]) => !keys || keys.includes(node.dataset.storageKey))),
    acknowledge(saved) {
      for (const [node, version] of saved) {
        if (fields.get(node) === version) fields.delete(node);
      }
      if (!fields.size) store.privateDrafts?.delete(token);
      store.dispatchEvent(new Event('storage-state'));
      return fields.size === 0;
    },
    dispose() {
      root.removeEventListener('input', changed, true);
      root.removeEventListener('change', changed, true);
      fields.clear();
      store.privateDrafts?.delete(token);
      store.dispatchEvent(new Event('storage-state'));
    },
  };
}

export function mountPrivateStatus(store) {
  const banner = el('div.offline-banner', { role: 'status', 'data-private-storage': 'true' });
  document.body.append(banner);
  const update = () => {
    const error = store.storageError || store.storage?.error;
    banner.textContent = store.storage?.conflict
      ? 'Jetson conflict — Not saved. Copy unsaved work before manually reloading; no force-save.'
      : error ? 'Jetson — Not saved. Keep this page open and copy unsaved work before reloading.'
        : store.pendingWrites() ? 'Jetson — Unsaved changes / saving. Keep this page open.'
          : 'Saved to Jetson · Private storage · No offline copy';
  };
  const beforeUnload = event => {
    if (store.pendingWrites()) { event.preventDefault(); event.returnValue = ''; }
  };
  store.addEventListener('change', update);
  store.addEventListener('storage-state', update);
  store.storage?.events?.addEventListener('state', update);
  window.addEventListener('beforeunload', beforeUnload);
  update();
  return () => {
    store.removeEventListener('change', update);
    store.removeEventListener('storage-state', update);
    store.storage?.events?.removeEventListener('state', update);
    window.removeEventListener('beforeunload', beforeUnload);
    banner.remove();
  };
}
