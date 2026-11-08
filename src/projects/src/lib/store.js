/**
 * Data layer on top of Puter.
 *
 * Storage design:
 *
 *  KV (small, hot, single-key reads — never kv.list() scans):
 *    pm:settings:v1  { theme, onboarded, sampleData }
 *    pm:projects:v1  [{ id, name, color, sample?, createdAt }]   (index)
 *    pm:trash:v1     [{ ...entry, deletedAt }]                   (deleted projects)
 *    pm:templates:v1 [{ id, name, createdAt, doc }]              (structure-only)
 *    pm:views:v1     [{ id, name, scope, filter, sort, group }]  (saved views)
 *
 *  FS (bulky, grows with use — one JSON document per project):
 *    projects-data/project-<id>.json
 *    projects-data/attachments/<projectId>/<taskId>/<attachmentId>-<name>
 *
 * Reads scale with the projects you open, not the total number of tasks,
 * and no KV listing is ever required. All mutations are optimistic: the
 * in-memory doc changes immediately, a debounced write persists it, and a
 * failed write surfaces through the 'save-error' event.
 */

import { storage, isPrivateStorage } from './storage.js';
import { uid, safeFileName } from './util.js';
import { todayISO } from './dates.js';
import { computeMove, orderForAppend, columnTasks, doneColumnIds } from './board.js';
import { normalizeRecurrence, nextOccurrenceDates, isRecurring } from './recurrence.js';
import { cloneTaskFields, cloneProjectDoc, templateFromDoc } from './duplicate.js';
import { zipFiles } from './zip.js';
import {
  SNAPSHOT_VERSION, snapshotName, parseSnapshotName, planSnapshotRetention,
  nextSnapshotName,
} from './snapshots.js';
import {
  BACKUP_APP, BACKUP_VERSION, BACKUP_JSON_NAME,
  attachmentEntryPath, validateBackup, prepareImportedProject,
} from './backup.js';
import { mirror, MIRROR_META, mirrorDocKey, looksOffline } from './mirror.js';
import { planProjectMove } from './projects.js';
import { normalizeSavedView, planViewReorder, ALL_SCOPE } from './savedviews.js';

const KV_SETTINGS = 'pm:settings:v1';
const KV_PROJECTS = 'pm:projects:v1';
const KV_TRASH = 'pm:trash:v1';
const KV_TEMPLATES = 'pm:templates:v1';
const KV_VIEWS = 'pm:views:v1';

/** How long a deleted task or project stays recoverable. */
export const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 3600 * 1000;

const DATA_DIR = 'projects-data';
const projectPath = (id) => `${DATA_DIR}/project-${id}.json`;
const attachmentDir = (projectId, taskId) => `${DATA_DIR}/attachments/${projectId}/${taskId}`;
const snapshotDir = (projectId) => `${DATA_DIR}/snapshots/project-${projectId}`;

import { PROJECT_COLORS, LABEL_COLORS, colorName } from './colors.js';

/* The palettes live in colors.js with the check every imported colour has to
   pass; they are re-exported here so nothing that reads them has to move. */
export { PROJECT_COLORS, LABEL_COLORS, colorName };

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

export const DEFAULT_COLUMNS = ['To do', 'In progress', 'Done'];

function isMissingFileError(err) {
  const code = err?.code ?? err?.error?.code;
  if (code === 'ENOENT') return true;
  if (typeof code === 'string' && /does_not_exist|not_found/.test(code)) return true;
  const msg = String(err?.message ?? err?.error?.message ?? '');
  return /no such file|not found|does not exist/i.test(msg);
}

export function blankTask(patch = {}) {
  return {
    id: uid(),
    title: '',
    description: '',
    columnId: null,
    order: 0,
    assigneeIds: [],
    labelIds: [],
    priority: null,
    startDate: null,
    dueDate: null,
    milestoneId: null,
    checklist: [],
    comments: [],
    attachments: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  };
}

/**
 * Checklists arrived after the first documents were written, so every reader
 * goes through here rather than trusting the field to exist.
 */
export function taskChecklist(task) {
  return Array.isArray(task?.checklist) ? task.checklist : [];
}

export function checklistProgress(task) {
  const items = taskChecklist(task);
  return { total: items.length, done: items.filter((i) => i.done).length };
}

/**
 * Deleted and archived tasks live beside `doc.tasks` rather than being
 * stamped in place, so every reader of `doc.tasks` keeps seeing exactly the
 * live tasks — no view, count, or future feature can leak them back in.
 */
export function docTrash(doc) {
  return Array.isArray(doc?.trash) ? doc.trash : [];
}

export function docArchive(doc) {
  return Array.isArray(doc?.archive) ? doc.archive : [];
}

/**
 * What the project is for, in Markdown. Briefs arrived after the first
 * documents were written, so every reader goes through here rather than
 * trusting the field to exist.
 */
export function docBrief(doc) {
  return typeof doc?.brief === 'string' ? doc.brief : '';
}

/**
 * A column's WIP limit: a positive whole number, or nothing at all. Capped so
 * a stray keypress cannot put "999999999" in a header.
 */
export function normalizeWipLimit(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : null;
}

/** How many days a done column waits before archiving, or null for never. */
export function normalizeArchiveDays(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : null;
}

export function blankProjectDoc({ id = uid(), name, color, ownerName }) {
  return {
    v: 1,
    id,
    name,
    color,
    brief: '',
    members: ownerName ? [{ id: uid(), name: ownerName, color: PROJECT_COLORS[0] }] : [],
    labels: [],
    columns: DEFAULT_COLUMNS.map((n, i) => ({
      id: uid(), name: n, done: i === DEFAULT_COLUMNS.length - 1,
    })),
    tasks: [],
    milestones: [],
    archive: [],
    trash: [],
  };
}

/**
 * When a task arrived in a done column, which is the only honest clock for
 * "it has sat here for a week" — `updatedAt` moves on every edit. Moving
 * within the same done column is not a fresh arrival; leaving one clears it.
 */
function stampDone(task, isDone, wasDone) {
  if (isDone && !wasDone) task.doneAt = Date.now();
  else if (!isDone && task.doneAt) task.doneAt = null;
}

const SAVE_DELAY = 500;

/** Same account, two windows: they tell each other what they just wrote. */
const SYNC_CHANNEL = 'pm:sync:v1';

/**
 * A file's identity at a moment in time. Two writers cannot both be right
 * about what the file says, so a write that finds a different stamp than
 * the one it loaded stops rather than overwriting.
 */
function stampOf(info) {
  if (!info) return null;
  const modified = info.modified ?? info.mtime ?? info.updated ?? null;
  const size = info.size ?? null;
  if (modified === null && size === null) return null;
  return `${modified}:${size}`;
}

export class ConflictError extends Error {
  constructor(projectId) {
    super('This project changed somewhere else');
    this.name = 'ConflictError';
    this.pmConflict = true;
    this.projectId = projectId;
  }
}

export class Store extends EventTarget {
  user = null;
  settings = { theme: 'system', onboarded: false, sampleData: false };
  projects = [];             // index entries
  deletedProjects = [];      // index entries with a deletedAt stamp
  templates = [];            // saved project structures
  views = [];                // saved filter + sort + group, per scope
  #docs = new Map();         // projectId → full doc
  #loads = new Map();        // projectId → the read that is fetching it
  #saveTimers = new Map();   // projectId → timeout id
  #pendingSaves = new Set(); // projectIds with a scheduled/failed write
  #saveGens = new Map();     // projectId → generation of the latest change
  #stamps = new Map();       // projectId → the file stamp this tab last saw
  #conflicts = new Set();    // projectIds whose file moved on underneath us
  #snapshotDays = new Map(); // projectId → the day its restore point was taken
  #channel = null;           // BroadcastChannel, when the browser has one
  /** True once a call failed for want of a connection; cleared by the next
   *  one that succeeds. Views read it; nothing else should. */
  offline = false;
  /** Projects whose local copy has not reached Puter yet. */
  #outbox = new Set();
  #attachmentCleanup = new Map(); // delete bytes only after their document commits
  #writes = new Map();       // projectId → the save that is in flight

  async init() {
    try {
      if (isPrivateStorage) this.user = await storage.getUser();
      const [user, settings, projects, trash, templates, views] = await Promise.all([
        isPrivateStorage ? this.user : Promise.resolve(storage.getUser()).catch(() => null),
        this.#kvGet(KV_SETTINGS),
        this.#kvGet(KV_PROJECTS),
        this.#kvGet(KV_TRASH),
        this.#kvGet(KV_TEMPLATES),
        this.#kvGet(KV_VIEWS),
      ]);
      if (isPrivateStorage) {
        if (settings !== null && (!settings || typeof settings !== 'object' || Array.isArray(settings))) throw new Error('Invalid settings data');
        for (const value of [projects, trash, templates, views]) {
          if (value !== null && !Array.isArray(value)) throw new Error('Invalid workspace index data');
        }
      }
      this.user = user;
      if (settings && typeof settings === 'object') this.settings = { ...this.settings, ...settings };
      this.projects = Array.isArray(projects) ? projects : [];
      this.deletedProjects = Array.isArray(trash) ? trash : [];
      this.templates = Array.isArray(templates) ? templates : [];
      this.views = (Array.isArray(views) ? views : [])
        .map(normalizeSavedView).filter(Boolean);
      this.#setOffline(false);
      this.#mirrorMeta();
    } catch (err) {
      if (isPrivateStorage) throw err;
      // No connection: boot from what this device already knows rather than
      // showing the "could not reach Puter" wall.
      const cached = await mirror.get(MIRROR_META);
      if (!cached) throw err;
      console.error(err);
      this.user = cached.user ?? null;
      this.settings = { ...this.settings, ...(cached.settings ?? {}) };
      this.projects = cached.projects ?? [];
      this.deletedProjects = cached.deletedProjects ?? [];
      this.templates = cached.templates ?? [];
      this.views = cached.views ?? [];
      this.#setOffline(true);
    }

    // Flush a pending debounce when the tab goes to the background — the
    // closest a page gets to a reliable "about to close" hook. (Guarded so
    // the store also runs under Node in tests.)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushAll();
      });
    }
    if (!isPrivateStorage) this.#openChannel();
    this.#watchConnection();
    await this.#loadOutbox();
  }

  // ---- offline -----------------------------------------------------------

  #setOffline(on) {
    if (this.offline === on) return;
    this.offline = on;
    this.#emit('connection', { offline: on });
  }

  /** Everything a cold, offline boot needs before any project is opened. */
  #mirrorMeta() {
    mirror.set(MIRROR_META, {
      user: this.user,
      settings: this.settings,
      projects: this.projects,
      deletedProjects: this.deletedProjects,
      templates: this.templates,
      views: this.views,
      savedAt: Date.now(),
    });
  }

  #watchConnection() {
    if (isPrivateStorage) return;
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => this.syncOutbox());
    window.addEventListener('offline', () => this.#setOffline(true));
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.syncOutbox();
      });
    }
  }

  /** Documents this device holds that Puter has not accepted yet. */
  async #loadOutbox() {
    if (!mirror.available()) return;
    for (const key of await mirror.keys()) {
      if (typeof key !== 'string' || !key.startsWith('doc:')) continue;
      const entry = await mirror.get(key);
      if (entry?.pending) this.#outbox.add(key.slice(4));
    }
    if (!this.#outbox.size) return;
    this.#emit('outbox', { count: this.#outbox.size });
    // Work from a previous session that never went out: send it now, before
    // anything reads a project and finds the older copy on the server.
    if (!this.offline) this.syncOutbox().catch((err) => console.error(err));
  }

  get pendingUploads() {
    return this.#outbox.size;
  }

  /**
   * Replay whatever never reached Puter. Each replay is a normal write, so
   * it goes through the same stale-file check — a document that moved on
   * elsewhere while this one was offline raises a conflict instead of
   * overwriting it.
   */
  async syncOutbox() {
    if (isPrivateStorage) return 0;
    if (!this.#outbox.size) {
      this.#setOffline(false);
      return 0;
    }
    let sent = 0;
    for (const projectId of [...this.#outbox]) {
      if (this.#conflicts.has(projectId)) continue;
      if (!this.#docs.has(projectId)) {
        const entry = await mirror.get(mirrorDocKey(projectId));
        if (!entry?.doc) { this.#outbox.delete(projectId); continue; }
        this.#docs.set(projectId, entry.doc);
        if (entry.stamp) this.#stamps.set(projectId, entry.stamp);
      }
      this.#pendingSaves.add(projectId);
      await this.#saveNow(projectId);
      if (!this.#outbox.has(projectId)) sent++;
    }
    if (sent) this.#emit('outbox', { count: this.#outbox.size, sent });
    return sent;
  }

  // ---- other windows ---------------------------------------------------

  /**
   * The cheap half of staying in sync: same-browser tabs tell each other
   * what they wrote, so a second tab notices immediately instead of on its
   * next save. Cross-device changes are caught by the stamp check below.
   */
  #openChannel() {
    if (typeof BroadcastChannel === 'undefined' || this.#channel) return;
    this.#channel = new BroadcastChannel(SYNC_CHANNEL);
    this.#channel.onmessage = (e) => this.#onRemote(e.data);
  }

  #broadcast(message) {
    try { this.#channel?.postMessage(message); } catch { /* nothing to do */ }
  }

  async #onRemote(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'index') {
      const [projects, trash] = await Promise.all([
        this.#kvGet(KV_PROJECTS), this.#kvGet(KV_TRASH),
      ]);
      if (Array.isArray(projects)) this.projects = projects;
      if (Array.isArray(trash)) this.deletedProjects = trash;
      this.#emit('change', { scope: 'projects' });
      return;
    }

    if (message.type !== 'doc' || !this.#docs.has(message.projectId)) return;
    const { projectId } = message;
    if (this.#pendingSaves.has(projectId)) {
      // We have unsaved work and the file moved on: saving now would throw
      // away whatever the other window just did.
      this.#markConflict(projectId);
      return;
    }
    // Nothing local to lose — take their version.
    this.reloadProject(projectId).catch((err) => console.error(err));
  }

  // ---- events ----------------------------------------------------------

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** True while any project has an unsaved (or failed) write. */
  get dirty() {
    return this.#pendingSaves.size > 0 || (isPrivateStorage && storage.dirty);
  }

  /**
   * The same question about one project. `dirty` is the right answer for
   * "may this tab close yet"; anything speaking for a project on screen has
   * to ask about that project, or it reports another one's trouble as its own.
   */
  hasPendingSave(projectId) {
    return this.#pendingSaves.has(projectId);
  }

  // ---- kv helpers ------------------------------------------------------

  async #kvGet(key) {
    const raw = await storage.kv.get(key);
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (error) { if (isPrivateStorage) throw error; return null; }
    }
    return raw;
  }

  async #kvSet(key, value) {
    await storage.kv.set(key, JSON.stringify(value));
  }

  /**
   * The project index is one key two windows both rewrite, so it is merged
   * rather than clobbered: create a project in one window and one in the
   * other, and both survive. Deletions have to be named, otherwise the
   * merge would resurrect what was just removed.
   */
  async #saveProjectIndex({ removed = [] } = {}) {
    if (isPrivateStorage) {
      // Do not merge a freshly read index into stale local state or refresh
      // its CAS revision. The index loaded at init is the write baseline.
      await this.#kvSet(KV_PROJECTS, this.projects);
      return;
    }
    const remote = await this.#kvGet(KV_PROJECTS).catch(() => null);
    const byId = new Map((Array.isArray(remote) ? remote : []).map((e) => [e.id, e]));
    for (const entry of this.projects) byId.set(entry.id, entry);
    for (const id of removed) byId.delete(id);
    this.projects = [...byId.values()];
    await this.#kvSet(KV_PROJECTS, this.projects);
    this.#mirrorMeta();
    this.#broadcast({ type: 'index' });
  }

  async #saveTrashIndex() {
    await this.#kvSet(KV_TRASH, this.deletedProjects);
    this.#mirrorMeta();
    this.#broadcast({ type: 'index' });
  }

  // ---- settings --------------------------------------------------------

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.#emit('change', { scope: 'settings' });
    this.#mirrorMeta();
    await this.#kvSet(KV_SETTINGS, this.settings);
  }

  // ---- projects --------------------------------------------------------

  projectEntry(id) {
    return this.projects.find((p) => p.id === id) || null;
  }

  async createProject({ name, color, sample = false, doc = null }) {
    const finalDoc = doc || blankProjectDoc({
      name, color, ownerName: this.user?.username || 'Me',
    });
    finalDoc.name = name ?? finalDoc.name;
    finalDoc.color = color ?? finalDoc.color;

    const entry = {
      id: finalDoc.id,
      name: finalDoc.name,
      color: finalDoc.color,
      sample,
      createdAt: Date.now(),
    };

    // Persist before exposing: a failed write must not leave a phantom
    // project in the sidebar that would vanish on the next reload.
    await this.#writeDoc(finalDoc);
    this.#docs.set(finalDoc.id, finalDoc);
    this.projects = [...this.projects, entry];
    try {
      await this.#saveProjectIndex();
    } catch (err) {
      this.#docs.delete(finalDoc.id);
      this.projects = this.projects.filter((p) => p.id !== finalDoc.id);
      storage.fs.delete(projectPath(finalDoc.id)).catch(() => {});
      throw err;
    }
    this.#emit('change', { scope: 'projects' });
    return finalDoc;
  }

  /**
   * Four things want every project at once — the agenda, search, the
   * palette, the reminder pass — so two of them overlapping used to mean two
   * reads of the same file, and two documents where there should be one. The
   * second read would replace the first in `#docs`, discarding whatever the
   * open pass had already done to it (a caught-up recurrence, a swept trash).
   * One read per project is shared by everyone who asked while it was in
   * flight.
   */
  loadProject(id) {
    if (this.#docs.has(id)) return Promise.resolve(this.#docs.get(id));
    let pending = this.#loads.get(id);
    if (!pending) {
      pending = this.#readProject(id).finally(() => {
        if (this.#loads.get(id) === pending) this.#loads.delete(id);
      });
      this.#loads.set(id, pending);
    }
    return pending;
  }

  async #readProject(id) {
    const path = projectPath(id);
    let doc;
    let stamp = null;
    try {
      // The stamp is read alongside the document, so the very first save
      // already knows what it is allowed to overwrite.
      const [blob, current] = await Promise.all([storage.fs.read(path), this.#stat(path)]);
      doc = JSON.parse(await blob.text());
      stamp = current;
      this.#setOffline(false);
      if (this.#outbox.has(id)) {
        // Local work from an offline session has not been sent yet, so the
        // copy on this device is the newer one. It keeps the stamp it was
        // based on, so sending it can still detect a document that changed
        // elsewhere while this one was away.
        const pendingCopy = await mirror.get(mirrorDocKey(id));
        if (pendingCopy?.doc) {
          doc = pendingCopy.doc;
          stamp = pendingCopy.stamp ?? current;
          this.#pendingSaves.add(id);
        }
      } else {
        mirror.set(mirrorDocKey(id), { doc, savedAt: Date.now(), pending: false, stamp: current });
      }
    } catch (err) {
      const cached = !isMissingFileError(err) && await mirror.get(mirrorDocKey(id));
      if (!cached?.doc) throw err;
      /* Offline, or the read failed: show what this device last saw — and keep
         the stamp that copy was based on. An unset stamp is not "check the
         file", it is the first-write case, which skips the check entirely: a
         document that moved on elsewhere while this device was away would then
         be overwritten without a word. With the baseline restored, sending
         this copy raises a conflict and the user chooses, which is the whole
         point of writing the stamp into the mirror in the first place. */
      console.error(err);
      this.#setOffline(true);
      doc = cached.doc;
      stamp = cached.stamp ?? null;
      if (cached.pending) this.#outbox.add(id);
    }
    this.#docs.set(id, doc);
    this.#stamps.set(id, stamp);
    // Opening a project is the only moment the trash is swept, recurring
    // work is caught up, and old restore points are dropped; none of them
    // writes unless there was something to do.
    this.purgeOldTrash(id);
    this.catchUpRecurring(id);
    this.autoArchiveDone(id);
    this.purgeSnapshots(id).catch((err) => console.error(err));
    // Anything that summarizes across projects (the agenda badge) can only
    // count what is in memory, so say when more arrives.
    this.#emit('change', { scope: 'loaded', projectId: id });
    return doc;
  }

  /** The loaded doc, or null when it isn't in memory yet. */
  getDoc(id) {
    return this.#docs.get(id) || null;
  }

  /**
   * Every project, for the things that have to look across all of them
   * (search, the palette, the agenda). One read per project, cached after
   * the first, and a project that cannot be read is counted rather than
   * failing the whole lot.
   *
   * `archived: false` leaves archived projects out. The agenda and the
   * reminder pass throw their tasks away regardless, so reading them is a
   * round trip per project for an answer nobody uses — and the archive is
   * where a finished project goes to stop costing anything. Search and the
   * command palette want them, because work you cannot find is work you have
   * lost.
   */
  async loadAllProjects({ archived = true } = {}) {
    const entries = archived ? this.projects : this.projects.filter((p) => !p.archived);
    const loaded = await Promise.all(entries.map((entry) =>
      this.loadProject(entry.id).then((doc) => ({ entry, doc })).catch(() => null)));
    return {
      docs: loaded.filter(Boolean),
      failed: loaded.filter((d) => !d).length,
    };
  }

  async updateProjectMeta(id, patch) {
    this.projects = this.projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
    this.#emit('change', { scope: 'projects' });
    // The doc mirrors name/color (exports read it), so pull it in if it
    // was never opened rather than leaving the file stale.
    const doc = this.#docs.get(id) ?? await this.loadProject(id).catch(() => null);
    if (doc) {
      Object.assign(doc, patch);
      this.#scheduleSave(id);
    }
    await this.#saveProjectIndex();
  }

  /**
   * Pin a project to the top of every list that shows one. Like archiving,
   * this is a flag on the index entry, so it costs one small KV write and
   * never opens the document.
   */
  async setProjectPinned(id, pinned) {
    if (!this.projectEntry(id)) return null;
    this.projects = this.projects.map((p) => (p.id === id ? { ...p, pinned: !!pinned } : p));
    this.#emit('change', { scope: 'projects' });
    await this.#saveProjectIndex();
    return this.projectEntry(id);
  }

  /**
   * Move a project to `toIndex` within its own group (pinned or not). The
   * arrangement is stored per entry, so the index still merges by id and two
   * windows reordering at once cannot lose a project.
   */
  async moveProject(id, toIndex) {
    const rewrites = planProjectMove(this.projects, id, toIndex);
    if (!rewrites.length) return false;
    const orders = new Map(rewrites.map((r) => [r.id, r.order]));
    this.projects = this.projects.map((p) => (orders.has(p.id)
      ? { ...p, order: orders.get(p.id) } : p));
    this.#emit('change', { scope: 'projects' });
    await this.#saveProjectIndex();
    return true;
  }

  /**
   * The brief lives on the document rather than the index entry: it is prose,
   * and the index is read on every boot. Nothing else has to know it changed —
   * the panel that shows it renders from the same doc events every view does.
   */
  setProjectBrief(id, text) {
    return this.mutate(id, (doc) => {
      doc.brief = String(text ?? '');
      return doc.brief;
    });
  }

  #forgetProject(id) {
    this.#loads.delete(id);
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);
    this.#pendingSaves.delete(id);
    this.#saveGens.delete(id);
    this.#stamps.delete(id);
    this.#conflicts.delete(id);
    this.#snapshotDays.delete(id);
    this.#outbox.delete(id);
    this.#docs.delete(id);
    mirror.del(mirrorDocKey(id));
  }

  /**
   * Soft delete: the index entry moves to the trash index and the document
   * (with its attachments) stays on disk, so a delete stays recoverable for
   * TRASH_DAYS. purgeProject() is the irreversible one.
   */
  async deleteProject(id) {
    const entry = this.projectEntry(id);
    if (!entry) return null;
    // Land any pending write first: the file on disk is what a restore brings back.
    if (this.#pendingSaves.has(id)) {
      clearTimeout(this.#saveTimers.get(id));
      await this.#saveNow(id);
      if (isPrivateStorage && this.hasPendingSave(id)) throw new Error('Unsaved edits must be saved or exported before deleting');
    }
    this.#forgetProject(id);

    const trashed = { ...entry, deletedAt: Date.now() };
    const prevTrash = this.deletedProjects;
    this.deletedProjects = [trashed, ...this.deletedProjects];
    // Trash index first: if the second write fails the project is listed
    // twice rather than nowhere, and its file is never orphaned.
    await this.#saveTrashIndex();
    this.projects = this.projects.filter((p) => p.id !== id);
    try {
      await this.#saveProjectIndex({ removed: [id] });
    } catch (err) {
      this.deletedProjects = prevTrash;
      this.projects = [...this.projects, entry];
      this.#saveTrashIndex().catch(() => {});
      throw err;
    }
    this.#emit('change', { scope: 'projects' });
    return trashed;
  }

  /** Put a trashed project back in the sidebar. */
  async restoreProject(id) {
    const trashed = this.deletedProjects.find((p) => p.id === id);
    if (!trashed) return null;
    const { deletedAt, ...entry } = trashed;
    this.projects = [...this.projects, entry];
    await this.#saveProjectIndex();
    this.deletedProjects = this.deletedProjects.filter((p) => p.id !== id);
    await this.#saveTrashIndex();
    this.#emit('change', { scope: 'projects' });
    return entry;
  }

  /** Irreversible: drops the document, its attachments, and both entries. */
  async purgeProject(id) {
    if (isPrivateStorage && (this.dirty || storage.conflict)) throw new Error('Unsaved edits must be saved or exported before purging');
    this.#forgetProject(id);
    const wasListed = this.projects.some((p) => p.id === id);
    this.projects = this.projects.filter((p) => p.id !== id);
    this.deletedProjects = this.deletedProjects.filter((p) => p.id !== id);
    if (wasListed) await this.#saveProjectIndex({ removed: [id] });
    await this.#saveTrashIndex();
    this.#emit('change', { scope: 'projects' });
    // Best-effort cleanup; a dangling file is invisible without its index entry.
    storage.fs.delete(projectPath(id)).catch(() => {});
    storage.fs.delete(`${DATA_DIR}/attachments/${id}`, { recursive: true }).catch(() => {});
    storage.fs.delete(snapshotDir(id), { recursive: true }).catch(() => {});
  }

  /** Called on boot: trash is a grace period, not a second archive. */
  async purgeOldDeletedProjects(now = Date.now()) {
    const stale = this.deletedProjects.filter((p) => now - (p.deletedAt ?? 0) > TRASH_MS);
    for (const p of stale) await this.purgeProject(p.id);
    return stale.length;
  }

  // ---- persistence -----------------------------------------------------

  /** What the file on disk looks like right now, or null when unknowable. */
  async #stat(path) {
    if (typeof storage.fs?.stat !== 'function') return null;
    try {
      return stampOf(await storage.fs.stat(path));
    } catch (err) {
      // A missing file is not a conflict — it is a first write.
      if (isMissingFileError(err)) return null;
      console.error(err);
      return null;
    }
  }

  /**
   * Every write first checks that the file is still the one this tab loaded.
   * It costs a stat per save, which is the price of never silently throwing
   * away what another window or device wrote.
   *
   * `force` is the user answering "keep mine" to that question.
   */
  async #writeDoc(doc, { force = false } = {}) {
    const path = projectPath(doc.id);
    const known = this.#stamps.get(doc.id);
    if (isPrivateStorage) {
      // Atomic server CAS, not the cloud stat-then-write approximation.
      await storage.fs.write(path, JSON.stringify(doc));
      return;
    }
    if (known && !force) {
      const current = await this.#stat(path);
      if (current && current !== known) throw new ConflictError(doc.id);
    }
    const result = await storage.fs.write(path, JSON.stringify(doc), { createMissingParents: true });
    // Prefer what the write itself reported; stat only when it said nothing.
    this.#stamps.set(doc.id, stampOf(result) ?? await this.#stat(path));
  }

  #markConflict(projectId) {
    clearTimeout(this.#saveTimers.get(projectId));
    this.#saveTimers.delete(projectId);
    this.#pendingSaves.add(projectId);
    if (this.#conflicts.has(projectId)) return;
    this.#conflicts.add(projectId);
    this.#emit('conflict', { projectId });
  }

  /** True while a project is holding local changes it must not write. */
  hasConflict(projectId) {
    return this.#conflicts.has(projectId);
  }

  #scheduleSave(projectId) {
    this.#saveGens.set(projectId, (this.#saveGens.get(projectId) ?? 0) + 1);
    this.#pendingSaves.add(projectId);
    this.#emit('saving', { projectId });
    // A conflicted project keeps collecting changes in memory, but nothing
    // goes to disk until the user has chosen which copy wins.
    if (this.#conflicts.has(projectId)) return;
    clearTimeout(this.#saveTimers.get(projectId));
    this.#saveTimers.set(projectId, setTimeout(() => this.#saveNow(projectId), SAVE_DELAY));
  }

  /**
   * One write per project at a time. The debounce timer, the flush when a
   * tab goes hidden, and the replay when a connection returns can each start
   * a save, and two of them in flight together used to check the file
   * against each other: the second one's stat would find the stamp the
   * first had just written and call it a conflict — "This project changed
   * somewhere else", about a change this very tab had made, with a Reload
   * button that throws the local copy away. Queued instead, the second save
   * runs after the first has landed, and finds nothing left to do.
   */
  #saveNow(projectId, opts = {}) {
    const previous = this.#writes.get(projectId);
    const run = (previous ? previous.catch(() => {}) : Promise.resolve())
      .then(() => this.#saveOnce(projectId, opts));
    this.#writes.set(projectId, run);
    run.finally(() => {
      if (this.#writes.get(projectId) === run) this.#writes.delete(projectId);
    }).catch(() => {});
    return run;
  }

  /** The save that is in flight for a project, so a caller that is about to
   *  replace the document can let it land first. */
  #settledWrite(projectId) {
    return (this.#writes.get(projectId) ?? Promise.resolve()).catch(() => {});
  }

  async #saveOnce(projectId, { force = false } = {}) {
    const doc = this.#docs.get(projectId);
    if (!doc) { this.#pendingSaves.delete(projectId); return; }
    // A save that waited its turn behind one that already landed everything.
    if (!this.#pendingSaves.has(projectId) && !force) return;
    if (this.#conflicts.has(projectId) && !force) return;
    // The doc is serialized when the write starts; a mutation racing the
    // write is NOT in the payload, so it must keep the project dirty (its
    // own debounce timer is already armed to persist it).
    const gen = this.#saveGens.get(projectId);
    // Local first: the mirror is what makes an unsent change survive the
    // tab closing, so it is written before anything can fail.
    await mirror.set(mirrorDocKey(projectId), {
      doc,
      savedAt: Date.now(),
      pending: true,
      // The stamp this copy is based on travels with it, so a replay days
      // later still notices a document that moved on in the meantime.
      stamp: this.#stamps.get(projectId) ?? null,
    });
    if (!isPrivateStorage) this.#outbox.add(projectId);
    try {
      await this.#snapshotDaily(projectId).catch((err) => console.error(err));
      // The ground can move while the snapshot is taken: the project is
      // purged, or a restore point replaces the document. What this save
      // holds is then a copy nothing owns, and writing it would bring back a
      // file that was deleted on purpose — or leave a stale pending entry in
      // the mirror for the next boot to replay over the restored one.
      if (!this.#docs.has(projectId)) {
        this.#outbox.delete(projectId);
        this.#pendingSaves.delete(projectId);
        await mirror.del(mirrorDocKey(projectId));
        return;
      }
      if (this.#docs.get(projectId) !== doc) return;
      // Bind cleanup to the document being serialized, not the live queue:
      // removals added during this write or a DELETE need their own commit.
      const cleanup = this.#attachmentCleanup.get(projectId);
      const cleanupBatch = [...(cleanup ?? [])];
      await this.#writeDoc(doc, { force });
      this.#conflicts.delete(projectId);
      this.#setOffline(false);
      // A mutation that raced the write is not in what just landed, so this
      // device is still ahead of Puter — and the mirror has to say so, or a
      // tab that dies inside the next debounce window would leave a copy
      // marked "sent" that nothing ever replays. Its own timer is already
      // armed; this only stops the record from lying in the meantime.
      let settled = this.#saveGens.get(projectId) === gen;
      if (settled) this.#outbox.delete(projectId);
      mirror.set(mirrorDocKey(projectId), {
        doc,
        savedAt: Date.now(),
        pending: !settled,
        stamp: this.#stamps.get(projectId) ?? null,
      });
      if (settled && isPrivateStorage) {
        for (const [path, options] of cleanupBatch) {
          await storage.fs.delete(path, options);
          cleanup.delete(path);
        }
        if (!cleanup?.size) this.#attachmentCleanup.delete(projectId);
        settled = this.#saveGens.get(projectId) === gen;
      }
      if (settled) {
        this.#pendingSaves.delete(projectId);
        this.#emit('saved', { projectId });
      }
      this.#broadcast({ type: 'doc', projectId, savedAt: Date.now() });
    } catch (err) {
      if (err?.pmConflict) {
        this.#outbox.delete(projectId);
        this.#markConflict(projectId);
        return;
      }
      console.error(err);
      if (!isPrivateStorage && looksOffline(err)) {
        // Not a failure to report as one: the change is on this device and
        // will go out when there is a connection.
        this.#setOffline(true);
        this.#emit('outbox', { count: this.#outbox.size });
        return;
      }
      // Stay dirty; the next mutation or an explicit retry re-attempts.
      this.#emit('save-error', { projectId, retry: () => this.#saveNow(projectId) });
    }
  }

  // ---- snapshots --------------------------------------------------------

  /**
   * A restore point rides along with normal use: the first save of the day
   * copies the version that was on disk *before* it, so "give me yesterday's
   * project" has an answer without a scheduler or a background job.
   *
   * It never blocks or fails a save — a snapshot that cannot be written is
   * logged and the save goes ahead.
   */
  async #snapshotDaily(projectId) {
    if (typeof storage.fs?.readdir !== 'function') return;
    const today = todayISO();
    if (this.#snapshotDays.get(projectId) === today) return;
    this.#snapshotDays.set(projectId, today);

    const existing = (await this.#snapshotNames(projectId)).map((f) => f.name);
    if (existing.some((name) => name.startsWith(today))) return;

    // The file still holds the pre-change document; the in-memory one has
    // already moved on, which is exactly the version we do not want.
    let previous = null;
    try {
      previous = JSON.parse(await (await storage.fs.read(projectPath(projectId))).text());
    } catch (err) {
      if (!isMissingFileError(err)) console.error(err);
      return; // nothing on disk yet: the project is brand new
    }
    await this.#writeSnapshot(projectId, previous, snapshotName(today));
  }

  async #writeSnapshot(projectId, doc, name) {
    const entry = this.projectEntry(projectId)
      ?? this.deletedProjects.find((p) => p.id === projectId)
      ?? { id: projectId, name: doc?.name, color: doc?.color };
    const payload = {
      v: SNAPSHOT_VERSION,
      takenAt: Date.now(),
      // The index entry travels with the document, so a restore can bring
      // back a project whose sidebar entry is gone.
      entry: { ...entry, id: projectId },
      doc,
    };
    await storage.fs.write(
      `${snapshotDir(projectId)}/${name}`,
      JSON.stringify(payload),
      { createMissingParents: true },
    );
  }

  async #snapshotNames(projectId) {
    if (typeof storage.fs?.readdir !== 'function') return [];
    try {
      const items = await storage.fs.readdir(snapshotDir(projectId));
      return (items ?? [])
        .map((item) => ({
          name: item?.name ?? String(item?.path ?? '').split('/').pop(),
          size: item?.size ?? 0,
          modified: item?.modified ?? null,
        }))
        .filter((f) => parseSnapshotName(f.name));
    } catch (err) {
      if (isPrivateStorage) throw err;
      if (!isMissingFileError(err)) console.error(err);
      return [];
    }
  }

  /** Restore points for one project, newest first. */
  async listSnapshots(projectId) {
    const files = await this.#snapshotNames(projectId);
    return files
      .map((f) => ({ ...f, ...parseSnapshotName(f.name) }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq);
  }

  /**
   * Every project that has restore points, including ones no longer in the
   * index — that is the hole a task-level trash cannot close.
   */
  async listSnapshotProjects() {
    if (typeof storage.fs?.readdir !== 'function') return [];
    let items = [];
    try {
      items = await storage.fs.readdir(`${DATA_DIR}/snapshots`) ?? [];
    } catch (err) {
      if (isPrivateStorage) throw err;
      if (!isMissingFileError(err)) console.error(err);
      return [];
    }
    const ids = items
      .map((item) => item?.name ?? String(item?.path ?? '').split('/').pop())
      .filter((name) => typeof name === 'string' && name.startsWith('project-'))
      .map((name) => name.slice('project-'.length));

    const rows = [];
    for (const id of ids) {
      const snapshots = await this.listSnapshots(id);
      if (!snapshots.length) continue;
      rows.push({
        id,
        entry: this.projectEntry(id)
          ?? this.deletedProjects.find((p) => p.id === id)
          ?? null,
        listed: !!this.projectEntry(id),
        snapshots,
      });
    }
    return rows;
  }

  /** Bounded retention, swept when a project is opened. */
  async purgeSnapshots(projectId) {
    const files = await this.#snapshotNames(projectId);
    if (!files.length) return 0;
    const { drop } = planSnapshotRetention(files.map((f) => f.name));
    for (const name of drop) {
      await storage.fs.delete(`${snapshotDir(projectId)}/${name}`).catch(() => {});
    }
    return drop.length;
  }

  /**
   * Put a restore point back. The current state is snapshotted first, so
   * restoring is itself reversible, and a project missing from the index
   * comes back with it.
   */
  async restoreSnapshot(projectId, name) {
    if (isPrivateStorage && (this.dirty || storage.conflict)) throw new Error('Export unsaved edits before restoring a snapshot');
    const gen = this.#saveGens.get(projectId);
    const blob = await storage.fs.read(`${snapshotDir(projectId)}/${name}`);
    const payload = JSON.parse(await blob.text());
    const restored = payload?.doc;
    if (!restored || !Array.isArray(restored.tasks)) {
      throw new Error('That restore point could not be read');
    }

    // Reversible: keep what is here now, under its own name.
    const current = this.#docs.get(projectId)
      ?? await this.loadProject(projectId).catch(() => null);
    if (current) {
      const existing = (await this.#snapshotNames(projectId)).map((f) => f.name);
      await this.#writeSnapshot(projectId, current, nextSnapshotName(existing, todayISO()))
        .catch((err) => console.error(err));
    }

    const doc = { ...restored, id: projectId };
    if (isPrivateStorage) {
      if (this.dirty || storage.conflict || this.#saveGens.get(projectId) !== gen) throw new Error('Unsaved edits changed while restoring; export them first');
      // Keep the current in-memory document until the server accepts CAS.
      await this.#writeDoc(doc);
      await this.#settledWrite(projectId);
      // Edits can arrive even while the restore response is pending. Do not
      // replace their document or cancel their debounce after acknowledging CAS.
      if (this.#saveGens.get(projectId) !== gen) throw new Error('Project changed while restoring; local edits were kept. Save or export them before retrying.');
    }
    clearTimeout(this.#saveTimers.get(projectId));
    this.#saveTimers.delete(projectId);
    // A save that is mid-flight holds the document being replaced; let it
    // land (or fail) before the restore writes over it.
    if (!isPrivateStorage) await this.#settledWrite(projectId);
    this.#pendingSaves.delete(projectId);
    this.#conflicts.delete(projectId);
    this.#outbox.delete(projectId);
    this.#docs.set(projectId, doc);
    // A restore is a deliberate overwrite of whatever is on disk.
    if (!isPrivateStorage) await this.#writeDoc(doc, { force: true });
    // The mirror follows: an offline read must show what was restored, not
    // the copy it replaced.
    mirror.set(mirrorDocKey(projectId), {
      doc, savedAt: Date.now(), pending: false, stamp: this.#stamps.get(projectId) ?? null,
    });
    this.#broadcast({ type: 'doc', projectId, savedAt: Date.now() });

    const entry = payload.entry ?? { id: projectId, name: doc.name, color: doc.color };
    if (!this.projectEntry(projectId)) {
      const { deletedAt, ...clean } = entry;
      this.projects = [...this.projects, { ...clean, id: projectId }];
      await this.#saveProjectIndex();
      if (this.deletedProjects.some((p) => p.id === projectId)) {
        this.deletedProjects = this.deletedProjects.filter((p) => p.id !== projectId);
        await this.#saveTrashIndex();
      }
    } else {
      this.projects = this.projects.map((p) => (p.id === projectId
        ? { ...p, name: doc.name ?? p.name, color: doc.color ?? p.color } : p));
      await this.#saveProjectIndex();
    }

    this.#emit('change', { scope: 'doc', projectId });
    this.#emit('change', { scope: 'projects' });
    return doc;
  }

  // ---- resolving a conflict --------------------------------------------

  /** "Reload": drop everything local and take what is on disk. */
  async reloadProject(projectId) {
    if (isPrivateStorage) throw new Error('Export unsaved edits, then explicitly reload the page');
    clearTimeout(this.#saveTimers.get(projectId));
    this.#saveTimers.delete(projectId);
    // A write still in flight would land the copy being dropped on top of
    // the one being read; it goes first, whichever way it ends.
    await this.#settledWrite(projectId);
    this.#pendingSaves.delete(projectId);
    this.#saveGens.delete(projectId);
    this.#conflicts.delete(projectId);
    this.#stamps.delete(projectId);
    this.#docs.delete(projectId);
    // Whatever was in flight was reading the version we are replacing.
    this.#loads.delete(projectId);
    const doc = await this.loadProject(projectId);
    this.#emit('change', { scope: 'doc', projectId });
    return doc;
  }

  /** "Keep mine": overwrite the other copy, deliberately. */
  async forceSave(projectId) {
    if (isPrivateStorage) throw new Error('Keep mine is disabled; export edits before reloading');
    this.#pendingSaves.add(projectId);
    await this.#saveNow(projectId, { force: true });
    return !this.#conflicts.has(projectId);
  }

  /** Run every pending debounced write now. Resolves when all attempts settle. */
  flushAll() {
    return Promise.allSettled([...this.#pendingSaves].map((id) => {
      clearTimeout(this.#saveTimers.get(id));
      return this.#saveNow(id);
    }));
  }

  /**
   * Every task/column/milestone mutation funnels through here: apply the
   * change to the in-memory doc, notify views, schedule the debounced write.
   */
  mutate(projectId, fn) {
    const doc = this.#docs.get(projectId);
    if (!doc) throw new Error(`Project ${projectId} is not loaded`);
    const result = fn(doc);
    this.#emit('change', { scope: 'doc', projectId });
    this.#scheduleSave(projectId);
    return result;
  }

  // ---- tasks -----------------------------------------------------------

  addTask(projectId, columnId, patch) {
    return this.mutate(projectId, (doc) => {
      const task = blankTask({
        ...patch,
        columnId,
        order: orderForAppend(doc.tasks, columnId),
      });
      doc.tasks.push(task);
      return task;
    });
  }

  updateTask(projectId, taskId, patch) {
    return this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      Object.assign(task, patch, { updatedAt: Date.now() });
      return task;
    });
  }

  moveTask(projectId, taskId, toColumnId, toIndex) {
    let spawned = null;
    const moved = this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      const doneIds = doneColumnIds(doc);
      const wasDone = doneIds.has(task.columnId);
      const { order, renormalize } = computeMove(doc.tasks, taskId, toColumnId, toIndex);
      if (renormalize) {
        const orders = new Map(renormalize.map((r) => [r.id, r.order]));
        for (const t of doc.tasks) if (orders.has(t.id)) t.order = orders.get(t.id);
      }
      task.columnId = toColumnId;
      task.order = order;
      task.updatedAt = Date.now();
      stampDone(task, doneIds.has(toColumnId), wasDone);
      // Reaching a done column is what materializes the next occurrence.
      if (!wasDone && doneIds.has(toColumnId)) spawned = this.#spawnRecurrence(doc, task);
      return task;
    });
    if (spawned) {
      this.#emit('recurrence-spawned', { projectId, taskId, next: spawned });
    }
    return moved;
  }

  // ---- bulk edits ------------------------------------------------------

  /**
   * A selection is edited in one mutation rather than one per task: N
   * single-task calls would re-render every view N times and schedule the
   * same write N times over. Each returns the ids it actually touched, so
   * the caller can report and undo exactly what happened.
   */
  bulkUpdateTasks(projectId, taskIds, patch) {
    return this.bulkPatchTasks(projectId, taskIds.map((id) => ({ id, ...patch })));
  }

  /**
   * A different patch per task, still in one mutation — what undoing a bulk
   * edit needs, since every task had its own value before it.
   */
  bulkPatchTasks(projectId, patches) {
    return this.mutate(projectId, (doc) => {
      const byId = new Map(doc.tasks.map((t) => [t.id, t]));
      const touched = [];
      for (const { id, ...patch } of patches) {
        const task = byId.get(id);
        if (!task) continue;
        Object.assign(task, patch, { updatedAt: Date.now() });
        touched.push(id);
      }
      return touched;
    });
  }

  /**
   * Stamp the day a reminder was raised, so it cannot fire twice.
   *
   * `updatedAt` is deliberately left alone, for the same reason
   * setTaskOrders() leaves it alone: a reminder the app raised on its own is
   * not an edit anyone made. Writing it through a normal patch made "Last
   * updated" read "just now" for every overdue task on the first pass of the
   * day, and re-sorted a list ordered by it under whoever was reading.
   *
   * Nothing is written when there is nothing to stamp, so the pass costs no
   * save on the second visit of the day.
   */
  markRemindersShown(projectId, taskIds, day) {
    const doc = this.getDoc(projectId);
    if (!doc) return [];
    const ids = new Set(taskIds);
    const pending = doc.tasks.filter((t) => ids.has(t.id) && t.remindedOn !== day);
    if (!pending.length) return [];
    return this.mutate(projectId, () => {
      for (const task of pending) task.remindedOn = day;
      return pending.map((t) => t.id);
    });
  }

  /** Add or remove one label / assignee across a selection. */
  bulkToggleTaskRef(projectId, taskIds, field, refId, on) {
    const ids = new Set(taskIds);
    return this.mutate(projectId, (doc) => {
      const touched = [];
      for (const task of doc.tasks) {
        if (!ids.has(task.id)) continue;
        const current = task[field] ?? [];
        const has = current.includes(refId);
        if (on === has) continue;
        task[field] = on ? [...current, refId] : current.filter((x) => x !== refId);
        task.updatedAt = Date.now();
        touched.push(task.id);
      }
      return touched;
    });
  }

  /**
   * Move a selection to the end of a column, keeping the order they were
   * given in. Recurrence still fires: a bulk move into a done column is a
   * completion like any other.
   */
  bulkMoveTasks(projectId, taskIds, toColumnId) {
    const spawned = [];
    const moved = this.mutate(projectId, (doc) => {
      if (!doc.columns.some((c) => c.id === toColumnId)) return [];
      const doneIds = doneColumnIds(doc);
      const touched = [];
      for (const id of taskIds) {
        const task = doc.tasks.find((t) => t.id === id);
        if (!task || task.columnId === toColumnId) continue;
        const wasDone = doneIds.has(task.columnId);
        task.columnId = toColumnId;
        task.order = orderForAppend(doc.tasks.filter((t) => t !== task), toColumnId);
        task.updatedAt = Date.now();
        stampDone(task, doneIds.has(toColumnId), wasDone);
        if (!wasDone && doneIds.has(toColumnId)) {
          const next = this.#spawnRecurrence(doc, task);
          // The task that handed the series over travels with its successor:
          // undoing the completion has to reopen the one and remove the other.
          if (next) spawned.push({ taskId: task.id, next });
        }
        touched.push(task.id);
      }
      return touched;
    });
    for (const { taskId, next } of spawned) {
      this.#emit('recurrence-spawned', { projectId, taskId, next, quiet: true });
    }
    return moved;
  }

  bulkArchiveTasks(projectId, taskIds) {
    const ids = new Set(taskIds);
    return this.mutate(projectId, (doc) => {
      const moving = doc.tasks.filter((t) => ids.has(t.id));
      if (!moving.length) return [];
      if (!Array.isArray(doc.archive)) doc.archive = [];
      doc.tasks = doc.tasks.filter((t) => !ids.has(t.id));
      const at = Date.now();
      for (const t of moving) doc.archive.unshift({ ...t, archivedAt: at });
      return moving.map((t) => t.id);
    });
  }

  bulkDeleteTasks(projectId, taskIds) {
    const ids = new Set(taskIds);
    return this.mutate(projectId, (doc) => {
      const moving = doc.tasks.filter((t) => ids.has(t.id));
      if (!moving.length) return [];
      if (!Array.isArray(doc.trash)) doc.trash = [];
      doc.tasks = doc.tasks.filter((t) => !ids.has(t.id));
      const at = Date.now();
      for (const t of moving) doc.trash.unshift({ ...t, deletedAt: at });
      return moving.map((t) => t.id);
    });
  }

  /** Undo for the two above: both put tasks back through the same re-homing. */
  bulkRestoreTasks(projectId, taskIds, from = 'trash') {
    const ids = new Set(taskIds);
    const read = from === 'archive' ? docArchive : docTrash;
    return this.mutate(projectId, (doc) => {
      const stored = read(doc).filter((t) => ids.has(t.id));
      if (!stored.length) return [];
      doc[from] = read(doc).filter((t) => !ids.has(t.id));
      return stored.map((t) => this.#revive(doc, t).id);
    });
  }

  // ---- recurrence ------------------------------------------------------

  setRecurrence(projectId, taskId, rule) {
    const normalized = normalizeRecurrence(rule);
    return this.updateTask(projectId, taskId, {
      recurrence: normalized,
      // Setting a fresh rule reopens the series on this task.
      recurrenceClosed: normalized ? false : undefined,
    });
  }

  /**
   * Copy the task into the first column with its dates moved on, checklist
   * unticked, and no comments or attachments. The completed task keeps its
   * rule but is marked closed, so exactly one live carrier exists and
   * re-completing it can never double up.
   */
  #spawnRecurrence(doc, task) {
    if (!isRecurring(task)) return null;
    const rule = normalizeRecurrence(task.recurrence);
    const target = doc.columns[0];
    if (!target) return null;
    const { startDate, dueDate } = nextOccurrenceDates(task, rule);
    const next = blankTask({
      ...cloneTaskFields(task, { resetChecklist: true }),
      title: task.title,
      recurrence: rule,
      // The successor is the series' new live carrier, whatever the task it
      // was cloned from had already handed over.
      recurrenceClosed: false,
      startDate,
      dueDate,
      columnId: target.id,
      order: orderForAppend(doc.tasks, target.id),
    });
    doc.tasks.push(next);
    task.recurrenceClosed = true;
    return next;
  }

  /**
   * Defensive catch-up on project open: a recurring task sitting in a done
   * column with its series still open never got its successor (a failed
   * write, a crash, an older build), so create it now.
   */
  catchUpRecurring(projectId) {
    const doc = this.getDoc(projectId);
    if (!doc) return 0;
    const doneIds = doneColumnIds(doc);
    const pending = doc.tasks.filter((t) => doneIds.has(t.columnId) && isRecurring(t));
    if (!pending.length) return 0;
    const spawned = [];
    this.mutate(projectId, (d) => {
      for (const task of pending) {
        const next = this.#spawnRecurrence(d, task);
        if (next) spawned.push(next);
      }
    });
    for (const next of spawned) {
      this.#emit('recurrence-spawned', { projectId, next, quiet: true });
    }
    return spawned.length;
  }

  /**
   * Soft delete into `doc.trash`. Attachment blobs stay on disk until the
   * item is purged — otherwise a restore would come back gutted.
   */
  deleteTask(projectId, taskId) {
    return this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      doc.tasks = doc.tasks.filter((t) => t.id !== taskId);
      if (!Array.isArray(doc.trash)) doc.trash = [];
      doc.trash.unshift({ ...task, deletedAt: Date.now() });
      return task;
    });
  }

  /**
   * Bring a stored task back into `doc.tasks`, re-homing it if the world
   * moved on while it was away: a deleted column falls back to the first
   * one, and references to a gone milestone, member, or label are dropped.
   */
  #revive(doc, stored) {
    const { deletedAt, archivedAt, ...task } = stored;
    if (!doc.columns.some((c) => c.id === task.columnId)) {
      task.columnId = doc.columns[0]?.id ?? null;
      task.order = orderForAppend(doc.tasks, task.columnId);
    }
    // It has arrived in a done column *now*, so an auto-archive rule cannot
    // sweep it straight back out the moment someone undoes the sweep.
    if (doneColumnIds(doc).has(task.columnId)) task.doneAt = Date.now();
    if (task.milestoneId && !doc.milestones.some((m) => m.id === task.milestoneId)) {
      task.milestoneId = null;
    }
    task.assigneeIds = (task.assigneeIds ?? []).filter((id) => doc.members.some((m) => m.id === id));
    task.labelIds = (task.labelIds ?? []).filter((id) => doc.labels.some((l) => l.id === id));
    doc.tasks.push(task);
    return task;
  }

  restoreTask(projectId, taskId) {
    return this.mutate(projectId, (doc) => {
      const trashed = docTrash(doc).find((t) => t.id === taskId);
      if (!trashed) return null;
      doc.trash = docTrash(doc).filter((t) => t.id !== taskId);
      return this.#revive(doc, trashed);
    });
  }

  // ---- archive ---------------------------------------------------------

  /**
   * Archiving is not deleting: the task leaves the board, timeline,
   * milestone lists, and every count, but nothing about it is thrown away
   * and there is no expiry.
   */
  archiveTask(projectId, taskId) {
    return this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      doc.tasks = doc.tasks.filter((t) => t.id !== taskId);
      if (!Array.isArray(doc.archive)) doc.archive = [];
      doc.archive.unshift({ ...task, archivedAt: Date.now() });
      return task;
    });
  }

  unarchiveTask(projectId, taskId) {
    return this.mutate(projectId, (doc) => {
      const stored = docArchive(doc).find((t) => t.id === taskId);
      if (!stored) return null;
      doc.archive = docArchive(doc).filter((t) => t.id !== taskId);
      return this.#revive(doc, stored);
    });
  }

  /** "Archive all done tasks": clears out a done column in one action. */
  archiveTasksIn(projectId, columnId) {
    const doc = this.getDoc(projectId);
    const ids = (doc?.tasks ?? []).filter((t) => t.columnId === columnId).map((t) => t.id);
    return this.bulkArchiveTasks(projectId, ids);
  }

  /** Delete a task that is sitting in the archive (straight to the trash). */
  trashArchivedTask(projectId, taskId) {
    return this.mutate(projectId, (doc) => {
      const stored = docArchive(doc).find((t) => t.id === taskId);
      if (!stored) return null;
      doc.archive = docArchive(doc).filter((t) => t.id !== taskId);
      if (!Array.isArray(doc.trash)) doc.trash = [];
      const { archivedAt, ...task } = stored;
      doc.trash.unshift({ ...task, deletedAt: Date.now() });
      return task;
    });
  }

  /**
   * Archived projects leave the sidebar and home grid; their document and
   * attachments stay untouched. The flag lives on the index entry alone, so
   * archiving costs one small KV write and never opens the document.
   */
  async setProjectArchived(id, archived) {
    if (!this.projectEntry(id)) return null;
    this.projects = this.projects.map((p) => (p.id === id ? { ...p, archived: !!archived } : p));
    this.#emit('change', { scope: 'projects' });
    // Back in play. The agenda and its sidebar badge can only count what is
    // in memory, and nothing reads an archived project — so bring it in now
    // rather than leaving Today short until someone opens it.
    if (!archived) this.loadProject(id).catch((err) => console.error(err));
    await this.#saveProjectIndex();
    return this.projectEntry(id);
  }

  /** Irreversible: drops the trashed task and its attachment blobs. */
  purgeTask(projectId, taskId) {
    return this.bulkPurgeTasks(projectId, [taskId]);
  }

  /**
   * The same for a set, in one mutation — the rule the bulk edits already
   * follow. Purging one at a time re-rendered every view once per task and
   * scheduled the same write that many times over, which is what emptying a
   * trash of fifty used to cost. Returns the ids actually purged.
   */
  bulkPurgeTasks(projectId, taskIds) {
    const doc = this.getDoc(projectId);
    if (!doc) return [];
    const ids = new Set(taskIds);
    const purged = docTrash(doc).filter((t) => ids.has(t.id));
    if (!purged.length) return [];
    this.mutate(projectId, (d) => {
      d.trash = docTrash(d).filter((t) => !ids.has(t.id));
    });
    // Blobs go after the document, and one directory at a time: they are
    // per task, and a delete that fails leaves a file nothing points at.
    for (const task of purged) {
      if (task.attachments?.length) {
        this.#deleteAttachmentBytes(projectId, attachmentDir(projectId, task.id), { recursive: true });
      }
    }
    return purged.map((t) => t.id);
  }

  emptyTrash(projectId) {
    return this.bulkPurgeTasks(projectId, docTrash(this.getDoc(projectId)).map((t) => t.id));
  }

  /**
   * Called when a project is opened: anything past the grace period goes for
   * good. Returns the number purged (0 leaves the document untouched, so an
   * open does not cost a write).
   */
  purgeOldTrash(projectId, now = Date.now()) {
    const stale = docTrash(this.getDoc(projectId))
      .filter((t) => now - (t.deletedAt ?? 0) > TRASH_MS);
    return this.bulkPurgeTasks(projectId, stale.map((t) => t.id)).length;
  }

  // ---- duplication & templates -----------------------------------------

  /** Copy a task in place, right below the original. */
  duplicateTask(projectId, taskId) {
    return this.mutate(projectId, (doc) => {
      const source = doc.tasks.find((t) => t.id === taskId);
      if (!source) return null;
      const copy = blankTask({
        ...cloneTaskFields(source),
        title: `${source.title} (copy)`.slice(0, 200),
        columnId: source.columnId,
      });
      // Slot it directly after the original rather than at the end of the
      // column, where it would be easy to miss.
      const at = columnTasks(doc.tasks, source.columnId).findIndex((t) => t.id === taskId);
      const { order, renormalize } = computeMove(
        [...doc.tasks, copy], copy.id, source.columnId, at + 1,
      );
      if (renormalize) {
        const orders = new Map(renormalize.map((r) => [r.id, r.order]));
        for (const t of doc.tasks) if (orders.has(t.id)) t.order = orders.get(t.id);
      }
      copy.order = order;
      doc.tasks.push(copy);
      return copy;
    });
  }

  /** Duplicate a whole project, with or without its tasks. */
  async duplicateProject(id, { name, color, includeTasks = true } = {}) {
    const source = await this.loadProject(id);
    const doc = cloneProjectDoc(source, { includeTasks, name, color });
    return this.createProject({ name: doc.name, color: doc.color, doc });
  }

  async saveTemplate(projectId, name) {
    const doc = await this.loadProject(projectId);
    const template = templateFromDoc(doc, name);
    this.templates = [...this.templates, template];
    await this.#kvSet(KV_TEMPLATES, this.templates);
    this.#emit('change', { scope: 'templates' });
    return template;
  }

  async deleteTemplate(templateId) {
    this.templates = this.templates.filter((t) => t.id !== templateId);
    await this.#kvSet(KV_TEMPLATES, this.templates);
    this.#emit('change', { scope: 'templates' });
  }

  async createFromTemplate(templateId, { name, color }) {
    const template = this.templates.find((t) => t.id === templateId);
    if (!template) throw new Error('That template no longer exists');
    // Fresh ids again: two projects from one template must not share them.
    const doc = cloneProjectDoc(template.doc, { includeTasks: false, name, color });
    return this.createProject({ name, color, doc });
  }

  // ---- saved views -----------------------------------------------------

  /**
   * A view is a named filter + arrangement for one scope: a project id, or
   * 'all' for the cross-project list. They live in one small KV key beside
   * the templates — no new documents, and one read on boot.
   */
  async saveView({ name, scope = ALL_SCOPE, filter, sort, group }) {
    const view = normalizeSavedView({
      id: uid(), name, scope, filter, sort, group, createdAt: Date.now(),
    });
    if (!view) throw new Error('A view needs a name');
    this.views = [...this.views, view];
    await this.#saveViews();
    return view;
  }

  async renameView(id, name) {
    const next = String(name ?? '').trim();
    if (!next) return null;
    this.views = this.views.map((v) => (v.id === id ? { ...v, name: next.slice(0, 60) } : v));
    await this.#saveViews();
    return this.views.find((v) => v.id === id) ?? null;
  }

  async deleteView(id) {
    const before = this.views.length;
    this.views = this.views.filter((v) => v.id !== id);
    if (this.views.length === before) return false;
    await this.#saveViews();
    return true;
  }

  /** Reorder within a scope; the other scopes' views keep their places. */
  async moveView(scope, id, toIndex) {
    const next = planViewReorder(this.views, scope, id, toIndex);
    if (!next) return false;
    this.views = next;
    await this.#saveViews();
    return true;
  }

  /**
   * The view a scope was last looked at through, so reopening a project shows
   * how you were looking at it rather than resetting to everything. It rides
   * along in settings: one small key that is already read on boot.
   */
  async rememberView(scope, viewId) {
    const lastViews = { ...(this.settings.lastViews ?? {}) };
    if (viewId) lastViews[scope] = viewId;
    else delete lastViews[scope];
    await this.updateSettings({ lastViews });
  }

  lastViewFor(scope) {
    return this.settings.lastViews?.[scope] ?? null;
  }

  async #saveViews() {
    this.#emit('change', { scope: 'views' });
    this.#mirrorMeta();
    await this.#kvSet(KV_VIEWS, this.views);
  }

  // ---- checklists ------------------------------------------------------

  /**
   * Checklist items are the unit below a card: a flat list per task, with
   * no dates or assignees of their own. Progress stays informational — a
   * task is done when its column says so, not when its items are ticked.
   */
  #checklistOf(doc, taskId) {
    const task = doc.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (!Array.isArray(task.checklist)) task.checklist = [];
    return task;
  }

  addChecklistItem(projectId, taskId, text) {
    return this.mutate(projectId, (doc) => {
      const task = this.#checklistOf(doc, taskId);
      if (!task) return null;
      const item = { id: uid(), text, done: false };
      task.checklist.push(item);
      task.updatedAt = Date.now();
      return item;
    });
  }

  updateChecklistItem(projectId, taskId, itemId, patch) {
    return this.mutate(projectId, (doc) => {
      const task = this.#checklistOf(doc, taskId);
      const item = task?.checklist.find((i) => i.id === itemId);
      if (!item) return null;
      Object.assign(item, patch);
      task.updatedAt = Date.now();
      return item;
    });
  }

  deleteChecklistItem(projectId, taskId, itemId) {
    this.mutate(projectId, (doc) => {
      const task = this.#checklistOf(doc, taskId);
      if (!task) return;
      task.checklist = task.checklist.filter((i) => i.id !== itemId);
      task.updatedAt = Date.now();
    });
  }

  moveChecklistItem(projectId, taskId, itemId, toIndex) {
    this.mutate(projectId, (doc) => {
      const task = this.#checklistOf(doc, taskId);
      if (!task) return;
      const from = task.checklist.findIndex((i) => i.id === itemId);
      if (from < 0) return;
      const [item] = task.checklist.splice(from, 1);
      task.checklist.splice(Math.max(0, Math.min(toIndex, task.checklist.length)), 0, item);
      task.updatedAt = Date.now();
    });
  }

  /**
   * Apply an explicit arrangement: [{ id, order }]. What a one-shot column
   * sort writes, and what its Undo writes straight back.
   *
   * `updatedAt` is deliberately left alone: rearranging cards changes the
   * board, not the tasks, and bumping twenty timestamps would make "Last
   * updated" mean "last time someone tidied a column".
   */
  setTaskOrders(projectId, rewrites) {
    return this.mutate(projectId, (doc) => {
      const orders = new Map(rewrites.map((r) => [r.id, r.order]));
      const touched = [];
      for (const task of doc.tasks) {
        if (!orders.has(task.id)) continue;
        task.order = orders.get(task.id);
        touched.push(task.id);
      }
      return touched;
    });
  }

  /**
   * Auto-archive: a done column may hold a policy about its own age, applied
   * in the catch-up pass that runs when a project is opened — the same place
   * recurring work is caught up, and still no scheduler anywhere.
   *
   * Nothing is deleted (the tasks go to the archive, where they stay
   * recoverable) and nothing happens quietly: the ids come back so the caller
   * can say what it did and offer it back.
   */
  autoArchiveDone(projectId, now = Date.now()) {
    const doc = this.getDoc(projectId);
    if (!doc) return [];
    const doneIds = doneColumnIds(doc);
    const ids = [];
    for (const column of doc.columns) {
      const days = normalizeArchiveDays(column.autoArchiveDays);
      // Done columns only, deliberately: a rule that emptied a backlog would
      // be a bug people discover a week late.
      if (!days || !doneIds.has(column.id)) continue;
      const cutoff = now - days * 24 * 3600 * 1000;
      for (const task of doc.tasks) {
        if (task.columnId !== column.id) continue;
        // Tasks that were finished before this project ever had a rule have
        // no arrival stamp; their last edit is the closest honest answer.
        const since = task.doneAt ?? task.updatedAt ?? task.createdAt ?? null;
        if (since === null || since > cutoff) continue;
        ids.push(task.id);
      }
    }
    if (!ids.length) return [];
    this.bulkArchiveTasks(projectId, ids);
    this.#emit('auto-archived', { projectId, ids });
    return ids;
  }

  // ---- columns ---------------------------------------------------------

  addColumn(projectId, name) {
    return this.mutate(projectId, (doc) => {
      const col = { id: uid(), name, done: false };
      doc.columns.push(col);
      return col;
    });
  }

  updateColumn(projectId, columnId, patch) {
    this.mutate(projectId, (doc) => {
      const col = doc.columns.find((c) => c.id === columnId);
      if (col) Object.assign(col, patch);
    });
  }

  moveColumn(projectId, columnId, toIndex) {
    this.mutate(projectId, (doc) => {
      const from = doc.columns.findIndex((c) => c.id === columnId);
      if (from < 0) return;
      const [col] = doc.columns.splice(from, 1);
      doc.columns.splice(Math.max(0, Math.min(toIndex, doc.columns.length)), 0, col);
    });
  }

  /**
   * Deleting a column moves its tasks to the first remaining column, and
   * returns everything restoreColumn() needs to put it all back.
   */
  deleteColumn(projectId, columnId) {
    return this.mutate(projectId, (doc) => {
      if (doc.columns.length <= 1) return null;
      const index = doc.columns.findIndex((c) => c.id === columnId);
      const column = doc.columns[index];
      if (!column) return null;
      doc.columns = doc.columns.filter((c) => c.id !== columnId);
      const fallback = doc.columns[0];
      const moved = [];
      for (const t of doc.tasks) {
        if (t.columnId === columnId) {
          moved.push({ id: t.id, order: t.order });
          t.columnId = fallback.id;
          t.order = orderForAppend(doc.tasks.filter((x) => x !== t), fallback.id);
        }
      }
      return { column, index, moved, fallbackName: fallback.name };
    });
  }

  restoreColumn(projectId, { column, index, moved }) {
    this.mutate(projectId, (doc) => {
      if (doc.columns.some((c) => c.id === column.id)) return;
      doc.columns.splice(Math.max(0, Math.min(index, doc.columns.length)), 0, column);
      for (const { id, order } of moved) {
        const task = doc.tasks.find((t) => t.id === id);
        if (task) { task.columnId = column.id; task.order = order; }
      }
    });
  }

  // ---- milestones ------------------------------------------------------

  addMilestone(projectId, { name, date, description = '' }) {
    return this.mutate(projectId, (doc) => {
      const m = { id: uid(), name, date, description, done: false };
      doc.milestones.push(m);
      return m;
    });
  }

  updateMilestone(projectId, milestoneId, patch) {
    this.mutate(projectId, (doc) => {
      const m = doc.milestones.find((x) => x.id === milestoneId);
      if (m) Object.assign(m, patch);
    });
  }

  /** Returns what restoreMilestone() needs, including the tasks it unhooked. */
  deleteMilestone(projectId, milestoneId) {
    return this.mutate(projectId, (doc) => {
      const index = doc.milestones.findIndex((m) => m.id === milestoneId);
      const milestone = doc.milestones[index];
      if (!milestone) return null;
      doc.milestones = doc.milestones.filter((m) => m.id !== milestoneId);
      const taskIds = [];
      for (const t of doc.tasks) {
        if (t.milestoneId === milestoneId) { t.milestoneId = null; taskIds.push(t.id); }
      }
      return { milestone, index, taskIds };
    });
  }

  restoreMilestone(projectId, { milestone, index, taskIds }) {
    this.mutate(projectId, (doc) => {
      if (doc.milestones.some((m) => m.id === milestone.id)) return;
      doc.milestones.splice(Math.max(0, Math.min(index, doc.milestones.length)), 0, milestone);
      for (const id of taskIds) {
        const task = doc.tasks.find((t) => t.id === id);
        if (task) task.milestoneId = milestone.id;
      }
    });
  }

  // ---- members & labels ------------------------------------------------

  addMember(projectId, { name, color }) {
    return this.mutate(projectId, (doc) => {
      const m = { id: uid(), name, color };
      doc.members.push(m);
      return m;
    });
  }

  updateMember(projectId, memberId, patch) {
    this.mutate(projectId, (doc) => {
      const m = doc.members.find((x) => x.id === memberId);
      if (m) Object.assign(m, patch);
    });
  }

  removeMember(projectId, memberId) {
    this.mutate(projectId, (doc) => {
      doc.members = doc.members.filter((m) => m.id !== memberId);
      for (const t of doc.tasks) t.assigneeIds = t.assigneeIds.filter((id) => id !== memberId);
    });
  }

  addLabel(projectId, { name, color }) {
    return this.mutate(projectId, (doc) => {
      const l = { id: uid(), name, color };
      doc.labels.push(l);
      return l;
    });
  }

  updateLabel(projectId, labelId, patch) {
    this.mutate(projectId, (doc) => {
      const l = doc.labels.find((x) => x.id === labelId);
      if (l) Object.assign(l, patch);
    });
  }

  removeLabel(projectId, labelId) {
    this.mutate(projectId, (doc) => {
      doc.labels = doc.labels.filter((l) => l.id !== labelId);
      for (const t of doc.tasks) t.labelIds = t.labelIds.filter((id) => id !== labelId);
    });
  }

  // ---- comments --------------------------------------------------------

  addComment(projectId, taskId, text) {
    return this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      const comment = {
        id: uid(),
        author: this.user?.username || 'Me',
        text,
        createdAt: Date.now(),
      };
      task.comments.push(comment);
      task.updatedAt = Date.now();
      return comment;
    });
  }

  /** Returns { comment, index } so an undo can put it back where it was. */
  deleteComment(projectId, taskId, commentId) {
    return this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      const index = task?.comments.findIndex((c) => c.id === commentId) ?? -1;
      if (!task || index < 0) return null;
      const [comment] = task.comments.splice(index, 1);
      return { comment, index };
    });
  }

  restoreComment(projectId, taskId, { comment, index }) {
    this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (!task || task.comments.some((c) => c.id === comment.id)) return;
      task.comments.splice(Math.max(0, Math.min(index, task.comments.length)), 0, comment);
    });
  }

  // ---- attachments -----------------------------------------------------

  /**
   * Attachment blobs go straight to fs (they never belong in the project
   * JSON); the doc only records metadata. The write happens before the doc
   * mutation so a failed upload leaves no dangling entry.
   */
  async addAttachment(projectId, taskId, file) {
    const att = {
      id: uid(),
      name: safeFileName(file.name),
      size: file.size,
      type: file.type || '',
      createdAt: Date.now(),
    };
    await storage.fs.write(
      `${attachmentDir(projectId, taskId)}/${att.id}-${att.name}`,
      file,
      { createMissingParents: true },
    );
    this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (task) { task.attachments.push(att); task.updatedAt = Date.now(); }
    });
    return att;
  }

  /**
   * A file that already lives in the user's Drive is referenced, not copied:
   * one copy of the truth, and editing it there is reflected here. The cost
   * is that moving or deleting it breaks the link, which the UI says out
   * loud rather than failing silently.
   */
  addLinkedAttachment(projectId, taskId, item) {
    if (isPrivateStorage) throw new Error('Puter Drive links are unavailable in private mode; upload the file instead');
    const path = item?.path ?? item?.fullPath ?? null;
    if (!path) throw new Error('That file has no path');
    const att = {
      id: uid(),
      kind: 'link',
      path,
      name: safeFileName(item.name ?? String(path).split('/').pop()),
      size: item.size ?? 0,
      type: item.type ?? item.mime ?? '',
      createdAt: Date.now(),
    };
    this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (task) { task.attachments.push(att); task.updatedAt = Date.now(); }
    });
    return att;
  }

  /** Where an attachment's bytes live: linked in Drive, or uploaded here. */
  attachmentPath(projectId, taskId, att) {
    return att.kind === 'link'
      ? att.path
      : `${attachmentDir(projectId, taskId)}/${att.id}-${att.name}`;
  }

  async readAttachment(projectId, taskId, att) {
    if (isPrivateStorage && att.kind === 'link') throw new Error('Puter Drive links are unavailable; upload the original file');
    return storage.fs.read(this.attachmentPath(projectId, taskId, att));
  }

  /** Whether a linked file is still where the link says it is. */
  async attachmentExists(projectId, taskId, att) {
    // A web address (an imported Trello attachment) lives on someone else's
    // server: asking it whether it is there would be a cross-origin request
    // this app has no business making, so it is taken at its word.
    if (att.kind === 'url') return true;
    if (isPrivateStorage && att.kind === 'link') return false;
    if (typeof storage.fs?.stat !== 'function') return true;
    try {
      await storage.fs.stat(this.attachmentPath(projectId, taskId, att));
      return true;
    } catch (err) {
      if (isMissingFileError(err)) return false;
      return true; // an offline check is not evidence of a broken link
    }
  }

  deleteAttachment(projectId, taskId, att) {
    this.mutate(projectId, (doc) => {
      const task = doc.tasks.find((t) => t.id === taskId);
      if (task) task.attachments = task.attachments.filter((a) => a.id !== att.id);
    });
    // Removing a link removes the reference; the file in Drive (or on the web)
    // is not this app's to delete.
    if (att.kind === 'link' || att.kind === 'url') return;
    this.#deleteAttachmentBytes(projectId, `${attachmentDir(projectId, taskId)}/${att.id}-${att.name}`);
  }

  #deleteAttachmentBytes(projectId, path, options) {
    if (!isPrivateStorage) { storage.fs.delete(path, options).catch(() => {}); return; }
    let cleanup = this.#attachmentCleanup.get(projectId);
    if (!cleanup) this.#attachmentCleanup.set(projectId, cleanup = new Map());
    cleanup.set(path, options);
  }

  // ---- export / sample data --------------------------------------------

  async exportAll(ids = null) {
    const entries = ids
      ? this.projects.filter((p) => ids.includes(p.id))
      : this.projects;
    const docs = [];
    const index = [];
    for (const entry of entries) {
      try {
        docs.push(await this.loadProject(entry.id));
        index.push(entry);
      } catch (err) {
        if (isPrivateStorage || !isMissingFileError(err)) throw err;
      }
    }
    return {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: Date.now(),
      projects: docs,
      index,
      templates: ids ? [] : this.templates,
    };
  }

  /**
   * The export as a zip: the envelope plus every attachment blob, so a
   * backup can actually be restored. A blob that cannot be read is reported
   * rather than failing the whole export.
   */
  async exportBundle(ids = null) {
    const data = await this.exportAll(ids);
    const files = [{
      name: BACKUP_JSON_NAME,
      blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    }];
    let missing = 0;
    for (const doc of data.projects) {
      const tasks = [...doc.tasks, ...docArchive(doc), ...docTrash(doc)];
      for (const task of tasks) {
        for (const att of task.attachments ?? []) {
          try {
            const blob = await this.readAttachment(doc.id, task.id, att);
            files.push({ name: attachmentEntryPath(doc.id, task.id, att), blob });
          } catch {
            missing++;
          }
        }
      }
    }
    return { blob: await zipFiles(files), data, missing };
  }

  /**
   * Import always creates: fresh ids for everything, so a re-import is a
   * predictable duplicate instead of a silent overwrite. Per-project failures
   * are collected rather than aborting the whole file.
   */
  async importBackup({ data, files = new Map() }) {
    const { projects } = validateBackup(data);
    const index = Array.isArray(data.index) ? data.index : [];
    const summary = { projects: 0, tasks: 0, attachments: 0, missingAttachments: 0, failed: [] };

    for (const [i, raw] of projects.entries()) {
      const sourceId = raw?.id;
      const name = raw?.name ?? index[i]?.name ?? 'Imported project';
      try {
        const { doc, entry, taskIdMap } = prepareImportedProject(raw, { entry: index[i] });
        // Copy attachment blobs to their new home before the project exists,
        // so a half-imported project never lists files it does not have.
        const carried = await this.#importAttachments({
          doc, sourceId, taskIdMap, files, summary,
        });
        await this.createProject({ name: doc.name, color: doc.color, doc });
        if (entry.archived) await this.setProjectArchived(doc.id, true);
        summary.projects++;
        summary.tasks += doc.tasks.length;
        summary.attachments += carried;
      } catch (err) {
        console.error(err);
        summary.failed.push({ name, error: err?.message || 'Unknown error' });
      }
    }
    return summary;
  }

  async #importAttachments({ doc, sourceId, taskIdMap, files, summary }) {
    let carried = 0;
    const groups = [doc.tasks, docArchive(doc), docTrash(doc)];
    const oldByNew = new Map([...taskIdMap].map(([oldId, newId]) => [newId, oldId]));
    for (const group of groups) {
      for (const task of group) {
        const oldTaskId = oldByNew.get(task.id);
        const kept = [];
        for (const att of task.attachments ?? []) {
          const blob = files.get(attachmentEntryPath(sourceId, oldTaskId, att));
          if (!blob) {
            // Attachments that were never bytes here keep what they point at:
            // a Drive link may well still resolve for this account, and a web
            // link (a Trello card's attachment, say) never needed bytes.
            if (att.kind === 'link' || att.kind === 'url') {
              kept.push({ ...att, name: safeFileName(att.name) });
              continue;
            }
            summary.missingAttachments++;
            continue;
          }
          try {
            // Both halves of the file name come out of the backup, and the
            // write creates whatever parents it needs — so an id or name
            // carrying `../` would put a file anywhere in the user's Drive.
            // A fresh id and a sanitized name land it where it belongs. (The
            // lookup above still uses what the backup said, since that is
            // what the entry inside the zip is called.)
            const stored = { ...att, id: uid(), name: safeFileName(att.name) };
            await storage.fs.write(
              `${attachmentDir(doc.id, task.id)}/${stored.id}-${stored.name}`,
              blob,
              { createMissingParents: true },
            );
            // The backup carried the bytes, so the copy is now the truth —
            // a link to someone else's Drive path would not resolve.
            const { kind, path, ...copied } = stored;
            kept.push(copied);
            carried++;
          } catch (err) {
            console.error(err);
            summary.missingAttachments++;
          }
        }
        // Metadata without a blob would be a row that can never open.
        task.attachments = kept;
      }
    }
    return carried;
  }

  /**
   * Remove every project flagged as sample data, then clear the flag. This
   * purges rather than trashing: "start fresh" should not leave the sample
   * project sitting in the trash for a month.
   */
  async wipeSampleData() {
    const samples = [...this.projects, ...this.deletedProjects].filter((p) => p.sample);
    for (const p of samples) await this.purgeProject(p.id);
    await this.updateSettings({ sampleData: false });
  }
}

export const store = new Store();
