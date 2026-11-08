import { createPrivateStorage } from '../../../private_storage/client.mjs';
import { preparePrivateBrowser } from '../../../private_storage/browser.mjs';
import { createPrivateGame } from './services/private-game.js';
import { PRIVATE_CACHE_PREFIXES } from './services/private-config.js';
import { validIdentity } from './services/private-state.js';

// Attribution only: this browser-local ID is not a bank, save, or outbox.
// A separate namespace deliberately does not import the legacy device/bank.
function privateDeviceId() {
  const key = 'solitaire.private.device.v1';
  try {
    const id = localStorage.getItem(key);
    if (validIdentity(id)) return id;
  } catch { /* Storage-less browsers get a page-lifetime attribution ID. */ }
  const id = crypto.randomUUID();
  try { localStorage.setItem(key, id); } catch { /* Not primary data. */ }
  return id;
}

function bindStatus(app) {
  const el = id => document.getElementById(id);
  el('private-storage-panel').hidden = false;
  const credit = document.querySelector('.credit');
  if (credit) credit.textContent = 'Private Jetson storage · Online connection required';
  function update() {
    const status = el('private-storage-status');
    status.dataset.state = app.status;
    const messages = {
      loading: 'Connecting to private storage… Gameplay is locked until authenticated state is loaded.',
      unsaved: 'Unsaved changes — saving to Jetson…',
      saved: 'Saved to Jetson',
    };
    status.textContent = messages[app.status] || `${app.status === 'conflict' ? 'Storage conflict' : 'Storage error'}: ${app.error?.message || 'Not saved'}. Keep this tab open. Export draft before reloading; reload discards unsaved changes.`;
    for (const id of ['newgame', 'undo', 'mode', 'winNew']) el(id).disabled = !app.canPlay;
    el('board').inert = !app.canPlay;
    el('modeMenu').inert = !app.canPlay;
    el('private-export').disabled = !app.game;
  }
  app.events.addEventListener('state', update);
  window.addEventListener('beforeunload', event => {
    if (!app.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  el('private-export').onclick = () => {
    const data = app.exportState();
    if (!data || !app.game) return;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'solitaire-private-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el('private-reload').onclick = () => {
    if (!app.dirty || window.confirm('Reload authoritative server state? Unsaved local work will be discarded. Export draft first.')) window.location.reload();
  };
  update();
}

export async function bootSolitaire({ privateMode, startApp, prepare = preparePrivateBrowser, storage } = {}) {
  if (!privateMode) { startApp(); return null; }
  const app = createPrivateGame({
    storage: storage || createPrivateStorage({ app: 'solitaire' }),
    prepare: () => prepare({ cachePrefixes: PRIVATE_CACHE_PREFIXES }),
    deviceId: privateDeviceId(),
  });
  bindStatus(app);
  await app.start();
  startApp(app);
  return app;
}
