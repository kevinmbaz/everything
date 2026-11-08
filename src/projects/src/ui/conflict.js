import { isPrivateStorage } from '../lib/storage.js';
import { el } from '../lib/dom.js';
import { icon } from './icons.js';
import { store } from '../lib/store.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import { clearHistory } from './history.js';
import { parseRoute, projectHash } from '../lib/routes.js';
import { safeFileName } from '../lib/util.js';

/**
 * "This project changed somewhere else."
 *
 * A clear choice beats a clever merge: reload and take theirs, or keep
 * yours and overwrite. Neither is destructive without a way back — the
 * local copy can be downloaded first, and the version being replaced is
 * still the one on disk until "Keep mine" is pressed.
 */

const open = new Set(); // one dialog per project at a time

/** The in-memory document, as a file, so nothing is lost either way. */
function downloadLocalCopy(projectId) {
  const doc = store.getDoc(projectId);
  if (!doc) return;
  const name = store.projectEntry(projectId)?.name || 'project';
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `${safeFileName(name)}-local-copy.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function openConflictDialog(projectId) {
  if (open.has(projectId)) return null;
  open.add(projectId);

  if (isPrivateStorage) {
    return openModal({
      title: 'Conflict — changes not saved',
      content: el('div.conflict', {},
        el('p', {}, 'Jetson storage changed in another tab or device. Your edits remain in this tab and have not overwritten the saved version. Saving is blocked until you explicitly reload the page.'),
        el('p', {}, 'Download your copy or use Settings → Export everything before manually reloading. Keep mine is disabled; reapply edits to the fresh version.'),
        el('button.btn.btn-primary', { onclick: () => downloadLocalCopy(projectId) }, 'Download my copy')),
      onClose: () => open.delete(projectId),
    });
  }
  const name = store.projectEntry(projectId)?.name || 'This project';
  const busy = (on, label) => {
    for (const b of content.querySelectorAll('button')) b.disabled = on;
    if (on) status.textContent = label;
    else status.textContent = '';
  };
  const status = el('p.form-hint', { role: 'status' });

  async function reload() {
    busy(true, 'Reloading…');
    try {
      // Leave any open task sheet first: it holds a reference into the
      // document that is about to be replaced.
      const route = parseRoute(location.hash);
      if (route.name === 'project' && route.id === projectId && route.taskId) {
        location.replace(projectHash(projectId, route.tab));
      }
      await store.reloadProject(projectId);
      // The document this project's undo stack was aimed at is gone.
      clearHistory(projectId);
      modal.close();
      toast('Reloaded the version from your Puter account', { icon: 'cloud' });
    } catch (err) {
      console.error(err);
      busy(false);
      status.textContent = 'Could not reload. Check your connection and try again.';
    }
  }

  async function keepMine() {
    busy(true, 'Saving your copy…');
    try {
      const saved = await store.forceSave(projectId);
      if (!saved) throw new Error('still conflicted');
      modal.close();
      toast('Your copy is now the saved one', { icon: 'cloud' });
    } catch (err) {
      console.error(err);
      busy(false);
      status.textContent = 'Could not save. Check your connection and try again.';
    }
  }

  const content = el('div.conflict', {},
    el('div.conflict-lead', {},
      el('span.conflict-ic', { html: icon('cloudOff', 22, 2), 'aria-hidden': 'true' }),
      el('p', {}, `“${name}” was saved somewhere else (another tab, or another `
        + 'device) after this window loaded it. Nothing has been overwritten.')
    ),
    el('ul.conflict-list', {},
      el('li', {}, el('strong', {}, 'Reload'), ' takes the other version. Changes made '
        + 'in this window since it loaded are lost.'),
      el('li', {}, el('strong', {}, 'Keep mine'), ' overwrites the other version with '
        + 'what is in this window.')
    ),
    status,
    el('div.row.row-end', {},
      el('button.btn.btn-ghost', {
        type: 'button',
        html: icon('download', 15, 2),
        onclick: () => downloadLocalCopy(projectId),
      }, ' Download my copy'),
      el('button.btn.btn-ghost', { type: 'button', onclick: reload }, 'Reload'),
      el('button.btn.btn-primary', { type: 'button', onclick: keepMine }, 'Keep mine')
    )
  );

  const modal = openModal({
    title: 'Changed somewhere else',
    content,
    onClose: () => open.delete(projectId),
  });
  return modal;
}
