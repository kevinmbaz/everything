/**
 * Reading a backup file: the other half of Settings → Download backup.
 *
 * Validation happens before anything is written, and returns a result rather
 * than throwing, so a bad file can be reported without ever touching the
 * user's data. What comes back is shaped exactly like store.exportAll(), the
 * input store.importAll() expects.
 */

import { DEFAULT_SETTINGS, SHARE_DIR, isMissingFileError, ownsAttachmentPath } from './store.js';
import { storage } from './storage.js';

export const BACKUP_VERSION = 1;

const fail = (error) => ({ ok: false, error });
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** parse + validate a downloaded backup file's text. */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ''));
  } catch {
    return fail('That file is not valid JSON');
  }
  return validateBackup(raw);
}

/**
 * validateBackup(raw) ->
 *   { ok: false, error }
 *   { ok: true, data: { app, version, settings, clients, items, recurring, docs },
 *     counts: { docs, clients, recurring, shared, years }, tokens: [...] }
 *
 * Unknown extra fields on documents and settings are preserved: a backup from
 * a newer minor build should round-trip, not get quietly trimmed.
 */
export function validateBackup(raw) {
  if (!isPlainObject(raw)) return fail('That file does not look like a backup');
  if (raw.app !== 'invoicing') {
    return fail('That file is not an Invoicing backup');
  }
  const version = Number(raw.version);
  if (!Number.isFinite(version) || version < 1) return fail('That backup is missing its version');
  if (version > BACKUP_VERSION) return fail('That backup was made by a newer version of this app');
  if (!isPlainObject(raw.settings)) return fail('That backup has no settings in it');
  if (raw.docs !== undefined && !isPlainObject(raw.docs)) return fail('That backup’s documents are unreadable');
  for (const key of ['clients', 'items', 'recurring']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) return fail(`That backup’s ${key} are unreadable`);
  }

  // Missing new fields (a logo, a tint) fall back to today's defaults, the
  // same merge store.init() does when reading settings written long ago.
  const settings = {
    ...DEFAULT_SETTINGS,
    ...raw.settings,
    business: { ...DEFAULT_SETTINGS.business, ...(raw.settings.business || {}) },
    paymentLink: { ...DEFAULT_SETTINGS.paymentLink, ...(raw.settings.paymentLink || {}) },
    // Element checks for the default taxes, as for every other list here:
    // settingsTaxes() maps over them on the Settings page, in the editor and
    // on Saved items, so one junk entry blanked all three at render.
    ...(raw.settings.taxes !== undefined
      ? { taxes: (Array.isArray(raw.settings.taxes) ? raw.settings.taxes : []).filter(isPlainObject) }
      : {}),
  };

  const clients = (raw.clients || []).filter((c) => isPlainObject(c) && c.id);
  // A saved item may carry its own tax treatment, and a junk entry inside it
  // would reach the editor as a line's taxes list — the same element-level
  // check the documents below get.
  const items = (raw.items || []).filter((i) => isPlainObject(i) && i.name)
    .map((i) => (Array.isArray(i.taxes) ? { ...i, taxes: i.taxes.filter(isPlainObject) } : i));
  // A schedule carries the same line list a document does, and it reaches the
  // same code: copyItems() throws on a junk item, which at boot takes the
  // whole recurring run down — silently, since the caller swallows it, so no
  // schedule drafts anything and nothing says why — and a junk tax row blanks
  // the schedule editor. Element checks belong with the container check here
  // exactly as they do on a document.
  const recurring = (raw.recurring || []).filter((r) => isPlainObject(r) && r.id).map((r) => ({
    ...r,
    items: (Array.isArray(r.items) ? r.items : []).filter(isPlainObject)
      .map((it) => (Array.isArray(it.taxes) ? { ...it, taxes: it.taxes.filter(isPlainObject) } : it)),
    ...(Array.isArray(r.taxes) ? { taxes: r.taxes.filter(isPlainObject) } : {}),
  }));

  const docs = {};
  const tokens = [];
  let docCount = 0;
  let attachmentCount = 0;
  for (const [year, list] of Object.entries(raw.docs || {})) {
    if (!/^\d{4}$/.test(year)) return fail(`That backup has an unexpected year in it: ${year}`);
    if (!Array.isArray(list)) return fail(`That backup’s ${year} documents are unreadable`);
    const clean = [];
    for (const d of list) {
      if (!isPlainObject(d) || !d.id) continue;
      if (d.kind !== 'invoice' && d.kind !== 'quote') continue;
      // Every stored document is filed under the year of its issue date; one
      // with no usable date would later be saved into a year file named
      // "unde" — and exports carrying that key can never be restored.
      if (!/^\d{4}-/.test(String(d.issueDate || ''))) {
        return fail(`A document in that backup has no usable issue date: ${d.number || d.id}`);
      }
      // Element checks belong with the container checks: a null or a string
      // inside payments/items/taxes/reminders would crash totals, status, or
      // the chasing history on every later render — before any view mounts —
      // so junk entries are dropped here, not restored. A taxes *array* stays
      // an array (`[]` means exempt); a document without one keeps its legacy
      // taxRate reading. Reminders are the user's own record of chasing, and
      // one junk entry there left a document's page blank and took the
      // dashboard's "Needs attention" card down with it.
      const doc = {
        ...d,
        items: (Array.isArray(d.items) ? d.items : []).filter(isPlainObject)
          .map((it) => (Array.isArray(it.taxes) ? { ...it, taxes: it.taxes.filter(isPlainObject) } : it)),
        payments: (Array.isArray(d.payments) ? d.payments : []).filter(isPlainObject),
        // Attachment metadata travels in a backup; the files themselves stay
        // in the filesystem where they are. A junk entry here would reach the
        // document's page as a row with no name and no file behind it — and
        // the path is what Remove and the trash purge delete, so an entry
        // pointing anywhere but the document's own folder is not adopted.
        ...(Array.isArray(d.attachments)
          ? { attachments: d.attachments.filter((a) => isPlainObject(a) && a.id && a.path && ownsAttachmentPath(d.id, a.path)) }
          : {}),
        // Deleted payments wait on the document they came off until they are
        // restored or purged; they are data, and a junk entry among them
        // would reach the trash view on every render.
        ...(d.trashedPayments === undefined
          ? {}
          : { trashedPayments: (Array.isArray(d.trashedPayments) ? d.trashedPayments : []).filter(isPlainObject) }),
        ...(Array.isArray(d.taxes) ? { taxes: d.taxes.filter(isPlainObject) } : {}),
        // A junk installment would reach docTotals on every render, and the
        // status of every list the document appears in derives from it.
        ...(Array.isArray(d.schedule) ? { schedule: d.schedule.filter(isPlainObject) } : {}),
        ...(d.reminders === undefined
          ? {}
          : { reminders: (Array.isArray(d.reminders) ? d.reminders : []).filter(isPlainObject) }),
        // The log of emails this app actually delivered, for the same reason:
        // it is drawn on the document's page, so one junk entry there would
        // blank the page it is meant to inform. An entry is its addresses —
        // one that names nobody says nothing, and the page joins that list.
        ...(d.emails === undefined
          ? {}
          : {
            emails: (Array.isArray(d.emails) ? d.emails : [])
              .filter((e) => isPlainObject(e) && Array.isArray(e.to) && e.to.length),
          }),
      };
      // A share token names a file that this backup does not carry, so it
      // can never point at a live page again. Restored documents come back
      // unshared; the tokens are handed to the caller to clean up after.
      if (doc.shareToken) {
        tokens.push(String(doc.shareToken));
        delete doc.shareToken;
      }
      attachmentCount += (doc.attachments || []).length;
      clean.push(doc);
    }
    docs[year] = clean;
    docCount += clean.length;
  }

  const years = Object.keys(docs).sort();
  return {
    ok: true,
    tokens,
    counts: {
      docs: docCount,
      clients: clients.length,
      recurring: recurring.length,
      shared: tokens.length,
      attachments: attachmentCount,
      years: years.length ? (years[0] === years.at(-1) ? years[0] : `${years[0]}–${years.at(-1)}`) : '',
    },
    data: { app: 'invoicing', version: BACKUP_VERSION, settings, clients, items, recurring, docs },
  };
}

/** One line for the confirm dialog: what this file will put back. */
export function restoreSummary(counts) {
  const n = (v, one, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
  const parts = [n(counts.docs, 'document'), n(counts.clients, 'client')];
  if (counts.recurring) parts.push(n(counts.recurring, 'schedule'));
  // A backup carries what a document says it has, not the files themselves.
  if (counts.attachments) parts.push(n(counts.attachments, 'attached file'));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${list}${counts.years ? ` from ${counts.years}` : ''}`;
}

/**
 * Take every share page involved in a restore offline: the ones this account
 * publishes now (their documents are about to be replaced) and the ones named
 * in the backup (whose files may still be live here from an earlier session).
 * Returns how many could not be deleted, so the caller can say so.
 */
export async function retireSharePages(store, backupTokens = []) {
  const tokens = new Set();
  for (const t of backupTokens) if (t) tokens.add(String(t));
  for (const d of store.docs()) if (d.shareToken) tokens.add(String(d.shareToken));
  let failed = 0;
  for (const token of tokens) {
    // Never build a path out of something that isn't a token.
    if (!/^[a-z0-9]{6,64}$/i.test(token)) continue;
    // The published copies of a document's attachments sit in a folder beside
    // its page, exactly as un-sharing takes both down together: leaving the
    // folder would keep those files downloadable at a URL somebody kept,
    // after a restore that reported every page taken offline. Attempt both
    // deletions, counting the token once if either fails; missing is fine.
    let tokenFailed = false;
    try {
      await storage.fs.delete(`${SHARE_DIR}/${token}`, { recursive: true });
    } catch (err) {
      if (!isMissingFileError(err)) tokenFailed = true;
    }
    try {
      await storage.fs.delete(`${SHARE_DIR}/${token}.html`);
    } catch (err) {
      if (!isMissingFileError(err)) tokenFailed = true;
    }
    if (tokenFailed) failed++;
  }
  return failed;
}

/**
 * Which attachments a restored backup describes but the filesystem does not
 * have. Metadata travels in a backup; the files stay where they are, so a
 * backup carried to another account (or restored after a purge) can name
 * files that are not there — worth reporting, never worth failing over.
 *
 * Capped, because this is one call per file and a restore should not stall
 * on an account with hundreds; the count says when it stopped looking.
 */
export async function missingAttachments(store, { limit = 200 } = {}) {
  const entries = store.docs().flatMap((d) => d.attachments || []);
  let missing = 0;
  let checked = 0;
  for (const entry of entries) {
    if (checked >= limit) break;
    checked++;
    try {
      if (storage.fs.stat) await storage.fs.stat(entry.path);
      else await storage.fs.read(entry.path);
    } catch (err) {
      if (isMissingFileError(err)) missing++;
    }
  }
  return { missing, checked, total: entries.length };
}
