import { isPrivateStorage } from '../lib/storage.js';
import { persistInput } from '../lib/private-browser.js';
import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { store, PRIORITIES } from '../lib/store.js';
import { columnTasks } from '../lib/board.js';
import { relativeTime, formatBytes, fieldId } from '../lib/util.js';
import { fmtShort } from '../lib/dates.js';
import { openModal, confirmDialog } from './modal.js';
import { openMenu } from './menu.js';
import { toast } from './toast.js';
import { avatar, accentAvatar } from './bits.js';
import { checklistSection } from './checklist.js';
import { markdownFragment, markdownView } from './markdown.js';
import { safeHref } from '../lib/markdown.js';
import { RECURRENCE_FREQS, normalizeRecurrence, describeRecurrence } from '../lib/recurrence.js';
import { REMINDER_OFFSETS, hasReminder, reminderDate } from '../lib/reminders.js';
import { parseRoute, taskHash } from '../lib/routes.js';
import { canPickFiles, pickFiles } from '../lib/puterui.js';

/**
 * Open a task by navigating: the sheet lives in the route (see routes.js),
 * so a task is linkable, survives a reload, and Back dismisses it. The
 * shell watches the route and mounts the sheet below.
 */
export function openTaskSheet(projectId, taskId) {
  const route = parseRoute(location.hash);
  const tab = route.name === 'project' && route.id === projectId ? route.tab : 'board';
  location.hash = taskHash(projectId, taskId, tab);
  // Mark the entry that assignment pushed: closing the sheet pops it, while
  // a sheet restored from a cold deep link has nothing to pop.
  try { history.replaceState({ ...history.state, pmSheet: true }, ''); } catch { /* non-blocking */ }
}

/**
 * Task detail sheet. Every field auto-saves; the sheet keeps its own DOM
 * up to date instead of re-rendering on store events, so typing never
 * loses focus.
 */
export function mountTaskSheet(projectId, taskId, { onClose } = {}) {
  const doc = store.getDoc(projectId);
  const task = doc?.tasks.find((t) => t.id === taskId);
  if (!task) return null;

  const patch = (p) => store.updateTask(projectId, taskId, p);

  // ---- title & description ---------------------------------------------

  const titleInput = el('input.sheet-title', {
    value: task.title,
    'aria-label': 'Task title',
    maxLength: 200,
    oninput: persistInput(() => {
      const v = titleInput.value.trim();
      if (v) patch({ title: v });
    }, 400),
    // An emptied field is a mistake, not a request for a nameless task — so
    // the title is kept. Put it back in the box too, or the sheet sits there
    // claiming a title the task does not have (the checklist does the same).
    onblur: () => { if (!titleInput.value.trim()) titleInput.value = task.title; },
  });

  /* Description: rendered Markdown that swaps to the textarea on click or
     via the Edit button. Storage stays plain Markdown, and the existing
     debounced autosave is unchanged. */
  const descInput = el('textarea.input.sheet-desc', {
    rows: 6,
    placeholder: 'Add a description… Markdown is supported',
    'aria-label': 'Description',
    value: task.description || '',
    oninput: persistInput(() => patch({ description: descInput.value.trim() }), 500),
    onkeydown: (e) => {
      if (e.isComposing) return;
      // Escape and Cmd/Ctrl+Enter both mean "done editing" (the comment box
      // already trains the second one).
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        setDescEditing(false);
      }
    },
    onblur: () => setDescEditing(false),
  });

  const descView = el('div.md.desc-view', {
    role: 'button',
    tabindex: 0,
    'aria-label': 'Description, activate to edit',
    onclick: (e) => {
      // Following a link inside the description must not open the editor.
      if (e.target.closest('a')) return;
      setDescEditing(true);
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDescEditing(true); }
    },
  });

  const descEditBtn = el('button.btn.btn-ghost.btn-sm', {
    type: 'button',
    // Pressing the button while editing must not move focus out of the
    // textarea first: its blur handler would close the editor, and the click
    // below would then read "not editing" and open it straight back up — so
    // "Done" would look like it did nothing at all.
    onmousedown: (e) => { if (descEditing) e.preventDefault(); },
    onclick: () => {
      const wasEditing = descEditing;
      setDescEditing(!wasEditing);
      // Hiding the textarea drops focus on the floor; keep it on the toggle.
      if (wasEditing) descEditBtn.focus();
    },
  });

  const descHint = el('p.form-hint.desc-hint', {},
    '**bold**, *italic*, `code`, # heading, > quote, - list, [link](https://…)');

  let descEditing = false;

  function renderDescView() {
    descView.replaceChildren();
    const text = task.description?.trim();
    if (text) descView.append(markdownFragment(text));
    else descView.append(el('p.md-p.desc-empty', {}, 'Add a description…'));
  }

  function setDescEditing(on) {
    if (on === descEditing) return;
    descEditing = on;
    if (!on) {
      // Leaving the editor flushes the pending debounce so the view below
      // never shows stale text.
      const value = descInput.value.trim();
      if (value !== (task.description || '')) patch({ description: value });
      renderDescView();
    }
    descInput.hidden = !on;
    descHint.hidden = !on;
    descView.hidden = on;
    descEditBtn.textContent = on ? 'Done' : 'Edit';
    if (on) {
      descInput.focus();
      descInput.setSelectionRange(descInput.value.length, descInput.value.length);
    }
  }

  // ---- meta selects ------------------------------------------------------

  function select({ label, value, options, onchange }) {
    const id = fieldId('task');
    const sel = el('select.input', { id, onchange: () => onchange(sel.value) },
      options.map((o) => el('option', { value: o.value, selected: o.value === (value ?? '') }, o.label)));
    return el('div.field', {}, el('label.label', { htmlFor: id }, label), sel);
  }

  const columnField = select({
    label: 'Column',
    value: task.columnId,
    options: doc.columns.map((c) => ({ value: c.id, label: c.name })),
    onchange: (v) => {
      if (v !== task.columnId) {
        store.moveTask(projectId, taskId, v, columnTasks(doc.tasks, v).length);
      }
    },
  });

  const priorityField = select({
    label: 'Priority',
    value: task.priority ?? '',
    options: [{ value: '', label: 'None' }, ...PRIORITIES],
    onchange: (v) => patch({ priority: v || null }),
  });

  const milestoneField = select({
    label: 'Milestone',
    value: task.milestoneId ?? '',
    options: [
      { value: '', label: 'None' },
      ...[...doc.milestones]
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((m) => ({ value: m.id, label: `${m.name} (${fmtShort(m.date)})` })),
    ],
    onchange: (v) => patch({ milestoneId: v || null }),
  });

  /* Repeat: a frequency plus an interval, next to the dates it shifts. */
  const repeatRule = () => normalizeRecurrence(task.recurrence);

  const repeatSelect = el('select.input', {
    'aria-label': 'Repeat',
    onchange: () => {
      const freq = repeatSelect.value;
      store.setRecurrence(projectId, taskId, freq
        ? { freq, interval: Number(repeatInterval.value) || 1 }
        : null);
      syncRepeat();
    },
  },
    el('option', { value: '', selected: !repeatRule() }, 'Does not repeat'),
    RECURRENCE_FREQS.map((f) => el('option', {
      value: f.value,
      selected: repeatRule()?.freq === f.value,
    }, `Every ${f.label.toLowerCase()}`))
  );

  const repeatInterval = el('input.input.repeat-interval', {
    type: 'number',
    min: 1,
    max: 30,
    step: 1,
    value: String(repeatRule()?.interval ?? 1),
    'aria-label': 'Repeat every how many',
    onchange: () => {
      if (!repeatSelect.value) return;
      store.setRecurrence(projectId, taskId, {
        freq: repeatSelect.value,
        interval: Number(repeatInterval.value) || 1,
      });
      syncRepeat();
    },
  });

  const repeatNote = el('p.form-hint.repeat-note');

  function syncRepeat() {
    const rule = repeatRule();
    repeatInterval.hidden = !rule;
    repeatNote.textContent = rule
      ? `${describeRecurrence(rule)}. Moving this task to a done column adds the next one.`
      : '';
  }

  const repeatField = el('div.field.repeat-field', {},
    el('span.label', {}, 'Repeat'),
    el('div.row.repeat-row', {}, repeatSelect, repeatInterval),
    repeatNote
  );

  function dateField(label, key) {
    const id = fieldId('task-date');
    const input = el('input.input', {
      id,
      type: 'date',
      value: task[key] || '',
      onchange: () => {
        patch({ [key]: input.value || null });
        if (key === 'dueDate') syncRemind();
      },
    });
    return el('div.field', {}, el('label.label', { htmlFor: id }, label), input);
  }

  /* Remind me: an offset from the due date, because a date-only app has no
     time of day to fire at. It lives next to the date it depends on. */
  const remindId = fieldId('task-remind');
  const remindSelect = el('select.input', {
    id: remindId,
    onchange: () => {
      patch({
        remindOffset: remindSelect.value === '' ? null : Number(remindSelect.value),
        // Changing the reminder reopens it, even if today's already fired.
        remindedOn: null,
      });
      syncRemind();
    },
  },
    el('option', { value: '', selected: !hasReminder(task) }, 'No reminder'),
    REMINDER_OFFSETS.map((o) => el('option', {
      value: String(o.value),
      selected: hasReminder(task) && task.remindOffset === o.value,
    }, o.label))
  );

  const remindNote = el('p.form-hint.remind-note');

  function syncRemind() {
    remindSelect.disabled = !task.dueDate;
    const at = reminderDate(task);
    remindNote.textContent = !task.dueDate
      ? 'Set a due date to be reminded about it.'
      : at
        ? `Reminds you on ${fmtShort(at)}, while the app is open.`
        : '';
  }

  const remindField = el('div.field', {},
    el('label.label', { htmlFor: remindId }, 'Remind me'),
    remindSelect,
    remindNote
  );

  // ---- assignees & labels (toggle chips) ---------------------------------

  function toggleChips({ label, items, selected, render, ontoggle, emptyHint }) {
    const wrap = el('div.chip-row', { role: 'group', 'aria-label': label });
    if (!items.length) wrap.append(el('span.form-hint', {}, emptyHint));
    for (const item of items) {
      const isOn = () => selected().includes(item.id);
      const btn = el('button.chip-toggle', {
        type: 'button',
        'aria-pressed': isOn() ? 'true' : 'false',
        onclick: () => {
          ontoggle(item.id, !isOn());
          btn.setAttribute('aria-pressed', isOn() ? 'true' : 'false');
          btn.classList.toggle('on', isOn());
        },
        className: `chip-toggle${isOn() ? ' on' : ''}`,
      }, render(item));
      wrap.append(btn);
    }
    return el('div.field', {}, el('span.label', {}, label), wrap);
  }

  const assigneeField = toggleChips({
    label: 'Assignees',
    items: doc.members,
    selected: () => task.assigneeIds,
    emptyHint: 'Add members under Members and labels in the project menu.',
    render: (m) => [avatar(m, 20), el('span', {}, m.name)],
    ontoggle: (id, on) => patch({
      assigneeIds: on ? [...task.assigneeIds, id] : task.assigneeIds.filter((x) => x !== id),
    }),
  });

  const labelField = toggleChips({
    label: 'Labels',
    items: doc.labels,
    selected: () => task.labelIds,
    emptyHint: 'Create labels under Members and labels in the project menu.',
    render: (l) => [el('span.dot', { style: { background: l.color }, 'aria-hidden': 'true' }), el('span', {}, l.name)],
    ontoggle: (id, on) => patch({
      labelIds: on ? [...task.labelIds, id] : task.labelIds.filter((x) => x !== id),
    }),
  });

  // ---- checklist ---------------------------------------------------------

  const checklist = checklistSection({ projectId, task });

  // ---- attachments -------------------------------------------------------

  const attachList = el('div.attach-list');
  const attachLabel = el('span.label', {}, 'Attachments');

  function attachIconName(att) {
    if ((att.type || '').startsWith('image/')) return 'image';
    if (/pdf|text|json|csv|markdown/.test(att.type || '')) return 'fileText';
    return 'file';
  }

  /**
   * Only render-safe types open in a tab. Blob URLs run with this app's
   * origin, so anything the browser executes when opened inline — an HTML
   * file, or an SVG carrying an inline <script> — would run against the
   * user's Puter session. Preview a strict allowlist of inert types
   * (raster images, PDF, plain text); everything else is downloaded.
   */
  function canPreview(att) {
    return /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon)|application\/pdf|text\/plain)$/.test(att.type || '');
  }

  /* Links are checked once per render, and only links: a row that points at
     a file which has moved must say so rather than fail when clicked. */
  const broken = new Set();

  function checkLinks() {
    const links = task.attachments.filter((a) => a.kind === 'link');
    if (!links.length) return;
    Promise.all(links.map(async (att) => {
      const ok = await store.attachmentExists(projectId, taskId, att);
      if (ok) broken.delete(att.id);
      else broken.add(att.id);
    })).then(() => { if (attachList.isConnected) renderAttachments({ recheck: false }); });
  }

  function renderAttachments({ recheck = true } = {}) {
    attachLabel.textContent =
      `Attachments${task.attachments.length ? ` (${task.attachments.length})` : ''}`;
    clear(attachList);
    for (const att of task.attachments) {
      const linked = att.kind === 'link';
      // A web address, from an imported Trello card: it opens in a tab, and
      // there are no bytes here to preview or download.
      const web = att.kind === 'url' && safeHref(att.url);
      const isBroken = linked && (isPrivateStorage || broken.has(att.id));
      attachList.append(el('div.attach-row', {
        className: `attach-row${isBroken ? ' broken' : ''}`,
      },
        el('span.attach-ic', {
          html: icon(isBroken ? 'cloudOff' : (linked || web) ? 'link' : attachIconName(att), 17, 1.8),
        }),
        web
          ? el('a.attach-name', {
            href: web,
            target: '_blank',
            rel: 'noopener noreferrer nofollow ugc',
            title: web,
          }, att.name)
          : el('button.attach-name', {
            type: 'button',
            disabled: isBroken,
            title: isBroken
              ? isPrivateStorage ? 'Puter Drive link unavailable — upload the original file from your device' : `${att.path} is no longer there`
              : linked
                ? `${att.path} (in your Puter Drive)`
                : canPreview(att) ? `Open ${att.name}` : `Download ${att.name}`,
            onclick: () => (canPreview(att) ? openAttachment(att) : downloadAttachment(att)),
          }, att.name),
        linked && el('span.attach-tag', {
          title: 'Linked from your Puter Drive, not copied here',
        }, isPrivateStorage ? 'Drive unavailable' : isBroken ? 'missing' : 'linked'),
        web && el('span.attach-tag', {
          title: 'A web address this task points at, not a file kept here',
        }, 'web'),
        el('span.attach-size', {}, isBroken || web ? '' : formatBytes(att.size)),
        !web && el('button.icon-btn.small', {
          html: icon('download', 15, 2),
          disabled: isBroken,
          'aria-label': `Download ${att.name}`,
          onclick: () => downloadAttachment(att),
        }),
        el('button.icon-btn.small', {
          html: icon('trash', 15, 2),
          'aria-label': linked || web ? `Remove the link to ${att.name}` : `Delete ${att.name}`,
          onclick: async () => {
            const ok = await confirmDialog({
              title: linked || web ? 'Remove this link?' : 'Delete attachment?',
              message: linked
                ? `The link to "${att.name}" is removed from this task. The file `
                  + 'stays exactly where it is in your Puter Drive.'
                : web
                  ? `The link to "${att.name}" is removed from this task. Nothing on the `
                    + 'web is touched.'
                  : `"${att.name}" is permanently removed from this task.`,
              confirmLabel: linked || web ? 'Remove link' : 'Delete',
            });
            if (!ok) return;
            store.deleteAttachment(projectId, taskId, att);
            broken.delete(att.id);
            renderAttachments();
          },
        })
      ));
    }
    if (recheck) checkLinks();
  }

  async function attachmentBlob(att) {
    const blob = await store.readAttachment(projectId, taskId, att);
    return att.type ? new Blob([blob], { type: att.type }) : blob;
  }

  async function openAttachment(att) {
    try {
      const url = URL.createObjectURL(await attachmentBlob(att));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      console.error(err);
      toast('Could not open the file. Check your connection', { icon: 'cloudOff' });
    }
  }

  async function downloadAttachment(att) {
    try {
      const url = URL.createObjectURL(await attachmentBlob(att));
      const a = el('a', { href: url, download: att.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      console.error(err);
      toast('Could not download the file. Check your connection', { icon: 'cloudOff' });
    }
  }

  const fileInput = el('input', {
    type: 'file', multiple: true, style: { display: 'none' },
    onchange: async () => {
      for (const file of fileInput.files) {
        if (file.size > 20 * 1024 * 1024) {
          toast(`"${file.name}" is over 20 MB`, { icon: 'cloudOff' });
          continue;
        }
        uploadBtn.disabled = true;
        uploadBtn.lastChild.textContent = ` Uploading ${file.name}…`;
        try {
          await store.addAttachment(projectId, taskId, file);
          renderAttachments();
        } catch (err) {
          console.error(err);
          toast(`Could not upload "${file.name}"`, { icon: 'cloudOff' });
        }
      }
      uploadBtn.disabled = false;
      uploadBtn.lastChild.textContent = ' Add file';
      fileInput.value = '';
    },
  });

  const uploadBtn = el('button.btn.btn-ghost.btn-sm', {
    type: 'button',
    html: icon('paperclip', 14, 2),
    onclick: () => fileInput.click(),
  }, ' Add file');

  /* Linking beats copying on a platform where the file is already in the
     user's cloud: one copy of the truth, and no second one to go stale. */
  const linkBtn = isPrivateStorage ? el('span.form-hint', {}, 'Puter Drive unavailable — upload from your device') : canPickFiles() && el('button.btn.btn-ghost.btn-sm', {
    type: 'button',
    html: icon('link', 14, 2),
    onclick: async () => {
      linkBtn.disabled = true;
      try {
        const items = await pickFiles({ multiple: true });
        for (const item of items) store.addLinkedAttachment(projectId, taskId, item);
        if (items.length) {
          renderAttachments();
          toast(items.length === 1
            ? 'Linked from your Puter Drive'
            : `${items.length} files linked from your Puter Drive`, { icon: 'link' });
        }
      } catch (err) {
        console.error(err);
        toast('Could not link that file', { icon: 'cloudOff' });
      } finally {
        linkBtn.disabled = false;
      }
    },
  }, ' Add from Puter');

  // ---- comments ----------------------------------------------------------

  const commentList = el('div.comment-list');

  function renderComments() {
    clear(commentList);
    if (!task.comments.length) {
      commentList.append(el('p.form-hint', {}, 'No comments yet.'));
      return;
    }
    for (const c of task.comments) {
      commentList.append(el('div.comment', {},
        accentAvatar(c.author, 28),
        el('div.comment-body', {},
          el('div.comment-head', {},
            el('span.comment-author', {}, c.author),
            el('span.comment-time', {}, relativeTime(c.createdAt)),
            el('button.icon-btn.small.comment-del', {
              html: icon('trash', 13, 2),
              'aria-label': 'Delete comment',
              onclick: () => {
                const removed = store.deleteComment(projectId, taskId, c.id);
                renderComments();
                if (!removed) return;
                toast('Comment deleted', {
                  icon: 'trash',
                  duration: 7000,
                  action: {
                    label: 'Undo',
                    onClick: () => {
                      store.restoreComment(projectId, taskId, removed);
                      renderComments();
                    },
                  },
                });
              },
            })
          ),
          markdownView(c.text, 'comment-text')
        )
      ));
    }
  }

  const commentInput = el('textarea.input', {
    rows: 2,
    placeholder: 'Write a comment…',
    'aria-label': 'New comment',
    onkeydown: (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComment(); }
    },
  });

  function submitComment() {
    const text = commentInput.value.trim();
    if (!text) return;
    store.addComment(projectId, taskId, text);
    commentInput.value = '';
    renderComments();
    commentList.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  // ---- task actions ------------------------------------------------------

  /* One overflow menu keeps the footer to "more" plus the destructive
     action, instead of a row of four buttons that wraps on a phone. */
  async function copyLink() {
    const { origin, pathname, search } = location;
    const url = `${origin}${pathname}${search}${taskHash(projectId, taskId)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied', { icon: 'link' });
    } catch {
      // Clipboard access can be denied (permissions, insecure origin).
      toast('Could not copy the link', { icon: 'cloudOff' });
    }
  }

  function duplicate() {
    const copy = store.duplicateTask(projectId, taskId);
    if (!copy) return;
    // Route straight to the copy — renaming it is almost always the next
    // step. The shell swaps the sheet; calling close() first would queue a
    // history pop that lands back on the board.
    openTaskSheet(projectId, copy.id);
    toast('Task duplicated', { icon: 'copy' });
  }

  function archive() {
    modal.close();
    store.archiveTask(projectId, taskId);
    toast('Task archived', {
      icon: 'archive',
      duration: 7000,
      action: {
        label: 'Undo',
        onClick: () => {
          store.unarchiveTask(projectId, taskId);
          openTaskSheet(projectId, taskId);
        },
      },
    });
  }

  const moreBtn = el('button.btn.btn-ghost.btn-sm', {
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: () => openMenu(moreBtn, [
      { label: 'Copy link', icon: 'link', onClick: copyLink },
      { label: 'Duplicate task', icon: 'copy', onClick: duplicate },
      {
        label: 'Archive task',
        icon: 'archive',
        onClick: archive,
      },
    ]),
  }, 'More', el('span.sheet-more-caret', { html: icon('chevDown', 14, 2.4), 'aria-hidden': 'true' }));

  // ---- assemble ----------------------------------------------------------

  const content = el('div.sheet', {},
    titleInput,
    el('div.sheet-grid', {},
      columnField, priorityField,
      dateField('Start date', 'startDate'), dateField('Due date', 'dueDate'),
      remindField, milestoneField,
      repeatField
    ),
    assigneeField,
    labelField,
    el('div.field', {},
      el('div.row.row-between.desc-head', {},
        el('span.label', {}, 'Description'),
        descEditBtn
      ),
      descView, descInput, descHint
    ),
    checklist,
    el('div.field', {},
      el('div.row.row-between', {},
        attachLabel,
        el('span.row', {}, linkBtn || null, uploadBtn, fileInput)
      ),
      attachList
    ),
    el('div.field', {},
      el('span.label', {}, 'Comments'),
      commentList,
      el('div.comment-compose', {},
        commentInput,
        el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: submitComment }, 'Comment')
      )
    ),
    el('div.sheet-foot', {},
      el('span.form-hint', {}, `Created ${new Date(task.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`),
      moreBtn,
      el('button.btn.btn-danger-ghost.btn-sm', {
        html: icon('trash', 14, 2),
        // No confirm: the delete goes to the project trash and the toast
        // offers an immediate undo.
        onclick: () => {
          modal.close();
          store.deleteTask(projectId, taskId);
          toast('Task moved to trash', {
            icon: 'trash',
            duration: 7000,
            action: {
              label: 'Undo',
              onClick: () => {
                store.restoreTask(projectId, taskId);
                openTaskSheet(projectId, taskId);
              },
            },
          });
        },
      }, ' Delete task')
    )
  );

  renderAttachments();
  renderComments();
  renderDescView();
  syncRepeat();
  syncRemind();
  descInput.hidden = true;
  descHint.hidden = true;
  descEditBtn.textContent = 'Edit';

  const modal = openModal({
    title: 'Task',
    content,
    wide: true,
    // The checklist holds window-level pointer listeners for reordering.
    onClose: () => { checklist.destroy?.(); onClose?.(); },
  });
  return modal;
}
