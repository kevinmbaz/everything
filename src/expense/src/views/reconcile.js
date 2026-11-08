/**
 * Reconciliation: import a statement, review suggested matches, confirm or
 * match by hand, and create expenses for charges nobody filed.
 */

import { el, clear, field } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { store } from '../lib/store.js';
import { formatMoney } from '../lib/money.js';
import { formatDate, friendlyDay } from '../lib/dates.js';
import { parseCSV, detectStatementColumns, rowsToStatementLines } from '../lib/csv.js';
import { suggestMatches, reconcileSummary, scoreMatch, isDuplicateLine } from '../lib/reconcile.js';
import { CURRENCIES } from '../lib/currencies.js';
import { emptyState, skeletonList, expenseRow, sectionHead } from '../ui/common.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { openExpenseForm } from '../ui/expenseform.js';
import { normalizeText } from '../lib/util.js';

export function reconcileView({ navigate }) {
  const root = el('section.view.reconcile', { 'aria-labelledby': 'rec-title' });
  const body = el('div', { 'aria-busy': 'true' }, skeletonList(4));
  root.append(
    el('div.page-head', {},
      el('div', {}, el('h1.page-title', { id: 'rec-title' }, 'Reconcile'), el('p.page-sub', {}, 'Match statement lines to expenses')),
      el('div.page-actions', {}, el('button.btn.btn-primary', { type: 'button', html: icon('fileUp', 16, 2.2), onclick: () => openImport() }, 'Import statement'))),
    body
  );

  let alive = true;
  let tab = 'open';
  let suggestions = [];
  const dismissed = new Set();

  async function render() {
    let lines; let expenses;
    try { [lines, expenses] = await Promise.all([store.loadStatements(), store.loadAll()]); } catch (err) {
      console.error(err);
      if (!alive) return;
      clear(body);
      body.append(emptyState({ icon: 'wifiOff', title: 'Couldn’t load', text: 'Check your connection and try again.', action: { label: 'Retry', onClick: render } }));
      return;
    }
    if (!alive) return;
    body.setAttribute('aria-busy', 'false');
    clear(body);
    const s = reconcileSummary(lines, expenses);
    if (!lines.length) {
      body.append(emptyState({
        icon: 'scale', title: 'No statement imported yet',
        text: 'Export a CSV from your card or bank and import it here. Lines are matched to your expenses by amount, date and merchant.',
        action: { label: 'Import statement', icon: 'fileUp', onClick: () => openImport() },
      }));
      return;
    }
    suggestions = suggestMatches(lines, expenses).filter((m) => !dismissed.has(`${m.lineId}:${m.expenseId}`));

    body.append(
      el('div.stats', {},
        tile('Statement lines', String(s.total)),
        tile('Matched', String(s.matched), s.total ? `${Math.round((s.matched / s.total) * 100)}% done` : ''),
        tile('Open lines', String(s.unmatchedLines)),
        tile('Unreconciled expenses', String(s.unreconciled))),
      el('div.meter', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': s.total, 'aria-valuenow': s.matched, 'aria-label': 'Reconciliation progress', style: { marginBottom: '18px' } },
        el('span', { style: { width: `${s.total ? (s.matched / s.total) * 100 : 0}%` } }))
    );

    if (suggestions.length) body.append(suggestionsCard(lines, expenses));

    const seg = el('div.segmented', { role: 'group', 'aria-label': 'Show lines' },
      [['open', `Open (${s.unmatchedLines})`], ['matched', `Matched (${s.matched})`], ['expenses', `Unreconciled expenses (${s.unreconciled})`]].map(([k, label]) =>
        el('button', { type: 'button', 'aria-pressed': k === tab, onclick: () => { tab = k; render(); } }, label)));
    const batches = [...new Map(lines.map((l) => [l.batchId, l])).values()];
    body.append(el('div.filter-bar', {}, seg, el('span.grow'), batches.length > 0 && el('button.btn.btn-ghost.btn-sm', { type: 'button', html: icon('trash', 14, 2.2), onclick: () => manageBatches(lines) }, 'Imports')));

    if (tab === 'expenses') {
      const open = expenses.filter((e) => !e.reconciled);
      body.append(open.length ? el('div.list', {}, open.map((e) => expenseRow(e, {
        onClick: () => pickLineFor(e, lines),
        trail: el('div.trail', {}, el('div.amount', {}, formatMoney(e.amount, e.currency)), el('span.badge', {}, 'Match')),
      }))) : emptyState({ icon: 'circleCheck', title: 'Every expense is reconciled' }));
      return;
    }
    const shown = lines.filter((l) => (tab === 'open' ? !l.matchedExpenseId : !!l.matchedExpenseId)).sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!shown.length) {
      body.append(emptyState({ icon: tab === 'open' ? 'circleCheck' : 'circleDashed', title: tab === 'open' ? 'Every line is matched' : 'No matched lines yet' }));
      return;
    }
    body.append(el('div.list', {}, shown.map((l) => lineRow(l, expenses))));
  }

  function tile(label, value, delta) {
    return el('div.stat', {}, el('span.label', {}, label), el('span.value', {}, value), delta && el('span.delta', {}, delta));
  }

  function lineRow(l, expenses) {
    const exp = l.matchedExpenseId ? expenses.find((e) => e.id === l.matchedExpenseId) : null;
    return el('div.list-row.static.line-row', {},
      el('span.cat-dot', { style: { '--cat': exp ? 'var(--ok)' : 'var(--ink-3)' }, html: icon(exp ? 'circleCheck' : 'card', 18, 1.9), 'aria-hidden': 'true' }),
      el('div.grow', {},
        el('div.title.truncate', {}, l.description || 'No description'),
        el('div.sub', {}, el('span', {}, formatDate(l.date)), el('span.sep', {}, l.source),
          exp && el('span.sep.truncate', {}, `matched to ${exp.merchant}`))),
      el('div.trail', {},
        el('div.amount', {}, formatMoney(l.amount, l.currency)),
        exp
          ? el('button.icon-btn', { type: 'button', html: icon('unlink', 17, 2), 'aria-label': 'Unmatch', title: 'Unmatch', onclick: () => store.unmatchLine(l.id).then(() => toast('Unmatched')).catch(() => toast('Couldn’t unmatch', { icon: 'wifiOff' })) })
          : el('div.row', {},
            el('button.btn.btn-sm.btn-outline', { type: 'button', onclick: () => pickExpenseFor(l, expenses) }, 'Match'),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', html: icon('plus', 14, 2.2), 'aria-label': 'Create expense from this line', title: 'Create expense', onclick: () => createFromLine(l) }),
            el('button.icon-btn.danger', { type: 'button', html: icon('x', 16, 2.2), 'aria-label': 'Delete line', title: 'Delete line', onclick: async () => {
              await store.deleteStatementLine(l.id).catch(() => toast('Couldn’t delete', { icon: 'wifiOff' }));
            } }))
      ));
  }

  function suggestionsCard(lines, expenses) {
    const byLine = new Map(lines.map((l) => [l.id, l]));
    const byExp = new Map(expenses.map((e) => [e.id, e]));
    const confirmAll = el('button.btn.btn-primary.btn-sm', { type: 'button', html: icon('checkCheck', 14, 2.2), onclick: async () => {
      confirmAll.disabled = true;
      let n = 0;
      for (const m of suggestions) { try { await store.matchLine(m.lineId, m.expenseId); n += 1; } catch (err) { console.error(err); } }
      toast(`${n} match${n === 1 ? '' : 'es'} confirmed`);
    } }, `Confirm all ${suggestions.length}`);
    return el('div.card.suggestions', {},
      sectionHead(`Suggested matches (${suggestions.length})`, confirmAll),
      el('div.stack', {}, suggestions.map((m) => {
        const l = byLine.get(m.lineId); const e = byExp.get(m.expenseId);
        if (!l || !e) return null;
        return el('div.match', {},
          el('div.match-side', {}, el('div.title.truncate', {}, l.description || 'Statement line'), el('div.sub', {}, `${formatDate(l.date)}, ${formatMoney(l.amount, l.currency)}`)),
          el('span.match-link', { html: icon('link', 16, 2.2), 'aria-hidden': 'true' }),
          el('div.match-side', {}, el('div.title.truncate', {}, e.merchant), el('div.sub', {}, `${formatDate(e.date)}, ${formatMoney(e.amount, e.currency)}`)),
          el('div.match-actions', {},
            el('span.badge', { className: `badge ${m.score >= 85 ? 'ok' : 'warn'}`, title: m.reasons.join(', ') }, `${m.score}%`),
            el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: (ev) => { ev.currentTarget.disabled = true; store.matchLine(m.lineId, m.expenseId).then(() => toast('Matched')).catch(() => toast('Couldn’t match', { icon: 'wifiOff' })); } }, 'Confirm'),
            el('button.icon-btn', { type: 'button', html: icon('x', 16, 2.2), 'aria-label': 'Dismiss suggestion', onclick: () => { dismissed.add(`${m.lineId}:${m.expenseId}`); render(); } }))
        );
      })));
  }

  /* Pick an expense for a statement line, ranked by likeness. */
  function pickExpenseFor(line, expenses) {
    const open = expenses.filter((e) => !e.reconciled);
    const ranked = open.map((e) => ({ e, s: scoreMatch(line, e, { days: 30, amount: 0.02, amountPct: 0.15 }) })).sort((a, b) => (b.s?.score || 0) - (a.s?.score || 0));
    const search = el('input.input', { type: 'search', placeholder: 'Search expenses', 'aria-label': 'Search expenses' });
    const list = el('div');
    const draw = () => {
      const q = normalizeText(search.value);
      const shown = ranked.filter(({ e }) => !q || normalizeText(`${e.merchant} ${e.amount} ${e.date}`).includes(q)).slice(0, 40);
      clear(list);
      list.append(shown.length ? el('div.list', {}, shown.map(({ e, s }) => expenseRow(e, {
        onClick: async () => { try { await store.matchLine(line.id, e.id); modal.close(); toast('Matched'); } catch (err) { console.error(err); toast('Couldn’t match', { icon: 'wifiOff' }); } },
        trail: el('div.trail', {}, el('div.amount', {}, formatMoney(e.amount, e.currency)), s && el('span.badge.ok', {}, `${s.score}%`)),
      }))) : el('p.muted.small', {}, 'No unreconciled expenses match'));
    };
    search.oninput = draw;
    draw();
    const modal = openModal({ title: 'Match to an expense', content: el('div', {},
      el('div.line-summary', {}, el('div.title', {}, line.description || 'Statement line'), el('div.sub', {}, `${formatDate(line.date)}, ${formatMoney(line.amount, line.currency)}`)),
      el('div.search-wrap', { html: icon('search', 17, 2), style: { marginBottom: '12px' } }, search),
      list,
      el('div.row.end', {}, el('button.btn.btn-outline', { type: 'button', html: icon('plus', 14, 2.2), onclick: () => { modal.close(); createFromLine(line); } }, 'Create expense instead'))) });
  }

  /* Pick a statement line for an expense. */
  function pickLineFor(exp, lines) {
    const open = lines.filter((l) => !l.matchedExpenseId);
    const ranked = open.map((l) => ({ l, s: scoreMatch(l, exp, { days: 30, amount: 0.02, amountPct: 0.15 }) })).sort((a, b) => (b.s?.score || 0) - (a.s?.score || 0)).slice(0, 40);
    const modal = openModal({ title: `Match ${exp.merchant}`, content: el('div', {},
      ranked.length ? el('div.list', {}, ranked.map(({ l, s }) => el('button.list-row', { type: 'button', onclick: async () => { try { await store.matchLine(l.id, exp.id); modal.close(); toast('Matched'); } catch (err) { console.error(err); toast('Couldn’t match', { icon: 'wifiOff' }); } } },
        el('div.grow', {}, el('div.title.truncate', {}, l.description || 'Statement line'), el('div.sub', {}, formatDate(l.date))),
        el('div.trail', {}, el('div.amount', {}, formatMoney(l.amount, l.currency)), s && el('span.badge.ok', {}, `${s.score}%`)))))
        : el('p.muted', {}, 'No open statement lines. Import a statement first.')) });
  }

  function createFromLine(line) {
    openExpenseForm({
      prefill: { merchant: titleCase(line.description), amount: line.amount, currency: line.currency, date: line.date, paymentMethod: 'Card' },
      onSaved: async (exp) => { try { await store.matchLine(line.id, exp.id); } catch (err) { console.error(err); } },
    });
  }

  function manageBatches(lines) {
    const groups = new Map();
    for (const l of lines) { if (!groups.has(l.batchId)) groups.set(l.batchId, { source: l.source, importedAt: l.importedAt, n: 0, matched: 0 }); const g = groups.get(l.batchId); g.n += 1; if (l.matchedExpenseId) g.matched += 1; }
    const modal = openModal({ title: 'Imported statements', content: el('div.list', {}, [...groups].map(([id, g]) => el('div.list-row.static', {},
      el('div.grow', {}, el('div.title', {}, g.source), el('div.sub', {}, `${g.n} lines, ${g.matched} matched, imported ${formatDate(new Date(g.importedAt).toISOString().slice(0, 10))}`)),
      el('button.icon-btn.danger', { type: 'button', html: icon('trash', 17, 2), 'aria-label': `Delete ${g.source}`, onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete this import?', message: 'Its lines are removed and any matched expenses become unreconciled again.', confirmLabel: 'Delete import' });
        if (!ok) return;
        try { await store.deleteStatementBatch(id); modal.close(); toast('Import deleted', { icon: 'trash' }); } catch (err) { console.error(err); toast('Couldn’t delete', { icon: 'wifiOff' }); }
      } })))) });
  }

  const onChange = () => render();
  store.addEventListener('change', onChange);
  root.destroy = () => { alive = false; store.removeEventListener('change', onChange); };
  render();
  return root;
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, ' ').trim().slice(0, 80);
}

/* ------------------------------------------------------------ import */

export function openImport() {
  const body = el('div');
  const modal = openModal({ title: 'Import statement', content: body, wide: true });
  let rows = null;
  let mapping = null;
  let text = '';
  const sourceInput = el('input.input', { type: 'text', placeholder: 'Company card, August', maxlength: 60 });
  const currencySel = el('select.select', {}, CURRENCIES.map((c) => el('option', { value: c.code, selected: c.code === store.settings.baseCurrency }, c.code)));

  function renderPick() {
    clear(body);
    const fileInput = el('input', { type: 'file', accept: '.csv,text/csv,text/plain', className: 'visually-hidden', tabindex: -1, onchange: async () => { const f = fileInput.files?.[0]; if (f) { if (!sourceInput.value) sourceInput.value = f.name.replace(/\.[^.]+$/, ''); loadText(await f.text()); } } });
    const paste = el('textarea.textarea', { rows: 5, placeholder: 'Or paste CSV rows here', 'aria-label': 'Paste CSV' });
    const drop = el('div.dropzone', {
      role: 'button', tabindex: 0, 'aria-label': 'Choose a CSV file', onclick: () => fileInput.click(),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
      ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
      ondrop: async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) { if (!sourceInput.value) sourceInput.value = f.name.replace(/\.[^.]+$/, ''); loadText(await f.text()); } },
    }, el('div.empty-icon', { html: icon('sheet', 26) }), el('h3', {}, 'Drop a statement CSV'), el('p', {}, 'Exported from your card or bank. Columns are detected automatically and you can correct them.'),
    el('div.dropzone-actions', {}, el('button.btn.btn-primary', { type: 'button', onclick: (e) => { e.stopPropagation(); fileInput.click(); } }, 'Choose file')));
    body.append(fileInput, drop, el('div.field', { style: { marginTop: '14px' } }, paste),
      el('div.row.end', {}, el('button.btn.btn-outline', { type: 'button', onclick: () => { if (paste.value.trim()) loadText(paste.value); } }, 'Use pasted text')));
  }

  function loadText(t) {
    text = t;
    rows = parseCSV(text);
    if (rows.length < 1) { toast('That file has no rows', { icon: 'warn' }); return; }
    mapping = detectStatementColumns(rows);
    renderReview();
  }

  function renderReview() {
    clear(body);
    const cols = rows[0].length;
    const colOptions = (current, allowNone = true) => [allowNone && el('option', { value: -1, selected: current === -1 || current == null }, 'None'), ...Array.from({ length: cols }, (_, i) => el('option', { value: i, selected: i === current }, mapping.hasHeader ? (mapping.headers[i] || `Column ${i + 1}`) : `Column ${i + 1}`))];
    const sel = (key, allowNone = true) => el('div.select-wrap', {}, el('select.select', { 'aria-label': key, onchange: (e) => { mapping[key] = Number(e.target.value); if (key === 'amountCol' && mapping.amountCol >= 0) { mapping.debitCol = -1; mapping.creditCol = -1; } renderReview(); } }, colOptions(mapping[key], allowNone)));
    const { lines, skipped } = rowsToStatementLines(rows, mapping, { currency: currencySel.value });
    const preview = lines.slice(0, 8);

    body.append(
      el('div.field-row', {},
        field('Source name', sourceInput, { hint: '(shown on each line)' }),
        field('Currency', el('div.select-wrap', {}, currencySel))),
      el('div.mapping', {},
        field('Date column', sel('dateCol', false)),
        field('Description column', sel('descCol', false)),
        field('Amount column', sel('amountCol')),
        mapping.amountCol < 0 && field('Debit column', sel('debitCol')),
        mapping.amountCol < 0 && field('Credit column', sel('creditCol'))),
      el('div.row.wrap', { style: { marginBottom: '14px' } },
        checkRow('First row is a header', mapping.hasHeader, (v) => { mapping.hasHeader = v; renderReview(); }),
        checkRow('Dates are day first (31/12)', mapping.dayFirst, (v) => { mapping.dayFirst = v; renderReview(); }),
        mapping.amountCol >= 0 && checkRow('Charges are positive numbers', mapping.negate, (v) => { mapping.negate = v; renderReview(); })),
      el('p.small.muted', {}, `${lines.length} line${lines.length === 1 ? '' : 's'} ready${skipped.length ? `, ${skipped.length} skipped (no date or amount)` : ''}. Refunds and payments show as negative amounts.`),
      el('div.table-wrap', {}, el('table.table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Date'), el('th', {}, 'Description'), el('th.num', {}, 'Amount'))),
        el('tbody', {}, preview.map((l) => el('tr', {}, el('td', {}, l.date), el('td', {}, el('span.truncate', { style: { maxWidth: '340px', display: 'inline-block' } }, l.description)), el('td.num', { className: `num${l.amount < 0 ? ' neg' : ''}` }, formatMoney(l.amount, l.currency))))))),
      el('div.row.end', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: renderPick }, 'Back'),
        el('button.btn.btn-primary', { type: 'button', disabled: !lines.length, onclick: () => doImport(lines) }, `Import ${lines.length} line${lines.length === 1 ? '' : 's'}`))
    );
    currencySel.onchange = renderReview;
  }

  function checkRow(label, checked, onChange) {
    const input = el('input.check', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
    return el('label.check-row', {}, input, el('span', {}, label));
  }

  let importing = false;
  async function doImport(lines) {
    if (importing) return;
    const privateMode = store.sdk?.mode === 'private';
    importing = privateMode;
    // A statement batch has no edit-in-place form: freeze its snapshot until
    // acknowledgement instead of accepting edits that cannot be saved back.
    const controls = privateMode ? [...body.querySelectorAll('input, select, button')].map(node => [node, node.disabled]) : [];
    for (const [node] of controls) node.disabled = true;
    const source = sourceInput.value.trim() || 'Statement';
    try {
      const existing = await store.loadStatements();
      const fresh = lines.filter((l) => !isDuplicateLine(l, existing));
      const dupes = lines.length - fresh.length;
      if (!fresh.length) { toast('Every line is already imported', { icon: 'info' }); modal.close(); return; }
      await store.addStatementLines(fresh, { source });
      modal.close();
      toast(`${fresh.length} line${fresh.length === 1 ? '' : 's'} imported${dupes ? `, ${dupes} duplicate${dupes === 1 ? '' : 's'} skipped` : ''}`);
    } catch (err) { console.error(err); toast('Couldn’t import. Check your connection', { icon: 'wifiOff' }); }
    finally {
      importing = false;
      for (const [node, disabled] of controls) node.disabled = disabled;
    }
  }

  renderPick();
  return modal;
}
