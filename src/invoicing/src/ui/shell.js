import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast, mountToastRoot } from './toast.js';
import { confirmDialog, openModal, closeAllModals } from './modal.js';
import { store } from '../lib/store.js';
import { isPrivate } from '../lib/storage.js';
import { todayISO } from '../lib/dates.js';
import { docStatus } from '../lib/doc.js';
import { wipeSampleData } from '../lib/sample.js';
import { openOnboarding } from './onboarding.js';
import { applyTheme, currentTheme } from './theme.js';
import { dashboardView } from '../views/dashboard.js';
import { invoicesView, quotesView } from '../views/documents.js';
import { clientsView } from '../views/clients.js';
import { clientView } from '../views/client.js';
import { recurringView } from '../views/recurring.js';
import { receiptsView } from '../views/receipts.js';
import { reportsView } from '../views/reports.js';
import { itemsView } from '../views/items.js';
import { trashView } from '../views/trash.js';
import { settingsView, confirmSignOut } from '../views/settings.js';
import { editorView } from '../views/editor.js';
import { detailView } from '../views/detail.js';

/* The mobile tab bar holds four destinations plus More; routes marked
   tab: false live in the More sheet there. The desktop sidebar shows all. */
const ROUTES = [
  { hash: '#/', label: 'Home', icon: 'home', view: dashboardView },
  { hash: '#/invoices', label: 'Invoices', icon: 'invoice', view: invoicesView },
  { hash: '#/quotes', label: 'Estimates', icon: 'quote', view: quotesView },
  { hash: '#/clients', label: 'Clients', icon: 'clients', view: clientsView },
  { hash: '#/recurring', label: 'Recurring', icon: 'repeat', view: recurringView, tab: false },
  { hash: '#/receipts', label: 'Receipts', icon: 'receipt', view: receiptsView, tab: false },
  { hash: '#/reports', label: 'Reports', icon: 'chart', view: reportsView, tab: false },
  { hash: '#/items', label: 'Saved items', icon: 'tag', view: itemsView, tab: false },
  { hash: '#/trash', label: 'Trash', icon: 'trash', view: trashView, tab: false },
  { hash: '#/settings', label: 'Settings', icon: 'gear', view: settingsView, tab: false, foot: true },
];

/* The sidebar groups the same destinations under headings, so eleven items
   read as three short lists instead of one long one. Settings carries
   `foot: true` above and sits below the rule with the account actions, where
   a shell's own preferences belong. */
const NAV_GROUPS = [
  { label: 'Billing', hashes: ['#/', '#/invoices', '#/quotes', '#/recurring'] },
  { label: 'Records', hashes: ['#/clients', '#/receipts', '#/items'] },
  { label: 'Tools', hashes: ['#/reports', '#/trash'] },
];

const MORE_SUBS = {
  '#/recurring': 'Invoices that write themselves on schedule',
  '#/receipts': 'Every payment received, ready to print',
  '#/reports': 'Income, tax collected, and top clients',
  '#/items': 'The rates and units the editor fills in',
  '#/trash': 'Deleted things, and the way back',
  '#/settings': 'Business profile, defaults, and integrations',
};

/**
 * Resolve a hash to { route, params }. Dynamic routes (detail, editor)
 * borrow a static route's nav highlight via `parent`.
 */
function parseRoute(hash) {
  const [path, query = ''] = (hash || '#/').split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  let m;
  if ((m = path.match(/^#\/doc\/([^/]+)$/))) {
    const doc = store.doc(m[1]);
    return {
      route: { view: detailView, parent: doc?.kind === 'quote' ? '#/quotes' : '#/invoices' },
      params: { id: m[1] },
    };
  }
  if ((m = path.match(/^#\/edit\/([^/]+)$/))) {
    const doc = store.doc(m[1]);
    return {
      route: { view: editorView, parent: doc?.kind === 'quote' ? '#/quotes' : '#/invoices' },
      params: { id: m[1] },
    };
  }
  if ((m = path.match(/^#\/client\/([^/]+)$/))) {
    return { route: { view: clientView, parent: '#/clients' }, params: { ...params, id: m[1] } };
  }
  if ((m = path.match(/^#\/edit-recurring\/([^/]+)$/))) {
    return { route: { view: editorView, parent: '#/recurring' }, params: { recurringId: m[1] } };
  }
  if ((m = path.match(/^#\/new\/(invoice|quote|recurring)$/))) {
    const parent = m[1] === 'quote' ? '#/quotes' : m[1] === 'recurring' ? '#/recurring' : '#/invoices';
    return { route: { view: editorView, parent }, params: { ...params, kind: m[1] } };
  }
  const route = ROUTES.find((r) => r.hash === path) || ROUTES[0];
  return { route, params };
}

export function mountShell(appRoot) {
  const sampleBanner = el('div');
  const offlineBanner = el('div');
  const viewWrap = el('div');
  // The panel is the frame; the column inside it is what holds the content to
  // a readable width and centres it in the panel.
  const main = el('main.main', { id: 'main' },
    el('div.main-inner', {}, offlineBanner, sampleBanner, viewWrap));
  let currentView = null;

  // Kept in variables: whether they can be pressed follows store.readOnly,
  // which changes when a device that opened from its saved copy gets back on
  // the network — and the sidebar is built once, not per route.
  const newInvoiceBtn = el('button.btn.btn-primary.btn-block', {
    html: icon('plus', 15, 1.9),
    onclick: () => navigate('#/new/invoice'),
  }, ' New invoice');
  const newQuoteBtn = el('button.btn.btn-quiet.btn-block', {
    html: icon('quote', 15, 1.6),
    onclick: () => navigate('#/new/quote'),
  }, ' New estimate');
  const syncCreateButtons = () => {
    for (const b of [newInvoiceBtn, newQuoteBtn]) {
      b.disabled = !!store.readOnly;
      if (store.readOnly) b.title = 'Reconnect to create documents';
      else b.removeAttribute('title');
    }
  };
  syncCreateButtons();

  /* Read-only banner: the app is showing the copy kept on this device. It
     says what still works, because "offline" on its own reads as broken. */
  let drawnReadOnly = null;
  function renderOfflineBanner() {
    if (store.readOnly === drawnReadOnly) return;
    drawnReadOnly = store.readOnly;
    clear(offlineBanner);
    document.body.classList.toggle('read-only', !!store.readOnly);
    syncCreateButtons();
    if (!store.readOnly) return;
    offlineBanner.append(el('div.sample-banner.offline-banner', { role: 'status' },
      el('span.sample-banner-ic', { html: icon('wifiOff', 14, 1.8) }),
      el('span.grow', {}, 'Offline: this is the copy saved on this device. '
        + 'You can read, print, and download PDFs; changes need a connection.')));
  }
  store.addEventListener('change', renderOfflineBanner);
  renderOfflineBanner();

  /* Sample-data banner: always visible while exploring, one-tap wipe. */
  // What it was last drawn for, so the store changes that leave it identical
  // skip the rebuild — every save emits, and rebuilding the banner destroys
  // the Start-fresh button under a keyboard user standing on it, exactly as
  // rebuilding the nav did before it started checking the badge first.
  let drawnSample = null;
  function renderSampleBanner() {
    // Wiping replaces the whole account, so it is a write: on a device showing
    // a saved copy the banner still says the data is not the user's, and
    // leaves it at that, rather than walking them through a confirmation that
    // promises everything is about to go and then refusing.
    const sample = store.settings.sampleData ? (store.readOnly ? 'read' : 'write') : null;
    if (sample === drawnSample) return;
    drawnSample = sample;
    clear(sampleBanner);
    if (!sample) return;
    sampleBanner.append(el('div.sample-banner', {},
      el('span.sample-banner-ic', { html: icon('sparkle', 14, 1.8) }),
      el('span.grow', {}, 'Sample data: explore freely, nothing here is yours'),
      sample === 'read' ? null : el('button', {
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Start fresh?',
            message: 'All sample data is removed and you set up your own business from scratch.',
            confirmLabel: 'Wipe sample data',
          });
          if (!ok) return;
          try {
            await wipeSampleData(store);
          } catch (err) {
            console.error(err);
            toast('Could not wipe. Check your connection', { icon: 'wifiOff' });
            return;
          }
          // Navigation closes open dialogs, so onboarding may only open
          // once the hash change has been handled — opening it in the same
          // breath would see it swept away by its own navigation.
          if (location.hash === '#/') {
            openOnboarding();
          } else {
            window.addEventListener('hashchange', () => openOnboarding(), { once: true });
            location.hash = '#/';
          }
        },
      }, 'Start fresh')
    ));
  }
  store.addEventListener('change', renderSampleBanner);
  renderSampleBanner();

  function navigate(hash) {
    location.hash = hash;
  }

  /**
   * Rewrite the current entry's query without navigating: a list's filter
   * chips and the Reports period are state a page should come back to. Kept
   * only in a closure, they were gone on Back — the list came back showing
   * everything, and scroll memory (keyed by hash) restored the offset that
   * belonged to the filtered slice onto the full list. replaceState fires
   * no hashchange, so nothing re-renders; the trail's last entry is renamed
   * so the return trip is recognised under the new string.
   */
  function replaceParams(next) {
    const [path] = (location.hash || '#/').split('?');
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v !== undefined && v !== null) q.set(k, String(v));
    const qs = q.toString();
    const hash = qs ? `${path}?${qs}` : path;
    if (hash === location.hash) return;
    history.replaceState(null, '', hash);
    if (trail.length) trail[trail.length - 1] = hash;
  }

  /* Attention badge: overdue invoices. */
  function overdueCount() {
    const today = todayISO();
    return store.docs().filter((d) => d.kind === 'invoice' && docStatus(d, today) === 'overdue').length;
  }

  function navBadge(route, count) {
    if (route.hash !== '#/invoices' || !count) return null;
    const label = `${count} overdue`;
    return el('span.nav-badge', { role: 'img', 'aria-label': label, title: label },
      count > 9 ? '9+' : String(count));
  }

  /* Sidebar (desktop) */
  const isPuterApp = typeof puter !== 'undefined' && puter.env === 'app';
  const sidebarNav = el('div.side-nav');
  const sidebarFoot = el('div.side-foot');
  const avatar = el('span.user-avatar', { 'aria-hidden': 'true' });
  const acctName = el('span.name');
  const acctSub = el('span.sub');
  /**
   * Whose books these are. It is not decoration: a device that opened from
   * its saved copy cannot ask the cloud who is signed in, so this block is the
   * one place that says which account the read-only copy belongs to. Reading
   * it once at mount left it naming the snapshot's owner after reconnect(),
   * when everything below it had already been replaced by the account that is
   * actually signed in — so it follows the store instead.
   *
   * The business name leads, because that is what the paper is printed for,
   * with the Puter account it is stored in beneath. Until Settings has a
   * business name the account carries both lines' worth on its own.
   */
  let drawnUser = null;
  function renderUser() {
    const user = store.user?.username || 'Puter user';
    const business = (store.settings.business?.name || '').trim();
    const key = `${business}|${user}`;
    if (key === drawnUser) return;
    drawnUser = key;
    avatar.textContent = (business || user).charAt(0).toUpperCase();
    acctName.textContent = business || user;
    acctName.title = business || user;
    acctSub.textContent = isPrivate ? 'Stored on your Jetson' : (business ? user : 'Puter account');
    acctSub.title = acctSub.textContent;
  }
  renderUser();
  store.addEventListener('change', renderUser);

  /* Light and dark, one press apart, in the corner the whole shell is
     identified in. Settings keeps the three-way control — this one only ever
     names the theme you are not in, so System stays reachable there. */
  const themeBtn = el('button.icon-btn.side-theme', { onclick: toggleTheme });
  const isDark = () => currentTheme() === 'dark'
    || (currentTheme() === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  /**
   * What this button says it will do has to match what pressing it does, and
   * it is not the only way the theme moves: Settings has the three-way
   * control, a restored backup brings its own, and the OS setting can change
   * under a shell asking to follow it. So it is drawn from the theme that is
   * actually on screen, on every one of those events, rather than once at
   * mount.
   */
  let drawnDark = null;
  function renderThemeBtn() {
    const dark = isDark();
    if (dark === drawnDark) return;
    drawnDark = dark;
    const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    themeBtn.innerHTML = icon(dark ? 'sun' : 'moon', 16, 1.7);
    themeBtn.setAttribute('aria-label', label);
    themeBtn.title = label;
  }
  async function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    renderThemeBtn();
    store.settings.theme = next;
    try {
      await store.updateSettings({ theme: next });
    } catch { /* applied locally; syncs on the next save */ }
  }
  renderThemeBtn();
  store.addEventListener('change', renderThemeBtn);
  document.addEventListener('themechange', renderThemeBtn);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeBtn);

  const sidebar = el('nav.sidebar', { 'aria-label': 'Main navigation' },
    el('div.brand', {},
      el('img.brand-mark', { src: './icon-192.png', alt: '', 'aria-hidden': 'true' }),
      el('span.brand-name', {}, 'Invoicing'),
      themeBtn
    ),
    el('div.side-account', {},
      avatar,
      el('span.side-account-main', {}, acctName, acctSub)
    ),
    sidebarNav,
    el('div.side-create', {}, newInvoiceBtn, newQuoteBtn),
    sidebarFoot
  );

  /* Tab bar (mobile) */
  const tabbar = el('nav.tabbar', { 'aria-label': 'Main navigation' });

  function openMoreSheet() {
    const modal = openModal({
      title: 'More',
      content: el('div.settings-list', {},
        ROUTES.filter((r) => r.tab === false).map((r) =>
          el('a.settings-row', {
            href: r.hash, style: { color: 'inherit' },
            onclick: () => modal.close(),
          },
            el('span', { html: icon(r.icon, 18, 1.5), style: { color: 'var(--ink-2)' } }),
            el('div.grow', {},
              el('div.title', {}, r.label),
              el('div.sub', {}, MORE_SUBS[r.hash] || '')),
            el('span', { html: icon('chevR', 17), style: { color: 'var(--ink-3)' } })
          ))
      ),
    });
  }

  // What the nav was last drawn with, so a store change that leaves it
  // identical can skip the rebuild entirely (see the listener at the end).
  let drawnOverdue = null;

  function renderNav() {
    const { route } = parseRoute(location.hash);
    const activeHash = route.parent || route.hash;
    const overdue = overdueCount();
    drawnOverdue = overdue;
    clear(sidebarNav);
    clear(sidebarFoot);
    clear(tabbar);

    const navItem = (r) => {
      const active = r.hash === activeHash;
      return el('a.nav-item', {
        href: r.hash,
        className: `nav-item${active ? ' active' : ''}`,
        html: icon(r.icon, 17, 1.7),
        'aria-current': active ? 'page' : null,
      }, el('span', {}, r.label), navBadge(r, overdue));
    };

    // The headings are what make eleven destinations read as three short
    // lists, and a heading that is only a line of text above some links says
    // nothing to a screen reader. Each group carries its own name, pointing
    // at the very words on screen — so a reader that ignores groups still
    // reads the heading exactly as it did before.
    for (const group of NAV_GROUPS) {
      const labelId = `nav-group-${group.label.toLowerCase()}`;
      sidebarNav.append(el('div.nav-group', { role: 'group', 'aria-labelledby': labelId },
        el('div.nav-group-label', { id: labelId }, group.label),
        group.hashes.map((h) => {
          const r = ROUTES.find((x) => x.hash === h);
          return r ? navItem(r) : null;
        })));
    }

    // Below the rule: the shell's own settings, and the way out of it.
    for (const r of ROUTES.filter((x) => x.foot)) sidebarFoot.append(navItem(r));
    // Inside the Puter desktop, sessions belong to the OS shell, not the app.
    if (!isPrivate && !isPuterApp) {
      sidebarFoot.append(el('button.nav-item', {
        type: 'button',
        html: icon('logout', 17, 1.7),
        onclick: confirmSignOut,
      }, el('span', {}, 'Sign out')));
    }

    for (const r of ROUTES) {
      if (r.tab === false) continue;
      const active = r.hash === activeHash;
      tabbar.append(el('a.tab-item', {
        href: r.hash,
        className: `tab-item${active ? ' active' : ''}`,
        html: icon(r.icon, 17, 1.7),
        'aria-current': active ? 'page' : null,
      }, el('span', {}, r.label), navBadge(r, overdue)));
    }
    const moreActive = ROUTES.some((r) => r.tab === false && r.hash === activeHash);
    tabbar.append(el('button.tab-item', {
      type: 'button',
      className: `tab-item${moreActive ? ' active' : ''}`,
      html: icon('more', 17, 1.7),
      'aria-haspopup': 'dialog',
      onclick: openMoreSheet,
    }, el('span', {}, 'More')));
  }

  /* Where the user stood on each page they stepped away from. Opening the
     thirtieth row of a long list and coming back landed at the top of it, and
     the row had to be found all over again. The position is given back only
     on the way *back up*: when the page being left is a leaf — a document, an
     editor, a client's page, the routes that borrow a list's nav highlight —
     and the page being entered is the one it was opened from (list → document
     → list, document → editor → document). Travelling between the navigation's
     own pages always starts at the top, and a repaint of the page already on
     screen keeps its place. */
  const scrollMemory = new Map();
  const trail = [];   // hashes rendered so far, newest last

  function renderRoute() {
    // A dialog belongs to the page that opened it. Navigation — above all
    // the browser's Back button, which never asked the app first — must
    // not swap the view underneath a dialog that stays floating over the
    // wrong page with the app inert behind it.
    closeAllModals();
    const here = location.hash || '#/';
    const leaving = trail[trail.length - 1];
    if (leaving !== undefined) scrollMemory.set(leaving, window.scrollY);
    const returning = leaving === here
      || (trail[trail.length - 2] === here && !!parseRoute(leaving).route.parent);
    if (leaving !== here) {
      trail.push(here);
      if (trail.length > 40) trail.shift();
    }
    const { route, params } = parseRoute(here);
    renderNav();
    currentView?.destroy?.();
    clear(viewWrap);
    currentView = route.view({ navigate, params, replaceParams });
    viewWrap.append(currentView);
    main.scrollTop = 0;
    window.scrollTo({ top: returning ? (scrollMemory.get(here) || 0) : 0 });
    // The FAB is contextual (estimates view creates an estimate), so its
    // accessible name must follow what it actually does here. On the editor
    // it disappears entirely: the editor has no unsaved-changes guard, so a
    // "new document" button floating over the form is a one-tap way to
    // discard everything typed.
    // Nothing to create while this device is showing a saved copy.
    fab.hidden = route.view === editorView || store.readOnly;
    // The editor commits from a bar pinned to the bottom of the screen, which
    // is where the toasts land: a validation message covered the very buttons
    // it was about. The stylesheet lifts them clear while this route is on.
    document.body.classList.toggle('route-editor', route.view === editorView);
    fab.setAttribute('aria-label', fabOnQuotes() ? 'New estimate' : 'New invoice');
  }

  const fabOnQuotes = () => (location.hash || '').startsWith('#/quotes');
  const fab = el('button.fab', {
    html: icon('plus', 22, 1.8),
    'aria-label': 'New invoice',
    onclick: () => navigate(fabOnQuotes() ? '#/new/quote' : '#/new/invoice'),
  });

  /* Fifteen tab stops stand between the top of the page and the content on a
     desktop: the theme toggle, nine nav items, the two create buttons,
     Settings and Sign out. They are the same ones on every page. The href
     keeps the link's semantics, but
     the jump is made by hand — the app routes on the hash, and letting
     "#main" reach it would land the user on the dashboard. */
  const skipLink = el('a.skip-link', {
    href: '#main',
    onclick: (e) => {
      e.preventDefault();
      main.setAttribute('tabindex', '-1');
      main.focus();
    },
  }, 'Skip to content');

  clear(appRoot);
  appRoot.append(skipLink, el('div.shell', {}, sidebar, main), tabbar, fab);
  // The toast live region must exist before the first message lands in it,
  // or screen readers have nothing watching the mutation.
  mountToastRoot();

  window.addEventListener('hashchange', renderRoute);
  renderRoute();

  // The overdue badge follows the data: refresh (debounced) on any change.
  // Only when the count actually moved, though — rebuilding both nav lists
  // is how a save landing while a keyboard user sits on a nav item destroys
  // the item under them and drops focus to <body>, and every save emits.
  let badgeTimer;
  let wasReadOnly = store.readOnly;
  store.addEventListener('change', () => {
    // Coming back online changes what the whole page offers — the create
    // buttons, the FAB, every view's own actions — so it is repainted whole
    // rather than left half in the old state.
    if (store.readOnly !== wasReadOnly) {
      wasReadOnly = store.readOnly;
      renderRoute();
      return;
    }
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      if (overdueCount() !== drawnOverdue) renderNav();
    }, 300);
  });
}
