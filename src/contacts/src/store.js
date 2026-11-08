// Reactive contact store backed by puter.kv. Contacts are the only cloud data;
// each is stored under its own key ("contact:<id>") so reads/writes scale and
// never collide. UI preferences are kept device-local via env.getPref.
import { normalizeContact, normalizeTags, contactKey, displayName } from './model.js'
import { withTimeout as puterTimeout, getPref, setPref } from './env.js'
import { getStorage, privateMode } from './storage.js'
// Private transport owns its abort/uncertain-outcome timeout. A shorter race
// here could report failure and then publish a late success behind the form.
const withTimeout = (promise, ms, label) => privateMode ? promise : puterTimeout(promise, ms, label)
import { SORT_KEYS } from './search.js'

// Identity signatures used to skip duplicates on import. Email is the strong
// key; phone is qualified by name so people who share a number (e.g. a home
// line) aren't wrongly merged; a contact with neither falls back to its name.
function contactSignatures(c) {
  const sigs = []
  for (const e of c.emails || []) {
    const v = String(e.value || '').trim().toLowerCase()
    if (v) sigs.push('email:' + v)
  }
  const name = displayName(c).toLowerCase().trim()
  const phones = (c.phones || []).map((p) => String(p.value || '').replace(/\D/g, '')).filter(Boolean)
  for (const ph of phones) sigs.push(`np:${name}|${ph}`)
  if (!(c.emails || []).length && !phones.length && name) sigs.push('name:' + name)
  return sigs
}

// Bulk jobs publish partial results so contacts appear (or vanish) as they
// land instead of all at once at the end. A render costs a full re-stamp of
// the list, which would make a 1,000-contact import O(n²) if it ran per
// record — so the emits are coalesced to at most one every STREAM_MS. The
// first window is spent in silence: a job short enough to finish inside it
// only needs the single emit its caller already does at the end.
const STREAM_MS = 400

// A 32-bit string hash (FNV-1a). Used only to fingerprint the address book for
// change detection — never for identity or storage.
function hashString(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function streamEmitter(store) {
  let last = Date.now()
  return () => {
    const now = Date.now()
    if (now - last < STREAM_MS) return
    last = now
    store.emit()
  }
}

class Store {
  constructor() {
    this.contacts = new Map()
    this.loaded = false
    // When the book in memory last came from the cloud. A window that stays open
    // — the API service instance especially — can otherwise answer from a book
    // that another window has since changed; see isFresh().
    this.loadedAt = 0
    this.error = null
    this.listeners = new Set()
    this.privateMutations = Promise.resolve()
    this.ui = {
      query: '',
      sort: SORT_KEYS.includes(getPref('sort')) ? getPref('sort') : 'first',
      favoritesOnly: false,
      tag: '',
      selectedId: null,
      // Roving-tabindex cursor for keyboard navigation: the row that is the
      // list's single tab stop. In single-select mode it tracks selectedId; in
      // select mode it moves independently of which rows are checked.
      cursorId: null,
      selectMode: false,
      checked: new Set(),
    }
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    for (const fn of this.listeners) fn(this)
  }

  get all() {
    return [...this.contacts.values()]
  }

  get(id) {
    return this.contacts.get(id) || null
  }

  get selected() {
    return this.ui.selectedId ? this.contacts.get(this.ui.selectedId) || null : null
  }

  setUI(patch) {
    Object.assign(this.ui, patch)
    if (patch.sort) setPref('sort', patch.sort)
    this.emit()
  }

  // --- multi-select ---------------------------------------------------------

  enterSelectMode() {
    this.ui.selectMode = true
    this.ui.checked = new Set()
    this.emit()
  }

  exitSelectMode() {
    this.ui.selectMode = false
    this.ui.checked = new Set()
    this.emit()
  }

  toggleCheck(id) {
    if (this.ui.checked.has(id)) this.ui.checked.delete(id)
    else this.ui.checked.add(id)
    // Keep the keyboard cursor on the row the user just acted on, so the tab
    // stop follows clicks as well as arrow keys.
    this.ui.cursorId = id
    this.emit()
  }

  setChecked(ids) {
    this.ui.checked = new Set(ids)
    this.emit()
  }

  /**
   * Re-read every contact from the cloud, replacing the book in memory only if
   * the read succeeds. Throws on failure and leaves everything — the book, and
   * `error` — exactly as it was: a background revalidation that fails must not
   * push a window that already has a perfectly good list into an error state.
   * `load()` is the UI-facing wrapper that does record the error.
   */
  async reload() {
    // Ask for our own keys by prefix rather than scanning the whole store: KV
    // reads are metered, and a re-read now happens whenever the API is asked for
    // a book that has aged. The client-side prefix check below still stands, so
    // a backend that ignores the pattern behaves exactly as it always did.
    const raw = await withTimeout(
      getStorage().kv.list('contact:*', true),
      20000,
      'Loading contacts',
    )
    const list = Array.isArray(raw) ? raw : []
    const next = new Map()
    for (const item of list) {
      if (!item || typeof item.key !== 'string' || !item.key.startsWith('contact:')) continue
      let value = item.value
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch (_e) {
          continue
        }
      }
      const c = normalizeContact(value)
      next.set(c.id, c)
    }
    this.contacts = next
    this.loaded = true
    this.loadedAt = Date.now()
    this.error = null
    this.emit()
  }

  /** Load all contacts (and exit any prior error state) from the cloud, putting
   *  the store into an error state — which the UI renders — if it fails. */
  async load() {
    this.error = null
    try {
      await this.reload()
    } catch (err) {
      this.error = err
      this.loaded = true
      this.emit()
      throw err
    }
  }

  /**
   * Is the book in memory a good enough answer right now? Loaded, not in an
   * error state, and — when `maxAgeMs` is given — read from the cloud that
   * recently.
   *
   * Contacts can be open in more than one window at once (the user's, plus a
   * headless instance serving the app-to-app API), and a window only sees its
   * own writes: there is no cross-window notification to invalidate on. So a
   * caller that must not answer from a stale book asks for an age bound and gets
   * a re-read when it isn't met.
   */
  isFresh(maxAgeMs = 0) {
    if (!this.loaded || this.error) return false
    if (!maxAgeMs) return true
    return Date.now() - this.loadedAt < maxAgeMs
  }

  /**
   * A fingerprint of the address book itself — `null` until it has been read
   * from the cloud at least once.
   *
   * This exists for the app-to-app API, which must tell another app when the
   * book *changed*. Subscribing to `emit()` cannot answer that: the store also
   * emits for a re-read that found nothing new, and for pure UI state (a search
   * query, a selection). Comparing two fingerprints answers it exactly, and
   * cannot be defeated by a future mutation path forgetting to announce itself.
   *
   * Built from each contact's id and `updatedAt` — every write stamps the
   * latter — combined additively so the result does not depend on Map order,
   * which a reload rebuilds from whatever order the cloud listed the keys in.
   * Two different books colliding would cost one missed notice (the caller
   * re-reads on its own schedule anyway); the size term makes that vanishingly
   * unlikely for the only shape that matters here, one contact changing.
   */
  revision() {
    if (!this.loaded) return null
    let sum = 0
    for (const c of this.contacts.values()) {
      sum = (sum + hashString(`${c.id}:${c.updatedAt}`)) >>> 0
    }
    return `${this.contacts.size}:${sum}`
  }

  /** Insert or update a contact. Optimistic in memory, then persisted. */
  async save(contact) {
    const existing = this.contacts.get(contact.id)
    const c = normalizeContact({
      ...contact,
      createdAt: (existing && existing.createdAt) || contact.createdAt || Date.now(),
      updatedAt: Date.now(),
    })
    if (privateMode) {
      return this.serializePrivateMutation(async () => {
        await getStorage().kv.set(contactKey(c.id), c)
        this.contacts.set(c.id, c)
        this.emit()
        return c
      })
    }
    this.contacts.set(c.id, c)
    this.emit()
    try {
      await withTimeout(getStorage().kv.set(contactKey(c.id), c), 15000, 'Saving contact')
    } catch (err) {
      // Roll back optimistic state to whatever the cloud actually holds.
      if (existing) this.contacts.set(c.id, existing)
      else this.contacts.delete(c.id)
      this.emit()
      throw err
    }
    return c
  }

  /** Delete a contact by id. */
  async remove(id) {
    if (privateMode) {
      return this.serializePrivateMutation(async () => {
        if (!this.contacts.has(id)) return
        await getStorage().kv.del(contactKey(id))
        this.contacts.delete(id)
        this.ui.checked.delete(id)
        if (this.ui.selectedId === id) this.ui.selectedId = null
        this.emit()
      })
    }
    const existing = this.contacts.get(id)
    if (!existing) return
    this.contacts.delete(id)
    if (this.ui.selectedId === id) this.ui.selectedId = null
    this.emit()
    try {
      await withTimeout(getStorage().kv.del(contactKey(id)), 15000, 'Deleting contact')
    } catch (err) {
      this.contacts.set(id, existing)
      this.emit()
      throw err
    }
  }

  async toggleFavorite(id) {
    const c = this.contacts.get(id)
    if (!c) return
    return this.save({ ...c, favorite: !c.favorite })
  }

  /**
   * Delete many contacts. Each is removed from memory only after its cloud
   * delete succeeds, so a partial failure leaves a consistent state. Returns
   * the number actually deleted.
   * @param {function(number, number)} [options.onProgress] - (finished, total)
   *   after each contact, counting failures, so the count always reaches total.
   */
  async removeMany(ids, { concurrency = 6, onProgress = null } = {}) {
    const captured = [...ids]
    return this.serializePrivateMutation(() => this.removePrepared(captured, { concurrency, onProgress }))
  }

  async removePrepared(ids, { concurrency, onProgress }) {
    const queue = ids.filter((id) => this.contacts.has(id))
    const total = queue.length
    let deleted = 0
    let finished = 0
    const stream = streamEmitter(this)
    if (onProgress) onProgress(0, total)
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift()
        try {
          await withTimeout(getStorage().kv.del(contactKey(id)), 15000, 'Deleting contacts')
          this.contacts.delete(id)
          this.ui.checked.delete(id)
          if (this.ui.selectedId === id) this.ui.selectedId = null
          deleted++
        } catch (_e) {
          /* leave this contact in place and continue with the rest */
        }
        finished++
        if (onProgress) onProgress(finished, total)
        stream()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    this.emit()
    return deleted
  }

  // Deduplication and delete existence checks must see earlier acknowledged
  // mutations. All private writes/deletes share this FIFO through publication,
  // so a later delete cannot be overtaken by an earlier queued update.
  // Keep queued work dirty before transport starts.
  serializePrivateMutation(task) {
    if (!privateMode) return task()
    const storage = getStorage()
    const token = Symbol('queued contact mutation')
    storage.setDraft(token, true)
    const result = this.privateMutations.then(task).finally(() => storage.setDraft(token, false))
    this.privateMutations = result.catch(() => {})
    return result
  }

  /**
   * Import many contacts, skipping ones that duplicate an existing contact (or
   * an earlier card in the same file). Persistence runs with limited
   * concurrency so large imports don't overwhelm the API.
   * @param {function(number, number)} [options.onProgress] - (finished, total)
   *   after each write, counting failures, so the count always reaches total.
   *   `total` excludes the duplicates that were skipped without a write.
   * @returns {Promise<{written: number, skipped: number, failed?: number}>}
   */
  async importMany(contacts, { concurrency = 6, onProgress = null } = {}) {
    const prepared = contacts.map((c) => normalizeContact(c))
    return this.serializePrivateMutation(() => this.importPrepared(prepared, { concurrency, onProgress }))
  }

  async importPrepared(prepared, { concurrency, onProgress }) {
    // Index what's already stored, then filter out duplicates (including
    // duplicates within this same import).
    const seen = new Set()
    for (const c of this.contacts.values()) {
      for (const k of contactSignatures(c)) seen.add(k)
    }
    const toWrite = []
    const seenIds = new Set(this.contacts.keys())
    let skipped = 0
    for (const c of prepared) {
      const sigs = contactSignatures(c)
      if ((privateMode && seenIds.has(c.id)) || (sigs.length && sigs.some((k) => seen.has(k)))) {
        skipped++
        continue
      }
      for (const k of sigs) seen.add(k)
      seenIds.add(c.id)
      toWrite.push(c)
    }

    let written = 0
    let finished = 0
    const queue = [...toWrite]
    const total = queue.length
    const stream = streamEmitter(this)
    if (onProgress) onProgress(0, total)
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift()
        try {
          await withTimeout(getStorage().kv.set(contactKey(c.id), c), 15000, 'Importing contacts')
          this.contacts.set(c.id, c)
          written++
        } catch (_e) {
          /* skip the failed record; continue importing the rest */
        }
        finished++
        if (onProgress) onProgress(finished, total)
        stream()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    this.emit()
    return privateMode ? { written, skipped, failed: total - written } : { written, skipped }
  }

  /**
   * Persist a batch of contacts as-is (normalized; ids and timestamps are
   * preserved, and nothing is de-duplicated). Each contact is committed to
   * memory only after its cloud write succeeds, so a partial failure never
   * leaves memory claiming something the cloud doesn't hold.
   * @param {function(number, number)} [options.onProgress] - (finished, total)
   *   after each write, counting failures, so the count always reaches total.
   * @returns {Promise<{saved: number, failed: number}>}
   */
  async saveMany(contacts, { concurrency = 6, onProgress = null } = {}) {
    const queue = contacts.map((c) => normalizeContact(c))
    return this.serializePrivateMutation(() => this.savePrepared(queue, { concurrency, onProgress }))
  }

  async savePrepared(queue, { concurrency, onProgress }) {
    const total = queue.length
    let saved = 0
    let failed = 0
    const stream = streamEmitter(this)
    if (onProgress) onProgress(0, total)
    const worker = async () => {
      while (queue.length) {
        const c = queue.shift()
        try {
          await withTimeout(getStorage().kv.set(contactKey(c.id), c), 15000, 'Saving contacts')
          this.contacts.set(c.id, c)
          saved++
        } catch (_e) {
          failed++
        }
        if (onProgress) onProgress(saved + failed, total)
        stream()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    this.emit()
    return { saved, failed }
  }

  // Contacts carrying `tagKey` (an already-lowercased tag name).
  taggedWith(tagKey) {
    return this.all.filter((c) => (c.tags || []).some((t) => t.toLowerCase() === tagKey))
  }

  /**
   * Rename a tag across every contact that carries it (case-insensitive).
   * The new name is parsed like the editor's tags field, so it can never
   * produce a value the editor would later split differently. Renaming onto
   * an existing tag merges the two (the per-contact de-dup keeps one copy);
   * contacts already spelled exactly right are skipped, not rewritten. On a
   * partial failure the failed contacts simply keep the old tag — both names
   * stay visible and nothing is lost. If the active tag filter is the renamed
   * tag, it follows to the new name.
   * @returns {Promise<{changed: number, failed: number, total: number, snapshot: object[]}>}
   *   `snapshot` holds the affected contacts' prior states so callers can
   *   offer undo via saveMany().
   */
  async renameTag(from, to) {
    const fromKey = String(from || '').trim().toLowerCase()
    const next = normalizeTags(to)
    if (!fromKey || !next.length) throw new Error('A tag name is required')
    const now = Date.now()
    const snapshot = []
    const updates = []
    for (const c of this.taggedWith(fromKey)) {
      const tags = normalizeTags(c.tags.flatMap((t) => (t.toLowerCase() === fromKey ? next : [t])))
      if (JSON.stringify(tags) === JSON.stringify(c.tags)) continue
      snapshot.push(c)
      updates.push({ ...c, tags, updatedAt: now })
    }
    const { saved, failed } = await this.saveMany(updates)
    if (saved && this.ui.tag.toLowerCase() === fromKey) {
      this.ui.tag = next[0]
      this.emit()
    }
    return { changed: saved, failed, total: updates.length, snapshot }
  }

  /**
   * Remove a tag from every contact that carries it (case-insensitive); the
   * contacts themselves are kept. Commit and partial-failure semantics match
   * renameTag. Once no contact carries the tag anymore, a matching active
   * filter is cleared so the user isn't left on a permanently empty list.
   * @returns {Promise<{changed: number, failed: number, total: number, snapshot: object[]}>}
   */
  async removeTag(tag) {
    const key = String(tag || '').trim().toLowerCase()
    if (!key) throw new Error('A tag name is required')
    const now = Date.now()
    const snapshot = this.taggedWith(key)
    const updates = snapshot.map((c) => ({
      ...c,
      tags: c.tags.filter((t) => t.toLowerCase() !== key),
      updatedAt: now,
    }))
    const { saved, failed } = await this.saveMany(updates)
    if (this.ui.tag.toLowerCase() === key && !this.taggedWith(key).length) {
      this.ui.tag = ''
      this.emit()
    }
    return { changed: saved, failed, total: updates.length, snapshot }
  }
}

export const store = new Store()
