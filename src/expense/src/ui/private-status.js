import { store } from '../lib/store.js';
import { el } from './dom.js';

export function hasPrivateDrafts() {
  return !!document.querySelector('[data-private-dirty]');
}

export function mountPrivateStatus() {
  const sdk = store.sdk;
  if (sdk?.mode !== 'private') return () => {};
  const banner = el('div.banner', {
    role: 'status', 'aria-live': 'polite', 'data-storage-status': '',
    style: { position:'sticky', top:'0', zIndex:'100', margin:'0', borderRadius:'0' },
  });
  document.body.prepend(banner);
  const update = () => {
    const error = sdk.conflict || sdk.error || store.error;
    banner.textContent = error
      ? `Jetson — ${sdk.conflict ? 'Conflict' : 'Storage error'}: ${error.message}. Keep unsaved work; do not reload until copied. No offline fallback.`
      : store.dirty || hasPrivateDrafts()
        ? 'Jetson — Unsaved changes. Keep this page open until confirmed.'
        : 'Jetson — Saved. Private storage; cloud OCR unavailable.';
  };
  const edit = event => {
    const target = event.target;
    const owner = target.closest?.('.modal-panel, form, .settings-row');
    if (owner) owner.dataset.privateDirty = '1';
    update();
  };
  const beforeUnload = event => {
    if (store.dirty || sdk.error || sdk.conflict || hasPrivateDrafts()) {
      event.preventDefault(); event.returnValue = '';
    }
  };
  sdk.events.addEventListener('state',update);
  store.addEventListener('storage-state',update);
  store.addEventListener('change',update);
  document.addEventListener('input',edit);
  document.addEventListener('change',edit);
  window.addEventListener('beforeunload',beforeUnload);
  update();
  return () => {
    sdk.events.removeEventListener('state',update);
    store.removeEventListener('storage-state',update);
    store.removeEventListener('change',update);
    document.removeEventListener('input',edit);
    document.removeEventListener('change',edit);
    window.removeEventListener('beforeunload',beforeUnload);
    banner.remove();
  };
}
