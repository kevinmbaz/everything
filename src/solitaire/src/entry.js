import { startApp } from './main.js';

if (import.meta.env.VITE_PRIVATE_STORAGE === '1') {
  import('./private-boot.js').then(({ bootSolitaire }) => bootSolitaire({ privateMode: true, startApp })).catch(error => {
    // Boot/storage failures remain visible and never fall through to local play.
    const panel = document.getElementById('private-storage-panel');
    panel.hidden = false;
    const status = document.getElementById('private-storage-status');
    status.dataset.state = 'error';
    status.textContent = `Private startup failed: ${error.message}. Reload only after resolving the error; close legacy tabs if worker preparation is blocked.`;
  });
} else {
  startApp();
}
