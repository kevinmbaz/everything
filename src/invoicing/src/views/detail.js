import { el, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { isPrivate } from '../lib/storage.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { statusChip, field, selectWrap, copyText, emptyState, keepFocus, refocus } from '../ui/bits.js';
import { paperHTML } from '../ui/paper.js';
import {
  store, TRASH_DAYS, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES,
} from '../lib/store.js';
import { uid, fileSize } from '../lib/util.js';
import { docStatus, isWrittenOff, dueDateFor } from '../lib/doc.js';
import { docTotals, fmtMoney, isRefund, refundableTotal, fxRateFor, inBase } from '../lib/money.js';
import { todayISO, fmtDate, freqLabel, isISODate, MIN_DATE, MAX_DATE } from '../lib/dates.js';
import { docPayLink } from '../lib/paylink.js';
import { lateFeePolicy, lateFeeAmount, lateFeeItemName, balanceWithLateFee } from '../lib/latefee.js';
import { overdueAmount } from '../lib/aging.js';
import {
  REMINDER_STAGES, reminderStage, reminderValues, reminderNote, reminders, daysLate, dayCount,
} from '../lib/reminders.js';
import { publishDoc, unpublishDoc, republishIfShared, shareUrl } from '../lib/share.js';
import { openCompose } from '../ui/compose.js';
import { savePdf } from '../ui/pdf-action.js';
import { openReceiptModal } from './receipts.js';

const PAY_METHODS = ['Bank transfer', 'Card', 'Cash', 'PayPal', 'Check', 'Other'];

export function detailView({ navigate, params }) {
  const root = el('div.view');

  // Always the open balance: docPayLink() returns null for a settled invoice
  // (a client following a live link would pay twice) and for a void one (the
  // balance never reached zero, but the money is no longer owed). Quotes
  // carry no payments, so their balance equals their total.
  const currentPayLink = (doc) => docPayLink(store.settings, doc);

  /**
   * Run one store action and report a failure rather than throwing into a
   * click handler. Declared here, not inside render(): the toasts the modals
   * below raise outlive the render that opened them, and an Undo reaching
   * for a helper that only existed inside it threw instead of undoing.
   */
  /**
   * A date field's change handler: the browser's field takes a year of five
   * or six digits, and the app stores four — a payment dated "20260-09-05"
   * would be numbered and reported into a year nothing else reads. The
   * field goes back to today, which is what both sheets open with.
   */
  const pinDate = (e) => {
    if (!e.target.value || isISODate(e.target.value)) return;
    toast('Enter a year between 1000 and 9999', { icon: 'alert' });
    e.target.value = todayISO();
  };

  const act = async (fn, failMsg = 'Could not save. Check your connection') => {
    try {
      await fn();
    } catch (err) {
      console.error(err);
      toast(failMsg, { icon: 'wifiOff' });
    }
  };

  function render() {
    // A change this page did not ask for repaints it too — a recurring
    // invoice drafted at boot, a save from elsewhere settling — and the row
    // of actions is rebuilt under whoever was standing on it.
    const restoreFocus = keepFocus(root);
    clear(root);
    const doc = store.doc(params.id);
    if (!doc) {
      // Reached from a stale link or the Back button, since deleting from
      // here leaves for the list right away. Give it the same heading,
      // explanation, and way out that a missing client's page has, rather
      // than a bare sentence with nowhere to go.
      root.append(
        el('div.page-head', {}, el('div', {},
          el('div.back-row', {},
            el('a.back-link', { href: '#/invoices', html: icon('back', 16, 1.8) }, ' Invoices')),
          el('h1.page-title', {}, 'Document not found'))),
        emptyState('invoice', 'This document no longer exists',
          'It may have been deleted. Nothing else in your records changed.')
      );
      restoreFocus();
      return;
    }
    const today = todayISO();
    const status = docStatus(doc, today);
    const isInvoice = doc.kind === 'invoice';
    const client = store.client(doc.clientId);
    const t = docTotals(doc);
    const backHash = isInvoice ? '#/invoices' : '#/quotes';
    const payLink = currentPayLink(doc);

    const actions = [];
    const extras = [];
    // Every action disables its button until the handler settles: Convert
    // and Duplicate are not idempotent, so a double click would otherwise
    // create two documents. The view re-renders on store changes anyway,
    // which resets the state for still-relevant buttons.
    //
    // What is on the document now goes on the row; the housekeeping (print,
    // share, duplicate, void, delete) moves into More, because a wall of
    // equally loud buttons is harder to read than a short row and a menu.
    // What still works with no connection: reading, printing, and writing a
    // PDF, because the writer is local. Everything else needs the cloud, and
    // is left out rather than offered and then refused.
    const OFFLINE_ACTIONS = new Set(['Download PDF', 'Print']);
    const add = (label, ic, handler, { primary = false, danger = false, secondary = false } = {}) => {
      if (store.readOnly && !OFFLINE_ACTIONS.has(label)) return;
      const run = async (e) => {
        const b = e.currentTarget;
        // Busy is marked with aria-disabled, not the disabled property: the
        // property sheds keyboard focus the moment it is set, so a dialog
        // this action opens (a payment, a compose sheet) finds no opener to
        // capture and closing it dumped the user at the top of the page.
        // The guard below is what actually blocks a second, non-idempotent
        // run; the attribute only says so out loud.
        if (b.getAttribute('aria-disabled') === 'true') return;
        const name = (b.textContent || '').trim();
        b.setAttribute('aria-disabled', 'true');
        try {
          await handler(e);
        } finally {
          if (b.isConnected) b.removeAttribute('aria-disabled');
          // The handler's store change re-rendered the view and destroyed
          // this button, dropping focus to <body>. Land focus on its
          // successor by name — or, when the action made the button
          // obsolete ("Mark as sent"), on the action row.
          else if (document.activeElement === document.body && root.isConnected) {
            const controls = [...root.querySelectorAll('.detail-actions .btn')];
            (controls.find((c) => (c.textContent || '').trim() === name) || controls[0])?.focus();
          }
        }
      };
      if (secondary) {
        extras.push({ label, icon: ic, handler, danger });
        return;
      }
      actions.push(el(`button.btn${primary ? '.btn-primary' : danger ? '.btn-danger' : ''}`, {
        type: 'button',
        html: icon(ic, 16, 1.6),
        onclick: run,
      }, ` ${label}`));
    };

    const openMore = () => {
      // The sheet stays clickable through its closing animation, and its
      // actions carry the same non-idempotence as the row buttons (Duplicate
      // creates a document), so each opening runs at most one action.
      let acted = false;
      const modal = openModal({
        title: 'More actions',
        content: el('div.settings-list', {}, extras.map((item) => el('button.settings-row', {
          type: 'button',
          className: `settings-row${item.danger ? ' danger' : ''}`,
          onclick: async () => {
            if (acted) return;
            acted = true;
            modal.close();
            await item.handler({ currentTarget: { disabled: false } });
          },
        },
          el('span', { html: icon(item.icon, 17, 1.9) }),
          el('div.grow', {}, el('div.title', {}, item.label))))),
      });
    };

    // Emailing is the natural next step for a document nobody has seen yet,
    // and stays available afterwards for a resend.
    if (status !== 'void') {
      add('Send by email', 'mail', () => emailDoc(doc), { primary: status === 'draft' });
    }
    if (status === 'draft') {
      add('Mark as sent', 'send',
        () => act(() => store.setDocStatus(doc.id, 'sent')));
    }
    if (isInvoice && ['sent', 'partial', 'overdue'].includes(status)) {
      add('Record payment', 'handCoins', () => openPaymentModal(doc), { primary: status !== 'draft' });
      add('Send reminder', 'clock', () => remindNow(doc));
    }
    // Money can still turn up on an invoice that was given up on, and
    // recording it is what makes the write-off shrink to what was really
    // lost. Chasing it, though, is over: no reminder, no late fee.
    if (isInvoice && status === 'writtenOff') {
      add('Record payment', 'handCoins', () => openPaymentModal(doc));
      add('Reopen', 'undo', () => act(async () => {
        await store.clearWriteOff(doc.id);
        toast(`${doc.number} is owed again`, { icon: 'undo' });
      }), { primary: true });
    }
    // Money can flow back out of any invoice that took some in.
    if (isInvoice && status !== 'void' && refundableTotal(doc) > 0.005) {
      add('Record refund', 'undo', () => openPaymentModal(doc, { refund: true }), { secondary: true });
    }
    // Applying the disclosed late-fee policy is deliberate, exactly like
    // sending a reminder is — and only an overdue invoice has earned one.
    if (isInvoice && status === 'overdue' && lateFeePolicy(store.settings, client)) {
      add('Add late fee', 'hourglass', () => addLateFee(doc), { secondary: true });
    }
    // A status the paper stamps — accepted, declined, and back to neither —
    // has to reach the page a client may already be holding the link to,
    // exactly as a payment or a void does.
    const setStatusAndRepublish = (next) => act(async () => {
      await store.setDocStatus(doc.id, next);
      republishIfShared(store, doc.id)
        .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
    });
    if (!isInvoice && ['sent', 'expired'].includes(status)) {
      add('Accepted', 'circleCheck', () => setStatusAndRepublish('accepted'), { primary: true });
      add('Declined', 'circleX', () => setStatusAndRepublish('declined'));
    }
    if (!isInvoice && status === 'accepted') {
      add('Convert to invoice', 'arrowR', () => act(async () => {
        const inv = await store.convertQuote(doc.id);
        if (inv) {
          toast(`${inv.number} created from ${doc.number}`);
          // Converting is a status the paper reflects: an accepted estimate
          // loses its Accepted stamp once it has become an invoice, and a
          // client holding the link saw the stamp stay — republished like
          // the other status changes above.
          republishIfShared(store, doc.id)
            .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
          // Only steer a user who is still here: a slow conversion must not
          // yank them off whatever view they moved on to (the editor's
          // save learned this in 973ee67).
          if (root.isConnected) navigate(`#/doc/${inv.id}`);
        }
      }), { primary: true });
    }
    if (!isInvoice && ['accepted', 'declined'].includes(status)) {
      add('Reopen', 'send', () => setStatusAndRepublish('sent'));
    }
    add('Download PDF', 'download', () => savePdf((mods) =>
      mods.docSpec(doc, client, store.settings, { today, payLink })));
    if (status !== 'void') add('Edit', 'pencil', () => navigate(`#/edit/${doc.id}`));
    add('Print', 'printer', () => window.print(), { secondary: true });
    if (payLink && isInvoice && status !== 'void' && status !== 'draft') {
      add('Copy payment link', 'link', () => copyText(payLink, 'Payment link copied'), { secondary: true });
    }
    if (!isPrivate && status !== 'void' && status !== 'draft') {
      add(doc.shareToken ? 'Update share page' : 'Share online', 'share', () => shareNow(doc), { secondary: true });
    }
    add('Duplicate', 'copy', () => act(async () => {
      const copy = await store.duplicateDoc(doc.id);
      if (copy) {
        toast(`${copy.number} created`);
        if (root.isConnected) navigate(`#/doc/${copy.id}`);
      }
    }), { secondary: true });
    // Distinct from Void, and offered wherever money is still expected: the
    // work was done and billed, and this says it will never be paid for.
    if (isInvoice && ['sent', 'partial', 'overdue'].includes(status)) {
      add('Write off', 'ban', () => openWriteOffModal(doc), { secondary: true });
    }
    if (isInvoice && ['sent', 'overdue'].includes(status) && t.paid <= 0.005) {
      add('Void', 'ban', async () => {
        const ok = await confirmDialog({
          title: `Void ${doc.number}?`,
          message: 'A void invoice stays in your records but no longer counts as money owed.',
          confirmLabel: 'Void invoice',
        });
        if (!ok) return;
        await act(async () => {
          await store.setDocStatus(doc.id, 'void');
          // A shared page must stop asking to be paid.
          republishIfShared(store, doc.id)
            .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
        });
      }, { secondary: true });
    }
    add('Delete', 'trash', async () => {
      const ok = await confirmDialog({
        title: `Delete ${doc.number}?`,
        message: `It moves to the trash, with its payments and receipts, and is recoverable for ${TRASH_DAYS} days.`
          + (doc.shareToken ? ' Its public page is taken offline now, and stays offline if you restore it.' : ''),
      });
      if (!ok) return;
      await act(async () => {
        // The public page goes first; if it cannot be removed the document
        // stays too, so the user is never left with a live page they can
        // no longer manage. Read from the store now, not from the copy this
        // page rendered from: a publish pressed just before could finish
        // while the confirmation was open, and the token it recorded is on
        // the document, not on that copy — deleting by the copy left a
        // trashed document with a public page nothing could take down.
        const current = store.doc(doc.id) || doc;
        if (current.shareToken) await unpublishDoc(store, current);
        // deleteDoc removes the document from memory and emits before its
        // writes settle, which re-renders this view into a bare "no longer
        // exists" stub. Leave as soon as that state exists instead of
        // staring at it; a failed write rolls the document back into the
        // list and the catch reports it.
        const done = store.deleteDoc(doc.id);
        if (root.isConnected) navigate(backHash);
        await done;
        toast(`${doc.number} moved to the trash`, {
          icon: 'trash',
          action: {
            label: 'Undo',
            onClick: () => act(async () => {
              await store.restoreDoc(doc.id);
              toast(`${doc.number} restored`, { icon: 'undo' });
            }),
          },
        });
      }, 'Could not delete. Check your connection');
    }, { danger: true, secondary: true });

    /**
     * Compose the email, then leave the document in the state the user just
     * put it in: a draft they emailed has been sent. Undo is offered because
     * "did that actually open my mail client?" is a real question.
     */
    async function emailDoc(doc) {
      await openCompose(doc, {
        onSend: async () => {
          const fresh = store.doc(doc.id);
          if (!fresh || docStatus(fresh, todayISO()) !== 'draft') return;
          try {
            await store.setDocStatus(fresh.id, 'sent');
            toast(`${fresh.number} marked as sent`, {
              icon: 'send',
              action: {
                label: 'Undo',
                onClick: () => act(() => store.setDocStatus(fresh.id, 'draft')),
              },
            });
          } catch (err) {
            console.error(err);
            toast('Emailed, but could not mark it as sent', { icon: 'wifiOff' });
          }
        },
      });
    }

    /**
     * Chase an unpaid invoice with wording that matches how late it is, and
     * write the nudge into the document's own history.
     */
    async function remindNow(doc) {
      const stage = reminderStage(doc, today);
      const late = daysLate(doc, today);
      // The date the message itself will quote: on a payment schedule that is
      // the earliest installment still open, which is also what `late` counts
      // from — the sheet must not preview a different deadline than it sends.
      const dueOn = dueDateFor(doc);
      // On a payment plan only the part whose date has passed is late; say
      // so beside the whole, as Home's attention row does, or the sheet reads
      // as though the entire balance were overdue.
      const { balance } = docTotals(doc);
      const lateAmount = overdueAmount(doc, today);
      const stillDue = late > 0 && lateAmount < balance - 0.005
        ? `${fmtMoney(lateAmount, doc.currency)} of ${fmtMoney(balance, doc.currency)} still due`
        : `${fmtMoney(balance, doc.currency)} still due`;
      await openCompose(doc, {
        templateKey: stage,
        title: `Reminder · ${doc.number}`,
        intro: late > 0
          ? `${dayCount(late)} overdue · ${stillDue}. Edit anything before it goes out.`
          : `Due ${dueOn ? fmtDate(dueOn) : 'on receipt'} · ${stillDue}. Edit anything before it goes out.`,
        extra: reminderValues(doc, today),
        onSend: async (how) => {
          try {
            await store.recordReminder(doc.id, { stage, how });
            toast('Reminder noted on this invoice', { icon: 'clock' });
          } catch (err) {
            console.error(err);
            toast('Sent, but could not save the reminder note', { icon: 'wifiOff' });
          }
        },
      });
    }

    /**
     * Append one application of the late-fee policy as a clearly labelled
     * line item. Because it lands as a line, totals, receipts, reports, and
     * the accounting export all keep working with no new money math. The
     * line is tax-exempt by default (its tax treatment stays editable, like
     * any line's).
     */
    async function addLateFee(doc) {
      const policy = lateFeePolicy(store.settings, store.client(doc.clientId));
      // Charged on what is late as of today: on a payment plan that is the
      // installment whose date has passed, not the whole balance.
      const fee = lateFeeAmount(policy, doc, today);
      if (!fee) return;
      const name = lateFeeItemName(policy);
      const ok = await confirmDialog({
        title: `Add a late fee to ${doc.number}?`,
        message: `Adds a "${name}" line of ${fmtMoney(fee, doc.currency)}, bringing the balance to `
          + `${fmtMoney(balanceWithLateFee(doc, fee, name), doc.currency)}. Your policy is disclosed on the invoice; `
          + 'the fee itself is only ever added by you.',
        confirmLabel: 'Add late fee',
        danger: false,
      });
      if (!ok) return;
      await act(async () => {
        // The document as it stands now, not the copy this page rendered
        // from: the dialog above waited, and a file attached meanwhile (an
        // upload is the one writer the modal does not block) would be
        // written over by that copy and left orphaned in the cloud.
        const fresh = store.doc(doc.id);
        if (!fresh) throw new Error('That document is no longer here.');
        await store.saveDoc({
          ...fresh,
          items: [...(fresh.items || []), { id: uid(), name, qty: 1, rate: fee, taxes: [] }],
        });
        toast(`${fmtMoney(fee, doc.currency)} late fee added to ${doc.number}`, { icon: 'hourglass' });
        // A shared page must show the new balance it asks to be paid.
        republishIfShared(store, doc.id)
          .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
      });
    }

    async function shareNow(doc) {
      try {
        const url = await publishDoc(store, doc, currentPayLink(doc));
        await copyText(url, 'Public link copied');
      } catch (err) {
        console.error(err);
        toast('Could not publish. Check your connection', { icon: 'wifiOff' });
      }
    }

    /* ----- Side panel cards ----- */
    const side = [];

    if (isInvoice) {
      // Newest first, by the date the money moved, the order the receipts
      // ledger and the Reminders and Delivered cards beside this one keep.
      // Stored order is the order of recording, so a payment entered late for
      // an earlier date sat under the ones that had followed it.
      const payments = [...(doc.payments || [])].sort((a, b) => (
        (a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1
          : (b.createdAt || 0) - (a.createdAt || 0)));
      side.push(el('section.card.side-card', {},
        el('div.card-head', {},
          el('h2.card-title', {}, 'Payments'),
          // Nothing is "due" on an invoice nobody is collecting: a void one,
          // or one that has been written off. The write-off card below says
          // what that balance actually is now.
          t.balance > 0.005 && !['draft', 'void', 'writtenOff'].includes(status)
            ? el('span.side-due', {}, `${fmtMoney(t.balance, doc.currency)} due`)
            : null),
        payments.length
          ? el('div.pay-list', {}, payments.map((p) => {
            const back = isRefund(p);
            return el('button.pay-row', {
              type: 'button',
              onclick: () => openReceiptModal(p, doc),
              'aria-label': `${back ? 'Refund receipt' : 'Receipt'} ${p.number}, ${fmtMoney(Math.abs(p.amount), doc.currency)} on ${fmtDate(p.date)}`,
            },
              el(`span.pay-ic${back ? '.refund' : ''}`, { html: icon(back ? 'undo' : 'receipt', 15, 1.6) }),
              el('span.pay-main', {},
                el('span.pay-title', {},
                  fmtMoney(p.amount, doc.currency),
                  back ? el('span.status-chip.small.tone-warn.pay-tag', {}, 'Refund') : null),
                el('span.pay-sub', {}, `${fmtDate(p.date)}${p.method ? ` · ${p.method}` : ''} · ${p.number}`)),
              el('span', { html: icon('chevR', 16), style: { color: 'var(--ink-3)' } }));
          }))
          : el('p.side-note', {}, status === 'draft'
            ? 'Payments can be recorded once the invoice is sent.'
            : 'No payments yet.')));
    }

    /* ----- Attachments ----- */
    // An invoice usually travels with something: the signed estimate, a
    // timesheet, a photo of a receipt passed through at cost. They live in
    // the user's own cloud beside everything else, never on a server of ours.
    {
      const files = doc.attachments || [];
      const busy = { on: false };

      const addFiles = async (list) => {
        const chosen = [...(list || [])];
        if (!chosen.length || busy.on) return;
        busy.on = true;
        let added = 0;
        for (const file of chosen) {
          try {
            await store.attachFile(doc.id, file);
            added++;
          } catch (err) {
            console.error(err);
            toast(err?.message || 'That file could not be attached', { icon: 'alert' });
            break;
          }
        }
        busy.on = false;
        if (added) {
          toast(`${added} file${added === 1 ? '' : 's'} attached`, { icon: 'check' });
          // A shared page carrying the files must carry the new one too.
          // Decided from the document as it stands now, not from the copy this
          // page rendered from: an upload takes seconds, and the box offering
          // the files on the public page can be ticked meanwhile. That tick
          // republished the page with the files recorded so far, and the one
          // that landed afterwards was left off it — the copy held here still
          // said the files were not offered. Whether the page is shared at
          // all is not decided here either: a first publish still in the air
          // has no token recorded yet, so a gate on it skipped the refresh
          // and the page went live from the copy taken before the upload,
          // without the file. republishIfShared reads the token inside the
          // document's own queue, behind that publish, and does nothing for
          // a document that is not shared.
          if (store.doc(doc.id)?.shareAttachments) {
            republishIfShared(store, doc.id)
              .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
          }
        }
      };

      const picker = el('input', {
        type: 'file', multiple: true, hidden: true,
        onchange: (e) => {
          // Copied out of the input before it is cleared, not held by
          // reference: `input.files` is a live FileList, and emptying the
          // input empties the very list this handler is holding — so every
          // file chosen through the button arrived here as nothing at all,
          // silently, while dropping the same file on the box worked.
          const chosen = [...e.target.files];
          e.target.value = '';         // re-picking the same file must still fire
          addFiles(chosen);
        },
      });

      const drop = store.readOnly ? null : el('div.attach-drop', {
        ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
        ondragleave: () => drop.classList.remove('over'),
        ondrop: (e) => {
          e.preventDefault();
          drop.classList.remove('over');
          addFiles(e.dataTransfer?.files);
        },
      },
        el('button.btn.btn-ghost.btn-block', {
          type: 'button',
          html: icon('upload', 15, 1.6),
          disabled: files.length >= MAX_ATTACHMENTS,
          onclick: () => picker.click(),
        }, files.length >= MAX_ATTACHMENTS ? ' Attachment limit reached' : ' Add a file'),
        el('p.side-note', {},
          `Drag files here. Up to ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB each, `
          + `${MAX_ATTACHMENTS} per document. ` + (isPrivate ? 'They stay on your Jetson.' : 'They stay in your own cloud.')),
        picker);

      const shareBox = el('input', {
        type: 'checkbox', checked: !!doc.shareAttachments,
        onchange: async (e) => {
          const on = e.target.checked;
          try {
            await store.setShareAttachments(doc.id, on);
          } catch (err) {
            console.error(err);
            e.target.checked = !on;
            toast('Could not save. Check your connection', { icon: 'wifiOff' });
            return;
          }
          // Two writes, two answers. The choice is saved by now — the save's
          // own repaint has already drawn this box in its new state — so a
          // page that could not be refreshed must say that, not "could not
          // save": one message beside a box that plainly did. Queued without
          // asking whether the page is shared: a first publish still in the
          // air has recorded no token yet, and the refresh decides inside
          // the document's queue, behind it.
          republishIfShared(store, doc.id)
            .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
        },
      });

      side.push(el('section.card.side-card', {},
        el('div.card-head', {},
          el('h2.card-title', {}, 'Attachments'),
          files.length ? el('span.side-note', {}, `${files.length} file${files.length === 1 ? '' : 's'}`) : null),
        files.length
          ? el('div.attach-list', {}, files.map((f) => el('div.attach-row', {},
            el('span.attach-ic', { html: icon('paperclip', 16, 1.6) }),
            el('button.attach-main', {
              type: 'button',
              title: `Download ${f.name}`,
              onclick: (e) => downloadAttachment(f, e.currentTarget),
            },
              el('span.attach-name', {}, f.name),
              el('span.attach-size', {}, fileSize(f.size))),
            !store.readOnly && el('button.icon-btn', {
              type: 'button',
              html: icon('x', 16, 1.6),
              'aria-label': `Remove ${f.name}`,
              title: 'Remove',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: `Remove ${f.name}?`,
                  message: isPrivate ? 'The file is deleted from your Jetson storage. This cannot be undone from the app.' : 'The file is deleted from your cloud. This cannot be undone.',
                });
                if (!ok) return;
                await act(async () => {
                  await store.removeAttachment(doc.id, f.id);
                  toast('File removed', { icon: 'trash' });
                  // From the document as it stands after the confirmation
                  // and the write above, like the upload path — and, like it,
                  // without asking for the token here.
                  if (store.doc(doc.id)?.shareAttachments) {
                    republishIfShared(store, doc.id)
                      .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
                  }
                }, 'Could not remove that file. Check your connection');
              },
            }))))
          : el('p.side-note', {}, 'Nothing attached yet.'),
        drop,
        // Publishing copies these files to a public URL, which is not what
        // everyone wants from a timesheet: off unless it is asked for.
        files.length && !store.readOnly && !isPrivate
          ? el('label.check-row.attach-share', {}, shareBox,
            el('span', {}, 'Offer these on the public page',
              el('span.field-hint', {}, ' (copies them beside the shared page while it is shared)')))
          : null));
    }

    // The write-off, on the page and nowhere else: like the reminder history
    // below it, this is the user's own record and never reaches the paper,
    // the PDF, or the share page. No client is handed a document stamped
    // "written off".
    if (isInvoice && isWrittenOff(doc)) {
      side.push(el('section.card.side-card', {},
        el('div.card-head', {},
          el('h2.card-title', {}, 'Written off'),
          el('span.side-note', {}, fmtDate(doc.writeOff.date))),
        el('p.side-note', {}, doc.writeOff.reason
          ? doc.writeOff.reason
          : 'No reason recorded.'),
        el('p.side-note', {},
          `${fmtMoney(t.balance, doc.currency)} of ${fmtMoney(t.total, doc.currency)} was given up on. `
          + 'It still counts as invoiced in your reports, and no longer counts as owed.')));
    }

    // Reminder history: the user's own record of chasing, newest first, and
    // deliberately absent from the paper the client sees.
    const remindersList = reminders(doc);
    if (isInvoice && remindersList.length) {
      side.push(el('section.card.side-card', {},
        el('div.card-head', {},
          el('h2.card-title', {}, 'Reminders'),
          el('span.side-note', {}, reminderNote(doc, today))),
        el('div.rem-list', {}, [...remindersList].reverse().map((r) => {
          const meta = REMINDER_STAGES[r.stage];
          return el('div.rem-row', {},
            el('span.rem-date', {}, fmtDate(r.date)),
            meta ? el(`span.status-chip.small.tone-${meta.tone}`, {}, meta.label) : null,
            // Only 'send' means the app watched it leave. The other two are
            // the user's own record that they went and did it, and the
            // wording says which is which rather than calling all three
            // "emailed" — the Delivered card below is the one that knows.
            el('span.rem-how', {},
              r.how === 'copy' ? 'copied' : r.how === 'send' ? 'sent' : 'mail app'));
        }))));
    }

    // What this app actually delivered, and to whom. Written only by a real
    // send (store.recordEmail), so unlike the reminder log above it is
    // evidence rather than a note to self — the answer to "did the client
    // ever get this?". Never on the paper.
    // Read every entry the way store.recordEmail writes it rather than
    // trusting its shape: an offline snapshot or a hand-edited year file does
    // not pass through the backup validator, and this card joins a list of
    // addresses — one string where an array belongs would throw here and take
    // the whole document page down with it. An entry naming nobody is not
    // evidence of a delivery, so it is not drawn as one.
    const addressesOf = (entry) => (Array.isArray(entry.to) ? entry.to : [entry.to])
      .map((v) => String(v || '').trim()).filter(Boolean);
    const emailLog = (Array.isArray(doc.emails) ? doc.emails : [])
      .filter((e) => e && typeof e === 'object' && addressesOf(e).length);
    if (emailLog.length) {
      side.push(el('section.card.side-card', {},
        el('div.card-head', {},
          el('h2.card-title', {}, 'Delivered'),
          el('span.side-note', {}, emailLog.length > 1 ? `${emailLog.length} emails` : '1 email')),
        // A line each: an email address is longer than this column is wide,
        // and sharing a row with the date left it broken mid-domain. The
        // subject is what separates the invoice from the reminder that chased
        // it, which the date and the address alone cannot.
        el('div.sent-list', {}, [...emailLog].reverse().slice(0, 6).map((e) => {
          const carried = Math.max(0, Math.round(Number(e.attachments) || 0));
          const line = String(e.subject || '').trim();
          return el('div.sent-row', {},
            el('div.sent-head', {},
              el('span.rem-date', {}, fmtDate(e.date)),
              carried ? el('span.rem-how', {}, `${carried} file${carried === 1 ? '' : 's'}`) : null),
            line ? el('span.sent-subject', { title: line }, line) : null,
            el('span.sent-to', {}, addressesOf(e).join(', ')));
        })),
        emailLog.length > 6
          ? el('p.side-note', {}, `Showing the last 6 of ${emailLog.length}.`)
          : null));
    }

    if (doc.shareToken && store.settings.share?.subdomain) {
      const url = shareUrl(store.settings, doc);
      side.push(el('section.card.side-card', {},
        el('h2.card-title', {}, 'Public link'),
        el('p.side-note.break', {}, url),
        el('div.side-actions', {},
          el('button.btn.btn-ghost', { html: icon('copy', 15, 1.6), onclick: () => copyText(url, 'Public link copied') }, ' Copy'),
          el('a.btn.btn-ghost', { href: url, target: '_blank', rel: 'noopener', html: icon('external', 15, 1.6) }, ' Open'),
          // Taking the page down is a write to the cloud that holds it, so
          // offline it is left out rather than offered and then refused —
          // the same allowlist the action row above keeps. The link itself
          // still reads and copies from the saved copy.
          !store.readOnly && el('button.btn.btn-ghost', {
            html: icon('circleX', 15, 1.6),
            onclick: () => act(async () => {
              await unpublishDoc(store, doc);
              toast('No longer shared');
            }),
          }, ' Stop sharing'))));
    }

    const links = [];
    if (doc.quoteId && store.doc(doc.quoteId)) {
      const q = store.doc(doc.quoteId);
      links.push(el('a.attn-row', { href: `#/doc/${q.id}` },
        el('span.attn-ic.tone-info', { html: icon('quote', 16, 1.6) }),
        el('span.attn-main', {},
          el('span.attn-title', {}, `From estimate ${q.number}`),
          el('span.attn-sub', {}, fmtDate(q.issueDate))),
        el('span', { html: icon('chevR', 16), style: { color: 'var(--ink-3)' } })));
    }
    if (doc.invoiceId && store.doc(doc.invoiceId)) {
      const inv = store.doc(doc.invoiceId);
      links.push(el('a.attn-row', { href: `#/doc/${inv.id}` },
        el('span.attn-ic.tone-info', { html: icon('invoice', 16, 1.6) }),
        el('span.attn-main', {},
          el('span.attn-title', {}, `Invoiced as ${inv.number}`),
          el('span.attn-sub', {}, fmtDate(inv.issueDate))),
        el('span', { html: icon('chevR', 16), style: { color: 'var(--ink-3)' } })));
    }
    const rule = doc.recurringId ? store.recurring.find((r) => r.id === doc.recurringId) : null;
    if (rule) {
      // The side card's title is one line with an ellipsis, and "Created by
      // a recurring schedule" never fit it at any width. A title that fits,
      // the rule's own name under it, and a row that opens that rule rather
      // than the whole list.
      links.push(el('a.attn-row', { href: `#/edit-recurring/${rule.id}` },
        el('span.attn-ic.tone-info', { html: icon('repeat', 16, 1.6) }),
        el('span.attn-main', {},
          el('span.attn-title', {}, 'Recurring schedule'),
          el('span.attn-sub', {}, rule.name || freqLabel(rule.freq))),
        el('span', { html: icon('chevR', 16), style: { color: 'var(--ink-3)' } })));
    }
    if (links.length) {
      side.push(el('section.card.side-card', {},
        el('h2.card-title', {}, 'Linked'),
        el('div.doc-list', {}, links)));
    }

    /* ----- Paper ----- */
    const paper = el('div.paper', { html: paperHTML(doc, client, store.settings, { payLink, today }) });

    root.append(
      el('div.page-head', {},
        el('div', {},
          el('div.back-row', {},
            el('a.back-link', { href: backHash, html: icon('back', 16, 1.8) },
              ` ${isInvoice ? 'Invoices' : 'Estimates'}`)),
          el('div.detail-title-row', {},
            el('h1.page-title', {}, doc.number),
            statusChip(status)),
          el('p.page-sub', {}, client
            // The 'Client' fallback matters most here: without it a client
            // restored with no name renders a focusable link with no text
            // and no accessible name.
            ? el('a.sub-link', { href: `#/client/${client.id}` }, client.company || client.name || 'Client')
            : 'No client'))),
      el('div.detail-actions', {}, actions, extras.length ? el('button.btn', {
        type: 'button',
        html: icon('more', 16, 1.6),
        'aria-haspopup': 'dialog',
        onclick: openMore,
      }, ' More') : null),
      el('div.detail-grid', {},
        el('div.detail-paper-col', {}, paper),
        side.length ? el('div.detail-side', {}, side) : null)
    );
    restoreFocus();
  }

  /**
   * Hand one attachment back to the user. The file lives in their cloud, so
   * it is read into a blob here and offered as a download — the same path
   * the PDF action takes, and the only one a Puter file can take.
   */
  async function downloadAttachment(entry, button) {
    if (button.getAttribute('aria-disabled') === 'true') return;
    button.setAttribute('aria-disabled', 'true');
    try {
      const blob = await store.readAttachment(entry);
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: entry.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error(err);
      // Offline the file is not missing, it is simply out of reach: the
      // document, its PDF, and its receipts all come from the copy on this
      // device, but an attachment lives in the cloud.
      toast(store.readOnly
        ? `${entry.name} is in your cloud. Reconnect to download it`
        : `${entry.name} is no longer in your cloud`, { icon: store.readOnly ? 'wifiOff' : 'alert' });
    } finally {
      if (button.isConnected) button.removeAttribute('aria-disabled');
    }
  }

  /* ----- Write off ----- */
  /**
   * Writing off asks for two things a confirm dialog cannot: when it
   * happened, and why. The reason is for the user alone — a year from now,
   * "client dissolved" is the difference between a decision and a mystery.
   */
  function openWriteOffModal(doc) {
    const t = docTotals(doc);
    const date = el('input.input', { type: 'date', value: todayISO(), min: MIN_DATE, max: MAX_DATE, onchange: pinDate });
    const reason = el('input.input', {
      placeholder: 'Client dissolved, dispute settled, too small to chase…',
      maxlength: '400',
    });
    const saveBtn = el('button.btn.btn-primary.btn-block', {
      onclick: async () => {
        if (!isISODate(date.value)) {
          toast(date.value ? 'Enter a year between 1000 and 9999' : 'Pick the date you gave up on it', { icon: 'alert' });
          date.focus();
          return;
        }
        saveBtn.disabled = true;
        try {
          await store.setWriteOff(doc.id, { date: date.value, reason: reason.value });
          modal.close();
          toast(`${doc.number} written off`, {
            icon: 'ban',
            action: { label: 'Undo', onClick: () => act(() => store.clearWriteOff(doc.id)) },
          });
        } catch (err) {
          console.error(err);
          toast('Could not save. Check your connection', { icon: 'wifiOff' });
          saveBtn.disabled = false;
          refocus(saveBtn);
        }
      },
    }, 'Write it off');

    const modal = openModal({
      title: `Write off ${doc.number}?`,
      content: el('div', {},
        el('p.compose-intro', {},
          `${fmtMoney(t.balance, doc.currency)} stops counting as owed: it leaves Outstanding, Overdue, `
          + 'and the client\u2019s statement. Unlike voiding, the invoice stays billed — your reports still '
          + 'show what you invoiced, with this as the part that never arrived. Nothing is printed on the '
          + 'document, and you can reopen it at any time.'),
        el('div.field-grid', {},
          field('Date', date),
          field('Reason', reason, { hint: '(optional, for you only)' })),
        saveBtn),
    });
  }

  /* ----- Record payment or refund ----- */
  // One form for money in and money out: same fields, same receipt series,
  // opposite sign. A refund is capped at what was actually received.
  function openPaymentModal(doc, { refund = false } = {}) {
    const t = docTotals(doc);
    const max = refundableTotal(doc);
    // The first payment on an invoice that asked for a deposit is almost
    // always that deposit; afterwards the open balance is the likely amount.
    // Math.abs, like the paper and pay link (a88dba3): net paid can go
    // negative when a payment is deleted out from under its refund, and the
    // prefill must ask for the same money the invoice shows.
    const expectDeposit = !refund && t.deposit > 0.005 && Math.abs(t.paid) <= 0.005;
    // On a payment plan the money that arrives is almost always the next
    // part's, exactly as the first payment on an invoice that asked for a
    // deposit is that deposit — and the paper, the reminder and the overdue
    // reading all speak of that part, not of the whole. Prefilled with what
    // is still open on the earliest unpaid installment while it is less than
    // the balance; the full balance is one edit away, and the hint keeps
    // saying what the whole invoice still owes.
    const nextPart = !refund && !expectDeposit
      ? t.installments.find((r) => r.open > 0.005 && r.open < t.balance - 0.005) || null
      : null;
    const start = refund ? max
      : expectDeposit ? t.deposit
      : nextPart ? nextPart.open
      : (t.balance > 0 ? t.balance : '');
    const amount = el('input.input.amount-input', {
      type: 'number', min: '0', step: 'any',
      max: refund ? String(max) : null,
      // Written as money, not as the number it happens to be: a balance of
      // 1802.4 read as "1802.4" in a 22px field beside "$1,802.40 outstanding".
      value: start === '' ? '' : Number(start).toFixed(2),
      inputmode: 'decimal', required: true,
    });
    const date = el('input.input', { type: 'date', value: todayISO(), min: MIN_DATE, max: MAX_DATE, onchange: pinDate });
    const method = el('select.select', {},
      PAY_METHODS.map((m) => el('option', { value: m }, m)));
    const note = el('input.input', {
      placeholder: refund ? 'Reason, reference…' : 'Reference, check number…',
    });
    // An invoice billed in someone else's money converts at the rate that
    // applied the day the money actually moved, which is rarely the day the
    // invoice was written. Prefilled from the document, and optional: no
    // rate simply leaves this payment out of the consolidated figures.
    const base = store.settings.baseCurrency || store.settings.currency || 'USD';
    const foreign = doc.currency !== base;
    const docRate = fxRateFor(doc, base);
    const fx = el('input.input', {
      type: 'number', min: '0', step: 'any', inputmode: 'decimal',
      value: docRate && docRate !== 1 ? docRate : '',
      placeholder: '1.00',
      oninput: () => renderFxHint(),
    });
    const fxHint = el('p.card-sub.fx-note');
    const renderFxHint = () => {
      const rate = Number(fx.value);
      const amt = Number(amount.value);
      fxHint.textContent = Number.isFinite(rate) && rate > 0 && Number.isFinite(amt) && amt > 0
        ? `${fmtMoney(amt, doc.currency)} = ${fmtMoney(inBase(amt, rate), base)}`
        : 'Left empty, this payment is not counted in the consolidated totals in Reports.';
    };
    if (foreign) {
      amount.addEventListener('input', renderFxHint);
      renderFxHint();
    }
    const saveBtn = el('button.btn.btn-primary.btn-block', {
      onclick: async () => {
        const amt = Number(amount.value);
        // A refused save puts the cursor on the field it is about: the toast
        // names the problem, and the box that has it is the next thing the
        // user reaches for — on a keyboard it was several tabs back up the
        // sheet.
        if (!Number.isFinite(amt) || amt <= 0) {
          toast('Enter an amount above zero', { icon: 'alert' });
          amount.focus();
          return;
        }
        if (refund && amt > max + 0.005) {
          toast(`A refund cannot be more than the ${fmtMoney(max, doc.currency)} received`, { icon: 'alert' });
          amount.focus();
          return;
        }
        // The receipt is numbered into this date's year and the payment is
        // reported in it; a five-digit year would land in neither.
        if (date.value && !isISODate(date.value)) {
          toast('Enter a year between 1000 and 9999', { icon: 'alert' });
          date.focus();
          return;
        }
        saveBtn.disabled = true;
        try {
          const p = await store.addPayment(doc.id, {
            date: date.value || todayISO(),
            amount: amt,
            method: method.value,
            note: note.value,
            refund,
            fxRate: foreign ? fx.value : null,
          });
          if (!p) {
            toast('That amount could not be recorded', { icon: 'alert' });
            saveBtn.disabled = false;
            refocus(saveBtn);
            return;
          }
          modal.close();
          const t2 = docTotals(store.doc(doc.id));
          toast(refund
            ? `Refund recorded. Receipt ${p.number} ready`
            : t2.balance <= 0.005
              ? `Paid in full. Receipt ${p.number} ready`
              : `Payment recorded. Receipt ${p.number} ready`, { icon: 'circleCheck' });
          // A shared page must reflect the new balance and pay link.
          republishIfShared(store, doc.id)
            .catch(() => toast('Could not refresh the shared page', { icon: 'wifiOff' }));
        } catch (err) {
          console.error(err);
          toast('Could not save. Check your connection', { icon: 'wifiOff' });
          saveBtn.disabled = false;
          refocus(saveBtn);
        }
      },
    }, refund ? 'Record refund' : 'Record payment');

    const modal = openModal({
      title: `${refund ? 'Record refund' : 'Record payment'} · ${doc.number}`,
      content: el('div', {},
        refund ? el('p.compose-intro', {},
          `Sends money back to the client and reopens the balance. At most ${fmtMoney(max, doc.currency)} can be refunded.`) : null,
        field('Amount', amount, {
          hint: refund
            ? `${fmtMoney(max, doc.currency)} received so far`
            : expectDeposit
              ? `${fmtMoney(t.deposit, doc.currency)} deposit requested · ${fmtMoney(t.balance, doc.currency)} outstanding`
              : nextPart
                ? `${fmtMoney(nextPart.open, doc.currency)} ${nextPart.paid > 0.005 ? 'left on' : 'for'} the installment`
                  + `${nextPart.dueDate ? ` due ${fmtDate(nextPart.dueDate)}` : ''} · ${fmtMoney(t.balance, doc.currency)} outstanding`
                : `${fmtMoney(t.balance, doc.currency)} outstanding`,
        }),
        el('div.field-grid', {},
          field('Date', date),
          field('Method', selectWrap(method))),
        field('Note', note, { hint: '(optional)' }),
        foreign ? field(`Exchange rate (1 ${doc.currency} = ? ${base})`, fx, { hint: '(optional)' }) : null,
        foreign ? fxHint : null,
        saveBtn),
    });
  }

  store.addEventListener('change', render);
  root.destroy = () => store.removeEventListener('change', render);
  render();
  return root;
}
