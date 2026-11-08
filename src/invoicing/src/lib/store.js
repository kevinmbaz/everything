/**
 * Data layer on top of Puter. Deliberately simpler than the accountant app:
 * no offline mirror, no learning engine, one event ('change').
 *
 * Storage design:
 *
 *  KV (small, hot, single-key reads; never kv.list() scans):
 *    invc:settings:v1   business profile, defaults, numbering counters
 *    invc:clients:v1    [{ id, name, company, email, phone, address }]
 *    invc:items:v1      saved line items (the price list) for the editor
 *    invc:recurring:v1  [{ id, ...invoice template, freq, anchorDay, nextDue, paused }]
 *    invc:years:v1      ["2026", ...] index of document files
 *
 *  FS (grows with history; one JSON file per issue year):
 *    invoicing-data/docs-YYYY.json  [document, ...]
 *
 * A few hundred documents per year keeps each file small, and reads scale
 * with the years you have, not with lifetime volume.
 */

import { uid, round2 } from './util.js';
import { storage, isPrivate } from './storage.js';
import {
  todayISO, addDays, daysBetween, yearOf, dueOccurrences, ruleCompleted, issuedCount,
} from './dates.js';
import {
  formatDocNumber, invoiceFromQuote, billingDefaults, termDays, MAX_TERM_DAYS, copyItems,
} from './doc.js';
import { refundableTotal, docTaxes } from './money.js';

const KV = {
  settings: 'invc:settings:v1',
  clients: 'invc:clients:v1',
  items: 'invc:items:v1',
  recurring: 'invc:recurring:v1',
  years: 'invc:years:v1',
};

const DATA_DIR = 'invoicing-data';
const SHARE_DIR = `${DATA_DIR}/public`;
const ATTACH_DIR = `${DATA_DIR}/attachments`;
const yearPath = (y) => `${DATA_DIR}/docs-${y}.json`;

export { DATA_DIR, SHARE_DIR, ATTACH_DIR };

/**
 * What an invoice may travel with. The caps are the app's, not the cloud's:
 * a document is a JSON row in a year file, and a hundred files hanging off
 * one of them is a folder nobody can find anything in — while a 10 MB
 * ceiling keeps a mis-picked video from silently eating an account.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

/**
 * A filename safe to build a path out of, and still recognisable: no
 * separators, no traversal, no control characters, and short enough that the
 * whole path stays reasonable. The extension is kept, because it is what
 * tells the client's machine what the file is.
 */
export function safeFileName(name) {
  const raw = String(name ?? '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f<>:"|?*]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+/, '');
  if (!clean) return 'file';
  if (clean.length <= 80) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
  return clean.slice(0, 80 - ext.length) + ext;
}

/** An id, as a path segment: ids are minted by uid(), but data can be restored. */
const idSegment = (value) => (String(value ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 40) || 'x');

/** Where one attachment lives: invoicing-data/attachments/<doc>/<id>-<name>. */
export function attachmentPath(docId, id, name) {
  return `${ATTACH_DIR}/${idSegment(docId)}/${idSegment(id)}-${safeFileName(name)}`;
}

/**
 * Whether a stored attachment path is one file inside this document's own
 * folder — the only place the store ever puts one, and the only place it is
 * willing to delete from or copy to a public page. An attachment record is
 * data the user can hand this app in a backup, and the record's `path` used
 * to be trusted verbatim: one naming a year file, or another app's file, was
 * deleted on Remove and again by the trash purge thirty days after a delete,
 * with no action of the user's in between.
 */
export function ownsAttachmentPath(docId, path) {
  const p = String(path || '');
  const dir = `${ATTACH_DIR}/${idSegment(docId)}/`;
  if (!p.startsWith(dir)) return false;
  const file = p.slice(dir.length);
  return !!file && file !== '.' && file !== '..' && !file.includes('/');
}

export const DEFAULT_SETTINGS = {
  // `logo` is an image data URI so documents (and share pages) embed it.
  business: { name: '', email: '', phone: '', address: '', taxId: '', logo: '' },
  brandColor: '',       // '' keeps the paper in plain ink
  currency: 'USD',
  // The currency reports consolidate into. '' follows `currency`; a document
  // billed in anything else carries the rate it was worth on the day.
  baseCurrency: '',
  // Named tax rates new documents start with; each prints as its own row.
  // The single pair below stays in step with the list's first entry, for
  // per-client overrides and documents saved before the list existed.
  taxes: [],
  taxRate: 0,
  taxLabel: 'Tax',
  taxInclusive: false, // new documents start with prices carrying the tax
  paymentTermsDays: 14,
  quoteValidDays: 30,
  paperSize: 'a4',      // page geometry for generated PDFs: 'a4' | 'letter'
  // Prefixes may carry a {YYYY} token, resolved from the issue date when a
  // number is reserved ('INV-{YYYY}-' -> 'INV-2026-0001').
  invoicePrefix: 'INV-',
  quotePrefix: 'EST-',
  receiptPrefix: 'RCT-',
  nextInvoice: 1,
  nextQuote: 1,
  nextReceipt: 1,
  // Per-counter yearly restart. When a kind is on, numbering draws from
  // yearNext[kind][year] instead of the lifetime counter above, so the
  // sequence starts over each January without losing any year's position.
  numberYearly: { invoice: false, quote: false, receipt: false },
  yearNext: {},         // { invoice: { '2026': 7 }, ... }
  defaultNotes: '',
  // Free-form "how to pay" block (bank name, IBAN, sort code…), printed on
  // invoices that still carry a balance. Clients may override it.
  paymentInstructions: '',
  // Late-fee policy, disclosed on unpaid invoices and applied by hand from
  // an overdue invoice's page. 'percent' is of the open balance, per month.
  lateFee: { type: 'none', value: 0 },
  // Why no tax is charged, printed on documents that charge none: a preset
  // id, free wording, or '' for nothing. Clients and documents override it.
  taxNote: '',
  // Email wording per template key; missing keys fall back to the shipped
  // defaults in lib/message.js.
  templates: {},
  paymentLink: { kind: 'none', value: '' },
  share: null,          // { subdomain } once a public site exists
  theme: 'system',
  onboarded: false,
  sampleData: false,
};

/** Missing-file rejections read as "no data yet"; anything else is real. */
export function isMissingFileError(err) {
  const code = err?.code ?? err?.error?.code;
  if (typeof code === 'string' && /does_not_exist|not_found/.test(code)) return true;
  const msg = String(err?.message ?? err?.error?.message ?? '');
  return /no such file|not found|does not exist/i.test(msg);
}

/** The billing keys a client may override; anything else on a client is plain contact detail. */
const BILLING_KEYS = ['currency', 'taxRate', 'paymentTermsDays', 'notes', 'paymentInstructions', 'lateFee', 'taxNote'];

/**
 * A client's optional billing overrides, normalized. '' means "inherit the
 * global default", which is why an empty field can never become 0: a zero
 * tax rate is a real answer (a tax-exempt client) and must stay one.
 */
function clientBilling(input = {}) {
  const optional = (value, { max = Infinity, integer = false } = {}) => {
    if (value === '' || value === null || value === undefined) return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    const clamped = Math.min(max, Math.max(0, n));
    return integer ? Math.round(clamped) : clamped;
  };
  // A late-fee override is an object, not a scalar: '' inherits the global
  // policy, { type: 'none' } is an explicit "never charge this client", and
  // a percent is pinned to 0–100 like every other rate.
  const lateFee = (v) => {
    if (!v || typeof v !== 'object' || !v.type) return '';
    if (v.type === 'none') return { type: 'none', value: 0 };
    const type = v.type === 'fixed' ? 'fixed' : 'percent';
    const value = Math.max(0, Number(v.value) || 0);
    if (value <= 0) return '';
    return { type, value: type === 'percent' ? Math.min(100, value) : value };
  };
  return {
    currency: (input.currency || '').trim(),
    taxRate: optional(input.taxRate, { max: 100 }),
    paymentTermsDays: optional(input.paymentTermsDays, { max: MAX_TERM_DAYS, integer: true }),
    notes: (input.notes || '').trim(),
    paymentInstructions: (input.paymentInstructions || '').trim(),
    lateFee: lateFee(input.lateFee),
    // '' inherits the global wording; 'none' is an explicit "this client's
    // invoices carry no such sentence", exactly like the late-fee override.
    taxNote: String(input.taxNote || '').trim().slice(0, 200),
  };
}

/**
 * How long a deleted thing stays recoverable. This app *is* the record —
 * there is no copy of it on a server of ours — so a mis-tapped row must not
 * be the end of an invoice, its payments, and its receipt.
 */
export const TRASH_DAYS = 30;

/** Anything carrying a deletedAt is in the trash, not in the records. */
export const isTrashed = (x) => !!x?.deletedAt;

class Store extends EventTarget {
  settings = null;
  clients = [];      // live clients; the trashed ones live in #allClients
  items = [];        // saved line items: { id, name, rate, unit, taxes? }
  recurring = [];    // live schedules; the trashed ones live in #allRecurring
  years = [];        // year keys with a doc file, sorted desc
  #allClients = [];
  #allRecurring = [];
  #docs = new Map(); // year -> array of documents (trashed ones included)
  #writeQueues = new Map();
  #settingsQueue = Promise.resolve();
  #indexQueue = Promise.resolve();
  #indexing = new Map(); // year -> the pending write that indexes it
  #converting = new Map(); // quote id -> the conversion in flight
  #paymentQueues = new Map(); // document id -> the last payment recording
  /**
   * Which load of the store is the current one. init() and loadOffline()
   * each take the next number; a load that finds a newer one when it comes
   * back from the network has been superseded and touches nothing (see
   * init()).
   */
  #loadGen = 0;
  #reconnecting = null;
  #recurringQueue = Promise.resolve();
  user = null;
  /**
   * True when the app opened from the copy kept on this device instead of
   * from the user's cloud. Everything reads; nothing writes — offline writes
   * would need a merge story, and the store's per-year queues and heal
   * passes assume one authority.
   */
  readOnly = false;

  #assertWritable() {
    if (this.readOnly) {
      throw new Error('This device is showing a saved copy. Reconnect to make changes.');
    }
  }

  /**
   * Fill the store from a local snapshot, without touching the cloud, and
   * mark it read-only. Shaped like exportAll(), which is what the snapshot
   * serialiser writes.
   */
  loadOffline(data, { user = null } = {}) {
    this.#loadGen += 1;
    const years = Object.keys(data.docs || {}).filter((y) => /^\d{4}$/.test(y)).sort().reverse();
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    this.#allClients = (data.clients || []).filter((c) => c && c.id);
    this.items = (data.items || []).filter((i) => i && i.name);
    this.#allRecurring = (data.recurring || []).filter((r) => r && r.id);
    this.#syncLive();
    this.years = years;
    this.#docs = new Map(years.map((y) => [y, (data.docs[y] || []).filter((d) => d && d.id)]));
    this.user = user;
    this.readOnly = true;
    this.emit();
  }

  /**
   * Back on the network: reload from the cloud and start writing again.
   * Read-only stays on until the cloud has actually answered — init() lifts
   * it as it switches the store over — so nothing can write against the
   * device copy while the load is still in the air. One at a time: a second
   * 'online' event during the load joins it rather than starting another.
   */
  async reconnect() {
    if (this.#reconnecting) return this.#reconnecting;
    this.#reconnecting = (async () => {
      try {
        await this.init();
      } catch (err) {
        this.readOnly = true;
        this.emit();
        throw err;
      } finally {
        this.#reconnecting = null;
      }
      this.emit();
    })();
    return this.#reconnecting;
  }

  /**
   * Republish the live views of the two KV-backed lists. Everything outside
   * the store reads `clients` and `recurring` and must never see a deleted
   * entry; the trash view asks for it by name.
   */
  #syncLive() {
    this.clients = this.#allClients.filter((c) => !isTrashed(c));
    this.recurring = this.#allRecurring.filter((r) => !isTrashed(r));
  }

  emit() {
    this.dispatchEvent(new Event('change'));
  }

  static #decode(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return fallback; }
    }
    return raw;
  }

  async #kvGet(key, fallback) {
    return Store.#decode(await storage.kv.get(key), fallback);
  }

  async #kvSet(key, value) {
    await storage.kv.set(key, JSON.stringify(value));
  }

  /* ---------- Init ---------- */

  /**
   * Load everything from the cloud. Everything is read first, into locals,
   * and the store is switched over in one step — and only if no other load
   * has started meanwhile. Boot's timeout does not cancel this call: when
   * it gives up and opens the device copy (loadOffline) instead, this load
   * can still come back minutes later, and it used to land under that copy
   * — replacing the settings and user without a word, and running the heal
   * passes below, which write year files, while the banner said nothing
   * here could change. A superseded load now resolves false and touches
   * nothing.
   *
   * The year files are always read afresh, never taken from the cache: the
   * cache holds whatever the previous load left, and after an offline boot
   * that is the device copy. Adopting it as the cloud's — which is what
   * reconnect() did — meant the next save wrote that stale list over the
   * cloud's file, and every document another device had added since was
   * gone.
   */
  async init() {
    const gen = ++this.#loadGen;
    const current = () => gen === this.#loadGen;
    const user = isPrivate
      ? await storage.getUser()
      : await storage.getUser().catch(() => null);
    const [settings, clients, items, recurring, years] = await Promise.all([
      this.#kvGet(KV.settings, null),
      this.#kvGet(KV.clients, []),
      this.#kvGet(KV.items, []),
      this.#kvGet(KV.recurring, []),
      this.#kvGet(KV.years, []),
    ]);
    const yearList = Array.isArray(years) ? [...years].sort().reverse() : [];
    const docs = new Map(await Promise.all(yearList.map(async (y) => [y, await this.#readYear(y)])));
    if (!current()) return false;

    this.user = user;
    this.settings = settings
      ? {
        ...DEFAULT_SETTINGS,
        ...settings,
        business: { ...DEFAULT_SETTINGS.business, ...(settings.business || {}) },
        paymentLink: { ...DEFAULT_SETTINGS.paymentLink, ...(settings.paymentLink || {}) },
      }
      : { ...DEFAULT_SETTINGS };
    this.#allClients = Array.isArray(clients) ? clients.filter((c) => c && c.id) : [];
    this.items = Array.isArray(items) ? items.filter((i) => i && i.name) : [];
    this.#allRecurring = Array.isArray(recurring) ? recurring.filter((r) => r && r.id) : [];
    this.#syncLive();
    this.years = yearList;
    this.#docs = docs;
    // The cloud is the authority again from here; the heal passes below are
    // its first writers.
    this.readOnly = false;
    if (!settings) await this.#kvSet(KV.settings, this.settings);
    await this.#healDuplicates(current);
    await this.#healDanglingLinks(current);
    await this.#purgeTrash(Date.now(), current);
    return true;
  }

  /**
   * Empty out whatever has sat in the trash past its thirty days, at boot,
   * beside the other heal passes and under the same discipline: a failed
   * write is simply retried by the next load, and the in-memory state is
   * already correct. Numbers are never reused, so nothing here rolls a
   * counter back.
   */
  async #purgeTrash(now = Date.now(), current = () => true) {
    const cutoff = now - TRASH_DAYS * 24 * 60 * 60 * 1000;
    const expired = (x) => isTrashed(x) && Date.parse(x.deletedAt) < cutoff;

    for (const [year, list] of this.#docs) {
      for (const doc of list) if (expired(doc)) await this.#deleteAttachments(doc);
      // The awaits above are where another load can take the store over;
      // from here on this pass would be editing that load's lists.
      if (!current()) return;
      const kept = list
        .filter((d) => !expired(d))
        .map((d) => (Array.isArray(d.trashedPayments) && d.trashedPayments.some(expired)
          ? { ...d, trashedPayments: d.trashedPayments.filter((p) => !expired(p)) }
          : d));
      const changed = kept.length !== list.length
        || kept.some((d, i) => d !== list[i]);
      if (!changed) continue;
      this.#docs.set(year, kept);
      await this.#persistYear(year).catch(() => {});
    }

    if (!current()) return;
    if (this.#allClients.some(expired)) {
      this.#allClients = this.#allClients.filter((c) => !expired(c));
      this.#syncLive();
      await this.#persistClients().catch(() => {});
    }
    if (!current()) return;
    if (this.#allRecurring.some(expired)) {
      this.#allRecurring = this.#allRecurring.filter((r) => !expired(r));
      this.#syncLive();
      await this.#persistRecurring().catch(() => {});
    }
  }

  /**
   * A save that moves a document between year files writes the new year
   * first, so a write failure can never lose the document — but it can
   * leave a stale copy behind in the old file, and a reload would then
   * list it twice and double-count its money. Keep the newest copy of
   * any id found more than once (every real save stamps updatedAt) and
   * repair the files the others sat in. A failed repair is retried by
   * the next load; the in-memory state is already clean.
   */
  async #healDuplicates(current = () => true) {
    const newest = new Map(); // id -> the copy to keep
    const age = (d) => d.updatedAt || d.createdAt || 0;
    for (const list of this.#docs.values()) {
      for (const doc of list) {
        if (!doc?.id) continue;
        const seen = newest.get(doc.id);
        if (!seen || age(doc) > age(seen)) newest.set(doc.id, doc);
      }
    }
    for (const [year, list] of this.#docs) {
      const kept = list.filter((d) => !d?.id || newest.get(d.id) === d);
      if (kept.length === list.length) continue;
      if (!current()) return;
      this.#docs.set(year, kept);
      await this.#persistYear(year).catch(() => {});
    }
  }

  /**
   * Deleting a converted invoice unlinks its quote with a follow-up write;
   * lose that write and the quote points at a document that no longer
   * exists — reading "invoiced" forever, with the convert action locked
   * away. Repaired on load like the duplicates above: a failed repair is
   * retried by the next one, and the in-memory state is already clean.
   */
  async #healDanglingLinks(current = () => true) {
    // Live documents only: deleting an invoice unlinks its quote (and
    // restoring it re-links), so a quote still pointing at a trashed invoice
    // is the lost unlink write this repairs — counting the trashed copy as
    // present left it reading "invoiced" with nothing to open, until the
    // purge finally made the link dangle thirty days later.
    const ids = new Set();
    const invoicesByQuote = new Map();   // quote id -> live invoices pointing back at it
    for (const list of this.#docs.values()) {
      for (const d of list) {
        if (!d?.id || isTrashed(d)) continue;
        ids.add(d.id);
        if (d.kind === 'invoice' && d.quoteId) {
          invoicesByQuote.set(d.quoteId, [...(invoicesByQuote.get(d.quoteId) || []), d.id]);
        }
      }
    }
    const dangling = (d) => d?.kind === 'quote' && d.invoiceId && !ids.has(d.invoiceId);
    // The other half of a conversion: the invoice landed and points back at
    // the quote, but the write that told the quote failed, so it read
    // "accepted", offering to convert again, until someone did. Exactly one
    // invoice pointing back is the lost link; two is a mess to leave alone.
    const unlinked = (d) => d?.kind === 'quote' && !isTrashed(d)
      && !(d.invoiceId && ids.has(d.invoiceId)) && invoicesByQuote.get(d.id)?.length === 1;
    for (const [year, list] of this.#docs) {
      if (!list.some((d) => dangling(d) || unlinked(d))) continue;
      if (!current()) return;
      this.#docs.set(year, list.map((d) => {
        if (unlinked(d)) return { ...d, status: 'accepted', invoiceId: invoicesByQuote.get(d.id)[0] };
        if (!dangling(d)) return d;
        const { invoiceId, ...rest } = d;
        return rest;
      }));
      await this.#persistYear(year).catch(() => {});
    }
  }

  /** An indexed year's documents, read from its file (a missing file is an
   *  empty year). */
  async #readYear(year) {
    try {
      const blob = await storage.fs.read(yearPath(year));
      const parsed = JSON.parse(await blob.text());
      // Element checks belong with the container check, exactly as the KV
      // lists above and the offline snapshot both do it: a year file is a
      // plain JSON file in the user's own cloud, and one junk entry in it
      // reaches every list, report, and total as a document with no id —
      // docs() would hand it out and the whole app would render nothing.
      if (Array.isArray(parsed)) {
        return parsed.filter((d) => !!d && typeof d === 'object' && !Array.isArray(d) && d.id);
      }
    } catch (err) {
      if (!isMissingFileError(err)) throw err;
    }
    return [];
  }

  async #loadYear(year) {
    if (this.#docs.has(year)) return this.#docs.get(year);
    // Only an indexed year's file is data. An unindexed one is a leftover —
    // a wipe or restore whose delete was lost — and adopting it here would
    // resurrect documents the user was told were gone, folding them into
    // the next save's re-index. It reads as empty, exactly as it would
    // after a reload, and the next write to the year replaces it.
    const docs = this.years.includes(year) ? await this.#readYear(year) : [];
    this.#docs.set(year, docs);
    return docs;
  }

  /** Serialize writes per year file so rapid edits can't clobber each other. */
  #queueWrite(year, fn) {
    const prev = this.#writeQueues.get(year) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.#writeQueues.set(year, next);
    return next;
  }

  /**
   * Put a year in the index, once, before anything is written to its file.
   * The index is one KV key shared by every year, so its writes go through
   * one queue — two saves into two new years used to race their index
   * writes, and whichever landed last (carrying the shorter list) won, which
   * left one written file unindexed: invisible after a reload, then written
   * over by the next save into that year. A second save into a year whose
   * index write is still in the air joins that write rather than trusting
   * the in-memory list: if the write fails, both saves fail, instead of the
   * second resolving with a file the index will never name.
   */
  #indexYear(year) {
    const pending = this.#indexing.get(year);
    if (pending) return pending;
    if (this.years.includes(year)) return Promise.resolve();
    this.years = [...this.years, year].sort().reverse();
    // Written with the list as it stands when its turn comes, so the last
    // write in the queue always carries every year indexed so far.
    const write = () => this.#kvSet(KV.years, this.years);
    const turn = this.#indexQueue.then(write, write);
    this.#indexQueue = turn.catch(() => {});
    const mine = turn.catch((err) => {
      // Only this year comes back out: another save's year, indexed by a
      // write of its own meanwhile, stays.
      this.years = this.years.filter((y) => y !== year);
      throw err;
    }).finally(() => {
      if (this.#indexing.get(year) === mine) this.#indexing.delete(year);
    });
    this.#indexing.set(year, mine);
    return mine;
  }

  async #persistYear(year) {
    // Every writer above has checked already; this is the backstop for the
    // heal passes, which init() runs on the cloud's behalf and which must
    // stop the moment the device copy has taken the store over.
    this.#assertWritable();
    // Index the year before writing its file: an indexed-but-missing file
    // reads as empty, but a written-yet-unindexed file would be invisible
    // after reload and silently overwritten by the next write.
    await this.#indexYear(year);
    // Serialize now, not when the queued write runs: the year list is
    // mutated by every overlapping save, and a write that stringifies at
    // run time can persist changes that were rolled back in between.
    const body = JSON.stringify(this.#docs.get(year) || []);
    await this.#queueWrite(year, () =>
      storage.fs.write(yearPath(year), body, { createMissingParents: true }));
  }

  /* ---------- Settings ---------- */

  /**
   * Settings carry every numbering counter, so their writes get the same
   * care as year files: one writer at a time (two in-flight snapshots
   * could land out of order and persist the older counter), each write
   * sending the settings as they stand when its turn comes. Failure rolls
   * back only when nothing newer has been applied meanwhile — a whole-
   * snapshot restore would also revert a counter a concurrent save had
   * already persisted, re-issuing its number.
   */
  async updateSettings(patch) {
    this.#assertWritable();
    const base = this.settings;
    this.settings = { ...this.settings, ...patch };
    this.emit();
    const mine = this.settings;
    const run = this.#settingsQueue.then(() => this.#kvSet(KV.settings, this.settings));
    this.#settingsQueue = run.catch(() => {});
    try {
      await run;
    } catch (err) {
      if (this.settings === mine) {
        this.settings = base;
        this.emit();
      }
      throw err;
    }
  }

  /* ---------- Clients ---------- */

  /**
   * A live client. A trashed one reads as gone everywhere — their documents
   * render "No client" exactly as a hard delete used to leave them — until
   * it is restored, which re-attaches them.
   */
  client(id) {
    return this.clients.find((c) => c.id === id) || null;
  }

  async #persistClients() {
    this.#assertWritable();
    // The trashed ones are stored too: the trash is data, not a UI state.
    await this.#kvSet(KV.clients, this.#allClients);
  }

  /** Replace the full client list and republish the live view of it. */
  #setClients(next) {
    this.#allClients = next;
    this.#syncLive();
  }

  async addClient(input) {
    this.#assertWritable();
    const client = {
      id: uid(),
      name: (input.name || '').trim(),
      company: (input.company || '').trim(),
      email: (input.email || '').trim(),
      phone: (input.phone || '').trim(),
      address: (input.address || '').trim(),
      taxId: (input.taxId || '').trim(),
      language: (input.language || '').trim(),
      ...clientBilling(input),
      createdAt: Date.now(),
    };
    const prev = this.#allClients;
    this.#setClients([...this.#allClients, client]);
    this.emit();
    try {
      await this.#persistClients();
    } catch (err) {
      this.#setClients(prev);
      this.emit();
      throw err;
    }
    return client;
  }

  /**
   * Patch one client. Only the keys handed in are touched, so saving just an
   * email address from the compose sheet leaves everything else alone — but a
   * billing override among them is normalized exactly as it would be on a new
   * client, rather than being stored raw from the form.
   */
  async updateClient(id, patch) {
    this.#assertWritable();
    const normalized = clientBilling({ ...this.client(id), ...patch });
    const next = { ...patch };
    for (const key of BILLING_KEYS) {
      if (key in patch) next[key] = normalized[key];
    }
    const prev = this.#allClients;
    this.#setClients(this.#allClients.map((c) => (c.id === id ? { ...c, ...next, id } : c)));
    this.emit();
    try {
      await this.#persistClients();
    } catch (err) {
      this.#setClients(prev);
      this.emit();
      throw err;
    }
  }

  /**
   * Move a client to the trash. Documents survive their client and no name
   * snapshot is stored, so their papers render "No client" from then on —
   * exactly what the delete confirmation warns — until the client is
   * restored, which re-attaches every one of them.
   */
  async deleteClient(id) {
    await this.#markClient(id, new Date().toISOString());
  }

  /** Put a trashed client back; their documents find them again by id. */
  async restoreClient(id) {
    await this.#markClient(id, null);
  }

  async #markClient(id, deletedAt) {
    this.#assertWritable();
    const prev = this.#allClients;
    this.#setClients(this.#allClients.map((c) => {
      if (c.id !== id) return c;
      if (deletedAt) return { ...c, deletedAt };
      const { deletedAt: gone, ...live } = c;
      return live;
    }));
    this.emit();
    try {
      await this.#persistClients();
    } catch (err) {
      this.#setClients(prev);
      this.emit();
      throw err;
    }
  }

  /** Gone for good: only ever from the trash, and only when asked. */
  async purgeClient(id) {
    this.#assertWritable();
    const prev = this.#allClients;
    this.#setClients(this.#allClients.filter((c) => c.id !== id));
    this.emit();
    try {
      await this.#persistClients();
    } catch (err) {
      this.#setClients(prev);
      this.emit();
      throw err;
    }
  }

  /* ---------- Documents ---------- */

  /**
   * Every live document, newest issue date first. A trashed one is absent
   * from here, which is what keeps every list, report, total, and badge
   * behaving exactly as they did before it was deleted.
   */
  docs() {
    const all = [];
    for (const year of this.years) {
      for (const doc of this.#docs.get(year) || []) if (!isTrashed(doc)) all.push(doc);
    }
    all.sort((a, b) => (a.issueDate < b.issueDate ? 1 : a.issueDate > b.issueDate ? -1
      : (b.createdAt || 0) - (a.createdAt || 0)));
    return all;
  }

  /** A live document by id. */
  doc(id) {
    const found = this.#anyDoc(id);
    return found && !isTrashed(found) ? found : null;
  }

  /** Any document by id, trashed included — for restoring and purging. */
  #anyDoc(id) {
    for (const list of this.#docs.values()) {
      const found = list.find((d) => d.id === id);
      if (found) return found;
    }
    return null;
  }

  docsForClient(clientId) {
    return this.docs().filter((d) => d.clientId === clientId);
  }

  /**
   * Days until an invoice for this client is due: their own terms when they
   * have any, otherwise the global default. Every path that derives a due
   * date goes through here, so a converted estimate, a duplicate, and a
   * scheduled invoice all agree with what the editor would have filled in.
   */
  #termsFor(clientId) {
    return billingDefaults(this.settings, this.client(clientId)).paymentTermsDays;
  }

  /**
   * A stored counter as a usable integer. Settings can arrive from a restored
   * backup, where a counter may be a string — and "7" + 1 is "71", so one
   * unchecked value would corrupt every number issued from then on.
   */
  static #counter(value) {
    return Math.max(1, Math.floor(Number(value) || 1));
  }

  /** The three counter series; anything unrecognized reserves as an invoice. */
  static #SERIES = {
    invoice: { prefix: 'invoicePrefix', next: 'nextInvoice' },
    quote: { prefix: 'quotePrefix', next: 'nextQuote' },
    receipt: { prefix: 'receiptPrefix', next: 'nextReceipt' },
  };

  static #seriesKind(kind) {
    return Store.#SERIES[kind] ? kind : 'invoice';
  }

  /**
   * The counter value the next number of a kind takes on `date`: the year's
   * own counter when that kind restarts yearly, the lifetime counter
   * otherwise.
   */
  nextNumberValue(kind, dateISO = null) {
    const k = Store.#seriesKind(kind);
    if (this.settings.numberYearly?.[k]) {
      return Store.#counter(this.settings.yearNext?.[k]?.[yearOf(dateISO || todayISO())]);
    }
    return Store.#counter(this.settings[Store.#SERIES[k].next]);
  }

  /** The number the next document of a kind would get, without reserving it. */
  peekNumber(kind, dateISO = null) {
    const k = Store.#seriesKind(kind);
    const date = dateISO || todayISO();
    return formatDocNumber(this.settings[Store.#SERIES[k].prefix], this.nextNumberValue(k, date), date);
  }

  /**
   * Reserve the next number for a kind; counters persist with settings.
   * `dateISO` is the issue (or payment) date the number belongs to: it
   * resolves a {YYYY} prefix token and picks the year's counter when that
   * kind restarts yearly, so a backdated document numbers into its own year.
   */
  async reserveNumber(kind, dateISO = null) {
    const k = Store.#seriesKind(kind);
    const date = dateISO || todayISO();
    const n = this.nextNumberValue(k, date);
    if (this.settings.numberYearly?.[k]) {
      const year = yearOf(date);
      const all = this.settings.yearNext || {};
      await this.updateSettings({
        yearNext: { ...all, [k]: { ...(all[k] || {}), [year]: n + 1 } },
      });
    } else {
      await this.updateSettings({ [Store.#SERIES[k].next]: n + 1 });
    }
    return formatDocNumber(this.settings[Store.#SERIES[k].prefix], n, date);
  }

  /**
   * Insert or replace a document, moving it between year files when the
   * issue year changed. On write failure the in-memory state is restored,
   * so a retried save can't double-apply.
   */
  async saveDoc(doc, { learn = true } = {}) {
    this.#assertWritable();
    const year = yearOf(doc.issueDate);
    await this.#loadYear(year);
    const touched = new Set([year]);

    // Track exactly what this save displaces, not a whole-map snapshot:
    // year writes serialize, so an overlapping save can succeed (and report
    // success) after this one's snapshot — a wholesale restore would erase
    // it from memory, and the next write would erase it from disk.
    const movedFrom = [];   // [year, entry] this save removed from other years
    for (const [y, list] of this.#docs) {
      if (y !== year && list.some((d) => d.id === doc.id)) {
        movedFrom.push([y, list.find((d) => d.id === doc.id)]);
        this.#docs.set(y, list.filter((d) => d.id !== doc.id));
        touched.add(y);
      }
    }
    const list = this.#docs.get(year) || [];
    const idx = list.findIndex((d) => d.id === doc.id);
    const replaced = idx >= 0 ? list[idx] : null;
    const next = { ...doc, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    this.#docs.set(year, list);
    this.emit();

    try {
      for (const y of touched) await this.#persistYear(y);
    } catch (err) {
      // Undo only this save's own change, and only while it is still the
      // current state — if a newer save of the same document has replaced
      // `next`, that save owns the document now and must survive.
      const cur = this.#docs.get(year) || [];
      const at = cur.indexOf(next);
      if (at >= 0) {
        const repaired = [...cur];
        if (replaced) repaired.splice(at, 1, replaced);
        else repaired.splice(at, 1);
        this.#docs.set(year, repaired);
        for (const [y, entry] of movedFrom) {
          const others = this.#docs.get(y) || [];
          if (!others.some((d) => d.id === doc.id)) this.#docs.set(y, [...others, entry]);
        }
      }
      this.emit();
      // What reached disk need not match the rollback: a same-year save
      // queued behind this one carried this document in its body and may
      // have landed, or a year move wrote the new file and lost the old
      // one's rewrite. Rewrite every touched year from memory, behind
      // whatever is queued — where the connection was the failure this
      // fails too and costs nothing; where one write of several was, disk
      // converges on what the user sees instead of a reload resurrecting
      // the change that was reported as not saved.
      for (const y of touched) {
        if (this.years.includes(y)) this.#persistYear(y).catch(() => {});
      }
      throw err;
    }
    // Only when the lines themselves changed. Every write on a document
    // comes through here — a payment recorded, an invoice marked sent, a
    // page published, a file attached — and re-teaching the price list from
    // an untouched old document rolled a rate the user had corrected on the
    // Saved items page back to whatever that document happened to carry.
    // `learn: false` is for bulk writers whose lines are not the user's
    // price list: a CSV import's "Opening balance INV-0042" rows are one
    // line each, and a hundred of them evicted every curated item.
    if (learn && (!replaced || Store.#itemLesson(replaced.items) !== Store.#itemLesson(next.items))) {
      this.#learnItems(next.items);
    }
    return next;
  }

  /**
   * Move a document to the trash. It stays in its year file with a
   * `deletedAt` on it, so nothing has to be rewritten and nothing is lost:
   * docs() filters it out, and every list, report, and total behaves as if
   * it were gone. Its number is never reused, restored or not.
   */
  async deleteDoc(id) {
    const doc = this.doc(id);
    if (!doc) return;
    // A converted quote keeps existing when its invoice goes; drop the
    // dangling link so it reads as accepted rather than invoiced, exactly as
    // a permanent delete used to. Restoring the invoice re-links it.
    const linked = doc.kind === 'invoice' && doc.quoteId ? this.doc(doc.quoteId) : null;
    await this.#markDoc(id, new Date().toISOString());
    if (linked) {
      const { invoiceId, ...unlinked } = linked;
      await this.saveDoc(unlinked).catch(() => {});
    }
  }

  /**
   * Flag (or unflag) a document as trashed, in place, in every year list
   * that holds it. Marking rather than saving matters: a document restored
   * from a backup can sit in a year file its issue date does not name, and
   * routing this through saveDoc would move it there — rewriting two files
   * to record one flag, and doing it on the way to the trash.
   */
  async #markDoc(id, deletedAt) {
    this.#assertWritable();
    const applied = [];   // [year, before, after]
    for (const [y, list] of this.#docs) {
      const idx = list.findIndex((d) => d.id === id);
      if (idx < 0) continue;
      const before = list[idx];
      let after;
      if (deletedAt) after = { ...before, deletedAt, updatedAt: Date.now() };
      else {
        const { deletedAt: gone, ...live } = before;
        after = { ...live, updatedAt: Date.now() };
      }
      const copy = [...list];
      copy[idx] = after;
      this.#docs.set(y, copy);
      applied.push([y, before, after]);
    }
    if (!applied.length) return null;
    this.emit();
    try {
      for (const [y] of applied) await this.#persistYear(y);
    } catch (err) {
      // Undo only this change, and only where it still stands: a later save
      // of the same document owns it from then on.
      for (const [y, before, after] of applied) {
        const cur = this.#docs.get(y) || [];
        const at = cur.indexOf(after);
        if (at < 0) continue;
        const repaired = [...cur];
        repaired[at] = before;
        this.#docs.set(y, repaired);
      }
      this.emit();
      throw err;
    }
    return this.#anyDoc(id);
  }

  /** Bring a document back, exactly as it was, with its number intact. */
  async restoreDoc(id) {
    const found = this.#anyDoc(id);
    if (!found || !isTrashed(found)) return null;
    const restored = await this.#markDoc(id, null);
    if (!restored) return null;
    // Re-link the estimate this invoice came from, if the delete unlinked it
    // and nothing else has claimed it meanwhile.
    if (restored.kind === 'invoice' && restored.quoteId) {
      const quote = this.doc(restored.quoteId);
      if (quote && !quote.invoiceId) {
        await this.saveDoc({ ...quote, invoiceId: restored.id }).catch(() => {});
      }
    }
    return restored;
  }

  /** Gone for good: only ever from the trash, and only when asked. */
  async purgeDoc(id) {
    this.#assertWritable();
    const doc = this.#anyDoc(id);
    if (!doc) return;
    // Remove the document from every year list that holds it, not just the
    // one its issue date names: a restored backup keys years verbatim, so a
    // document can sit in a "wrong" year file — and deleting only where the
    // issue date points would report success while leaving it in the list.
    const removed = [];   // [year, entries[]] this delete filtered out
    for (const [y, list] of this.#docs) {
      if (!list.some((d) => d.id === id)) continue;
      removed.push([y, list.filter((d) => d.id === id)]);
      this.#docs.set(y, list.filter((d) => d.id !== id));
    }
    this.emit();
    try {
      for (const [y] of removed) await this.#persistYear(y);
    } catch (err) {
      // Put back only what this delete removed, and only where nothing has
      // re-created the document meanwhile — restoring the old list wholesale
      // would revert concurrent saves that already reported success.
      for (const [y, entries] of removed) {
        const list = this.#docs.get(y) || [];
        if (!list.some((d) => d.id === id)) this.#docs.set(y, [...list, ...entries]);
      }
      this.emit();
      throw err;
    }
    // The files it carried go with it: a purge is the point at which the
    // document stops existing, and its folder has nothing left to hold.
    // Only once the record is gone, though — deleted first, a record write
    // that then failed rolled the document back into the trash with an
    // Attachments card listing files that no longer existed (removeAttachment
    // keeps the same order for the same reason). A deletion that fails here
    // leaves orphan files, which is the lesser of the two.
    await this.#deleteAttachments(doc);
  }

  /**
   * Give up on collecting an invoice, without pretending it was never
   * billed. Stored as `{ date, reason }` on the document; absent means the
   * invoice is live, so nothing written before this existed is touched.
   */
  async setWriteOff(id, { date, reason } = {}) {
    const doc = this.doc(id);
    if (!doc || doc.kind !== 'invoice') return null;
    const writeOff = {
      date: date || todayISO(),
      // Capped like the reminder history: a year file must not grow without
      // bound because someone pasted an email thread into the box.
      reason: String(reason || '').trim().slice(0, 400),
      at: Date.now(),
    };
    await this.saveDoc({ ...doc, writeOff });
    return writeOff;
  }

  /** Take it back: the invoice is owed again, exactly as before. */
  async clearWriteOff(id) {
    const doc = this.doc(id);
    if (!doc) return;
    const { writeOff, ...rest } = doc;
    await this.saveDoc(rest);
  }

  async setDocStatus(id, status) {
    const doc = this.doc(id);
    if (!doc) return;
    await this.saveDoc({ ...doc, status });
  }

  /* ---------- Payments & receipts ---------- */

  /**
   * Record money received, or sent back when `refund` is set. A refund is
   * stored as a negative amount on the same list, so balance, status, the
   * receipts ledger, and the accounting export all follow from one place.
   * It can never exceed what the client actually paid.
   */
  async addPayment(docId, input) {
    this.#assertWritable();
    // A receipt reservation waits on the cloud. Serialize recordings for
    // this invoice so each one sees the preceding payment and its outcome.
    const previous = this.#paymentQueues.get(docId) || Promise.resolve();
    const run = () => this.#addPayment(docId, input);
    const pending = previous.then(run, run);
    this.#paymentQueues.set(docId, pending);
    try {
      return await pending;
    } finally {
      if (this.#paymentQueues.get(docId) === pending) this.#paymentQueues.delete(docId);
    }
  }

  async #addPayment(docId, { date, amount, method, note, refund = false, fxRate = null }) {
    this.#assertWritable();
    const doc = this.doc(docId);
    if (!doc || doc.kind !== 'invoice') return null;
    const magnitude = round2(Math.abs(Number(amount) || 0));
    if (magnitude <= 0) return null;
    if (refund && magnitude > refundableTotal(doc) + 0.005) return null;
    const amt = refund ? -magnitude : magnitude;
    // Reserve the receipt number before writing the payment: a failed write
    // may skip a number, but two receipts can never end up sharing one.
    const paidOn = date || todayISO();
    const number = await this.reserveNumber('receipt', paidOn);
    // Edits and deletions can complete while numbering waits. Append to the
    // current document, and recheck refunds if its payments changed meanwhile.
    const fresh = this.doc(docId);
    if (!fresh || fresh.kind !== 'invoice') return null;
    if (refund && magnitude > refundableTotal(fresh) + 0.005) return null;
    const payment = {
      id: uid(),
      number,
      date: paidOn,
      amount: amt,
      method: (method || '').trim(),
      note: (note || '').trim(),
      // Money received months later converted at a different rate than the
      // invoice did; absent means the document's own rate applies.
      ...(Number(fxRate) > 0 ? { fxRate: Number(fxRate) } : {}),
      createdAt: Date.now(),
    };
    await this.saveDoc({ ...fresh, payments: [...(fresh.payments || []), payment] });
    return payment;
  }

  /**
   * Move a payment to the trash. It leaves `payments` — so the balance, the
   * status, the receipts ledger, the reports, and the accounting export all
   * behave exactly as they did before it was ever recorded — and waits in a
   * list of its own on the same document until it is restored or purged.
   */
  async deletePayment(docId, paymentId) {
    const doc = this.doc(docId);
    if (!doc) return;
    const payment = (doc.payments || []).find((p) => p.id === paymentId);
    if (!payment) return;
    await this.saveDoc({
      ...doc,
      payments: (doc.payments || []).filter((p) => p.id !== paymentId),
      trashedPayments: [
        ...(doc.trashedPayments || []),
        { ...payment, deletedAt: new Date().toISOString() },
      ],
    });
  }

  /** Put a payment back on its document, with its receipt number intact. */
  async restorePayment(docId, paymentId) {
    const doc = this.doc(docId);
    if (!doc) return null;
    const trashed = (doc.trashedPayments || []).find((p) => p.id === paymentId);
    if (!trashed) return null;
    const { deletedAt, ...payment } = trashed;
    await this.saveDoc({
      ...doc,
      payments: [...(doc.payments || []), payment],
      trashedPayments: (doc.trashedPayments || []).filter((p) => p.id !== paymentId),
    });
    return payment;
  }

  /** Gone for good: only ever from the trash, and only when asked. */
  async purgePayment(docId, paymentId) {
    const doc = this.doc(docId);
    if (!doc) return;
    await this.saveDoc({
      ...doc,
      trashedPayments: (doc.trashedPayments || []).filter((p) => p.id !== paymentId),
    });
  }

  /* ---------- Attachments ---------- */

  /**
   * Put a file beside a document, in the user's own cloud. Written first,
   * recorded second: a file with no record is invisible clutter, while a
   * record with no file is a download that fails — so a failed record takes
   * the file back out with it.
   */
  async attachFile(docId, file) {
    this.#assertWritable();
    const doc = this.doc(docId);
    if (!doc) return null;
    const list = doc.attachments || [];
    if (list.length >= MAX_ATTACHMENTS) {
      throw new Error(`A document can carry ${MAX_ATTACHMENTS} files; this one already has ${list.length}.`);
    }
    const size = Number(file?.size) || 0;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`That file is larger than ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB.`);
    }
    const id = uid();
    const name = safeFileName(file?.name);
    const path = attachmentPath(docId, id, name);
    await storage.fs.write(path, file, { createMissingParents: true });
    const entry = { id, name, size, type: String(file?.type || ''), path, addedAt: Date.now() };
    try {
      const fresh = this.doc(docId);
      if (!fresh) throw new Error('That document is no longer here.');
      await this.saveDoc({ ...fresh, attachments: [...(fresh.attachments || []), entry] });
    } catch (err) {
      // Only when the record is really gone. A later save of this document
      // took the entry along and now owns the document; if that save fails
      // too, its rollback restores this version, entry included — and a
      // file deleted here would leave that record pointing at nothing.
      if (!(this.doc(docId)?.attachments || []).some((a) => a.id === id)) {
        await storage.fs.delete(path).catch(() => {});
      }
      throw err;
    }
    return entry;
  }

  /**
   * Take a file off a document. The record goes first: an orphaned file is
   * invisible and harmless, while a record pointing at a deleted file is a
   * download that fails in the client's hands.
   */
  async removeAttachment(docId, attachmentId) {
    this.#assertWritable();
    const doc = this.doc(docId);
    if (!doc) return;
    const entry = (doc.attachments || []).find((a) => a.id === attachmentId);
    if (!entry) return;
    await this.saveDoc({
      ...doc,
      attachments: (doc.attachments || []).filter((a) => a.id !== attachmentId),
    });
    if (ownsAttachmentPath(docId, entry.path)) await storage.fs.delete(entry.path).catch(() => {});
  }

  /** The file itself, as a Blob, for downloading or attaching. */
  async readAttachment(entry) {
    return storage.fs.read(entry.path);
  }

  /** Whether attachments ride along on this document's public page. */
  async setShareAttachments(docId, on) {
    const doc = this.doc(docId);
    if (!doc) return;
    await this.saveDoc({ ...doc, shareAttachments: !!on });
  }

  /** Every attachment file of a document, gone. Only ever from a purge. */
  async #deleteAttachments(doc) {
    for (const entry of doc?.attachments || []) {
      if (!ownsAttachmentPath(doc.id, entry.path)) continue;
      await storage.fs.delete(entry.path).catch(() => {});
    }
    if (doc?.attachments?.length) {
      await storage.fs.delete(`${ATTACH_DIR}/${idSegment(doc.id)}`, { recursive: true }).catch(() => {});
    }
  }

  /* ---------- Reminders ---------- */

  /**
   * Note that a client was chased, so "did I already remind them?" has an
   * answer. Kept on the document (never on the paper), newest last, and
   * capped so a long-running dispute can't grow the year file without bound.
   */
  async recordReminder(docId, { stage, how = 'mail' } = {}) {
    const doc = this.doc(docId);
    if (!doc || doc.kind !== 'invoice') return null;
    const entry = { id: uid(), date: todayISO(), stage: stage || '', how, at: Date.now() };
    const list = [...(doc.reminders || []), entry].slice(-50);
    await this.saveDoc({ ...doc, reminders: list });
    return entry;
  }

  /**
   * Note an email this app actually delivered — the worker accepted it and
   * named the addresses it went to (src/lib/mailer.js).
   *
   * Only real deliveries land here. Handing the text to a mail client or the
   * clipboard is recorded as a reminder's `how` where it belongs, but it is
   * not evidence of anything: the app never learns whether that window was
   * ever sent. This log is the answer to "did it go, and to whom", so it must
   * only ever hold sends it watched happen. Kept on the document, never on the
   * paper, and capped like the reminder history.
   */
  async recordEmail(docId, { to = [], subject = '', attachments = 0 } = {}) {
    const doc = this.doc(docId);
    if (!doc) return null;
    const list = (Array.isArray(to) ? to : [to]).map((v) => String(v || '').trim()).filter(Boolean);
    if (!list.length) return null;
    const entry = {
      id: uid(),
      date: todayISO(),
      at: Date.now(),
      to: list,
      subject: String(subject || '').slice(0, 200),
      attachments: Math.max(0, Math.round(Number(attachments) || 0)),
    };
    const log = [...(doc.emails || []), entry].slice(-50);
    await this.saveDoc({ ...doc, emails: log });
    return entry;
  }

  /** All payments across invoices, newest first: the receipts ledger. */
  receipts() {
    const out = [];
    for (const doc of this.docs()) {
      if (doc.kind !== 'invoice') continue;
      for (const p of doc.payments || []) out.push({ payment: p, doc });
    }
    out.sort((a, b) => (a.payment.date < b.payment.date ? 1 : a.payment.date > b.payment.date ? -1
      : (b.payment.createdAt || 0) - (a.payment.createdAt || 0)));
    return out;
  }

  /* ---------- Quote conversion ---------- */

  async convertQuote(quoteId) {
    // One conversion per quote at a time. The page re-renders on every
    // store change, and reserveNumber emits before its own write lands, so
    // a second press on the rebuilt button ran a second conversion before
    // the first invoice had reached memory — the back-link check below
    // found nothing, and two invoices were minted for one quote. The second
    // caller now gets the first caller's invoice.
    const pending = this.#converting.get(quoteId);
    if (pending) return pending;
    const run = this.#convertQuoteNow(quoteId).finally(() => {
      if (this.#converting.get(quoteId) === run) this.#converting.delete(quoteId);
    });
    this.#converting.set(quoteId, run);
    return run;
  }

  async #convertQuoteNow(quoteId) {
    const quote = this.doc(quoteId);
    // A link to an invoice that no longer exists (its delete lost the
    // unlink write) does not make the quote converted: converting again
    // is the session's way back.
    if (!quote || quote.kind !== 'quote') return null;
    if (quote.invoiceId && this.doc(quote.invoiceId)) return null;
    // The conversion is two writes: the invoice, then the quote's link to
    // it. A retry after the second failed (the invoice exists, the quote
    // doesn't know it yet) must finish the link rather than mint a second
    // invoice — the invoice's own quoteId back-link is how it is found.
    const existing = this.docs().find((d) => d.kind === 'invoice' && d.quoteId === quote.id);
    if (existing) {
      await this.saveDoc({ ...quote, status: 'accepted', invoiceId: existing.id });
      return existing;
    }
    const issueDate = todayISO();
    const number = await this.reserveNumber('invoice', issueDate);
    const invoice = invoiceFromQuote(quote, {
      id: uid(),
      number,
      issueDate,
      dueDate: addDays(issueDate, this.#termsFor(quote.clientId)),
    });
    invoice.createdAt = Date.now();
    await this.saveDoc(invoice);
    await this.saveDoc({ ...quote, status: 'accepted', invoiceId: invoice.id });
    return invoice;
  }

  async duplicateDoc(id) {
    const src = this.doc(id);
    if (!src) return null;
    const issueDate = todayISO();
    const number = await this.reserveNumber(src.kind, issueDate);
    // How far the copy's issue date moved. Its due date is recomputed from
    // the client's terms, so a payment plan left on the source's dates made a
    // duplicate that was already overdue the moment it was sent — dated
    // today, due next month on the face of it, and measured against an
    // installment from February. Shifting the plan by the same offset keeps
    // "half on signing, half a month later" saying what it said.
    const shift = /^\d{4}-\d{2}-\d{2}$/.test(String(src.issueDate || ''))
      ? daysBetween(src.issueDate, issueDate) : 0;
    const shifted = (date) => (shift && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
      ? addDays(date, shift) : date);
    const copy = {
      ...src,
      id: uid(),
      number,
      issueDate,
      status: 'draft',
      payments: [],
      reminders: [],
      // Copies of the mutable innards, as invoiceFromQuote and
      // processRecurringDue make them: a bare spread would leave source and
      // duplicate sharing the same item, tax, and deposit objects, so a later
      // in-place edit of one would quietly change the other.
      items: copyItems(src.items),
      ...(Array.isArray(src.taxes) ? { taxes: src.taxes.map((t) => ({ ...t })) } : {}),
      ...(src.deposit ? { deposit: { ...src.deposit } } : {}),
      ...(Array.isArray(src.schedule)
        ? { schedule: src.schedule.map((r) => ({ ...r, ...(r?.dueDate ? { dueDate: shifted(r.dueDate) } : {}) })) }
        : {}),
      createdAt: Date.now(),
    };
    delete copy.quoteId;
    delete copy.invoiceId;
    delete copy.recurringId;
    delete copy.shareToken;
    // Attachments are not copied: their records point at files under the
    // *source* document's folder, so a duplicate carrying them shares one
    // set of files with it — and removing one from the copy (or purging the
    // copy) would delete the original's file out from under it. A duplicate
    // is a fresh document; anything it needs to travel with is attached to it.
    delete copy.attachments;
    delete copy.shareAttachments;
    // Nor the history of the invoice it was copied from: a fresh draft that
    // is already written off reads as given up on before it was ever sent
    // (and reports it as money lost), and a deleted payment carried across
    // could be restored onto the copy, minting a second payment under a
    // receipt number the original already owns.
    delete copy.writeOff;
    delete copy.trashedPayments;
    // Nor the record of what was delivered. That log is evidence of a send
    // this app watched happen (recordEmail), and every entry in it names the
    // *source* document's message: a fresh draft carrying it would open with
    // a Delivered card claiming addresses it has never been sent to.
    delete copy.emails;
    if (src.kind === 'invoice') copy.dueDate = addDays(issueDate, this.#termsFor(src.clientId));
    else copy.validUntil = addDays(issueDate, termDays(this.settings.quoteValidDays, 30));
    await this.saveDoc(copy);
    return copy;
  }

  /* ---------- Recurring invoices ---------- */

  async #persistRecurring() {
    this.#assertWritable();
    // The trashed ones are stored too, like the clients above.
    await this.#kvSet(KV.recurring, this.#allRecurring);
  }

  #setRecurring(next) {
    this.#allRecurring = next;
    this.#syncLive();
  }

  async saveRecurring(rule) {
    this.#assertWritable();
    const prev = this.#allRecurring;
    const idx = this.#allRecurring.findIndex((r) => r.id === rule.id);
    this.#setRecurring(idx >= 0
      ? this.#allRecurring.map((r) => (r.id === rule.id ? rule : r))
      : [...this.#allRecurring, { ...rule, id: rule.id || uid(), createdAt: Date.now() }]);
    this.emit();
    try {
      await this.#persistRecurring();
    } catch (err) {
      this.#setRecurring(prev);
      this.emit();
      throw err;
    }
  }

  /** Move a schedule to the trash: it drafts nothing while it sits there. */
  async deleteRecurring(id) {
    await this.#markRecurring(id, new Date().toISOString());
  }

  /** Put a schedule back; it picks its cadence up where it left off. */
  async restoreRecurring(id) {
    await this.#markRecurring(id, null);
  }

  async #markRecurring(id, deletedAt) {
    this.#assertWritable();
    const prev = this.#allRecurring;
    this.#setRecurring(this.#allRecurring.map((r) => {
      if (r.id !== id) return r;
      if (deletedAt) return { ...r, deletedAt };
      const { deletedAt: gone, ...live } = r;
      return live;
    }));
    this.emit();
    try {
      await this.#persistRecurring();
    } catch (err) {
      this.#setRecurring(prev);
      this.emit();
      throw err;
    }
  }

  /** Gone for good: only ever from the trash, and only when asked. */
  async purgeRecurring(id) {
    this.#assertWritable();
    const prev = this.#allRecurring;
    this.#setRecurring(this.#allRecurring.filter((r) => r.id !== id));
    this.emit();
    try {
      await this.#persistRecurring();
    } catch (err) {
      this.#setRecurring(prev);
      this.emit();
      throw err;
    }
  }

  /**
   * Generate draft invoices for every schedule that came due, then advance
   * each schedule. Drafts, not sent: a generated invoice should be looked
   * at before it goes anywhere. Returns how many were created.
   */
  /**
   * Draft every invoice whose schedule has come due. One run at a time: the
   * "already drafted?" check below sits before two awaits, and a second run
   * entering during them passed the same check and minted the same period
   * again with the next number. That second run has real callers — boot's
   * is not awaited, and Resume on a rule or saving a schedule dated today
   * can be pressed while it is still working through a catch-up — so each
   * call queues behind the one in flight and then does its own pass, which
   * finds that period drafted and moves on to whatever it was asked for.
   */
  processRecurringDue() {
    const run = () => this.#draftRecurringDue();
    const mine = this.#recurringQueue.then(run, run);
    this.#recurringQueue = mine.catch(() => {});
    return mine;
  }

  async #draftRecurringDue() {
    const today = todayISO();
    let created = 0;
    for (const { id } of [...this.recurring]) {
      // The rule as it stands now, not as it stood when the loop began. A
      // catch-up costs a write per draft, and the schedules ahead of this
      // one in the list can hold it up for seconds — long enough for the
      // user to pause, edit, or delete it from the Recurring page. Read
      // from the copy taken at the start, a paused schedule still drafted
      // every period it had missed, and the bookkeeping written from that
      // copy below put the stale rule back: un-paused, its edit undone, or
      // lifted straight out of the trash it had just been moved to.
      const rule = this.recurring.find((r) => r.id === id);
      // A completed schedule is as inert as a paused one: a fixed-term
      // engagement that ended must not keep drafting invoices.
      if (!rule || rule.paused || ruleCompleted(rule) || !rule.nextDue || rule.nextDue > today) continue;
      const { dates, nextDue } = dueOccurrences(rule, today);
      let drafted = 0;   // dates this run walked, drafted or found drafted
      let made = 0;      // drafts this run actually created
      for (const date of dates) {
        // A pause or a delete landing between two of this rule's own drafts
        // stops it here; the schedule picks up from the first date it did
        // not reach, exactly as an interrupted run does.
        const now = this.recurring.find((r) => r.id === id);
        if (!now || now.paused) break;
        // An earlier run may have drafted this date and then failed before
        // the schedule advanced (the drafts saved, the rule write didn't).
        // Like a retried quote conversion, the retry finishes the
        // bookkeeping instead of minting duplicates — the draft's own
        // back-link is how it is found.
        if (!this.docs().some((d) => d.kind === 'invoice' && d.recurringId === rule.id
          && d.issueDate === date)) {
          // Each catch-up draft numbers into the year of its own issue date,
          // not the day the app happened to be opened.
          const number = await this.reserveNumber('invoice', date);
          await this.saveDoc({
            id: uid(),
            kind: 'invoice',
            number,
            clientId: rule.clientId,
            issueDate: date,
            dueDate: addDays(date, this.#termsFor(rule.clientId)),
            currency: rule.currency,
            items: copyItems(rule.items),
            taxRate: rule.taxRate || 0,
            // Old rules carry a single rate, new ones a named list; docTaxes
            // reads either, so the generated invoice stores the list form.
            taxes: docTaxes(rule).map((t) => ({ ...t })),
            taxInclusive: !!rule.taxInclusive,
            discountType: rule.discountType || 'none',
            discountValue: rule.discountValue || 0,
            notes: rule.notes || '',
            status: 'draft',
            payments: [],
            recurringId: rule.id,
            createdAt: Date.now(),
          });
          created++;
          made++;
        }
        drafted++;
      }
      // What the schedule has produced over its lifetime, which is what an
      // occurrence cap is measured against: the drafts on file — trashed
      // ones included, so deleting a generated draft does not buy another
      // period — or the count carried so far plus this run's own, whichever
      // is higher (a purge shrinks the first). Counting every date walked
      // grew the second without drafting anything: "Next invoice on" moved
      // back onto dates already drafted spent a capped schedule's remaining
      // periods on invoices that already existed, and completed it early.
      let linked = 0;
      for (const list of this.#docs.values()) {
        for (const d of list) if (d.kind === 'invoice' && d.recurringId === id) linked++;
      }
      // The bookkeeping lands on the rule as it stands after the drafts —
      // paused, edited, trashed, whatever the user did meanwhile stays — and
      // a rule purged meanwhile has nothing left to advance. `issued`
      // counts what this schedule has drafted over its lifetime, which is
      // what an occurrence cap is measured against: deleting a generated
      // draft does not buy another period.
      const live = this.#allRecurring.find((r) => r.id === id);
      if (!live) continue;
      await this.saveRecurring({
        ...live,
        // A date the user moved while this ran is theirs to keep; otherwise
        // the schedule advances past what was drafted, or stops at the
        // first date a pause kept it from reaching.
        nextDue: live.nextDue !== rule.nextDue ? live.nextDue
          : drafted < dates.length ? dates[drafted] : nextDue,
        issued: Math.max(issuedCount(live) + made, linked),
        lastRun: today,
      });
    }
    return created;
  }

  /* ---------- Saved line items (the price list) ---------- */

  itemSuggestions() {
    return this.items;
  }

  /**
   * One saved item as it is stored: a trimmed name, a numeric rate, an
   * optional unit, and an optional tax treatment shaped exactly like a line
   * item's (`[]` means "no tax", absent means "whatever the document
   * charges"), so filling a line from the list needs no translation.
   */
  static #cleanItem(input, existing = null) {
    const item = {
      id: existing?.id || input.id || uid(),
      name: String(input.name ?? '').trim(),
      rate: Number(input.rate) || 0,
      unit: String(input.unit ?? '').trim().slice(0, 24),
    };
    if (Array.isArray(input.taxes)) {
      item.taxes = input.taxes
        .filter((t) => t && typeof t === 'object')
        .map((t) => ({ label: String(t.label || '').trim(), rate: Number(t.rate) || 0 }))
        .filter((t) => t.rate > 0);
    }
    return item;
  }

  /** Add or replace one saved item; returns what was stored. */
  async saveItem(input) {
    this.#assertWritable();
    const existing = input?.id ? this.items.find((i) => i.id === input.id) : null;
    const item = Store.#cleanItem(input || {}, existing);
    if (!item.name) return null;
    const prev = this.items;
    // Names are the key the editor matches on, so two entries sharing one
    // would make which rate gets filled a coin toss. An edit that collides
    // with another entry takes that entry's place.
    const key = item.name.toLowerCase();
    const next = this.items.filter((i) => i.id !== item.id && i.name.toLowerCase() !== key);
    const at = this.items.findIndex((i) => i.id === item.id);
    if (at >= 0) next.splice(Math.min(at, next.length), 0, item);
    else next.push(item);
    this.items = next;
    this.emit();
    try {
      await this.#kvSet(KV.items, this.items);
    } catch (err) {
      this.items = prev;
      this.emit();
      throw err;
    }
    return item;
  }

  async deleteItem(id) {
    this.#assertWritable();
    const prev = this.items;
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
    try {
      await this.#kvSet(KV.items, this.items);
    } catch (err) {
      this.items = prev;
      this.emit();
      throw err;
    }
  }

  /**
   * The only three things #learnItems reads off a line list, as one
   * comparable string: a save that leaves all three alone has nothing new
   * to teach, whatever else about the document moved.
   */
  static #itemLesson(items) {
    return JSON.stringify((items || []).map((it) => [
      String(it?.name ?? '').trim(), Number(it?.rate) || 0, String(it?.unit ?? '').trim(),
    ]));
  }

  /**
   * Quietly remember line items by name with their latest rate and unit.
   * A curated entry is corrected, never emptied: a line saved without a unit
   * leaves the unit the user set on the list alone, because the automatic
   * learning is a convenience and the list is the record.
   */
  #learnItems(items) {
    let changed = false;
    for (const it of items || []) {
      const name = (it.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = this.items.find((s) => String(s.name || '').toLowerCase() === key);
      const unit = String(it.unit ?? '').trim();
      if (existing) {
        if (existing.rate !== it.rate) { existing.rate = it.rate; changed = true; }
        if (unit && existing.unit !== unit) { existing.unit = unit; changed = true; }
      } else {
        this.items.push({ id: uid(), name, rate: it.rate, ...(unit ? { unit } : {}) });
        changed = true;
      }
    }
    if (this.items.length > 100) { this.items = this.items.slice(-100); changed = true; }
    if (changed) this.#kvSet(KV.items, this.items).catch(() => {});
  }

  /* ---------- Bulk replace (sample data, wipe, import) ---------- */

  /**
   * Replace the whole dataset. Shaped like an export so sample data and
   * "start fresh" run through one hardened path.
   */
  async importAll(data) {
    this.#assertWritable();
    const years = Object.keys(data.docs || {}).sort().reverse();
    // The old KV indexes stay live until the very end, and they point at
    // the files this import is about to replace. Snapshot those files
    // first: a failure partway must put them back, or the next load pairs
    // old indexes and counters with half-replaced files — two datasets
    // mixed together. A snapshot that cannot be read is a reason not to
    // start overwriting at all.
    const preserve = new Map();   // year -> previous file content, null = absent
    for (const y of new Set([...years, ...this.years])) {
      try {
        preserve.set(y, await (await storage.fs.read(yearPath(y))).text());
      } catch (err) {
        if (!isMissingFileError(err)) throw err;
        preserve.set(y, null);
      }
    }
    try {
      // Write files first, then the indexes that make them visible.
      for (const y of years) {
        await this.#queueWrite(y, () =>
          storage.fs.write(yearPath(y), JSON.stringify(data.docs[y] || []), { createMissingParents: true }));
      }
      // Remove stale year files that the new dataset doesn't cover.
      for (const y of this.years.filter((y) => !years.includes(y))) {
        await storage.fs.delete(yearPath(y)).catch(() => {});
      }
      const results = await Promise.allSettled([
        this.#kvSet(KV.years, years),
        this.#kvSet(KV.clients, data.clients || []),
        this.#kvSet(KV.items, data.items || []),
        this.#kvSet(KV.recurring, data.recurring || []),
        this.#kvSet(KV.settings, data.settings),
      ]);
      // Drain every import write before rollback: a slower successful write
      // must not land after its old value has already been restored.
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    } catch (err) {
      // Best effort: restore the files the old indexes describe and re-pin
      // every KV key to the in-memory (pre-import) state, since some keys
      // may have committed even though another failed.
      await Promise.allSettled([...preserve].map(([y, body]) => (body == null
        ? storage.fs.delete(yearPath(y))
        : this.#queueWrite(y, () => storage.fs.write(yearPath(y), body, { createMissingParents: true })))));
      await Promise.allSettled([
        this.#kvSet(KV.years, this.years),
        this.#kvSet(KV.clients, this.#allClients),
        this.#kvSet(KV.items, this.items),
        this.#kvSet(KV.recurring, this.#allRecurring),
        this.#kvSet(KV.settings, this.settings),
      ]);
      throw err;
    }
    this.years = years;
    this.#docs = new Map(years.map((y) => [y, data.docs[y] || []]));
    this.#allClients = data.clients || [];
    this.items = data.items || [];
    this.#allRecurring = data.recurring || [];
    this.#syncLive();
    this.settings = data.settings;
    // A backup made by a broken install may carry the same document in two
    // year files, or a quote linked to an invoice it does not carry; heal
    // both here rather than letting them mislead until the next reload does.
    await this.#healDuplicates();
    await this.#healDanglingLinks();
    this.emit();
  }

  /**
   * Everything, shaped for importAll (backup / inspection) — including what
   * is in the trash, which is still the user's data until it is purged.
   */
  exportAll() {
    const docs = {};
    for (const y of this.years) docs[y] = this.#docs.get(y) || [];
    return {
      app: 'invoicing',
      version: 1,
      settings: this.settings,
      clients: this.#allClients,
      items: this.items,
      recurring: this.#allRecurring,
      docs,
    };
  }

  /* ---------- Trash ---------- */

  /**
   * What is recoverable, newest deletion first. Payments are listed with the
   * document they came off, because "€250 on the 3rd" means nothing without
   * the invoice it belongs to.
   */
  trash() {
    const when = (x) => Date.parse(x?.deletedAt) || 0;
    const docs = [];
    const payments = [];
    for (const list of this.#docs.values()) {
      for (const doc of list) {
        if (isTrashed(doc)) docs.push(doc);
        // Payments trashed off a document that is itself in the trash are
        // that document's business: restoring it brings its payments with it.
        else for (const p of doc.trashedPayments || []) payments.push({ doc, payment: p });
      }
    }
    docs.sort((a, b) => when(b) - when(a));
    payments.sort((a, b) => when(b.payment) - when(a.payment));
    return {
      docs,
      payments,
      clients: this.#allClients.filter(isTrashed).sort((a, b) => when(b) - when(a)),
      recurring: this.#allRecurring.filter(isTrashed).sort((a, b) => when(b) - when(a)),
    };
  }

  /** How many recoverable things are sitting in the trash right now. */
  trashCount() {
    const t = this.trash();
    return t.docs.length + t.payments.length + t.clients.length + t.recurring.length;
  }

  /**
   * Empty it, in one pass: every container is filtered once and written
   * once, the way the boot-time purge does it. Purging item by item rewrote
   * a year file for each of its trashed documents — forty documents in a
   * 200 KB year meant forty uploads of it — and the clients list once per
   * trashed client. A container that cannot be written is rolled back where
   * it still stands and the failure reported, like the single-item purges;
   * whatever was written before it stays purged.
   */
  async emptyTrash() {
    this.#assertWritable();
    const t = this.trash();
    const gone = new Set(t.docs.map((d) => d.id));
    const touched = [];   // [year, before, after]
    for (const [y, list] of this.#docs) {
      const after = list
        .filter((d) => !gone.has(d.id))
        .map((d) => (Array.isArray(d.trashedPayments) && d.trashedPayments.length
          ? { ...d, trashedPayments: [] }
          : d));
      const changed = after.length !== list.length || after.some((d, i) => d !== list[i]);
      if (!changed) continue;
      touched.push([y, list, after]);
      this.#docs.set(y, after);
    }
    const prevClients = this.#allClients;
    const prevRecurring = this.#allRecurring;
    if (t.clients.length) this.#setClients(this.#allClients.filter((c) => !isTrashed(c)));
    if (t.recurring.length) this.#setRecurring(this.#allRecurring.filter((r) => !isTrashed(r)));
    if (touched.length || t.clients.length || t.recurring.length) this.emit();
    const written = new Set();
    let clientsDone = !t.clients.length;
    let recurringDone = !t.recurring.length;
    try {
      for (const [y] of touched) {
        await this.#persistYear(y);
        written.add(y);
      }
      if (!clientsDone) await this.#persistClients();
      clientsDone = true;
      if (!recurringDone) await this.#persistRecurring();
      recurringDone = true;
    } catch (err) {
      // Undo only what did not land, and only where nothing has changed it
      // since: a container already written stays purged.
      for (const [y, before, after] of touched) {
        if (!written.has(y) && this.#docs.get(y) === after) this.#docs.set(y, before);
      }
      if (!clientsDone) this.#setClients(prevClients);
      if (!recurringDone) this.#setRecurring(prevRecurring);
      this.emit();
      throw err;
    }
    // The files of the documents that are gone, once their records are (the
    // order purgeDoc keeps, for the same reason).
    for (const doc of t.docs) await this.#deleteAttachments(doc);
  }
}

export const store = new Store();
