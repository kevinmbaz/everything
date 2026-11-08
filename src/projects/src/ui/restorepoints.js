import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { store } from '../lib/store.js';
import { KEEP_DAILY, KEEP_WEEKLY } from '../lib/snapshots.js';
import { fmtLong, todayISO } from '../lib/dates.js';
import { formatBytes, relativeTime } from '../lib/util.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { clearHistory } from './history.js';
import { projectHash } from '../lib/routes.js';
import { emptyState } from './bits.js';

/**
 * Restore points: the day-granularity answer to "give me yesterday's
 * project" after a bad bulk edit or a botched column delete.
 *
 * Scoped to one project from its menu, or across every project (including
 * ones no longer in the sidebar) from Settings.
 */
export function openRestorePoints({ projectId = null } = {}) {
  const list = el('div.restore-list');
  const hint = el('p.form-hint');

  const content = el('div', {},
    el('p.form-hint', {}, projectId
      ? 'A copy is kept the first time this project changes on any day. '
        + `About ${KEEP_DAILY} daily and ${KEEP_WEEKLY} weekly copies are kept.`
      : 'A copy of each project is kept the first time it changes on any day. '
        + 'Projects you deleted keep theirs too, so they can come back.'),
    hint,
    list
  );

  const modal = openModal({ title: 'Restore points', content, dismissOnBack: true });

  function snapshotRow(row, snap) {
    const today = todayISO();
    const name = row.entry?.name ?? 'this project';
    return el('div.restore-row', {},
      el('span.restore-ic', { html: icon('history', 16, 2), 'aria-hidden': 'true' }),
      el('div.grow', {},
        el('div.restore-date', {}, snap.date === today ? 'Today' : fmtLong(snap.date)),
        el('div.restore-meta', {},
          snap.seq > 0 ? 'Extra copy from that day · ' : '',
          formatBytes(snap.size),
          snap.modified ? ` · ${relativeTime(snap.modified * 1000)}` : ''
        )
      ),
      el('button.btn.btn-ghost.btn-sm', {
        type: 'button',
        // Every row's button says "Restore"; only the date beside it says
        // which copy, so the label has to carry it.
        'aria-label': `Restore ${name} to ${fmtLong(snap.date)}`,
        onclick: () => restore(row, snap),
      }, 'Restore')
    );
  }

  async function restore(row, snap) {
    const name = row.entry?.name ?? 'this project';
    const ok = await confirmDialog({
      title: `Restore ${name} to ${fmtLong(snap.date)}?`,
      message: 'Everything in the project goes back to that copy. The current '
        + 'state is saved as a restore point first, so this is reversible.',
      confirmLabel: 'Restore',
      danger: false,
    });
    if (!ok) return;
    try {
      await store.restoreSnapshot(row.id, snap.name);
      // Every step on that project's undo stack was aimed at a document this
      // just replaced.
      clearHistory(row.id);
      modal.close();
      toast(`${name} restored to ${fmtLong(snap.date)}`, {
        icon: 'history',
        duration: 7000,
      });
      location.hash = projectHash(row.id);
    } catch (err) {
      console.error(err);
      toast('Could not restore that copy. Check your connection', { icon: 'cloudOff' });
    }
  }

  function projectBlock(row, only) {
    const name = row.entry?.name ?? 'Untitled project';
    // Open when there is nothing to choose between, and for a project that
    // is no longer in the sidebar — that is the one people came looking for.
    return el('details.restore-project', { open: only || !!projectId || !row.listed },
      el('summary.restore-summary', {},
        el('span.archived-chevron', { html: icon('chevDown', 15, 2), 'aria-hidden': 'true' }),
        el('span.dot', { style: { background: row.entry?.color || 'var(--ink-3)' }, 'aria-hidden': 'true' }),
        el('span.grow', {}, name),
        !row.listed && el('span.nav-tag.muted', {}, 'deleted'),
        el('span.restore-count', {}, `${row.snapshots.length}`)
      ),
      el('div.restore-rows', {}, row.snapshots.map((s) => snapshotRow(row, s)))
    );
  }

  async function render() {
    clear(list);
    list.append(el('div.view-loading', { role: 'status' }, el('span.spinner')));
    let rows = [];
    try {
      rows = projectId
        ? [{
          id: projectId,
          entry: store.projectEntry(projectId),
          listed: true,
          snapshots: await store.listSnapshots(projectId),
        }].filter((r) => r.snapshots.length)
        : await store.listSnapshotProjects();
    } catch (err) {
      console.error(err);
      clear(list);
      hint.textContent = 'Could not load restore points. Check your connection and try again; your saved copies have not been replaced.';
      list.append(el('button.btn.btn-ghost', { onclick: render }, 'Retry'));
      return;
    }
    clear(list);
    if (!rows.length) {
      hint.textContent = '';
      list.append(emptyState({
        icon: 'history',
        title: 'No restore points yet',
        sub: 'The first change to a project on any day leaves one behind.',
      }));
      return;
    }
    const total = rows.reduce((n, r) => n + r.snapshots.length, 0);
    hint.textContent = `${total} restore point${total === 1 ? '' : 's'} across `
      + `${rows.length} project${rows.length === 1 ? '' : 's'}.`;
    for (const row of rows) list.append(projectBlock(row, rows.length === 1));
  }

  render();
  return modal;
}
