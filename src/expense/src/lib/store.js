/**
 * Data layer on Puter. Small, hot documents live in KV; expenses live in one
 * file per month under the app's data folder so loading never scans history;
 * receipts are files next to them; statement lines share one file.
 *
 *   KV  exp:settings:v1     base currency, theme, flags (a few hundred bytes)
 *   KV  exp:categories:v1   category list
 *   KV  exp:months:v1       index of month files, newest first
 *   FS  expenses-data/exp-YYYY-MM.json     expenses, one file per month
 *   FS  expenses-data/reports.json         expense reports (expenses point at them by id)
 *   FS  expenses-data/statements.json      imported statement lines
 *   FS  expenses-data/receipts/<expenseId>.<ext>
 *
 * KV never holds files or growing documents: only small, hot values.
 *
 * Writes to the same file are serialised through a per-path queue so quick
 * successive edits cannot clobber each other.
 */

import { uid, round2, extensionFor } from './util.js';
import { monthKey, todayISO } from './dates.js';
import { DEFAULT_OCR_MODEL } from './ocr.js';
import { applyTransition, canTransition } from './reports.js';
import { installPrivateCommands } from './private-commands.js';
import { getStorage } from './storage.js';

export const KV_KEYS = {
  settings: 'exp:settings:v1',
  categories: 'exp:categories:v1',
  months: 'exp:months:v1',
};

export const DATA_DIR = 'expenses-data';
export const RECEIPTS_DIR = `${DATA_DIR}/receipts`;
export const STATEMENTS_PATH = `${DATA_DIR}/statements.json`;
export const REPORTS_PATH = `${DATA_DIR}/reports.json`;
export const monthPath = (key) => `${DATA_DIR}/exp-${key}.json`;

export const DEFAULT_SETTINGS = {
  baseCurrency: 'USD',
  theme: 'system',
  onboarded: false,
  sampleData: false,
  ocrModel: DEFAULT_OCR_MODEL,
  autoOcr: true,
};

export const DEFAULT_CATEGORIES = [
  { id: 'meals', name: 'Meals', icon: 'utensils', slot: 2 },
  { id: 'travel', name: 'Travel', icon: 'plane', slot: 1 },
  { id: 'lodging', name: 'Lodging', icon: 'bed', slot: 7 },
  { id: 'transport', name: 'Ground transport', icon: 'car', slot: 3 },
  { id: 'office', name: 'Office supplies', icon: 'paperclip', slot: 4 },
  { id: 'software', name: 'Software', icon: 'laptop', slot: 5 },
  { id: 'entertainment', name: 'Client entertainment', icon: 'wine', slot: 8 },
  { id: 'other', name: 'Other', icon: 'tag', slot: 6 },
];

export const EXPORT_VERSION = 1;

function parseValue(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}

export function normalizeExpense(input, now = Date.now()) {
  const amount = round2(Number(input.amount) || 0);
  return {
    id: input.id || uid(),
    date: input.date || todayISO(),
    merchant: String(input.merchant || '').trim(),
    amount,
    currency: input.currency || 'USD',
    categoryId: input.categoryId || null,
    paymentMethod: input.paymentMethod || null,
    notes: String(input.notes || '').trim(),
    items: Array.isArray(input.items) ? input.items : [],
    tax: input.tax == null ? null : round2(Number(input.tax)),
    receiptPath: input.receiptPath || null,
    receiptMime: input.receiptMime || null,
    receiptName: input.receiptName || null,
    ocr: input.ocr || null,
    reportId: input.reportId || null,
    reconciled: !!input.reconciled,
    reconciledAt: input.reconciledAt || null,
    statementLineId: input.statementLineId || null,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

export class Store extends EventTarget {
  constructor(getSdk = getStorage, { draft = false } = {}) {
    super();
    this.getSdk = getSdk;
    this.settings = { ...DEFAULT_SETTINGS };
    this.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    this.reports = [];
    this.months = [];
    this.user = null;
    this.ready = false;
    this._months = new Map();
    this._statements = null;
    this._queues = new Map();
    this._loading = new Map();
    if (!draft) installPrivateCommands(this, sdk => new Store(() => sdk, { draft: true }));
  }

  get sdk() { return this.getSdk(); }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { type, ...detail } }));
  }

  /* ------------------------------------------------------------ boot */

  async init() {
    const { kv, auth } = this.sdk;
    const privateMode = this.sdk.mode === 'private';
    const authorized = privateMode ? await auth.getUser() : null;
    const [user, settings, categories, months, reports] = await Promise.all([
      privateMode ? authorized : Promise.resolve().then(() => auth.getUser()).catch(() => null),
      kv.get(KV_KEYS.settings),
      kv.get(KV_KEYS.categories),
      kv.get(KV_KEYS.months),
      this._readJson(REPORTS_PATH, []),
    ]);
    if (privateMode) {
      if (settings !== null && (typeof settings !== 'object' || Array.isArray(settings))) throw new Error('Invalid settings document');
      if (categories !== null && !Array.isArray(categories)) throw new Error('Invalid categories document');
      if (months !== null && (!Array.isArray(months) || months.some(k => !/^\d{4}-(0[1-9]|1[0-2])$/.test(k)))) throw new Error('Invalid months document');
    }
    this.user = user;
    this.settings = { ...DEFAULT_SETTINGS, ...(parseValue(settings, null) || {}) };
    if (privateMode) this.settings.autoOcr = false;
    const cats = parseValue(categories, null);
    this.categories = Array.isArray(cats) && cats.length ? cats : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    this.reports = Array.isArray(reports) ? reports : [];
    this.months = (parseValue(months, []) || []).slice().sort().reverse();
    this.ready = true;
    return this;
  }

  /* ------------------------------------------------------------ low-level io */

  async _kvSet(key, value) {
    await this.sdk.kv.set(key, value);
  }

  /** Serialise writes per path: the next write waits for the previous. */
  _enqueue(path, task) {
    const prev = this._queues.get(path) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this._queues.set(path, next);
    const cleanup = () => { if (this._queues.get(path) === next) this._queues.delete(path); };
    next.then(cleanup, cleanup);
    return next;
  }

  async _readJson(path, fallback) {
    try {
      const blob = await this.sdk.fs.read(path);
      const text = typeof blob === 'string' ? blob : await blob.text();
      if (!text.trim() && this.sdk.mode !== 'private') return fallback;
      const value = JSON.parse(text);
      if (this.sdk.mode === 'private' && Array.isArray(fallback) && !Array.isArray(value)) throw new Error(`Invalid document: ${path}`);
      return value;
    } catch (err) {
      if (this.sdk.mode === 'private' && err.code !== 'ENOENT') {
        this.error ||= err;
        this.dispatchEvent(new Event('storage-state'));
        throw err;
      }
      return fallback;
    }
  }

  _writeJson(path, data) {
    return this._enqueue(path, () => this.sdk.fs.write(path, JSON.stringify(data), { createMissingParents: true, overwrite: true }));
  }

  /* ------------------------------------------------------------ settings */

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    if (this.sdk.mode === 'private') this.settings.autoOcr = false;
    await this._kvSet(KV_KEYS.settings, this.settings);
    this.emit('settings');
    return this.settings;
  }

  /* ------------------------------------------------------------ categories */

  category(id) {
    return this.categories.find((c) => c.id === id) || null;
  }

  async addCategory({ name, icon = 'tag', slot = 1 }) {
    const cat = { id: uid(), name: String(name).trim(), icon, slot };
    this.categories = [...this.categories, cat];
    await this._kvSet(KV_KEYS.categories, this.categories);
    this.emit('categories');
    return cat;
  }

  async updateCategory(id, patch) {
    this.categories = this.categories.map((c) => (c.id === id ? { ...c, ...patch, id } : c));
    await this._kvSet(KV_KEYS.categories, this.categories);
    this.emit('categories');
  }

  /** Remove a category; expenses that used it fall back to uncategorised. */
  async deleteCategory(id) {
    this.categories = this.categories.filter((c) => c.id !== id);
    await this._kvSet(KV_KEYS.categories, this.categories);
    await this.loadAll();
    for (const key of this.months) {
      const list = this._months.get(key) || [];
      if (!list.some((e) => e.categoryId === id)) continue;
      await this._mutateMonth(key, (cur) => cur.map((e) => (e.categoryId === id ? { ...e, categoryId: null } : e)));
    }
    this.emit('categories');
  }

  /* ------------------------------------------------------------ expenses */

  /**
   * Load a month file once. Concurrent callers share the same read, and a
   * read that finishes after something else already filled the cache (an
   * import, a write) must not replace the newer data with its stale result.
   */
  loadMonth(key) {
    if (this._months.has(key)) return Promise.resolve(this._months.get(key));
    const slot = `month:${key}`;
    if (!this._loading.has(slot)) {
      const p = this._readJson(monthPath(key), []).then((list) => {
        if (!this._months.has(key)) this._months.set(key, Array.isArray(list) ? list : []);
        return this._months.get(key);
      }).finally(() => this._loading.delete(slot));
      this._loading.set(slot, p);
    }
    return this._loading.get(slot);
  }

  async loadAll() {
    await Promise.all(this.months.map((k) => this.loadMonth(k)));
    return this.allExpenses();
  }

  /** Every loaded expense, newest first. Call loadAll() first for completeness. */
  allExpenses() {
    const out = [];
    for (const key of this.months) out.push(...(this._months.get(key) || []));
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
  }

  getExpense(id) {
    for (const list of this._months.values()) {
      const hit = list.find((e) => e.id === id);
      if (hit) return hit;
    }
    return null;
  }

  async _ensureMonth(key) {
    if (this.months.includes(key)) return;
    this.months = [...this.months, key].sort().reverse();
    await this._kvSet(KV_KEYS.months, this.months);
  }

  /**
   * Read-modify-write one month file inside its queue, so two edits that
   * arrive together both see the other's result instead of the same stale
   * list. `fn` gets the current list and returns the next one.
   */
  _mutateMonth(key, fn) {
    return this._enqueue(monthPath(key), async () => {
      const list = await this.loadMonth(key);
      const next = fn(list);
      this._months.set(key, next);
      await this.sdk.fs.write(monthPath(key), JSON.stringify(next), { createMissingParents: true, overwrite: true });
      return next;
    });
  }

  async addExpense(data) {
    const exp = normalizeExpense(data);
    const key = monthKey(exp.date);
    await this._ensureMonth(key);
    await this._mutateMonth(key, (list) => [exp, ...list]);
    this.emit('expenses', { id: exp.id });
    return exp;
  }

  async updateExpense(id, patch) {
    const current = this.getExpense(id) || (await this.loadAll(), this.getExpense(id));
    if (!current) throw new Error('Expense not found');
    const fromKey = monthKey(current.date);
    const toKey = monthKey(patch.date || current.date);
    let next = null;
    if (fromKey === toKey) {
      // Merge against the list inside the queue: `current` may be stale by the time we run.
      await this._mutateMonth(fromKey, (list) => list.map((e) => {
        if (e.id !== id) return e;
        next = normalizeExpense({ ...e, ...patch, id, createdAt: e.createdAt });
        return next;
      }));
    } else {
      await this._ensureMonth(toKey);
      await this._mutateMonth(fromKey, (list) => {
        const found = list.find((e) => e.id === id) || current;
        next = normalizeExpense({ ...found, ...patch, id, createdAt: found.createdAt });
        return list.filter((e) => e.id !== id);
      });
      await this._mutateMonth(toKey, (list) => [next, ...list]);
    }
    if (!next) throw new Error('Expense not found');
    this.emit('expenses', { id });
    return next;
  }

  async deleteExpense(id) {
    const current = this.getExpense(id) || (await this.loadAll(), this.getExpense(id));
    if (!current) return;
    const key = monthKey(current.date);
    await this._mutateMonth(key, (list) => list.filter((e) => e.id !== id));
    if (current.statementLineId) await this.unmatchLine(current.statementLineId, { silent: true });
    if (current.receiptPath) this.deleteReceipt(current.receiptPath).catch(() => {});
    this.emit('expenses', { id, deleted: true });
  }

  /* ------------------------------------------------------------ receipts */

  /** Private form save: upload immutable bytes before the metadata transaction. */
  async saveExpenseWithReceipt({ id = null, data, file = null, removeReceipt = false }) {
    if (this.sdk.mode !== 'private') throw new Error('Private receipt workflow only');
    if (id) await this.loadAll();
    const current = id ? this.getExpense(id) : null;
    if (id && !current) throw new Error('Expense not found');
    const patch = { ...data };
    if (removeReceipt) Object.assign(patch, { receiptPath: null, receiptMime: null, receiptName: null });
    if (file) Object.assign(patch, await this.saveReceipt(id, file));
    const result = id ? await this.updateExpense(id, patch) : await this.addExpense(patch);
    if ((file || removeReceipt) && current?.receiptPath) await this.deleteReceipt(current.receiptPath);
    return result;
  }

  async saveReceipt(expenseId, file) {
    const ext = extensionFor(file.type, file.name);
    const privateMode = this.sdk.mode === 'private';
    if (privateMode && (!(file instanceof Blob) || file.size > 10 * 1024 * 1024 || !/^(jpg|jpeg|png|webp|heic|gif|pdf|bin)$/.test(ext))) {
      throw new Error('Receipt must be a supported image or PDF, at most 10 MiB');
    }
    const path = `${RECEIPTS_DIR}/${privateMode ? crypto.randomUUID() : expenseId}.${ext}`;
    await this.sdk.fs.write(path, file, { createMissingParents: true, overwrite: true });
    return { receiptPath: path, receiptMime: file.type || null, receiptName: file.name || `receipt.${ext}` };
  }

  async readReceipt(path) {
    return this.sdk.fs.read(path);
  }

  async deleteReceipt(path) {
    try { await this.sdk.fs.delete(path); } catch (err) {
      if (this.sdk.mode === 'private' && err.code !== 'ENOENT') {
        this.error ||= err;
        this.dispatchEvent(new Event('storage-state'));
        throw err;
      }
    }
  }

  /* ------------------------------------------------------------ reports */

  report(id) {
    return this.reports.find((r) => r.id === id) || null;
  }

  async _saveReports() {
    await this._writeJson(REPORTS_PATH, this.reports);
    this.emit('reports');
  }

  async createReport({ title, notes = '' }) {
    const now = Date.now();
    const report = {
      id: uid(), title: String(title || '').trim() || 'Untitled report', notes, status: 'draft',
      submittedAt: null, approvedAt: null, reimbursedAt: null, createdAt: now, updatedAt: now,
    };
    this.reports = [report, ...this.reports];
    await this._saveReports();
    return report;
  }

  async updateReport(id, patch) {
    this.reports = this.reports.map((r) => (r.id === id ? { ...r, ...patch, id, updatedAt: Date.now() } : r));
    await this._saveReports();
    return this.report(id);
  }

  async transitionReport(id, to) {
    const r = this.report(id);
    if (!r) throw new Error('Report not found');
    if (!canTransition(r.status, to)) throw new Error(`Cannot move a ${r.status} report to ${to}`);
    this.reports = this.reports.map((x) => (x.id === id ? applyTransition(x, to) : x));
    await this._saveReports();
    return this.report(id);
  }

  /** Delete a report; its expenses go back to unreported. */
  async deleteReport(id) {
    await this.loadAll();
    const affected = this.allExpenses().filter((e) => e.reportId === id).map((e) => e.id);
    await this.setReport(affected, null);
    this.reports = this.reports.filter((r) => r.id !== id);
    await this._saveReports();
  }

  /** Assign (or with null, unassign) expenses to a report, one write per month. */
  async setReport(expenseIds, reportId) {
    const ids = new Set(expenseIds);
    if (!ids.size) return;
    await this.loadAll();
    const now = Date.now();
    for (const key of this.months) {
      const list = this._months.get(key) || [];
      if (!list.some((e) => ids.has(e.id))) continue;
      await this._mutateMonth(key, (cur) => cur.map((e) => (ids.has(e.id) ? { ...e, reportId, updatedAt: now } : e)));
    }
    this.emit('expenses');
  }

  /* ------------------------------------------------------------ statements */

  loadStatements() {
    if (this._statements) return Promise.resolve(this._statements);
    const slot = 'statements';
    if (!this._loading.has(slot)) {
      const p = this._readJson(STATEMENTS_PATH, []).then((list) => {
        if (!this._statements) this._statements = Array.isArray(list) ? list : [];
        return this._statements;
      }).finally(() => this._loading.delete(slot));
      this._loading.set(slot, p);
    }
    return this._loading.get(slot);
  }

  async _saveStatements(list) {
    this._statements = list;
    await this._writeJson(STATEMENTS_PATH, list);
    this.emit('statements');
  }

  async addStatementLines(lines, { source = 'Statement' } = {}) {
    const existing = await this.loadStatements();
    const batchId = uid();
    const now = Date.now();
    const added = lines.map((l) => ({
      id: uid(), batchId, source, date: l.date, description: l.description || '',
      amount: round2(l.amount), currency: l.currency || this.settings.baseCurrency,
      matchedExpenseId: null, importedAt: now,
    }));
    await this._saveStatements([...added, ...existing]);
    return { batchId, added };
  }

  statementLine(id) {
    return (this._statements || []).find((l) => l.id === id) || null;
  }

  async matchLine(lineId, expenseId) {
    const lines = await this.loadStatements();
    const line = lines.find((l) => l.id === lineId);
    if (!line) throw new Error('Statement line not found');
    if (line.matchedExpenseId && line.matchedExpenseId !== expenseId) await this.unmatchLine(lineId);
    const exp = this.getExpense(expenseId) || (await this.loadAll(), this.getExpense(expenseId));
    if (!exp) throw new Error('Expense not found');
    if (exp.statementLineId && exp.statementLineId !== lineId) {
      await this._detachLine(exp.statementLineId);
    }
    await this.updateExpense(expenseId, { reconciled: true, reconciledAt: Date.now(), statementLineId: lineId });
    await this._saveStatements(this._statements.map((l) => (l.id === lineId ? { ...l, matchedExpenseId: expenseId } : l)));
  }

  async _detachLine(lineId) {
    const lines = await this.loadStatements();
    if (!lines.some((l) => l.id === lineId && l.matchedExpenseId)) return;
    await this._saveStatements(lines.map((l) => (l.id === lineId ? { ...l, matchedExpenseId: null } : l)));
  }

  async unmatchLine(lineId, { silent = false } = {}) {
    const lines = await this.loadStatements();
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    const expId = line.matchedExpenseId;
    await this._saveStatements(lines.map((l) => (l.id === lineId ? { ...l, matchedExpenseId: null } : l)));
    if (expId && !silent) {
      const exp = this.getExpense(expId) || (await this.loadAll(), this.getExpense(expId));
      if (exp) await this.updateExpense(expId, { reconciled: false, reconciledAt: null, statementLineId: null });
    }
  }

  async deleteStatementLine(lineId) {
    const lines = await this.loadStatements();
    const line = lines.find((l) => l.id === lineId);
    if (!line) return;
    if (line.matchedExpenseId) await this.unmatchLine(lineId);
    await this._saveStatements((await this.loadStatements()).filter((l) => l.id !== lineId));
  }

  async deleteStatementBatch(batchId) {
    const lines = await this.loadStatements();
    for (const l of lines) if (l.batchId === batchId && l.matchedExpenseId) await this.unmatchLine(l.id);
    await this._saveStatements((await this.loadStatements()).filter((l) => l.batchId !== batchId));
  }

  /* ------------------------------------------------------------ export / import */

  async exportAll() {
    await this.loadAll();
    const expenses = {};
    for (const key of this.months) expenses[key] = this._months.get(key) || [];
    return {
      app: 'expenses',
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      settings: this.settings,
      categories: this.categories,
      reports: this.reports,
      expenses,
      statements: await this.loadStatements(),
    };
  }

  /**
   * Replace everything with a dataset in export shape. Month files that are
   * not in the dataset are deleted so nothing lingers.
   */
  async importAll(data) {
    if (!data || data.app !== 'expenses') throw new Error('Not an Expenses export');
    const months = Object.keys(data.expenses || {}).sort().reverse();
    const stale = this.months.filter((k) => !months.includes(k));
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    if (this.sdk.mode === 'private') this.settings.autoOcr = false;
    this.categories = Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    this.reports = Array.isArray(data.reports) ? data.reports : [];
    this.months = months;
    this._months = new Map();
    this._statements = Array.isArray(data.statements) ? data.statements : [];

    await Promise.all([
      this._kvSet(KV_KEYS.settings, this.settings),
      this._kvSet(KV_KEYS.categories, this.categories),
      this._kvSet(KV_KEYS.months, this.months),
      this._writeJson(REPORTS_PATH, this.reports),
      ...months.map((k) => {
        const list = (data.expenses[k] || []).map((e) => normalizeExpense(e, e.updatedAt || Date.now()));
        this._months.set(k, list);
        return this._writeJson(monthPath(k), list);
      }),
      this._writeJson(STATEMENTS_PATH, this._statements),
      ...stale.map((k) => this.sdk.fs.delete(monthPath(k)).catch(() => {})),
    ]);
    this.emit('import');
  }

  /** Everything gone, including receipt files. */
  async wipeAll({ keepSettings = {} } = {}) {
    const receipts = this.sdk.mode === 'private' ? await this.sdk.fs.readdir(`${RECEIPTS_DIR}/`) : null;
    await this.importAll({
      app: 'expenses', version: EXPORT_VERSION,
      settings: { ...DEFAULT_SETTINGS, theme: this.settings.theme, baseCurrency: this.settings.baseCurrency, ...keepSettings },
      categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      reports: [], expenses: {}, statements: [],
    });
    if (receipts) {
      for (const receipt of receipts) await this.sdk.fs.delete(receipt.path);
    } else await this.sdk.fs.delete(RECEIPTS_DIR).catch(() => {});
  }
}

export const store = new Store();
