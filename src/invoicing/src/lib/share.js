/**
 * Public share pages. Each shared document becomes one static, unlisted
 * HTML file in the user's own cloud, served through a Puter-hosted
 * subdomain created once per account. The URL carries a random token, so
 * only people given the link can find it; un-sharing deletes the file.
 */

import { docPayLink } from './paylink.js';
import { isPrivate } from './storage.js';
import { SHARE_DIR, isMissingFileError, safeFileName, ownsAttachmentPath } from './store.js';

function randomToken(len = 20) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

/**
 * A token of the shape this file mints, and therefore safe to build a path or
 * a URL out of. Every token in a document comes from randomToken() and a
 * restored backup has its own stripped, so this should never reject one — but
 * a share token names a file, and the check that it cannot name a different
 * file belongs where the path is built, not in the history of how it got here.
 */
const isToken = (value) => /^[a-z0-9]{6,64}$/i.test(String(value ?? ''));

/** The public URL for an already-shared document, or null. */
export function shareUrl(settings, doc) {
  if (isPrivate || !settings.share?.subdomain || !isToken(doc.shareToken)) return null;
  return `https://${settings.share.subdomain}.puter.site/${doc.shareToken}.html`;
}

/**
 * One piece of share work at a time per document. A publish is several
 * writes over several seconds (every attachment is re-copied), and a
 * refresh is fired without being awaited from every action that changes
 * what a client must see — so "Stop sharing" or Delete could land in the
 * middle of one. The takedown won, the toast said "No longer shared", and
 * then the refresh's remaining writes put the page and its files back —
 * under a token the document no longer carried, so nothing could ever take
 * them down again. Queued per document, the takedown simply runs after the
 * refresh it interrupted, and a refresh queued behind a takedown finds no
 * token and does nothing.
 */
const inFlight = new Map();
function withDoc(docId, fn) {
  const prev = inFlight.get(docId) || Promise.resolve();
  const mine = prev.then(fn, fn);
  const settled = mine.catch(() => {});
  inFlight.set(docId, settled);
  settled.then(() => {
    if (inFlight.get(docId) === settled) inFlight.delete(docId);
  });
  return mine;
}

/**
 * Publish (or refresh) the share page for a document and return its URL.
 * Creates the per-account subdomain on first use.
 *
 * Works from the document as the store holds it now, not as the caller saw
 * it: the caller's copy is from before the awaits it took to get here, and
 * saving it back with a token would write over anything that landed in
 * between (a file attached while a payment's refresh was still copying).
 */
export function publishDoc(store, doc, payLink) {
  if (isPrivate) return Promise.reject(new Error('Public sharing is disabled in private storage. Download a PDF instead.'));
  return withDoc(doc.id, () => publishNow(store, doc.id, payLink));
}

/** publishDoc's body, for callers already holding the document's turn. */
async function publishNow(store, docId, payLink) {
  const live = store.doc(docId);
  if (!live) throw new Error('That document is no longer here.');
  const token = isToken(live.shareToken) ? live.shareToken : randomToken();
  const minted = live.shareToken !== token;
  const client = store.client(live.clientId);
  try {
    // Copies of whatever rides along, beside the page: a share page fetches
    // nothing to render, so a link on it has to point at a file that is
    // already published. Only when the document says so — attachments are not
    // published by default, because a timesheet is not the invoice.
    const files = await publishAttachments(live, token);
    // Loaded on demand: the page template carries the paper stylesheet and the
    // whole PDF writer as source, none of which belongs in the app's first load.
    const { sharePageHTML } = await import('./share-page.js');
    const html = await sharePageHTML(live, client, store.settings, payLink, { files });
    await puter.fs.write(`${SHARE_DIR}/${token}.html`, html, { createMissingParents: true });
    await recordShare(store, live, token);
  } catch (err) {
    // Whatever went up under a token the document does not carry can never
    // be taken down again: the "Public link / Stop sharing" card keys off
    // the token. So a failure anywhere in a first publish removes what it
    // put there — the page, and the folder of attachment copies written
    // before it, which used to stay readable at their URLs with no record
    // anywhere that could retire them. A failed refresh of an already-shared
    // page leaves it up: that page is the user's, and was theirs before.
    if (minted) {
      await puter.fs.delete(`${SHARE_DIR}/${token}`, { recursive: true }).catch(() => {});
      await puter.fs.delete(`${SHARE_DIR}/${token}.html`).catch(() => {});
    }
    throw err;
  }
  return `https://${store.settings.share.subdomain}.puter.site/${token}.html`;
}

/**
 * Copy this document's attachments into the published folder and describe
 * the links to them, or clear the folder out when it carries none.
 *
 * The folder is emptied first, every time: it is how a file removed from the
 * document stops being reachable at a URL somebody may have kept. Copies
 * that cannot be written are simply not linked — a published page that is
 * missing a file is better than a publish that fails outright.
 */
async function publishAttachments(doc, token) {
  const dir = `${SHARE_DIR}/${token}`;
  await removePublishedAttachments(token);
  const list = doc.shareAttachments ? (doc.attachments || []) : [];
  if (!list.length) return [];
  const files = [];
  for (const entry of list) {
    // Only a file from the document's own folder goes public: a record with
    // any other path (a restored backup can carry one) names something this
    // page has no business copying out of the account.
    if (!ownsAttachmentPath(doc.id, entry.path)) continue;
    const name = safeFileName(entry.name);
    const at = `${dir}/${String(entry.id).replace(/[^a-z0-9]/gi, '')}-${name}`;
    try {
      const blob = await puter.fs.read(entry.path);
      await puter.fs.write(at, blob, { createMissingParents: true });
      // The href is a URL, and these names carry spaces and the occasional
      // ampersand: encode each segment, never the slash between them.
      const href = at.slice(SHARE_DIR.length + 1).split('/').map(encodeURIComponent).join('/');
      files.push({ name, size: entry.size, href });
    } catch (err) {
      // A missing source file is not a reason to refuse the whole publish.
      if (!isMissingFileError(err)) console.error(err);
    }
  }
  return files;
}

/** An absent folder is already private; a failed deletion still needs a retry. */
async function removePublishedAttachments(token) {
  try {
    await puter.fs.delete(`${SHARE_DIR}/${token}`, { recursive: true });
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
  }
}

/** The bookkeeping half of a publish: the subdomain, then the token. */
async function recordShare(store, doc, token) {
  if (!store.settings.share?.subdomain) {
    // A blank index shields the site root: without one, a host could fall
    // back to listing the directory, exposing every share token.
    await puter.fs.write(`${SHARE_DIR}/index.html`,
      '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="robots" content="noindex, nofollow"><title>Nothing here</title></head>'
      + '<body style="font-family:system-ui;color:#5b5e66;display:grid;place-items:center;min-height:100vh;margin:0">'
      + '<p>Nothing to see here.</p></body></html>',
      { createMissingParents: true }).catch(() => {});
    let subdomain = `inv-${randomToken(10)}`;
    try {
      await puter.hosting.create(subdomain, SHARE_DIR);
    } catch {
      // One retry with a fresh name in case of a collision.
      subdomain = `inv-${randomToken(12)}`;
      await puter.hosting.create(subdomain, SHARE_DIR);
    }
    await store.updateSettings({ share: { subdomain } });
  }

  if (doc.shareToken !== token) {
    // Re-read: the subdomain step above is a save of its own, and the
    // caller's copy predates it and everything else that landed meanwhile.
    // A document that is no longer live — deleted while the page was going
    // up — is not written back from the caller's copy: doc() is live-only,
    // and saving the pre-delete snapshot lifted the document out of the
    // trash with a public page nothing had recorded. Failing here instead
    // lets publishNow take the freshly written page back down.
    const fresh = store.doc(doc.id);
    if (!fresh) throw new Error('That document is no longer here.');
    await store.saveDoc({ ...fresh, shareToken: token });
  }
}

/**
 * Refresh the public page of an already-shared document; a no-op for
 * unshared ones. Payments, edits, and voiding change what a client must see
 * (balance, paid rows, whether a pay link belongs there at all), so every
 * mutation of a shared document routes through here to keep the page
 * truthful.
 */
export async function republishIfShared(store, docId) {
  if (isPrivate) return;
  // Decided inside the queue, from the document as it stands when this
  // refresh's turn comes: a takedown ahead of it has removed the token.
  await withDoc(docId, async () => {
    const doc = store.doc(docId);
    if (!doc?.shareToken) return;
    await publishNow(store, docId, docPayLink(store.settings, doc));
  });
}

/**
 * Remove the public page for a document. A failed deletion must propagate:
 * reporting "no longer shared" while the page is still live (and about to
 * become unreachable once the token is dropped) would be a false privacy
 * assurance. An already-missing file is fine, that is the desired state.
 */
export async function unpublishDoc(store, doc) {
  if (isPrivate) throw new Error('Private storage cannot remove a page previously published on Puter.');
  await withDoc(doc.id, async () => {
    const live = store.doc(doc.id) || doc;
    const token = live.shareToken;
    if (!token) return;
    if (isToken(token)) {
      // The published copies of its attachments go with the page: leaving them
      // behind would keep files reachable at a URL after "no longer shared".
      await removePublishedAttachments(token);
      try {
        await puter.fs.delete(`${SHARE_DIR}/${token}.html`);
      } catch (err) {
        if (!isMissingFileError(err)) throw err;
      }
    }
    // Saved from the document as it stands after the deletes above, not
    // from the caller's copy: anything that landed on it meanwhile stays.
    // A document deleted meanwhile is left in the trash: the page is gone,
    // and saving the caller's live copy would bring the document back.
    const current = store.doc(doc.id);
    if (!current) return;
    const next = { ...current };
    delete next.shareToken;
    await store.saveDoc(next);
  });
}
