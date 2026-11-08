import { isPrivateStorage, isPuterDesktop } from '../lib/storage.js';
import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { appIcon, accentAvatar } from './bits.js';
import { store } from '../lib/store.js';
import { openModal } from './modal.js';
import { openProjectForm } from './projectform.js';
import { openTaskSearch } from './search.js';
import { openQuickAdd } from './quickadd.js';
import { MOD_KEY } from './shortcuts.js';
import { parseRoute, projectHash } from '../lib/routes.js';
import { initListReorder } from './reorder.js';
import { toast } from './toast.js';
import {
  projectGroups, matchesProjectQuery, FIND_PROJECTS_FROM,
} from '../lib/projects.js';
import { agendaDueCount } from '../views/today.js';
import { confirmSignOut } from '../views/settings.js';

/**
 * The app's navigation, built once and shown two ways: as the desktop
 * sidebar, and as a slide-in drawer on small screens, where the sidebar is
 * hidden and nothing used to replace it.
 *
 * Both presentations come from createNav(), so the project list, the Today
 * badge, the active states, and the account row cannot drift apart. The
 * drawer is a modal, which is where its scrim, focus trap, inert handling,
 * Escape and Back dismissal all come from.
 */

/**
 * createNav({ className, brand, onActivate }) → <nav> with .destroy()
 *
 * Keeps itself current: it re-renders on route changes and on the store
 * events that affect what it shows.
 */
export function createNav({ className = 'sidebar', brand = true, onActivate } = {}) {
  const username = store.user?.username || 'Puter user';
  const headingId = `nav-projects-${Math.random().toString(36).slice(2, 8)}`;

  /* The agenda count is the app's passive reminder, so it is computed from
     documents already in memory — a badge must never trigger a read per
     project. It fills in as projects load. */
  const todayNav = el('a.nav-item.nav-today', { href: '#/today' },
    el('span.nav-today-ic', { html: icon('calendarClock', 18, 1.9), 'aria-hidden': 'true' }),
    el('span.nav-label', {}, 'Today')
  );

  /* Two lists rather than one: pinned projects lead, and each keeps its own
     drag container so a drag can never silently unpin something. */
  const pinnedNav = el('div.sidebar-projects', {
    role: 'list', 'aria-label': 'Pinned projects',
  });
  /* "What is due" and "everything else" are two questions, so they are two
     entries side by side rather than one view with a mode. */
  const allNav = el('a.nav-item.nav-all', { href: '#/all' },
    el('span.nav-today-ic', { html: icon('listTodo', 18, 1.9), 'aria-hidden': 'true' }),
    el('span.nav-label', {}, 'All tasks')
  );

  const projectsNav = el('div.sidebar-projects', {
    role: 'list', 'aria-labelledby': headingId,
  });
  const groupSep = el('div.sidebar-divider', { 'aria-hidden': 'true' });
  const bottomNav = el('div', { style: { display: 'contents' } });

  /* The filter box owns its own DOM: rebuilding it inside render() would pull
     focus out of the field on every keystroke. It appears only once there are
     enough projects for a wall of names to be a problem. */
  let query = '';
  const findInput = el('input.sidebar-find-input', {
    type: 'search',
    placeholder: 'Filter projects',
    'aria-label': 'Filter projects by name',
    oninput: () => { query = findInput.value; render(); },
    onkeydown: (e) => {
      if (e.isComposing) return;
      // Escape clears the box rather than closing the drawer around it.
      if (e.key === 'Escape' && findInput.value) {
        e.stopPropagation();
        findInput.value = '';
        query = '';
        render();
      }
    },
  });
  const findWrap = el('div.sidebar-find', {},
    el('span.sidebar-find-ic', { html: icon('search', 14, 2), 'aria-hidden': 'true' }),
    findInput
  );

  /** Runs after anything that navigates or opens a dialog. */
  const activated = () => onActivate?.();

  const action = (label, iconName, kbd, run) => el('button.nav-item.nav-action', {
    type: 'button',
    html: icon(iconName, 18, 1.9),
    onclick: () => { run(); activated(); },
  }, el('span.nav-label', {}, label), kbd && el('kbd.nav-kbd', {}, kbd));

  const root = el(`nav.${className}`, { 'aria-label': 'Main navigation' },
    brand && el('a.brand', { href: '#/' }, appIcon(28, 'brand-mark'), 'Projects'),
    /* The keyboard hints are the only place these bindings are advertised
       outside the ? dialog, and they are how people learn them. */
    action('Quick add', 'circlePlus', 'n',
      () => openQuickAdd({ projectId: parseRoute(location.hash).id })),
    action('Find a task', 'search', '/', () => openTaskSearch()),
    action('Commands', 'command', `${MOD_KEY}K`,
      () => import('./palette.js').then((m) => m.openCommandPalette())),
    todayNav,
    allNav,
    el('div.sidebar-section', {},
      el('span.sidebar-heading', { id: headingId }, 'Projects'),
      el('button.icon-btn.small', {
        html: icon('plus', 15, 2.2),
        'aria-label': 'New project',
        title: 'New project',
        onclick: () => {
          openProjectForm({ onDone: (p) => location.replace(projectHash(p.id)) });
          activated();
        },
      })
    ),
    findWrap,
    pinnedNav,
    groupSep,
    projectsNav,
    el('div.sidebar-spacer'),
    bottomNav,
    el('div.sidebar-user', {},
      accentAvatar(username, 26, { decorative: true }),
      el('span.name', { title: username }, username),
      !isPrivateStorage && !isPuterDesktop() && el('button.icon-btn', {
        html: icon('logout', 17, 2),
        'aria-label': 'Sign out',
        title: 'Sign out',
        onclick: () => { confirmSignOut(); activated(); },
      })
    )
  );

  function renderToday(route = parseRoute(location.hash)) {
    const onAll = route.name === 'all';
    allNav.classList.toggle('active', onAll);
    if (onAll) allNav.setAttribute('aria-current', 'page');
    else allNav.removeAttribute('aria-current');

    const active = route.name === 'today';
    todayNav.classList.toggle('active', active);
    if (active) todayNav.setAttribute('aria-current', 'page');
    else todayNav.removeAttribute('aria-current');

    const count = agendaDueCount();
    todayNav.querySelector('.nav-badge')?.remove();
    if (count > 0) {
      todayNav.append(el('span.nav-badge', {
        role: 'status',
        'aria-label': `${count} task${count === 1 ? '' : 's'} due or overdue`,
      }, String(count)));
    }
  }

  /**
   * Move a project one place within its own group and keep the keyboard on
   * it. The store re-renders this nav synchronously, so the node to refocus
   * is looked up after the move rather than before it.
   */
  function moveBy(entry, delta, part) {
    const group = groupOf(entry);
    const at = group.findIndex((p) => p.id === entry.id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= group.length) return;
    store.moveProject(entry.id, to).catch((err) => {
      console.error(err);
      toast('Could not save the order. Check your connection', { icon: 'cloudOff' });
    });
    root.querySelector(`.nav-row[data-id="${CSS.escape(entry.id)}"] ${part}`)?.focus();
  }

  /** The rows a move is measured against: the group as it is drawn. */
  function groupOf(entry) {
    const { pinned, rest } = projectGroups(listedProjects());
    return entry.pinned ? pinned : rest;
  }

  /* Archived projects live in home's Archived section, not here — except the
     one currently open, so the nav never contradicts the view. */
  function listedProjects(route = parseRoute(location.hash)) {
    return store.projects.filter((p) =>
      !p.archived || (route.name === 'project' && route.id === p.id));
  }

  function projectRow(entry, route, { reorderable }) {
    const active = route.name === 'project' && route.id === entry.id;

    const link = el('a.nav-item', {
      href: `#/p/${entry.id}`,
      className: `nav-item${active ? ' active' : ''}`,
      'aria-current': active ? 'page' : null,
      // Alt+arrows also work from the row itself, which is what tabbing
      // lands on — the grip is a mouse and touch affordance.
      onkeydown: (e) => {
        if (!reorderable || !e.altKey) return;
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        moveBy(entry, e.key === 'ArrowUp' ? -1 : 1, '.nav-item');
      },
    },
      el('span.dot', { style: { background: entry.color }, 'aria-hidden': 'true' }),
      el('span.nav-label', {}, entry.name),
      entry.pinned && el('span.nav-pin', {
        html: icon('pin', 12, 2.2),
        role: 'img',
        'aria-label': 'Pinned',
        title: 'Pinned',
      }),
      entry.archived && el('span.nav-tag.muted', {}, 'archived'),
      entry.sample && el('span.nav-tag', {}, 'sample')
    );

    return el('div.nav-row', {
      dataset: { id: entry.id },
      role: 'listitem',
    },
      link,
      // No handle while the list is filtered: a position among four of
      // fifteen rows is not a position anyone means.
      reorderable && el('button.nav-grip.drag-handle', {
        type: 'button',
        html: icon('grip', 13, 2),
        tabindex: -1,
        'aria-hidden': 'true',
        title: 'Drag to reorder, or Alt with the arrow keys',
        onkeydown: (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault();
          moveBy(entry, e.key === 'ArrowUp' ? -1 : 1, '.nav-grip');
        },
      })
    );
  }

  function render() {
    const route = parseRoute(location.hash);
    clear(pinnedNav);
    clear(projectsNav);

    const listed = listedProjects(route);
    // The box is worth its space only once the list is long enough to be a
    // wall of names, and it keeps whatever was typed into it across renders.
    const canFind = listed.length >= FIND_PROJECTS_FROM;
    findWrap.hidden = !canFind;
    if (!canFind && query) { query = ''; findInput.value = ''; }
    const matching = listed.filter((p) => matchesProjectQuery(p, query));
    // Dragging inside a filtered list would mean nothing, so it is off.
    const reorderable = !query.trim() && listed.length > 1;

    const { pinned, rest } = projectGroups(matching);
    for (const p of pinned) pinnedNav.append(projectRow(p, route, { reorderable }));
    for (const p of rest) projectsNav.append(projectRow(p, route, { reorderable }));
    pinnedNav.hidden = !pinned.length;
    groupSep.hidden = !pinned.length || !rest.length;

    if (!matching.length) {
      projectsNav.append(el('p.sidebar-empty', {},
        query.trim() ? `No project matches “${query.trim()}”`
          : store.projects.length ? 'All projects archived'
            : 'No projects yet'));
    }

    clear(bottomNav);
    for (const item of [
      { hash: '#/', label: 'All projects', icon: 'grid', active: route.name === 'home' },
      { hash: '#/settings', label: 'Settings', icon: 'gear', active: route.name === 'settings' },
    ]) {
      bottomNav.append(el('a.nav-item', {
        href: item.hash,
        className: `nav-item${item.active ? ' active' : ''}`,
        html: icon(item.icon, 18, 1.9),
        'aria-current': item.active ? 'page' : null,
      }, el('span.nav-label', {}, item.label)));
    }

    renderToday(route);
  }

  const onChange = (e) => {
    const scope = e.detail?.scope;
    if (scope === 'projects' || scope === 'settings') render();
    // A due date changing anywhere moves the agenda count, and a freshly
    // loaded project adds to it.
    else if (scope === 'doc' || scope === 'loaded') renderToday();
  };

  store.addEventListener('change', onChange);
  window.addEventListener('hashchange', render);

  /* One reorderer per group, built once: they read the rows at drag time, so
     a re-render underneath them is not a problem. */
  const reorderers = [pinnedNav, projectsNav].map((container) =>
    initListReorder(container, {
      itemSelector: '.nav-row',
      handleSelector: '.drag-handle',
      onReorder: (id, toIndex) => {
        store.moveProject(id, toIndex).catch((err) => {
          console.error(err);
          toast('Could not save the order. Check your connection', { icon: 'cloudOff' });
          render(); // put the row back where the data says it is
        });
      },
    }));

  root.destroy = () => {
    for (const r of reorderers) r.destroy();
    store.removeEventListener('change', onChange);
    window.removeEventListener('hashchange', render);
  };

  render();
  return root;
}

/**
 * The drawer: the same nav, in a modal panel that slides in from the edge.
 * It closes on navigation, because every link in it is a lateral move.
 */
export function openNavDrawer() {
  let modal = null;
  const nav = createNav({
    className: 'drawer-nav',
    brand: false,
    onActivate: () => modal?.close(),
  });

  const closeOnNavigate = () => modal?.close();
  window.addEventListener('hashchange', closeOnNavigate);

  modal = openModal({
    title: 'Projects',
    content: nav,
    variant: 'drawer',
    dismissOnBack: true,
    onClose: () => {
      window.removeEventListener('hashchange', closeOnNavigate);
      nav.destroy();
    },
  });
  return modal;
}

/** The header affordance that opens it. Hidden on desktop, where the
 *  sidebar is already there. */
export function menuButton() {
  return el('button.icon-btn.menu-btn', {
    type: 'button',
    'aria-label': 'Open navigation',
    'aria-haspopup': 'dialog',
    html: icon('menu', 20, 2),
    onclick: () => openNavDrawer(),
  });
}
