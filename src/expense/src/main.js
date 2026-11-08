import './styles/index.css';
import { el } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { store } from './lib/store.js';
import { applyTheme } from './ui/theme.js';
import { mountShell } from './ui/shell.js';
import { shouldOnboard, openOnboarding } from './ui/onboarding.js';
import { openCapture } from './ui/capture.js';
import { authView } from './views/auth.js';
import { isPrivateStorage, prepareStorageBrowser } from './lib/storage.js';
import { mountPrivateStatus } from './ui/private-status.js';

const appRoot = document.getElementById('app');

function showError(title, message, onRetry) {
  appRoot.replaceChildren(el('div.auth-view', {},
    el('div.auth-card', {},
      el('div.empty-icon', { html: icon('wifiOff', 28) }),
      el('h1.auth-title', { style: { fontSize: '22px' } }, title),
      el('p.auth-sub', {}, message),
      el('button.btn.btn-primary.auth-cta', { type: 'button', onclick: onRetry }, 'Try again'))
  ));
}

async function start() {
  if (isPrivateStorage) {
    try {
      await prepareStorageBrowser();
      await boot();
    } catch (err) {
      showError('Private storage unavailable', err.message, () => location.reload());
    }
    return;
  }
  if (typeof puter === 'undefined') {
    showError('Couldn’t reach Puter', 'The Puter SDK failed to load. Check your connection and try again.', () => location.reload());
    return;
  }
  let signedIn = false;
  try { signedIn = await Promise.resolve(puter.auth.isSignedIn()); } catch { signedIn = false; }
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
    showError('Couldn’t load your data', isPrivateStorage ? 'Jetson authorization or storage failed. No cloud or offline fallback is used.' : navigator.onLine ? 'Something went wrong talking to your Puter cloud.' : 'You appear to be offline.', () => location.reload());
    return;
  }
  // Settings win over the pre-paint localStorage value (they sync across devices).
  applyTheme(store.settings.theme || 'system');
  mountShell(appRoot);
  if (isPrivateStorage) mountPrivateStatus();
  if (shouldOnboard(store)) openOnboarding({ onCapture: () => openCapture() });
  setupOfflineBanner();
}

function setupOfflineBanner() {
  let banner = null;
  const update = () => {
    if (!navigator.onLine && !banner) {
      banner = el('div.offline-banner', { html: icon('wifiOff', 15, 2) }, ' You’re offline. Changes can’t be saved until you reconnect');
      document.body.append(banner);
    } else if (navigator.onLine && banner) {
      banner.remove();
      banner = null;
    }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

/* Service worker for the installable shell. Skipped on dev hosts. */
const isDevHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname) || location.hostname.endsWith('.localhost');
if (!isPrivateStorage && 'serviceWorker' in navigator && !isDevHost && !import.meta.env?.DEV) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

if (import.meta.env?.DEV) window.__exp = { store };

start();
