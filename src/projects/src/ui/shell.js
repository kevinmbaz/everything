import { isPrivateStorage, storage } from '../lib/storage.js';
import { privateSaveState } from '../lib/private-browser.js';
import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { store } from '../lib/store.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';
import { openOnboarding } from './onboarding.js';
import { createNav } from './navdrawer.js';
import { openConflictDialog } from './conflict.js';
import { initShortcuts } from './shortcuts.js';
import { clearHistoryExcept } from './history.js';
import { parseRoute, projectHash } from '../lib/routes.js';
import { mountTaskSheet, openTaskSheet } from './tasksheet.js';
import { homeView } from '../views/home.js';
import { todayView } from '../views/today.js';
import { allTasksView } from '../views/alltasks.js';
import { projectView } from '../views/project.js';
import { settingsView } from '../views/settings.js';

export { parseRoute };

export function mountShell(appRoot) {
  const viewWrap = el('div.view-wrap');
  const privateStatus = isPrivateStorage && el('div.private-storage-status', { role: 'status', 'aria-live': 'polite' });
  const main = el('main.main', { id: 'main' }, privateStatus || null, viewWrap);
  if (isPrivateStorage) {
    const renderPrivateStatus = () => {
      privateStatus.textContent = `Stored on your Jetson · ${privateSaveState(store, storage)}`;
      privateStatus.classList.toggle('error', !!storage.error || !!storage.conflict);
    };
    storage.events.addEventListener('state', renderPrivateStatus);
    for (const event of ['saving', 'saved', 'save-error', 'conflict', 'change']) store.addEventListener(event, renderPrivateStatus);
    renderPrivateStatus();
  }
  let currentView = null;

  function navigate(hash, { replace = false } = {}) {
    if (replace) location.replace(hash);
    else location.hash = hash;
  }

  /* The sidebar on desktop; below 900px the same nav is a drawer the view
     headers open (see ui/navdrawer.js), so the two can never drift. */
  const sidebar = createNav({ className: 'sidebar', brand: true });

  /* The open task sheet lives in the route, so it survives a reload and the
     OS back gesture dismisses it. Only the task part of the route changing
     must not rebuild the view underneath (that would drop the board's
     composer draft and scroll position), so renders are keyed on the view. */
  let viewKey = null;
  let sheet = null; // { key, dismiss }

  const routeViewKey = (r) =>
    r.name === 'project' ? `project:${r.id}:${r.tab}` : r.name;

  function syncSheet(route) {
    const key = route.name === 'project' && route.taskId
      ? `${route.id}:${route.taskId}` : null;
    if (sheet?.key === key) return;
    if (sheet) {
      const stale = sheet;
      sheet = null; // before dismiss(): its onClose must not pop history
      stale.dismiss();
    }
    if (!key) return;

    const entry = { key, dismiss: () => {} };
    sheet = entry;
    store.loadProject(route.id).then(() => {
      if (sheet !== entry) return; // the route moved on while loading
      const task = store.getDoc(route.id)?.tasks.find((t) => t.id === route.taskId);
      if (!task) {
        // Stale task link (deleted, or another account's id): drop the task
        // from the route and stay on the view, like the project guard above.
        sheet = null;
        toast('That task no longer exists', { icon: 'listTodo' });
        location.replace(projectHash(route.id, route.tab));
        return;
      }
      const modal = mountTaskSheet(route.id, route.taskId, {
        onClose: () => {
          if (sheet !== entry) return; // already closed by a route change
          sheet = null;
          if (parseRoute(location.hash).taskId !== route.taskId) return;
          // Closed from the UI: pop the entry opening the sheet pushed, so
          // Back does not walk through a route whose sheet is gone. A sheet
          // restored from a cold deep link pushed nothing — replace instead,
          // or Back would leave the app.
          if (history.state?.pmSheet) history.back();
          else location.replace(projectHash(route.id, route.tab));
        },
      });
      entry.dismiss = () => modal.close();
    }).catch((err) => {
      console.error(err);
      if (sheet === entry) sheet = null;
    });
  }

  function renderRoute() {
    const route = parseRoute(location.hash);

    /* The undo stack belongs to the project you are in. Leaving it (or
       opening another) drops the rest: an inverse aimed at a document nobody
       is looking at is one nobody can check. */
    clearHistoryExcept(route.name === 'project' ? route.id : null);

    if (route.name === 'project' && !store.projectEntry(route.id)) {
      // Stale link (deleted project, another account's id): land home.
      location.replace('#/');
      return;
    }

    const key = routeViewKey(route);
    if (key !== viewKey) {
      viewKey = key;
      currentView?.destroy?.();
      clear(viewWrap);
      currentView =
        route.name === 'project' ? projectView({ id: route.id, tab: route.tab, navigate })
        : route.name === 'settings' ? settingsView({ navigate })
        : route.name === 'today' ? todayView({ navigate })
        : route.name === 'all' ? allTasksView({ navigate })
        : homeView({ navigate });
      viewWrap.append(currentView);
      main.scrollTop = 0;
    }
    syncSheet(route);
  }

  clear(appRoot);
  appRoot.append(el('div.shell', {}, sidebar, main));

  initShortcuts();
  window.addEventListener('hashchange', renderRoute);

  // A document that moved on underneath this window is not a failed write:
  // it needs an answer, not a retry.
  store.addEventListener('conflict', (e) => openConflictDialog(e.detail.projectId));

  /* Losing the connection is worth saying once — with what it means, since
     the app keeps working — and so is getting it back. */
  store.addEventListener('connection', (e) => {
    if (e.detail.offline) {
      toast('Offline. Changes are kept on this device until you are back', {
        icon: 'cloudOff', duration: 7000,
      });
    } else {
      toast('Back online', { icon: 'cloud' });
    }
  });
  store.addEventListener('outbox', (e) => {
    const { sent } = e.detail;
    if (sent) toast(`${sent} project${sent === 1 ? '' : 's'} saved to Puter`, { icon: 'cloud' });
  });

  // Failed writes surface once with a retry; success stays quiet.
  let saveErrorShown = false;
  store.addEventListener('save-error', (e) => {
    if (saveErrorShown) return;
    saveErrorShown = true;
    toast('Could not save. Check your connection', {
      icon: 'cloudOff',
      duration: 8000,
      action: { label: 'Retry', onClick: () => { saveErrorShown = false; e.detail.retry(); } },
    });
  });
  store.addEventListener('saved', () => { saveErrorShown = false; });

  /* A done column that archives its own tasks must never do it silently:
     the pass runs when a project is opened, so this says what it did, in
     which project, and offers it back. */
  store.addEventListener('auto-archived', (e) => {
    const { projectId, ids } = e.detail;
    const name = store.projectEntry(projectId)?.name;
    toast(`${ids.length} done task${ids.length === 1 ? '' : 's'} archived`
      + (name ? ` in ${name}` : ''), {
      icon: 'archive',
      duration: 9000,
      action: {
        label: 'Undo',
        onClick: () => store.bulkRestoreTasks(projectId, ids, 'archive'),
      },
    });
  });

  // A recurring task completing quietly adds its successor; say so, and
  // offer a jump to it. The catch-up pass on project open stays quiet.
  store.addEventListener('recurrence-spawned', (e) => {
    const { projectId, next, quiet } = e.detail;
    if (quiet) return;
    toast('Repeated. The next one is on the board', {
      icon: 'repeat',
      duration: 6000,
      action: { label: 'Open', onClick: () => openTaskSheet(projectId, next.id) },
    });
  });

  renderRoute();
}

/**
 * Shared banner shown while sample data is installed. The returned node
 * carries a destroy() the host view must call on teardown; otherwise every
 * mount would leave a store listener behind holding detached DOM.
 */
export function sampleBanner() {
  const wrap = el('div');
  function render() {
    clear(wrap);
    if (!store.settings.sampleData) return;
    wrap.append(el('div.sample-banner', {},
      el('span.sample-banner-ic', { html: icon('sparkle', 14, 2.2) }),
      el('span.grow', {}, 'Sample data: explore freely, nothing here is yours'),
      el('button', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Start fresh?',
            message: 'The sample project is removed and you start with a clean workspace.',
            confirmLabel: 'Wipe sample data',
          });
          if (!ok) return;
          try {
            await store.wipeSampleData();
          } catch (err) {
            console.error(err);
            toast('Could not wipe. Check your connection', { icon: 'cloudOff' });
            return;
          }
          location.hash = '#/';
          openOnboarding();
        },
      }, 'Start fresh')
    ));
  }
  const onChange = (e) => {
    if (e.detail?.scope === 'settings' || e.detail?.scope === 'projects') render();
  };
  store.addEventListener('change', onChange);
  wrap.destroy = () => store.removeEventListener('change', onChange);
  render();
  return wrap;
}
