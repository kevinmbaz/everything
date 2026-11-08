/**
 * Sending a document straight from the app — the calling side of
 * src/workers/email-worker.js.
 *
 * The app has no server, so for a long time "send" meant composing the message
 * in the user's own mail client (`mailto:`) or handing them the text to paste.
 * That still works and is still offered; what it could never do is carry the
 * invoice PDF, or tell the user whether anything actually left.
 *
 * This module posts the finished message to the app's one shared email worker
 * through `puter.workers.exec()`, which forwards the signed-in user's Puter
 * token. That is what lets the worker send at all, and what makes each send
 * billed to and rate-limited as the person who pressed the button rather than
 * the app owner. Nothing here composes wording: the message is exactly what the
 * user read on the compose sheet (src/ui/compose.js), built from their own
 * templates (src/lib/message.js).
 */

import { isPrivate } from './storage.js';

/** The one shared, app-owned worker (see src/workers/email-worker.js). */
export const EMAIL_WORKER_URL = 'https://invoicing-email.puter.work';

/** What the worker accepts in one request; the sheet holds itself to these. */
export const MAX_RECIPIENTS = 5;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
/**
 * The worker cuts a subject or a body past these to length rather than
 * refusing it, so a message over them would go out shortened while the app
 * recorded the whole of it as delivered. The sheet refuses first, naming the
 * limit; a test keeps both numbers equal to the worker's own.
 */
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 20_000;

const puterOf = () => (!isPrivate && typeof puter !== 'undefined' ? puter : null);

/**
 * Whether this device can send at all. Sending needs the worker bridge — it is
 * what carries the user's session — so without it there is no authenticated
 * caller and the worker would refuse anyway. False on an old SDK, and false
 * offline, where `mailto:` and Copy are still perfectly good answers.
 */
export function mailerAvailable(getPuter = puterOf) {
  const p = getPuter();
  return Boolean(p && p.workers && typeof p.workers.exec === 'function');
}

/**
 * A short, SYNCHRONOUS digest of one recipient's message. Deliberately not
 * SHA-256: it is computed while assembling a request, and crypto.subtle is
 * async. This is a change detector, not a secret — the worker compares it only
 * against the digest it last sent to the same address for the same document,
 * and the cost of the (vanishingly unlikely) collision is one message that is
 * skipped as a duplicate, which "Send anyway" covers.
 */
export function digest(parts) {
  const text = JSON.stringify(parts);
  // 64-bit FNV-1a, carried in two 32-bit halves (JS bitwise ops are 32-bit).
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Everything one recipient will see, as a digest. Attachments count by name and
 * size rather than by content: re-rendering the same invoice produces bytes
 * that differ in nothing a client would notice, and hashing megabytes to learn
 * that would be waste.
 */
export function sendVersion({ to = '', subject = '', body = '', attachments = [] } = {}) {
  return digest([
    String(to).trim().toLowerCase(),
    subject,
    body,
    (attachments || []).map((a) => [a.filename, (a.content || '').length]),
  ]);
}

/** Base64 for a Blob, a Uint8Array, or an ArrayBuffer — what an attachment is. */
export async function base64Of(data) {
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on
  // anything bigger than a page or two of PDF.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Send one document's message to its recipients.
 *
 *   sendDocument({ doc, settings, recipients, subject, body, link, payLink,
 *                  attachments, force })
 *
 * `recipients` is a list of { email, name }; each gets its own private message,
 * so a copy to a second contact never discloses the other address. Resolves to
 * the worker's summary ({ sent, skipped, failed, suppressed, results }) and
 * rejects with a message fit for a toast.
 */
/**
 * How long one send may take before the sheet gives up waiting: six megabytes
 * of attachments on a slow uplink is a couple of minutes, and the worker's
 * hand-off to the transport comes after that.
 */
export const SEND_TIMEOUT_MS = 180_000;
class SendTimeout extends Error {}

export async function sendDocument({
  doc,
  settings = {},
  recipients = [],
  subject = '',
  body = '',
  link = '',
  payLink = '',
  attachments = [],
  force = false,
} = {}, { getPuter = puterOf, workerUrl = EMAIL_WORKER_URL, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  if (!mailerAvailable(getPuter)) throw new Error('Sending needs the Puter SDK. Use your mail app instead.');

  const list = [];
  const seen = new Set();
  for (const r of recipients) {
    const email = String((r && r.email) || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    list.push({
      email,
      name: String((r && r.name) || ''),
      version: sendVersion({ to: email, subject, body, attachments }),
    });
    if (list.length >= MAX_RECIPIENTS) break;
  }
  if (!list.length) throw new Error('There is nobody to send this to.');

  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document: {
        id: doc.id,
        number: doc.number || '',
        kind: doc.kind === 'quote' ? 'quote' : 'invoice',
        businessName: settings?.business?.name || '',
        businessEmail: settings?.business?.email || '',
        viewUrl: link || '',
        payUrl: payLink || '',
      },
      recipients: list,
      subject,
      body,
      attachments,
      force,
    }),
  };
  // A worker that cannot be reached at all — the device dropped off the
  // network mid-send, or nobody has deployed one — makes the bridge itself
  // reject, and the SDK's own words for that ("Failed to fetch") are not
  // something to put in front of the user. Every other path below already
  // answers in a sentence they can act on; this one has to as well.
  // Bounded: a request the browser never settles (a connection that drops
  // without an error) left the sheet's three exits faded and refusing in
  // silence for as long as the tab stayed open. The worker's own dedupe is
  // the safety net for a send that did go out after all — pressing Send
  // again is answered with "they already have this".
  let res = null;
  let timer = null;
  try {
    res = await Promise.race([
      getPuter().workers.exec(`${workerUrl}/send`, request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SendTimeout()), timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof SendTimeout) {
      throw new Error('The email service did not answer in time. It may still go out: if you send it again and they already have it, you will be told so.');
    }
    console.error(err);
    throw new Error('Could not reach the email service. Check your connection, or use your mail app instead.');
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) throw new Error(failureMessage(res.status, data));
  return data;
}

/**
 * Whether one address was actually reached, read from the worker's
 * per-recipient results. The tally counts every recipient alike, and with
 * "Send me a copy" ticked the one that went can be the sender's own — a reply
 * of `sent: 1` then says nothing about the client. Reached means the message
 * went ('sent') or they had this exact one already ('already_sent'). A reply
 * with no per-recipient results (an older worker) can only fall back to the
 * tally, and an address the worker did not answer for at all was not reached.
 */
export function recipientOutcome(out, email) {
  const results = Array.isArray(out && out.results) ? out.results : [];
  const wanted = String(email || '').trim().toLowerCase();
  if (!results.length) return { reached: ((out && out.sent) || 0) > 0, status: 'unknown', reason: '' };
  const r = results.find((x) => x && String(x.email || '').trim().toLowerCase() === wanted);
  if (!r) return { reached: false, status: 'missing', reason: '' };
  const reached = r.status === 'sent' || (r.status === 'skipped' && r.reason === 'already_sent');
  return { reached, status: r.status, reason: r.reason || '' };
}

/** What to say about an address that was not reached while another was. */
export function describeUnreached(email, outcome, { copySent = false } = {}) {
  let why = `Could not deliver to ${email}.`;
  if (outcome.status === 'suppressed') why = `${email} has opted out of these emails.`;
  else if (outcome.status === 'skipped' && outcome.reason === 'daily_limit') why = `${email} was held back by today's email limit.`;
  return copySent ? `${why} Your copy was sent.` : why;
}

/** Why a send did not happen, in words the user can act on. */
export function failureMessage(status, data) {
  const code = (data && data.error) || '';
  if (status === 401 || code === 'sign_in_required') return 'Sign in to Puter again to send email.';
  if (status === 429 || code === 'daily_limit') return "You've reached today's email limit. Try again tomorrow.";
  // The worker could not read its own books (the daily counter), so it sent
  // nothing rather than guess. Transient, and nothing to change on this end.
  if (status === 503 || code === 'temporarily_unavailable') return 'The email service is busy right now. Try again in a moment, or use your mail app instead.';
  // Too many, too large, or unreadable — the sheet holds itself to the first
  // two, so reaching this means something the app could not see coming.
  if (code === 'attachments_invalid') return 'Those files could not be emailed. Send fewer, or share them on the linked page instead.';
  if (status === 404) return 'The email service is unavailable right now. Use your mail app instead.';
  return 'Could not send the email. Please try again.';
}

/**
 * What to tell the user about a send. `resend` is true when nothing went out
 * because the worker had already sent this exact message — the honest answer is
 * "they already have it", and the sheet then offers to send it anyway.
 *
 * The addresses come from the worker's per-recipient results, never from the
 * list that was asked for: a send where the client was skipped as a duplicate
 * and only the sender's own copy went out must not report the client as
 * emailed. `recipients` is the fallback for a reply that carries no results.
 */
export function describeSendResult(out, { recipients = [] } = {}) {
  const results = Array.isArray(out && out.results) ? out.results : [];
  const sent = (out && out.sent) || 0;
  const failed = (out && out.failed) || 0;
  const optedOut = (out && out.suppressed) || 0;
  const held = results.filter((r) => r && r.status === 'skipped');
  const already = held.filter((r) => r.reason === 'already_sent').length;
  const capped = held.filter((r) => r.reason === 'daily_limit').length;
  const delivered = results.filter((r) => r && r.status === 'sent').map((r) => r.email);
  const to = results.length ? delivered[0] || '' : recipients[0] || '';
  if (failed) {
    return {
      icon: 'alert',
      message: sent ? `Sent to ${sent}, but ${failed} could not be delivered.` : 'That email could not be delivered.',
      resend: false,
    };
  }
  if (optedOut) {
    // Not a failure to retry: they unsubscribed from this sender's mail, and
    // no amount of pressing Send will reach them.
    return {
      icon: 'ban',
      message: sent
        ? `Sent to ${sent}. ${optedOut} address${optedOut === 1 ? ' has' : 'es have'} opted out of these emails.`
        : `${optedOut === 1 ? 'That address has' : 'Those addresses have'} opted out of these emails.`,
      resend: false,
    };
  }
  if (sent) {
    // Some went, some did not. Saying only "emailed" would leave the user
    // believing an address was reached that the worker never spent a send on.
    const rest = [
      already ? `${already === 1 ? 'One address' : `${already} addresses`} already had it.` : '',
      capped ? `${capped === 1 ? 'One was' : `${capped} were`} held back by today's email limit.` : '',
    ].filter(Boolean).join(' ');
    const named = sent === 1 && to ? `Emailed to ${to}` : `Emailed to ${sent} recipients`;
    return { icon: 'send', message: rest ? `${named}. ${rest}` : named, resend: false };
  }
  // Nothing went out, nothing failed, nobody opted out: the worker recognised
  // this exact message as one it had already delivered. A reply with no
  // per-recipient results can only be that case too.
  if (!results.length || already) {
    return { icon: 'check', message: 'They already have this exact email.', resend: true };
  }
  return { icon: 'alert', message: 'Nothing was sent. Please try again.', resend: false };
}
