import { persistInput } from '../lib/private-browser.js';
import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { store, docBrief } from '../lib/store.js';
import { markdownFragment } from './markdown.js';

/**
 * The project brief: what the project is for, what "done" means, where the
 * files live. Markdown, rendered by default and edited in place — the same
 * arrangement a task description has, down to the debounced autosave, so
 * there is no second editor and no second renderer.
 *
 * The panel owns its DOM across the board's re-renders (a rebuild mid-edit
 * would pull focus out of the textarea), so nothing here is thrown away by
 * render(); state is carried on `hidden` and class flags instead.
 *
 * Collapsed by default, remembered per project: a brief should inform the
 * board, not eat it. That memory is a per-device view preference, so it lives
 * in localStorage rather than costing a KV write on every toggle.
 */

const LS_KEY = 'pm:brief-open:v1';

function expandedProjects() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function rememberExpanded(projectId, open) {
  const ids = expandedProjects();
  if (open) ids.add(projectId);
  else ids.delete(projectId);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...ids]));
  } catch { /* private mode, or a full quota: the panel still works */ }
}

const PLACEHOLDER = 'What is this project for? What does done mean? '
  + 'Where do the spec and the files live? Markdown is supported';

/** briefPanel({ projectId }) → node with .destroy() */
export function briefPanel({ projectId }) {
  const text = () => docBrief(store.getDoc(projectId)).trim();

  let editing = false;
  let expanded = expandedProjects().has(projectId);

  const input = el('textarea.input.brief-input', {
    rows: 6,
    placeholder: PLACEHOLDER,
    'aria-label': 'Project brief',
    oninput: persistInput(() => save(), 500),
    onkeydown: (e) => {
      if (e.isComposing) return;
      // Escape and Cmd/Ctrl+Enter both mean "done editing", as in the task
      // sheet's description.
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        setEditing(false, { restoreFocus: true });
      }
    },
    onblur: () => setEditing(false),
  });

  const hint = el('p.form-hint.brief-hint', {},
    '**bold**, *italic*, `code`, # heading, > quote, - list, [link](https://…)');

  const body = el('div.md.brief-body', {
    role: 'button',
    tabindex: 0,
    onclick: (e) => {
      // Following a link inside the brief must not open the editor.
      if (e.target.closest('a')) return;
      activateBody();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateBody(); }
    },
  });

  const moreBtn = el('button.brief-more', {
    type: 'button',
    'aria-expanded': 'false',
    onclick: () => setExpanded(!expanded),
  });

  const editBtn = el('button.btn.btn-ghost.btn-sm.brief-edit', {
    type: 'button',
    // Pressing the button while editing must not blur the textarea first: its
    // blur handler would close the editor and this click would reopen it, so
    // "Done" would look like it did nothing (the task sheet has the same guard).
    onmousedown: (e) => { if (editing) e.preventDefault(); },
    onclick: () => {
      const wasEditing = editing;
      setEditing(!wasEditing, { restoreFocus: wasEditing });
    },
  }, 'Edit');

  const addBtn = el('button.brief-add', {
    type: 'button',
    html: icon('fileText', 15, 2),
    onclick: () => setEditing(true),
  }, el('span', {}, ' Add a brief'));

  const head = el('div.brief-head', {},
    el('span.brief-label', {}, 'Overview'),
    el('span.grow'),
    editBtn
  );

  const root = el('section.brief', { 'aria-label': 'Project overview' },
    addBtn, head, body, moreBtn, input, hint);

  /**
   * Whether the two-line clamp hides anything — the only thing that justifies
   * a More/Less toggle. Answering it while expanded means measuring the
   * collapsed box, so the class goes on for one synchronous measurement and
   * comes straight back off. (The observer below re-runs on the size change
   * that causes, finds the box back where it was, and settles.)
   */
  function clampHides() {
    if (!expanded) return body.scrollHeight > body.clientHeight + 2;
    body.classList.add('collapsed');
    const hides = body.scrollHeight > body.clientHeight + 2;
    body.classList.remove('collapsed');
    return hides;
  }

  /**
   * Clicking the text means "show me the rest" while there is a rest to show,
   * and "let me edit it" once there is not. Measured at the moment of the
   * click rather than read off the More button, whose state depends on a
   * layout pass that may not have happened yet.
   */
  function activateBody() {
    if (!expanded && clampHides()) setExpanded(true);
    else setEditing(true);
  }

  function save() {
    const value = input.value.trim();
    if (value === text()) return;
    store.setProjectBrief(projectId, value);
  }

  function setEditing(on, { restoreFocus = false } = {}) {
    if (on === editing) return;
    editing = on;
    if (on) {
      input.value = docBrief(store.getDoc(projectId));
      // Editing a clamped brief while only two lines of it are visible would
      // be writing blind.
      if (!expanded) setExpanded(true, { render: false });
    } else {
      // Leaving the editor flushes the pending debounce, so the rendered view
      // below can never show stale text.
      save();
    }
    render();
    if (on) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (restoreFocus) {
      // Hiding the textarea drops focus on the floor. An emptied brief has no
      // Edit button left to hold it, so the add row takes it instead.
      (editBtn.hidden ? addBtn : editBtn).focus();
    }
  }

  function setExpanded(on, { render: doRender = true } = {}) {
    expanded = on;
    rememberExpanded(projectId, on);
    if (doRender) render();
  }

  /**
   * The toggle only earns its place when there is more to see, which is a
   * question about the rendered box — so it is measured, not guessed from the
   * length of the text. A ResizeObserver re-measures when the width changes
   * (and once on mount, where the panel is not in the document yet).
   */
  function syncMore() {
    if (editing || !text()) { moreBtn.hidden = true; return; }
    moreBtn.textContent = expanded ? 'Less' : 'More';
    moreBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    moreBtn.hidden = !clampHides();
    body.setAttribute('aria-label', moreBtn.hidden || expanded
      ? 'Project brief, activate to edit'
      : 'Project brief, activate to show all of it');
  }

  function render() {
    const brief = text();
    const empty = !brief && !editing;

    root.classList.toggle('is-empty', empty);
    addBtn.hidden = !empty;
    head.hidden = empty;
    editBtn.hidden = empty;
    body.hidden = editing || empty;
    input.hidden = !editing;
    hint.hidden = !editing;
    editBtn.textContent = editing ? 'Done' : 'Edit';

    if (!editing) {
      clear(body);
      if (brief) body.append(markdownFragment(brief));
      body.classList.toggle('collapsed', !expanded);
    }
    syncMore();
  }

  /* The panel is built before it is in the document, where nothing can be
     measured, so the first honest measurement waits for a frame; the observer
     covers every later change of width. Both are throttled in a background
     tab, which is exactly when nobody can see the toggle anyway. */
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => syncMore())
    : null;
  observer?.observe(body);
  const frame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => syncMore())
    : null;

  const onChange = (e) => {
    if (e.detail?.scope !== 'doc' || e.detail.projectId !== projectId) return;
    // Never yank the text out from under someone typing it; the editor is the
    // one writing these events anyway.
    if (editing) return;
    render();
  };
  store.addEventListener('change', onChange);

  root.destroy = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
    store.removeEventListener('change', onChange);
    // A pending debounce must still land: closing a tab mid-sentence is not
    // a reason to lose the sentence.
    if (editing) save();
  };

  render();
  return root;
}
