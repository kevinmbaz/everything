import { auth, isPrivateStorage, isPuterDesktop } from '../lib/storage.js';
import { el, clear } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { radioGroupKeys } from '../ui/bits.js';
import { store, TRASH_DAYS } from '../lib/store.js';
import { applyTheme } from '../ui/theme.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { openOnboarding } from '../ui/onboarding.js';
import { openProjectTrash } from '../ui/trash.js';
import { openRestorePoints } from '../ui/restorepoints.js';
import { openMenu } from '../ui/menu.js';
import { exportBackup } from '../ui/backupactions.js';
import { importAnyFile } from '../ui/importfile.js';
import { openCalendarExport } from '../ui/calendarexport.js';
import { canSaveFiles } from '../lib/puterui.js';
import { openShortcuts, MOD_KEY } from '../ui/shortcuts.js';
import { menuButton } from '../ui/navdrawer.js';
import { notificationState, requestNotificationPermission } from '../ui/reminders.js';

export async function confirmSignOut() {
  if (isPrivateStorage) return;
  const ok = await confirmDialog({
    title: 'Sign out?',
    message: 'Your data stays safe in your Puter account and is here when you sign back in.',
    confirmLabel: 'Sign out',
    danger: false,
  });
  if (!ok) return;
  // Debounced writes must land before the session token goes away.
  await store.flushAll();
  if (store.dirty) {
    // The flush failed (offline?) — signing out now would silently discard
    // the very changes the dialog above promised were safe.
    const discard = await confirmDialog({
      title: 'Some changes are not saved',
      message: 'Your latest changes could not reach Puter and will be lost if you sign out now. Check your connection and try again, or sign out anyway.',
      confirmLabel: 'Sign out anyway',
    });
    if (!discard) return;
  }
  auth.signOut();
  location.hash = '#/';
  location.reload();
}

export function settingsView() {
  const username = store.user?.username || 'Puter user';

  /* Appearance */
  const themeGroup = el('div.seg', { role: 'radiogroup', 'aria-label': 'Theme' });
  function renderTheme() {
    const current = store.settings.theme || 'system';
    themeGroup.replaceChildren(...[
      { value: 'light', label: 'Light', icon: 'sun' },
      { value: 'dark', label: 'Dark', icon: 'moon' },
      { value: 'system', label: 'System', icon: 'monitor' },
    ].map((o) => el('button.seg-btn', {
      type: 'button',
      role: 'radio',
      'aria-checked': o.value === current ? 'true' : 'false',
      tabindex: o.value === current ? 0 : -1,
      className: `seg-btn${o.value === current ? ' active' : ''}`,
      html: icon(o.icon, 15, 2),
      onclick: () => {
        applyTheme(o.value);
        store.updateSettings({ theme: o.value }).catch(() => {});
        renderTheme();
      },
    }, el('span', {}, o.label))));
  }
  renderTheme();
  radioGroupKeys(themeGroup, '.seg-btn');

  /* Data */
  const exportBtn = el('button.btn.btn-ghost.btn-sm', {
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    html: icon('download', 15, 2),
    onclick: () => openMenu(exportBtn, [
      {
        label: 'Everything (.zip)',
        icon: 'archive',
        onClick: () => exportBackup(exportBtn, { withAttachments: true }),
      },
      {
        label: 'Data only (.json)',
        icon: 'fileText',
        onClick: () => exportBackup(exportBtn, { withAttachments: false }),
      },
      canSaveFiles() && 'sep',
      canSaveFiles() && {
        label: 'Save .zip to Puter…',
        icon: 'cloud',
        onClick: () => exportBackup(exportBtn, { withAttachments: true, toPuter: true }),
      },
    ]),
  }, ' Export');

  const importBtn = el('button.btn.btn-ghost.btn-sm', {
    html: icon('upload', 15, 2),
    onclick: () => importInput.click(),
  }, ' Import');

  const importInput = el('input', {
    type: 'file',
    accept: '.zip,.json,.csv,.tsv,application/json,application/zip,text/csv',
    style: { display: 'none' },
    onchange: async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (file) await importAnyFile(file, importBtn);
    },
  });

  /* Reminders: permission is asked for here and nowhere else, and the copy
     is honest that they only fire while the app is running. */
  const reminderControl = el('span.row');

  function reminderSub() {
    const state = notificationState();
    if (state === 'unsupported') return 'This browser cannot show notifications';
    if (state === 'granted') return 'Reminders appear while the app is open, or in a pinned tab';
    if (state === 'denied') return 'Blocked in your browser settings. The count in the tab title still works';
    return 'Reminders appear in the app; allow notifications to see them when it is in the background';
  }

  function renderReminders() {
    const state = notificationState();
    clear(reminderControl);
    if (state === 'granted') {
      reminderControl.append(el('span.settings-state', {}, 'On'));
    } else if (state === 'denied' || state === 'unsupported') {
      reminderControl.append(el('span.settings-state.muted', {},
        state === 'denied' ? 'Blocked' : 'Unavailable'));
    } else {
      reminderControl.append(el('button.btn.btn-ghost.btn-sm', {
        onclick: async () => {
          await requestNotificationPermission();
          renderReminders();
          const row = reminderControl.closest('.settings-row');
          const sub = row?.querySelector('.sub');
          if (sub) sub.textContent = reminderSub();
        },
      }, 'Allow'));
    }
  }
  renderReminders();

  /* The count is a discoverability cue: after a delete people look here. */
  const trashCount = store.deletedProjects.length;
  const trashBtn = el('button.btn.btn-ghost.btn-sm', {
    // Two rows in this section put an "Open" button on the right, and out of
    // that context — a screen reader's list of buttons, or a voice command —
    // the pair is indistinguishable. Each says which one it is, count and all.
    'aria-label': `Open deleted projects${trashCount ? ` (${trashCount})` : ''}`,
    onclick: () => openProjectTrash(),
  }, trashCount ? `Open (${trashCount})` : 'Open');

  const section = (title, ...rows) => el('section.settings-section', {},
    el('h2.section-title', {}, title),
    el('div.settings-card', {}, rows));

  const row = ({ ic, title, sub, control }) => el('div.settings-row', {},
    el('span.settings-ic', { html: icon(ic, 19, 1.8) }),
    el('div.grow', {},
      el('div.title', {}, title),
      sub && el('div.sub', {}, sub)),
    control || null);

  return el('section.view.settings-view', {},
    el('header.view-head', {},
      menuButton(),
      el('a.icon-btn.back-btn', { href: '#/', 'aria-label': 'All projects', html: icon('arrowL', 20, 2) }),
      el('h1.view-title', {}, 'Settings')
    ),

    section('Appearance',
      row({ ic: 'monitor', title: 'Theme', sub: 'System follows your device setting', control: themeGroup })
    ),

    section('Reminders',
      row({
        ic: 'bell',
        title: 'Notify me about due tasks',
        sub: reminderSub(),
        control: reminderControl,
      })
    ),

    section('Keyboard',
      row({
        ic: 'help',
        title: 'Keyboard shortcuts',
        sub: `Press ? anywhere, or ${MOD_KEY}+K for the command palette`,
        control: el('button.btn.btn-ghost.btn-sm', { onclick: () => openShortcuts() }, 'View'),
      })
    ),

    section('Data',
      isPrivateStorage && row({ ic: 'cloudOff', title: 'Puter Drive unavailable', sub: 'Upload files from your device. Download exports and full ZIP backups locally; Drive links and Drive export are disabled.' }),
      row({
        ic: 'download',
        title: 'Export everything',
        sub: 'A .zip with every project and its attachments, or JSON on its own',
        control: exportBtn,
      }),
      row({
        ic: 'upload',
        title: 'Import',
        sub: 'A backup from this app, a Trello board JSON, or a CSV from Asana or a '
          + 'spreadsheet. Always added as new projects',
        control: el('span.row', {}, importBtn, importInput),
      }),
      row({
        ic: 'calendarClock',
        title: 'Calendar file',
        sub: 'An .ics of every due date and milestone, for the calendar you already use',
        control: el('button.btn.btn-ghost.btn-sm', {
          'aria-label': 'Export a calendar file',
          onclick: () => openCalendarExport(),
        }, 'Export'),
      }),
      row({
        ic: 'history',
        title: 'Restore points',
        sub: 'Daily copies of each project, kept automatically, including deleted ones',
        control: el('button.btn.btn-ghost.btn-sm', {
          'aria-label': 'Open restore points',
          onclick: () => openRestorePoints(),
        }, 'Open'),
      }),
      row({
        ic: 'trashBin',
        title: 'Deleted projects',
        sub: `Restorable for ${TRASH_DAYS} days after deletion`,
        control: trashBtn,
      }),
      store.settings.sampleData && row({
        ic: 'sparkle', title: 'Sample data', sub: 'Wipe the sample project and start fresh',
        control: el('button.btn.btn-ghost.btn-sm', {
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Start fresh?',
              message: 'The sample project is removed and you start with a clean workspace.',
              confirmLabel: 'Wipe sample data',
            });
            if (!ok) return;
            try {
              await store.wipeSampleData();
              location.hash = '#/';
              openOnboarding();
            } catch (err) {
              console.error(err);
              toast('Could not wipe. Check your connection', { icon: 'cloudOff' });
            }
          },
        }, 'Wipe'),
      })
    ),

    section('Account',
      row({ ic: 'users', title: username, sub: isPrivateStorage ? 'Stored on your Jetson. Access controlled by your private connection.' : 'Signed in with Puter' }),
      // Inside the Puter desktop, the session belongs to the OS — no sign-out.
      !isPrivateStorage && !isPuterDesktop() && row({
        ic: 'logout', title: 'Sign out', sub: 'Your data stays in your Puter account',
        control: el('button.btn.btn-ghost.btn-sm', { onclick: confirmSignOut }, 'Sign out'),
      })
    ),

    section('About',
      row({ ic: 'board', title: 'Project Management', sub: isPrivateStorage ? 'Private Projects. No browser data mirror or offline write replay. Keep regular downloaded backups.' : 'Boards, timelines, and milestones. Your data lives in your own Puter cloud.' }),
      !isPrivateStorage && row({
        ic: 'cloud', title: 'Powered by Puter',
        control: el('a.btn.btn-ghost.btn-sm', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Learn more'),
      })
    )
  );
}
