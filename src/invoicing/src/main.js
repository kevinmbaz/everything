import './styles/index.css';
import { el } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { store } from './lib/store.js';
import { isPrivate } from './lib/storage.js';
import { applyTheme } from './ui/theme.js';
import { mountShell } from './ui/shell.js';
import { toast } from './ui/toast.js';
import { shouldOnboard, openOnboarding } from './ui/onboarding.js';
import { authView } from './views/auth.js';
import { offlineEnabled, setOfflineEnabled, readSnapshot, serializeSnapshot, writeSnapshot } from './lib/snapshot.js';

const appRoot = document.getElementById('app');

if (isPrivate) window.addEventListener('invoicing-storage-conflict', () => {
  if (document.getElementById('storage-conflict')) return;
  // Keep the editor intact: reloading automatically would discard the very
  // changes this warning asks the user to rescue. The adapter blocks writes.
  document.body.prepend(el('div', {
    id: 'storage-conflict', role: 'alert',
    style: { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '10000',
      padding: '16px', background: '#fff3cd', color: '#332600',
      borderBottom: '2px solid #a46b00', display: 'flex', gap: '16px', alignItems: 'center' },
  },
  el('span', {}, 'Saving stopped: this data changed on another device. Copy your unsaved changes, then reload before saving.'),
  el('button.btn', { type: 'button', onclick: () => location.reload() }, 'Reload')));
});

function showError(title, message, onRetry) {
  appRoot.replaceChildren(el('div.auth-view', {},
    el('div.empty-icon', { html: icon('wifiOff', 26) }),
    el('h1.auth-title', { style: { fontSize: '22px' } }, title),
    el('p.auth-sub', {}, message),
    el('button.btn.btn-primary.auth-cta', { onclick: onRetry }, 'Try again')
  ));
}

/**
 * Open from the copy kept on this device, read-only, when the cloud cannot
 * be reached. Deliberately independent of the Puter SDK: the whole point is
 * that a train, a plane, or a basement office no longer ends at "Could not
 * reach Puter".
 */
function bootOffline() {
  const snapshot = offlineEnabled() ? readSnapshot() : null;
  if (!snapshot) return false;
  store.loadOffline(snapshot.data, { user: snapshot.user ? { username: snapshot.user } : null });
  applyTheme(store.settings.theme || 'system');
  mountShell(appRoot);
  watchForNetwork();
  return true;
}

/**
 * Come back online without a reload: re-run init() against the cloud and
 * drop the read-only state. Tried once per 'online' event, and again on the
 * next one if it fails — a device can report a network it cannot use yet.
 */
let watching = false;
function watchForNetwork() {
  if (watching) return;
  watching = true;
  window.addEventListener('online', async () => {
    if (!store.readOnly) return;
    // An offline launch whose cached copy of the SDK had been evicted mounted
    // the shell with no `puter` at all. Every reconnect attempt then threw
    // inside init() and was swallowed below, so the banner kept saying
    // "changes need a connection" on a device that had one, for good. Only a
    // reload can load the SDK; say so, once per event, and offer it.
    if (!isPrivate && typeof puter === 'undefined') {
      toast('Back online. Reload to reconnect to your cloud', {
        icon: 'wifi',
        action: { label: 'Reload', onClick: () => location.reload() },
      });
      return;
    }
    try {
      await store.reconnect();
      toast(isPrivate ? 'Back online: connected to your Jetson storage' : 'Back online: showing your cloud again', { icon: 'circleCheck' });
      keepSnapshot();
      store.processRecurringDue().catch(() => {});
    } catch {
      // Still unreachable; the next 'online' event tries again.
    }
  });
}

/**
 * Keep the device copy in step with what was loaded, while the setting is
 * on. Debounced, because every save emits, and quiet: a snapshot that
 * cannot be written must never take a real save down with it.
 */
let snapshotTimer = null;
function keepSnapshot() {
  const save = () => {
    if (store.readOnly || !offlineEnabled() || !store.settings) return;
    const result = writeSnapshot(serializeSnapshot(store.exportAll(), {
      user: store.user?.username || '',
    }));
    if (!result.ok && result.error === 'too large') {
      // The same rule Settings applies when the box is ticked: a copy that
      // cannot be written is not a setting to leave on. Left on, every save
      // refused in silence while the months-old copy already on the device
      // kept opening offline as if it were current — a paid invoice read as
      // unpaid, and got chased. writeSnapshot has dropped that copy; the
      // setting goes with it, said once, here.
      setOfflineEnabled(false);
      toast('The copy on this device was turned off: your account is now larger than this browser will hold', { icon: 'alert' });
    }
    // The Settings page shows when the copy was last written and how big
    // it is; the write is debounced behind the store's own event, so a
    // repaint on that event read the previous copy. This is the moment.
    document.dispatchEvent(new Event('snapshotchange'));
  };
  save();
  store.addEventListener('change', () => {
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(save, 1500);
  });
}

/**
 * A call that cannot hang the boot splash. Offline, an SDK request may sit
 * open rather than fail, and a spinner that never resolves is the worst of
 * the states this feature exists to remove.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

async function start() {
  if (isPrivate) {
    await boot();
    return;
  }
  if (!isPrivate && typeof puter === 'undefined') {
    if (bootOffline()) return;
    showError('Could not reach Puter', 'The Puter SDK failed to load. Check your connection and try again.', () => location.reload());
    return;
  }

  let signedIn = false;
  let unreachable = false;
  try {
    signedIn = await withTimeout(puter.auth.isSignedIn(), 8000);
  } catch {
    // Failing is not the same as answering "no": a signed-out account must
    // see the sign-in screen, while an unreachable one gets its device copy.
    unreachable = true;
  }

  if (!signedIn) {
    if ((unreachable || !navigator.onLine) && bootOffline()) return;
    appRoot.replaceChildren(authView({ onSignedIn: boot }));
    return;
  }
  await boot();
}

async function boot() {
  try {
    await withTimeout(store.init(), 20000);
  } catch (err) {
    console.error(err);
    if (bootOffline()) return;
    showError('Could not load your data', isPrivate
      ? 'Could not reach your Jetson storage. Check that the Jetson and Tailscale are connected, then reload. No cloud service is used.'
      : 'Something went wrong talking to your Puter cloud.', () => location.reload());
    return;
  }

  // Settings win over the pre-paint localStorage value (they sync across devices).
  applyTheme(store.settings.theme || 'system');
  mountShell(appRoot);
  keepSnapshot();
  registerServiceWorker();
  if (shouldOnboard(store)) openOnboarding();

  // Generate any recurring invoices that came due since the last visit.
  store.processRecurringDue()
    .then((n) => {
      if (n) {
        toast(`${n} recurring invoice${n === 1 ? '' : 's'} drafted`, { icon: 'repeat' });
      }
    })
    .catch(() => {});
}

/**
 * The service worker is written by the build (see vite.config.js), so it
 * exists only in a real build — the dev server and the mock page have none.
 *
 * Registered once the page has finished loading, so it never competes with
 * the first paint for bandwidth — but boot() gets here only after the SDK
 * and the store have answered over the network, and by then `load` has
 * almost always already fired. A listener added after the event never runs,
 * which left every signed-in visit without a worker: nothing was precached,
 * and the offline launch this exists for opened to "Could not reach Puter".
 */
function registerServiceWorker() {
  if (!import.meta.env?.PROD || !('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable', err));
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// Dev-only handle for console debugging.
if (import.meta.env?.DEV) window.__invc = { store };

start();
