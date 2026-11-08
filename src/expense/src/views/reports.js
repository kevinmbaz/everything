import { el, clear, field } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { store } from '../lib/store.js';
import { formatTotals, formatMoney } from '../lib/money.js';
import { formatDate, monthKey } from '../lib/dates.js';
import { REPORT_STATUSES, STATUS_LABEL, nextStatus, transitionLabel, isEditable, reportTotals, reportExpenses, suggestReportTitle } from '../lib/reports.js';
import { statusBadge, expenseListByDay, emptyState, skeletonList, sectionHead, expenseRow } from '../ui/common.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { openExpenseForm } from '../ui/expenseform.js';
import { downloadBlob, expensesToCSV } from '../lib/export.js';

export function reportsView({ navigate, params }) {
  return params?.id ? reportDetail({ navigate, id: params.id }) : reportsList({ navigate });
}

/* ------------------------------------------------------------ list */

function reportsList({ navigate }) {
  const root = el('section.view', { 'aria-labelledby': 'rep-title' });
  let filter = 'open';
  const listWrap = el('div', { 'aria-busy': 'true' }, skeletonList(3));
  const seg = el('div.segmented', { role: 'group', 'aria-label': 'Filter reports' },
    ['open', 'reimbursed', 'all'].map((f) => el('button', {
      type: 'button', 'aria-pressed': f === filter,
      onclick: (e) => { filter = f; for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); render(); },
    }, f === 'open' ? 'Open' : f === 'reimbursed' ? 'Reimbursed' : 'All')));

  root.append(
    el('div.page-head', {},
      el('div', {}, el('h1.page-title', { id: 'rep-title' }, 'Reports'), el('p.page-sub', {}, 'Bundle expenses and track them to reimbursement')),
      el('div.page-actions', {}, el('button.btn.btn-primary', { type: 'button', html: icon('plus', 16, 2.2), onclick: () => openReportForm({ onSaved: (r) => navigate(`#/reports/${r.id}`) }) }, 'New report'))),
    el('div.filter-bar', {}, seg),
    listWrap
  );

  let all = [];
  let alive = true;
  async function render() {
    try { all = await store.loadAll(); } catch (err) { console.error(err); }
    if (!alive) return;
    const reports = store.reports.filter((r) => filter === 'all' || (filter === 'reimbursed' ? r.status === 'reimbursed' : r.status !== 'reimbursed'));
    clear(listWrap);
    listWrap.setAttribute('aria-busy', 'false');
    if (!store.reports.length) {
      listWrap.append(emptyState({ icon: 'folder', title: 'No reports yet', text: 'A report groups expenses for a trip, a month, or a project, then moves from draft to submitted, approved, and reimbursed.', action: { label: 'Create a report', icon: 'plus', onClick: () => openReportForm({ onSaved: (r) => navigate(`#/reports/${r.id}`) }) } }));
      return;
    }
    if (!reports.length) {
      listWrap.append(emptyState({ icon: 'folder', title: filter === 'open' ? 'Nothing open' : 'Nothing reimbursed yet', text: filter === 'open' ? 'Every report has been reimbursed.' : 'Reports land here once they are paid out.' }));
      return;
    }
    listWrap.append(el('div.report-grid', {}, reports.map((r) => reportCard(r, all))));
  }

  function reportCard(r, expenses) {
    const t = reportTotals(r, expenses);
    const step = REPORT_STATUSES.indexOf(r.status);
    return el('a.report-card', { href: `#/reports/${r.id}` },
      el('div.row.between', {}, el('h3.report-card-title.truncate', {}, r.title), statusBadge(r.status)),
      el('div.report-card-total', {}, formatTotals(t.byCurrency, store.settings.baseCurrency)),
      el('div.report-card-meta', {},
        `${t.count} expense${t.count === 1 ? '' : 's'}`,
        t.count ? `, ${t.withReceipt}/${t.count} with receipts` : '',
        r.status === 'reimbursed' && r.reimbursedAt ? `, paid ${formatDate(new Date(r.reimbursedAt).toISOString().slice(0, 10))}` : ''),
      el('ol.steps', { 'aria-label': `Status: ${STATUS_LABEL[r.status]}` }, REPORT_STATUSES.map((s, i) => el('li', { className: `step${i <= step ? ' done' : ''}`, 'aria-current': s === r.status ? 'step' : null }, el('span.visually-hidden', {}, STATUS_LABEL[s]))))
    );
  }

  const onChange = () => render();
  store.addEventListener('change', onChange);
  root.destroy = () => { alive = false; store.removeEventListener('change', onChange); };
  render();
  return root;
}

/* ------------------------------------------------------------ detail */

function reportDetail({ navigate, id }) {
  const root = el('section.view.report-detail', { 'aria-labelledby': 'rep-title' });
  let alive = true;

  async function render() {
    const report = store.report(id);
    clear(root);
    if (!report) {
      root.append(el('a.back-link', { href: '#/reports', html: icon('chevL', 16, 2.2) }, 'Reports'),
        emptyState({ icon: 'folder', title: 'Report not found', text: 'It may have been deleted.' }));
      return;
    }
    let all = [];
    try { all = await store.loadAll(); } catch (err) { console.error(err); }
    if (!alive) return;
    const expenses = reportExpenses(report, all);
    const t = reportTotals(report, expenses);
    const editable = isEditable(report);
    const next = nextStatus(report.status);
    const missingReceipts = expenses.filter((e) => !e.receiptPath).length;

    const primary = next && el('button.btn.btn-primary', {
      type: 'button', html: icon(next === 'submitted' ? 'send' : next === 'approved' ? 'badge' : 'banknote', 16, 2.2),
      onclick: async () => {
        if (next === 'submitted' && !expenses.length) { toast('Add at least one expense before submitting', { icon: 'info' }); return; }
        if (next === 'submitted' && missingReceipts) {
          const ok = await confirmDialog({ title: 'Submit without every receipt?', message: `${missingReceipts} expense${missingReceipts === 1 ? ' has' : 's have'} no receipt attached. You can still submit, but the expenses are locked until the report is withdrawn.`, confirmLabel: 'Submit anyway', danger: false });
          if (!ok) return;
        }
        try { await store.transitionReport(id, next); toast(`Report ${STATUS_LABEL[next].toLowerCase()}`); } catch (err) { console.error(err); toast('Couldn’t update the report', { icon: 'wifiOff' }); }
      },
    }, transitionLabel(report.status));

    const more = el('div.page-actions', {},
      report.status === 'submitted' && el('button.btn.btn-ghost', { type: 'button', html: icon('undo', 16, 2.2), onclick: async () => { await store.transitionReport(id, 'draft').then(() => toast('Report back in draft')).catch(() => toast('Couldn’t withdraw', { icon: 'wifiOff' })); } }, 'Withdraw'),
      el('button.btn.btn-outline', { type: 'button', html: icon('sheet', 16, 2.2), onclick: () => {
        if (!expenses.length) { toast('Nothing to export', { icon: 'info' }); return; }
        downloadBlob(new Blob([expensesToCSV(expenses, { categories: store.categories, reports: store.reports })], { type: 'text/csv;charset=utf-8' }), `${report.title.replace(/[^\w-]+/g, '-')}.csv`);
      } }, 'CSV'),
      el('button.btn.btn-outline', { type: 'button', html: icon('printer', 16, 2.2), onclick: () => window.print() }, 'Print'),
      el('button.icon-btn', { type: 'button', html: icon('pencil', 18, 2), 'aria-label': 'Edit report', title: 'Edit', onclick: () => openReportForm({ report }) }),
      el('button.icon-btn.danger', { type: 'button', html: icon('trash', 18, 2), 'aria-label': 'Delete report', title: 'Delete', onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete this report?', message: 'Its expenses are kept and go back to “not in a report”.', confirmLabel: 'Delete report' });
        if (!ok) return;
        try { await store.deleteReport(id); toast('Report deleted', { icon: 'trash' }); navigate('#/reports'); } catch (err) { console.error(err); toast('Couldn’t delete', { icon: 'wifiOff' }); }
      } }),
      primary
    );

    const step = REPORT_STATUSES.indexOf(report.status);
    const timeline = el('ol.timeline', { 'aria-label': 'Report progress' }, REPORT_STATUSES.map((s, i) => {
      const at = { submitted: report.submittedAt, approved: report.approvedAt, reimbursed: report.reimbursedAt, draft: report.createdAt }[s];
      return el('li', { className: `tl-step${i <= step ? ' done' : ''}${s === report.status ? ' current' : ''}`, 'aria-current': s === report.status ? 'step' : null },
        el('span.tl-dot', { 'aria-hidden': 'true' }),
        el('span.tl-label', {}, STATUS_LABEL[s]),
        el('span.tl-date', {}, i <= step && at ? formatDate(new Date(at).toISOString().slice(0, 10)) : ''));
    }));

    root.append(
      el('a.back-link', { href: '#/reports', html: icon('chevL', 16, 2.2) }, 'Reports'),
      el('div.page-head', {},
        el('div', {},
          el('div.row', {}, el('h1.page-title', { id: 'rep-title' }, report.title), statusBadge(report.status)),
          el('p.page-sub', {}, report.notes || `Created ${formatDate(new Date(report.createdAt).toISOString().slice(0, 10))}`)),
        more),
      el('div.report-summary.card', {},
        el('div.report-total', {}, el('span.label', {}, 'Total'), el('span.value', {}, formatTotals(t.byCurrency, store.settings.baseCurrency))),
        el('div.report-facts', {},
          fact('receipt', `${t.withReceipt}/${t.count}`, 'with receipts'),
          fact('circleCheck', `${t.reconciled}/${t.count}`, 'reconciled'),
          fact('layers', String(t.count), t.count === 1 ? 'expense' : 'expenses')),
        timeline),
      !editable && el('div.banner', {}, el('span', { html: icon('info', 15, 2.2) }), el('span.grow', {}, 'This report has been submitted. Withdraw it to add or remove expenses.')),
      el('div.card', {},
        sectionHead('Expenses', editable && el('button.btn.btn-outline.btn-sm', { type: 'button', html: icon('plus', 14, 2.2), onclick: () => openAddExpenses(report, all) }, 'Add expenses')),
        expenses.length
          ? expenseListByDay(expenses, (e) => ({
            onClick: () => openExpenseForm({ expense: e }), showDate: false,
            trail: el('div.trail', {}, el('div.amount', {}, formatMoney(e.amount, e.currency)),
              editable && el('button.icon-btn', { type: 'button', html: icon('x', 16, 2.2), 'aria-label': `Remove ${e.merchant} from report`, title: 'Remove from report',
                onclick: (ev) => { ev.stopPropagation(); store.setReport([e.id], null).then(() => toast('Removed from report')).catch(() => toast('Couldn’t remove', { icon: 'wifiOff' })); } })),
          }))
          : emptyState({ icon: 'receipt', title: 'No expenses in this report', text: editable ? 'Add expenses you have already captured, or capture new ones and pick this report when saving.' : '', action: editable ? { label: 'Add expenses', icon: 'plus', onClick: () => openAddExpenses(report, all) } : null }))
    );
  }

  function fact(ic, value, label) {
    return el('div.fact', { html: icon(ic, 16, 2) }, el('span.fact-value', {}, value), el('span.fact-label', {}, label));
  }

  function openAddExpenses(report, all) {
    const candidates = all.filter((e) => !e.reportId);
    const picked = new Set();
    const list = el('div');
    const addBtn = el('button.btn.btn-primary', { type: 'button', disabled: true }, 'Add');
    const renderList = () => {
      clear(list);
      if (!candidates.length) { list.append(el('p.muted', {}, 'Every expense is already in a report. Capture a new one and pick this report when saving.')); return; }
      list.append(expenseListByDay(candidates, (e) => ({
        onClick: () => { if (picked.has(e.id)) picked.delete(e.id); else picked.add(e.id); addBtn.disabled = !picked.size; addBtn.textContent = picked.size ? `Add ${picked.size}` : 'Add'; renderList(); },
        showDate: false, selected: picked.has(e.id), onToggle: (on) => { if (on) picked.add(e.id); else picked.delete(e.id); addBtn.disabled = !picked.size; addBtn.textContent = picked.size ? `Add ${picked.size}` : 'Add'; renderList(); },
      }), { totals: false }));
    };
    renderList();
    addBtn.onclick = async () => {
      if (addBtn.disabled) return;
      addBtn.disabled = true;
      const controls = store.sdk?.mode === 'private' ? [...list.querySelectorAll('input, button')] : [];
      for (const control of controls) control.disabled = true;
      try { await store.setReport([...picked], report.id); modal.close(); toast(`${picked.size} added to ${report.title}`); } catch (err) { console.error(err); addBtn.disabled = false; toast('Couldn’t add', { icon: 'wifiOff' }); }
      finally { for (const control of controls) control.disabled = false; }
    };
    const modal = openModal({ title: 'Add expenses', content: el('div', {}, list, el('div.row.end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), addBtn)) });
  }

  const onChange = () => render();
  store.addEventListener('change', onChange);
  root.destroy = () => { alive = false; store.removeEventListener('change', onChange); };
  render();
  return root;
}

/* ------------------------------------------------------------ create / edit */

export function openReportForm({ report = null, onSaved = null } = {}) {
  const title = el('input.input', { type: 'text', value: report?.title || '', placeholder: suggestReportTitle(monthKey()), maxlength: 80 });
  const notes = el('textarea.textarea', { rows: 2, placeholder: 'Purpose, cost centre, trip' }, report?.notes || '');
  const save = el('button.btn.btn-primary', { type: 'submit' }, report ? 'Save' : 'Create report');
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (save.disabled) return;
      save.disabled = true;
      const generation = modal.editGeneration;
      try {
        const data = { title: title.value.trim() || title.placeholder, notes: notes.value.trim() };
        const saved = report ? await store.updateReport(report.id, data) : await store.createReport(data);
        if (!modal.closeIfUnchanged(generation)) {
          report = saved;
          save.disabled = false;
          save.textContent = 'Save';
          return;
        }
        toast(report ? 'Report updated' : 'Report created');
        onSaved?.(saved);
      } catch (err) { console.error(err); save.disabled = false; toast('Couldn’t save', { icon: 'wifiOff' }); }
    },
  },
    field('Title', title),
    field('Notes', notes, { hint: '(optional)' }),
    el('div.row.end', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), save));
  const modal = openModal({ title: report ? 'Edit report' : 'New report', content: form });
  return modal;
}
