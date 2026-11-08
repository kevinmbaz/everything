/**
 * Composing the email that carries a document to its client.
 *
 * Three ways out, in the order they are offered: send it from here — the app's
 * shared email worker does the delivery, billed to the user's own Puter account
 * (src/lib/mailer.js) — or hand the finished text to the user's own mail client,
 * or copy it for people who live in webmail. Only the first can carry the
 * invoice as a PDF, and only the first can honestly say it went.
 *
 * One flow serves both "here is your invoice" and "this invoice is overdue".
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { openModal } from './modal.js';
import { field, copyText, refocus } from './bits.js';
import { store, isMissingFileError } from '../lib/store.js';
import { fileSize } from '../lib/util.js';
import { docPayLink } from '../lib/paylink.js';
import { isPrivate } from '../lib/storage.js';
import { publishDoc, unpublishDoc, shareUrl } from '../lib/share.js';
import { buildMessage, mailtoUrl, looksLikeEmail } from '../lib/message.js';
import {
  mailerAvailable, sendDocument, describeSendResult, recipientOutcome, describeUnreached, base64Of,
  MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_SUBJECT_CHARS, MAX_BODY_CHARS, SEND_TIMEOUT_MS,
} from '../lib/mailer.js';

/** A labelled checkbox that carries its own input, for reading back on send. */
function checkRow(label, { checked = false, disabled = false, title = null } = {}) {
  const box = el('input', { type: 'checkbox', checked, disabled });
  const row = el('label.check-row', title ? { title } : {}, box, el('span', {}, label));
  row.input = box;
  return row;
}

/**
 * openCompose(doc, {
 *   templateKey, title, intro, extra,   // which template, and its extra values
 *   onSend,                             // (how: 'send' | 'mail' | 'copy') => Promise|void
 * })
 *
 * Publishes (or refreshes) the share page first, so the message always
 * carries a link that works. A failed publish is reported and the message
 * goes out without the link rather than not at all.
 */
export async function openCompose(doc, {
  templateKey = null,
  title = null,
  intro = null,
  extra = {},
  onSend = null,
} = {}) {
  // Whatever the user pressed to get here. Recording the share token below
  // is a save, so the page underneath re-renders while this waits and that
  // control is gone — with focus — by the time the sheet opens. Handing it
  // to the sheet anyway lets its close find the replacement by name.
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const live = store.doc(doc.id) || doc;
  const client = store.client(live.clientId);
  const payLink = docPayLink(store.settings, live);
  // Whether the page below is this sheet's doing. Publishing before the
  // user sends is what puts a working link in the message — but closing
  // the sheet without sending must take that page back down: the user
  // never chose to share, only to start an email.
  const wasShared = !!live.shareToken;
  let sent = false;
  // A send is in the air, and the sheet has been closed under it. Both bear on
  // whether the page published above may be taken back down; see
  // dropPageIfUnused().
  let sending = false;
  let dismissed = false;

  let link = shareUrl(store.settings, live) || '';
  const origin = location.hash;
  if (!isPrivate) {
    const publishing = toast('Publishing the online copy…', { icon: 'globe', duration: 20000 });
    try {
      link = await publishDoc(store, live, payLink);
    } catch (err) {
      console.error(err);
      toast('Could not publish the online copy. The message goes out without a link', { icon: 'wifiOff' });
    } finally {
      publishing.dismiss();
    }
  }

  // The publish can outlive the page that asked for it. If the user walked
  // away meanwhile, a sheet popping up over some other view (and making it
  // inert) would be the modal sweep's job to prevent — except this modal
  // did not exist yet when the sweep ran. Fold the flow up instead, taking
  // a never-shared page back down exactly as cancelling the sheet would.
  if (location.hash !== origin) {
    dropPageIfUnused();
    return null;
  }

  const message = buildMessage(live, client, store.settings, { link, payLink, templateKey, extra });

  const to = el('input.input', {
    type: 'email', value: client?.email || '',
    autocomplete: 'email', placeholder: 'client@example.com',
  });
  const subject = el('input.input', { value: message.subject });
  const body = el('textarea.textarea.compose-body', { rows: 10, value: message.body });

  const saveToClient = el('button.btn.btn-ghost', {
    type: 'button',
    hidden: !client || !!client.email,
    onclick: async () => {
      const value = to.value.trim();
      if (!looksLikeEmail(value)) {
        toast('That does not look like an email address', { icon: 'alert' });
        return;
      }
      saveToClient.disabled = true;
      try {
        await store.updateClient(client.id, { email: value });
        saveToClient.hidden = true;
        toast(`Saved to ${client.company || client.name}`, { icon: 'check' });
        // Disabling the button shed focus, and hiding it left nothing to give
        // focus back to — on <body>, outside a dialog whose page is inert, so
        // there was no way back in but the mouse. Land on the address it just
        // saved, which is what the button was standing beside.
        refocus(to);
      } catch (err) {
        console.error(err);
        toast('Could not save. Check your connection', { icon: 'wifiOff' });
        saveToClient.disabled = false;
        refocus(saveToClient);
      }
    },
  }, 'Save to client');

  /**
   * Take the page back down, if this sheet is what put it up and nothing has
   * gone out carrying its link. Closing without sending must undo the publish:
   * the user never chose to share, only to start an email.
   *
   * A failed unpublish keeps the token, so the document's page still shows a
   * truthful "Public link" card the user can act on.
   */
  function dropPageIfUnused() {
    if (wasShared || sent) return;
    const fresh = store.doc(live.id);
    if (fresh?.shareToken) unpublishDoc(store, fresh).catch(() => {});
  }

  /* ---- Sending from here ------------------------------------------------ */

  // Delivery needs the worker bridge (it carries the user's Puter session) and
  // a network to reach it. Read-only means this device is offline: the mail
  // app and the clipboard still work, so the sheet keeps them and simply does
  // not offer what it cannot do.
  const canSend = mailerAvailable() && !store.readOnly;
  const files = live.attachments || [];
  const selfEmail = looksLikeEmail(store.settings.business?.email)
    ? store.settings.business.email.trim() : '';

  // The document itself, as the file a client expects an invoice to arrive as.
  // A `mailto:` cannot carry one, which is the single biggest thing sending
  // from here adds — so it is on by default.
  const pdfCheck = checkRow('Attach the document as a PDF', { checked: true });
  // A document's own files are opt-in: a signed estimate or a timesheet is
  // kept beside the invoice for the user's sake, and is not automatically the
  // client's business.
  const fileChecks = files.map((entry) => {
    // Nothing the worker would reject can be armed in the first place.
    const tooBig = (Number(entry.size) || 0) > MAX_ATTACHMENT_BYTES;
    const row = checkRow(`${entry.name} (${fileSize(entry.size)})`, {
      title: entry.name,
      disabled: tooBig,
    });
    if (tooBig) row.classList.add('is-off');
    return { entry, row, tooBig };
  });
  // Not an attachment but a second recipient, so it sits with the address it
  // adds to rather than in the Attach group below — and it goes out as its own
  // private message, never a Cc (see sendNow).
  const copyMe = selfEmail
    ? checkRow(`Send me a copy (${selfEmail})`, { checked: false })
    : null;

  // A document may carry more files than one email will take (the store allows
  // twenty, the worker takes ten counting the PDF). Rather than let the user
  // tick an eleventh and have the send come back refused, the boxes that would
  // not fit go quiet as the last slot is filled, and the hint says why.
  const capHint = el('p.field-hint.compose-attach-cap', { hidden: true },
    `An email carries ${MAX_ATTACHMENTS} files at most. Untick one to choose another.`);

  function enforceAttachmentCap() {
    const chosen = (pdfCheck.input.checked ? 1 : 0)
      + fileChecks.filter(({ row }) => row.input.checked).length;
    const full = chosen >= MAX_ATTACHMENTS;
    const close = (row) => {
      row.input.disabled = full && !row.input.checked;
      row.classList.toggle('is-off', row.input.disabled);
    };
    // An oversized file was never selectable; it is already closed off.
    for (const { row, tooBig } of fileChecks) if (!tooBig) close(row);
    close(pdfCheck);
    capHint.hidden = !full;
  }

  // Set only when the worker reports this exact message as already sent, and
  // cleared the moment anything about the message changes. The button holding
  // that decision is built below, once sendNow() exists to be wired to it.
  let forceNext = false;
  const sendLabel = el('span', {}, ' Send email');

  /** Anything that changes what would go out puts "Send it again" back. */
  function messageChanged() {
    if (!forceNext) return;
    forceNext = false;
    sendLabel.textContent = ' Send email';
  }

  /**
   * The files this send carries, as base64: the PDF when `pdf` is set, and the
   * `files` chosen. Both are handed in rather than read off the boxes here,
   * because the reads would land after the awaits below (see sendNow). Throws
   * when they add up to more than the worker will take — better here, naming
   * the limit, than as a 400 from the other end.
   */
  async function collectAttachments({ pdf: withPdf, files: chosen }) {
    const out = [];
    let bytes = 0;
    if (withPdf) {
      const [pdf, spec] = await Promise.all([
        import('../lib/pdf.js'),
        import('../lib/pdf-spec.js'),
      ]);
      const built = spec.docSpec(live, client, store.settings, { payLink });
      const data = await pdf.renderPdf(built);
      bytes += data.length;
      out.push({
        filename: pdf.pdfFilename(built),
        contentType: 'application/pdf',
        content: await base64Of(data),
      });
    }
    for (const entry of chosen) {
      // A record outlives its file whenever the cloud copy is deleted from
      // under it — and the SDK's own words for that are an internal path the
      // user has never seen ("No such file: invoicing-data/attachments/…").
      // Name the file they ticked, and the way past it.
      let blob = null;
      try {
        blob = await store.readAttachment(entry);
      } catch (err) {
        console.error(err);
        throw new Error(
          `“${entry.name}” ${isMissingFileError(err) ? 'is no longer in your cloud' : 'could not be read'}, `
          + 'so it cannot be attached. Untick it to send the message without it.',
        );
      }
      bytes += blob.size;
      out.push({
        filename: entry.name,
        contentType: entry.type || blob.type || 'application/octet-stream',
        content: await base64Of(blob),
      });
    }
    if (out.length > MAX_ATTACHMENTS) {
      throw new Error(
        `An email carries ${MAX_ATTACHMENTS} files at most; this one has ${out.length}. `
        + 'Send fewer, or share them on the linked page instead.',
      );
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Those files come to ${fileSize(bytes)}; ${fileSize(MAX_ATTACHMENT_BYTES)} is the most an email can carry here. `
        + 'Send fewer, or share them on the linked page instead.',
      );
    }
    return out;
  }

  /**
   * The three ways out of this sheet are one decision, so while a send is in
   * the air none of them may be taken again — a second exit would close the
   * sheet under the send, mark the document twice, and note the reminder
   * twice. Marked with aria-disabled rather than the disabled property: that
   * property blurs the button it is set on, and a keyboard user would be
   * standing on <body> for the length of the send (see .btn[aria-disabled]).
   */
  function setBusy(on) {
    sending = on;
    for (const control of [sendBtn, mailBtn, copyBtn]) {
      if (!control) continue;
      if (on) control.setAttribute('aria-disabled', 'true');
      else control.removeAttribute('aria-disabled');
    }
  }

  /**
   * Deliver it. The sheet closes only once something has actually gone out;
   * every failure — a refusal, an address that could not be reached, a reply
   * in which nothing was sent — leaves it open, with the mail app and the
   * clipboard still sitting there as the way out.
   */
  async function sendNow({ force = false } = {}) {
    if (sending) return;
    const address = to.value.trim();
    if (!looksLikeEmail(address)) {
      toast('Add an email address to send to', { icon: 'alert' });
      to.focus();
      return;
    }
    // The worker refuses an empty body, and the 400 it answers with reads as
    // "could not send, try again" — a dead end, because trying again with the
    // same blank message never works. Say what is missing instead, and land
    // on the box that is missing it. (Reachable: the templates in Settings
    // always fill something in, but this one is editable right here.)
    if (!body.value.trim()) {
      toast('Write a message to send, or copy the subject and send it from your mail app', { icon: 'alert' });
      body.focus();
      return;
    }
    // A blank subject went out under the worker's stand-in ("Invoice
    // INV-0042") while the Delivered card recorded no subject at all — the
    // line that tells the invoice from the reminder that chased it. Settings
    // refuses a blank template subject; this box is refused the same way.
    if (!subject.value.trim()) {
      toast('Add a subject to send', { icon: 'alert' });
      subject.focus();
      return;
    }
    // The worker cuts a subject or a body past its caps to length and sends
    // the rest, so a message over them went out ending mid-sentence while
    // the Delivered card recorded the whole of it. Refused here instead,
    // naming the limit and the box that is over it — the same way the files
    // are held to what one email carries.
    const over = (value, cap) => value.length > cap;
    if (over(subject.value, MAX_SUBJECT_CHARS)) {
      toast(`The subject can be ${MAX_SUBJECT_CHARS} characters at most; this one is ${subject.value.length.toLocaleString()}.`, { icon: 'alert' });
      subject.focus();
      return;
    }
    if (over(body.value, MAX_BODY_CHARS)) {
      toast(`The message can be ${MAX_BODY_CHARS.toLocaleString()} characters at most; this one is ${body.value.length.toLocaleString()}. `
        + 'Shorten it, or put the rest on the linked page.', { icon: 'alert' });
      body.focus();
      return;
    }
    // The wording as it stands at the press, not as it stands when the reply
    // comes back: the fields stay editable while a send is in the air (they
    // are only aria-disabled, so nothing steals focus mid-send), and typing
    // into the subject during those seconds would otherwise write a line into
    // the document's Delivered card that no recipient ever received.
    const outgoing = { subject: subject.value, body: body.value };
    // The boxes get the same treatment. Rendering the PDF and reading each
    // file out of the cloud take seconds, and the boxes stay live meanwhile:
    // read afterwards, a file ticked (or the copy to yourself unticked) during
    // that wait quietly changed *this* send, not the next one — while the
    // label had already gone back to "Send email" for a message that was
    // still being assembled from the old choices.
    const carry = {
      pdf: pdfCheck.input.checked,
      files: fileChecks.filter(({ row }) => row.input.checked).map(({ entry }) => entry),
      copy: !!copyMe?.input.checked,
    };
    setBusy(true);
    // Shown until the send settles (both outcomes dismiss it); the bound is
    // the mailer's own timeout, after which the catch below speaks instead.
    const pending = toast('Sending…', { icon: 'send', duration: SEND_TIMEOUT_MS + 5000 });
    try {
      const attachments = await collectAttachments(carry);
      const recipients = [{ email: address, name: client?.company || client?.name || '' }];
      // The sender's copy is its own private message, never a Cc: the client
      // has no business reading the sender's address list.
      if (carry.copy && selfEmail && selfEmail.toLowerCase() !== address.toLowerCase()) {
        recipients.push({ email: selfEmail, name: store.settings.business?.name || '' });
      }
      const out = await sendDocument({
        doc: live,
        settings: store.settings,
        recipients,
        subject: outgoing.subject,
        body: outgoing.body,
        link,
        payLink,
        attachments,
        force,
      });
      pending.dismiss();
      const result = describeSendResult(out, { recipients: recipients.map((r) => r.email) });
      // Nothing went out because the worker had already sent this exact
      // message — from another device, or from a press whose reply was lost.
      // Say so and stay open, with the decision to send it anyway carried by
      // this button rather than by the toast: a toast raised over an open
      // dialog is inert (see openModal), so an action on it could never be
      // pressed. Editing anything below puts the label back — a changed
      // message is not a duplicate and needs no permission.
      if (result.resend && !force) {
        forceNext = true;
        sendLabel.textContent = ' Send it again';
        setBusy(false);
        // Closed while this was in the air, and nothing went out: finish the
        // takedown that close deferred.
        if (dismissed) {
          dropPageIfUnused();
        } else {
          refocus(sendBtn);
          toast(`${result.message} Press Send it again to send it anyway.`, { icon: result.icon });
        }
        return;
      }
      // A reply the worker did not refuse, but in which nothing went out: the
      // address failed, or has opted out, or was held by today's limit. The
      // worker answers per recipient, so that is a 200 with `sent: 0` — and it
      // used to fall through to the success path below, which marked the
      // draft as sent, noted a reminder as given, and kept the page this sheet
      // published for a message nobody received. Nothing was delivered, so
      // nothing may be recorded as delivered: the sheet stays open, with the
      // mail app and the clipboard still on it, exactly as it does when the
      // worker refuses outright.
      if (!out.sent) {
        setBusy(false);
        toast(result.message, { icon: result.icon });
        if (dismissed) dropPageIfUnused();
        else refocus(sendBtn);
        return;
      }
      // The document's own record of what actually left, which is a thing
      // only a real send can know. Awaited, not fired off: onSend below
      // writes to the same document (a draft becomes sent), and two writes
      // racing from the same base would drop whichever landed first. A
      // failure here must not read as a failure to send, though — the email
      // is gone either way.
      const recordDelivered = async () => {
        try {
          await store.recordEmail(live.id, {
            to: (out.results || []).filter((r) => r.status === 'sent').map((r) => r.email),
            subject: outgoing.subject,
            attachments: attachments.length,
          });
        } catch (err) {
          console.error(err);
        }
      };
      // `sent` counts every recipient alike, and with the copy to yourself
      // ticked the one that went can be your own: the client's address
      // bounced, or has opted out, or was held by today's limit, and the
      // tally still read sent: 1 — which used to fall through to the path
      // below and mark the draft as sent, note a reminder as given, and keep
      // the page, for a message the client never received. The copy did go,
      // so it is recorded; nothing else is, and the sheet stays open saying
      // which address was not reached.
      const outcome = recipientOutcome(out, address);
      // The client already had this exact message and only the copy to
      // yourself went: the same duplicate as above, with a tally of one. It
      // used to take the success path — close the sheet, note a second
      // reminder as given, mark the draft sent — for a message the client
      // was not sent again. The copy did go, so it is recorded; the sheet
      // stays open with the decision on the button, as without the copy.
      if (outcome.status === 'skipped' && outcome.reason === 'already_sent' && !force) {
        await recordDelivered();
        forceNext = true;
        sendLabel.textContent = ' Send it again';
        setBusy(false);
        if (dismissed) {
          dropPageIfUnused();
        } else {
          refocus(sendBtn);
          toast(`${address} already has this exact email; your copy was sent. Press Send it again to send it anyway.`, { icon: 'check' });
        }
        return;
      }
      if (!outcome.reached) {
        await recordDelivered();
        setBusy(false);
        toast(describeUnreached(address, outcome, { copySent: true }), {
          icon: outcome.status === 'suppressed' ? 'ban' : 'alert',
        });
        if (dismissed) dropPageIfUnused();
        else refocus(sendBtn);
        return;
      }
      toast(result.message, { icon: result.icon });
      await recordDelivered();
      sent = true;
      setBusy(false);
      modal.close();
      await onSend?.('send');
    } catch (err) {
      setBusy(false);
      pending.dismiss();
      console.error(err);
      toast(err.message || 'Could not send the email. Please try again.', { icon: 'alert' });
      // Nothing left, so the page this sheet published is owed the takedown
      // its close could not do while the send was still open.
      if (dismissed) dropPageIfUnused();
      else refocus(sendBtn);
    }
  }

  const sendBtn = canSend
    ? el('button.btn.btn-primary', {
      type: 'button',
      html: icon('send', 15, 1.6),
      onclick: () => sendNow({ force: forceNext }),
    }, sendLabel)
    : null;

  const mailBtn = el(`a.btn${sendBtn ? '' : '.btn-primary'}`, {
    href: mailtoUrl({ to: to.value, subject: message.subject, body: message.body }),
    target: '_blank', rel: 'noopener',
    html: icon('mail', 15, 1.6),
    onclick: async (e) => {
      if (sending) {
        e.preventDefault();
        return;
      }
      if (!to.value.trim()) {
        e.preventDefault();
        toast('Add an email address, or copy the message instead', { icon: 'alert' });
        to.focus();
        return;
      }
      sent = true;
      modal.close();
      await onSend?.('mail');
    },
  }, ' Open email app');

  // Keep the link in step with edits, so what the mail client receives is
  // what is on screen.
  const syncHref = () => {
    mailBtn.href = mailtoUrl({ to: to.value, subject: subject.value, body: body.value });
    messageChanged();
  };
  for (const input of [to, subject, body]) input.addEventListener('input', syncHref);
  // Ticking a file changes the message too, as far as "already sent" goes.
  for (const row of [pdfCheck, copyMe, ...fileChecks.map((f) => f.row)]) {
    row?.input.addEventListener('change', messageChanged);
  }
  for (const row of [pdfCheck, ...fileChecks.map((f) => f.row)]) {
    row.input.addEventListener('change', enforceAttachmentCap);
  }

  const copyBtn = el('button.btn', {
    type: 'button',
    html: icon('copy', 15, 1.6),
    onclick: async () => {
      if (sending) return;
      if (await copyText(body.value, 'Message copied')) {
        sent = true;
        modal.close();
        await onSend?.('copy');
      }
    },
  }, ' Copy message');

  // What rides along. Only the sending path can carry a file, so the choices
  // appear only when there is something to make them about; the note below
  // covers the mail-app path, where attaching is still by hand.
  const attachBox = canSend
    ? field('Attach', el('div.compose-attach', {},
      pdfCheck,
      ...fileChecks.map(({ entry, row }) => (
        (Number(entry.size) || 0) > MAX_ATTACHMENT_BYTES
          ? el('div.compose-attach-over', {}, row,
            el('span.field-hint', {}, `too large to email — ${fileSize(MAX_ATTACHMENT_BYTES)} max`))
          : row
      )),
      capHint), { group: true })
    : null;

  const modal = openModal({
    title: title || `Email ${live.number}`,
    opener,
    onClose: () => {
      dismissed = true;
      // Escape, the scrim, and navigation (which sweeps every open dialog)
      // can all land here mid-send — and that send is carrying this link into
      // someone's inbox. Taking the page down now would deliver a dead one,
      // so the decision waits for sendNow, which knows whether anything went.
      if (sending) return;
      dropPageIfUnused();
    },
    content: el('div', {},
      intro && el('p.compose-intro', {}, intro),
      // The self-copy rides under the address it adds to, inside the same
      // field: it is a second recipient, and a group labelled "Attach"
      // announcing it called a recipient an attachment. field() still puts
      // the label's `for` on the first input in here, which is the address.
      field('To', el('div.compose-to', {},
        el('div.compose-row', {}, to, saveToClient),
        canSend ? copyMe : null)),
      field('Subject', el('div.compose-row', {}, subject,
        el('button.icon-btn', {
          type: 'button', html: icon('copy', 16, 1.6),
          'aria-label': 'Copy subject', title: 'Copy subject',
          onclick: () => copyText(subject.value, 'Subject copied'),
        }))),
      field('Message', body, { hint: 'templates live in Settings' }),
      attachBox,
      // The note is a flex row (icon, then words), and its text needs a box
      // of its own: a bare text node becomes an anonymous flex item, which
      // cannot shrink below its longest word — so a long filename below
      // stretched the whole sheet past the edge of the screen. .grow is the
      // box, and it is allowed to give way.
      el('p.compose-note', {},
        el('span.compose-note-ic', { html: icon('globe', 13, 1.6) }),
        el('span.grow', {}, link
          ? 'The link opens an unlisted page of this document. Stop sharing any time from the document itself.'
          : 'No online copy is linked, so attach or paste the document yourself.')),
      // Sending from here attaches the files above. The mail app cannot: a
      // `mailto:` carries no file, so say what the document has and whether
      // the link already offers it.
      !canSend && files.length
        ? el('p.compose-note', {},
          el('span.compose-note-ic', { html: icon('paperclip', 13, 1.6) }),
          el('span.grow', {},
            `${files.map((a) => a.name).join(', ')}`,
            live.shareAttachments && link
              ? ' — already offered on the linked page.'
              : ' — attach these to the message yourself.'))
        : null,
      // "Open email app" hands the text to the mail client, which cannot take
      // a file with it. Said once, here, rather than left to be discovered.
      canSend
        ? el('p.compose-note', {},
          el('span.compose-note-ic', { html: icon('mail', 13, 1.6) }),
          el('span.grow', {},
            'Sending from here delivers it through your own Puter account. '
            + 'Your mail app can take the wording, but not the files.'))
        : null,
      // The two fallbacks travel as one group: at this width the row wraps,
      // and it should break between "send it" and "do it yourself" rather
      // than through the middle of the pair. The primary goes last, where
      // every other dialog in the app puts it.
      el('div.side-actions.compose-actions', {},
        el('div.compose-alt', {}, mailBtn, copyBtn),
        sendBtn)),
  });

  if (!to.value.trim()) to.focus();
  return modal;
}
