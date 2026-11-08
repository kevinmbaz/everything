import { el, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { store } from '../lib/store.js';
import { formatTotals, totalsByCurrency } from '../lib/money.js';
import { monthKey, monthLabel } from '../lib/dates.js';
import { normalizeText, debounce } from '../lib/util.js';
import { expenseListByDay, emptyState, skeletonList } from '../ui/common.js';
import { openExpenseForm } from '../ui/expenseform.js';
import { openCapture } from '../ui/capture.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { isEditable } from '../lib/reports.js';
import { downloadBlob, expensesToCSV } from '../lib/export.js';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unreported', label: 'Not in a report' },
  { id: 'reported', label: 'In a report' },
  { id: 'unreconciled', label: 'Not reconciled' },
  { id: 'reconciled', label: 'Reconciled' },
  { id: 'noreceipt', label: 'Missing receipt' },
];

export function expensesView({ navigate }) {
  const root = el('section.view', { 'aria-labelledby': 'exp-title' });
  const query = new URLSearchParams((location.hash.split('?')[1] || ''));
  const state = { q: '', status: STATUS_FILTERS.some((f) => f.id === query.get('filter')) ? query.get('filter') : 'all', category: '', month: '', selecting: false, selected: new Set() };
  let all = [];
  let loaded = false;

  const search = el('input.input', { type: 'search', placeholder: 'Search merchant, notes, amount', 'aria-label': 'Search expenses', autocomplete: 'off',
    oninput: debounce((e) => { state.q = e.target.value; renderList(); }, 120) });
  const statusSel = pillSelect('Status', STATUS_FILTERS.map((f) => [f.id, f.label]), state.status, (v) => { state.status = v; renderList(); });
  const catSel = pillSelect('Category', [['', 'All categories'], ...store.categories.map((c) => [c.id, c.name])], '', (v) => { state.category = v; renderList(); });
  const monthSel = el('div.select-wrap');
  const selectBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', html: icon('squareCheck', 15, 2.2), onclick: () => toggleSelecting() }, 'Select');
  const exportBtn = el('button.btn.btn-ghost.btn-sm', { type: 'button', html: icon('sheet', 15, 2.2), 'aria-label': 'Export CSV', title: 'Export visible expenses as CSV', onclick: exportCSV }, 'CSV');

  const summary = el('p.page-sub', { id: 'exp-summary' });
  const listWrap = el('div', { 'aria-live': 'polite', 'aria-busy': 'true' }, skeletonList(6));
  const bulkBar = el('div.bulk-bar', { hidden: true });

  root.append(
    el('div.page-head', {},
      el('div', {}, el('h1.page-title', { id: 'exp-title' }, 'Expenses'), summary),
      el('div.page-actions', {},
        el('button.btn.btn-outline', { type: 'button', html: icon('plus', 16, 2.2), onclick: () => openExpenseForm() }, 'Manual entry'),
        el('button.btn.btn-primary', { type: 'button', html: icon('camera', 16, 2.2), onclick: () => openCapture() }, 'Capture'))),
    el('div.filter-bar', {},
      el('div.search-wrap', { html: icon('search', 17, 2) }, search),
      statusSel, catSel, monthSel, el('span.grow'), selectBtn, exportBtn),
    listWrap,
    bulkBar
  );

  function pillSelect(label, options, value, onChange) {
    return el('div.select-wrap', {}, el('select.select.select-pill', { 'aria-label': label, onchange: (e) => onChange(e.target.value) },
      options.map(([v, l]) => el('option', { value: v, selected: v === value }, l))));
  }

  function renderMonthSelect() {
    clear(monthSel);
    monthSel.append(el('select.select.select-pill', { 'aria-label': 'Month', onchange: (e) => { state.month = e.target.value; renderList(); } },
      el('option', { value: '', selected: !state.month }, 'All time'),
      store.months.map((m) => el('option', { value: m, selected: m === state.month }, monthLabel(m)))));
  }

  function filtered() {
    const q = normalizeText(state.q);
    return all.filter((e) => {
      if (state.month && !e.date.startsWith(state.month)) return false;
      if (state.category && e.categoryId !== state.category) return false;
      switch (state.status) {
        case 'unreported': if (e.reportId) return false; break;
        case 'reported': if (!e.reportId) return false; break;
        case 'unreconciled': if (e.reconciled) return false; break;
        case 'reconciled': if (!e.reconciled) return false; break;
        case 'noreceipt': if (e.receiptPath) return false; break;
        default: break;
      }
      if (q) {
        const hay = normalizeText(`${e.merchant} ${e.notes} ${e.amount} ${store.category(e.categoryId)?.name || ''} ${e.date}`);
        if (!q.split(' ').every((t) => hay.includes(t))) return false;
      }
      return true;
    });
  }

  function renderList() {
    if (!loaded) return;
    const list = filtered();
    clear(listWrap);
    listWrap.setAttribute('aria-busy', 'false');
    summary.textContent = `${list.length} of ${all.length} expense${all.length === 1 ? '' : 's'}, ${formatTotals(totalsByCurrency(list), store.settings.baseCurrency)}`;
    if (!all.length) {
      listWrap.append(emptyState({ icon: 'scan', title: 'No expenses yet', text: 'Capture a receipt or enter one manually to get started.', action: { label: 'Capture receipt', icon: 'camera', onClick: () => openCapture() } }));
      return;
    }
    if (!list.length) {
      listWrap.append(emptyState({ icon: 'filter', title: 'Nothing matches', text: 'Try a different search or clear the filters.', action: { label: 'Clear filters', onClick: clearFilters } }));
      return;
    }
    listWrap.append(expenseListByDay(list, (e) => ({
      onClick: state.selecting ? () => toggle(e.id, !state.selected.has(e.id)) : () => openExpenseForm({ expense: e }),
      showDate: false, showReport: true,
      selected: state.selecting ? state.selected.has(e.id) : null,
      onToggle: state.selecting ? (on) => toggle(e.id, on) : null,
    })));
    renderBulk();
  }

  function clearFilters() {
    state.q = ''; state.status = 'all'; state.category = ''; state.month = '';
    search.value = '';
    statusSel.querySelector('select').value = 'all';
    catSel.querySelector('select').value = '';
    renderMonthSelect();
    renderList();
  }

  function toggleSelecting(on = !state.selecting) {
    state.selecting = on;
    state.selected.clear();
    selectBtn.textContent = on ? 'Done' : 'Select';
    selectBtn.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('selecting', on);
    renderList();
  }
  function toggle(id, on) {
    if (on) state.selected.add(id); else state.selected.delete(id);
    renderList();
  }

  function renderBulk() {
    const n = state.selected.size;
    bulkBar.hidden = !state.selecting;
    clear(bulkBar);
    if (!state.selecting) return;
    const visible = filtered();
    const drafts = store.reports.filter((r) => isEditable(r));
    bulkBar.append(
      el('span.grow', {}, n ? `${n} selected` : 'Select expenses'),
      el('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: () => { for (const e of visible) state.selected.add(e.id); renderList(); } }, 'Select all'),
      el('button.btn.btn-primary.btn-sm', { type: 'button', disabled: !n, html: icon('folder', 14, 2.2), onclick: () => addToReport([...state.selected], drafts) }, 'Add to report')
    );
  }

  function addToReport(ids, drafts) {
    const body = el('div.stack');
    const modal = openModal({ title: 'Add to report', content: body });
    let createdReport = null;
    let creating = false;
    const pick = async (reportId, generation = modal.editGeneration) => {
      try {
        await store.setReport(ids, reportId);
        if (!modal.closeIfUnchanged(generation)) return;
        toggleSelecting(false);
        toast(`${ids.length} expense${ids.length === 1 ? '' : 's'} added to the report`, { action: { label: 'Open', onClick: () => navigate(`#/reports/${reportId}`) } });
      } catch (err) { console.error(err); toast('Couldn’t update. Check your connection', { icon: 'wifiOff' }); }
    };
    const titleInput = el('input.input', { type: 'text', placeholder: `${monthLabel(monthKey())} expenses`, 'aria-label': 'New report title' });
    body.append(
      drafts.length ? el('div.list', {}, drafts.map((r) => el('button.list-row', { type: 'button', onclick: () => pick(r.id) },
        el('div.grow', {}, el('div.title', {}, r.title), el('div.sub', {}, 'Draft')), el('span', { html: icon('chevR', 18), style: { color: 'var(--ink-3)' } }))))
        : el('p.muted.small', {}, 'No draft reports yet. Create one:'),
      el('div.row', {}, titleInput, el('button.btn.btn-primary', { type: 'button', onclick: async () => {
        if (creating) return;
        creating = true;
        const generation = modal.editGeneration;
        const data = { title: titleInput.value.trim() || titleInput.placeholder };
        try {
          const r = createdReport ? await store.updateReport(createdReport.id, data) : await store.createReport(data);
          if (store.sdk?.mode === 'private') createdReport = r;
          await pick(r.id, generation);
        } catch { toast('Couldn’t create report', { icon: 'wifiOff' }); }
        finally { creating = false; }
      } }, 'Create'))
    );
  }

  function exportCSV() {
    const list = filtered();
    if (!list.length) { toast('Nothing to export', { icon: 'info' }); return; }
    const csv = expensesToCSV(list, { categories: store.categories, reports: store.reports });
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `expenses-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  let alive = true;
  async function load() {
    try {
      all = await store.loadAll();
    } catch (err) {
      console.error(err);
      if (!alive) return;
      clear(listWrap);
      listWrap.append(emptyState({ icon: 'wifiOff', title: 'Couldn’t load expenses', text: 'Check your connection and try again.', action: { label: 'Retry', onClick: load } }));
      return;
    }
    if (!alive) return;
    loaded = true;
    renderMonthSelect();
    renderList();
  }
  const onChange = () => load();
  store.addEventListener('change', onChange);
  root.destroy = () => { alive = false; store.removeEventListener('change', onChange); document.body.classList.remove('selecting'); };
  load();
  return root;
}
