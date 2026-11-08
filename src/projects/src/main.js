import './styles/index.css';
import { auth, isPrivateStorage } from './lib/storage.js';
import { preparePrivateBrowser, warnBeforeUnload } from './lib/private-browser.js';
import { el } from './lib/dom.js';
import { icon } from './ui/icons.js';
import { store } from './lib/store.js';
import { applyTheme } from './ui/theme.js';
import { mountShell } from './ui/shell.js';
import { shouldOnboard, openOnboarding } from './ui/onboarding.js';
import { initReminders } from './ui/reminders.js';
import { authView } from './views/auth.js';

const appRoot = document.getElementById('app');

function showError(title, message, onRetry) {
  appRoot.replaceChildren(el('div.auth-view', {},
    el('div.empty-icon', { html: icon('cloudOff', 30) }),
    el('h1.auth-title', {}, title),
    el('p.auth-sub', {}, message),
    el('button.btn.btn-primary.auth-cta', { onclick: onRetry }, 'Try again')
  ));
}

async function start() {
  if (isPrivateStorage) {
    try { await preparePrivateBrowser(); }
    catch (error) { showError('Private storage unavailable', error.message, () => location.reload()); return; }
    await boot();
    return;
  }
  if (!auth.isAvailable()) {
    showError('Could not reach Puter', 'The Puter SDK failed to load. Check your connection and try again.', () => location.reload());
    return;
  }

  let signedIn = false;
  try {
    signedIn = await Promise.resolve(auth.isSignedIn());
  } catch {
    signedIn = false;
  }

  if (!signedIn) {
    appRoot.replaceChildren(authView({ onSignedIn: boot }));
    return;
  }
  await boot();
}

async function boot() {
  try {
    await store.init();
  } catch (err) {
    console.error(err);
    showError('Could not load your data', isPrivateStorage ? 'Could not authenticate or read Jetson storage. No offline or empty workspace was loaded. Check your private connection and retry.' : 'Something went wrong talking to your Puter cloud. Check your connection and try again.', () => location.reload());
    return;
  }

  // Settings win over the pre-paint localStorage value (they sync across devices).
  applyTheme(store.settings.theme || 'system');
  mountShell(appRoot);

  // Trash is a grace period: sweep expired projects once per boot, in the
  // background — the UI must not wait on it, and a failure is not fatal.
  store.purgeOldDeletedProjects().catch((err) => console.error(err));
  // Reminders run off the critical path: the first pass waits for idle.
  initReminders();
  if (shouldOnboard(store)) openOnboarding();

  // Saves are debounced, so a close inside that window still has to land —
  // but it no longer needs to interrupt anyone: flushAll() writes the local
  // mirror first, and whatever does not reach Puter goes out from there on
  // the next visit.
  window.addEventListener('beforeunload', (event) => {
    if (isPrivateStorage) { warnBeforeUnload(event, store); return; }
    if (store.dirty) store.flushAll();
  });
}

/**
 * The shell — this app's HTML, JS, CSS and the Puter SDK — is cached so the
 * app can start with no connection. Data never is (see public/sw.js).
 * Registered after load so it never competes with the first paint, and only
 * in a real build: in dev it would sit between Vite and the browser.
 */
function registerServiceWorker() {
  if (isPrivateStorage) return;
  if (!import.meta.env?.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.error(err));
  });
}
registerServiceWorker();

// Dev-only handle for console debugging.
if (import.meta.env?.DEV) window.__pm = { store };

start();
