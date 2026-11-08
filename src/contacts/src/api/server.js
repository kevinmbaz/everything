/**
 * Transport for the Contacts API: reads requests off an AppConnection,
 * dispatches them to the method table, and posts replies back.
 *
 * The connection carries two protocols, and a message says which it is in.
 *
 * ── The app-to-app protocol (`$: 'contacts-api'`) ─────────────────────────────
 * One request → one reply, matched by the caller's `id`:
 *   in   { $: 'contacts-api', v: 1, id, method, params }
 *   out  { $: 'contacts-api', v: 1, id, ok: true,  result }
 *        { $: 'contacts-api', v: 1, id, ok: false, error: { code, message, details? } }
 *
 * Two unsolicited notices are also posted (neither carries an `id`):
 *   { $: 'contacts-api', v: 1, type: 'ready',   methods: [...] }  — on start
 *   { $: 'contacts-api', v: 1, type: 'changed' }                  — after the
 *       address book actually changed, so a client can drop a cached snapshot.
 *       Reads never provoke one, however often the store re-reads itself.
 *
 * ── MCP (`jsonrpc: '2.0'`) ────────────────────────────────────────────────────
 * The same address book, spoken in the protocol AI clients already know. See
 * mcp.js. A caller picks a protocol simply by writing in it; there is no mode to
 * negotiate and no second connection to open, which is what lets one app use
 * both — the calendar's autocomplete on the fast path, an agent's tool call on
 * the same wire.
 *
 * Anything in neither dialect is ignored, as it always was.
 */
import {
  ALLOWED_CALLERS,
  ApiError,
  CHANNEL,
  ERRORS,
  PROTOCOL_VERSION,
  grantedMethods,
  isRequest,
} from './protocol.js'
import { JSONRPC, createMcp, isMcpMessage } from './mcp.js'

const CHANGED_DEBOUNCE_MS = 250

/**
 * Serve the API to whichever app opened `connection`.
 *
 * @param {object} deps
 * @param {{ on: Function, off?: Function, postMessage: Function }} deps.connection
 *   the AppConnection from `puter.ui.parentApp()`
 * @param {string} deps.callerApp the launching app's name, per readLaunchContext()
 * @param {Record<string, Function>} deps.methods method table (see createMethods)
 * @param {object} [deps.allowed] caller → grant map, for tests
 * @param {(fn: Function) => Function} [deps.subscribe] store subscribe, to
 *   announce changes; its unsubscribe is called by stop()
 * @param {() => (string|null)} [deps.revision] a fingerprint of the address book
 *   (store.revision), so a `changed` notice is sent only when it really did.
 *   Omitted, every store emit is announced — safe, but noisy; see below.
 * @param {(method: string) => void} [deps.onActivity] called per accepted request
 * @returns {{ stop: () => void, granted: string[], tools: string[] } | null} null
 *   when the caller has no grant — in that case nothing is listened to at all.
 */
export function startApiServer({
  connection,
  callerApp,
  methods,
  allowed = ALLOWED_CALLERS,
  subscribe = null,
  revision = null,
  onActivity = null,
}) {
  if (import.meta.env.VITE_PRIVATE_STORAGE === '1') return null
  if (!connection || typeof connection.postMessage !== 'function') return null

  const granted = grantedMethods(callerApp, allowed)
  // An app with no grant gets no listener, so an unauthorized caller can't even
  // tell whether a method exists — and can never reach the store. This covers
  // MCP as well: an app that may call nothing is offered no tools either.
  if (!granted.length) return null
  const grantedSet = new Set(granted)
  const mcp = createMcp({ methods, granted })

  // Whether this caller has spoken MCP yet. Until it has, it gets only the
  // notices the app-to-app protocol has always sent — an existing client must
  // not start receiving traffic it was never written to see.
  let sawMcp = false

  function reply(id, payload) {
    connection.postMessage({ $: CHANNEL, v: PROTOCOL_VERSION, id, ...payload })
  }

  function fail(id, code, message, details) {
    reply(id, { ok: false, error: details ? { code, message, details } : { code, message } })
  }

  function touch(method) {
    if (!onActivity) return
    try {
      onActivity(method)
    } catch (_e) {
      /* an activity hook must never break a request */
    }
  }

  async function handle(msg) {
    const { id, method } = msg
    if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
      fail(id, ERRORS.VERSION, `This app speaks contacts-api v${PROTOCOL_VERSION}`)
      return
    }
    // Unknown and un-granted are one answer on purpose: the reply must not
    // reveal which methods exist beyond what this caller may use.
    if (!grantedSet.has(method) || typeof methods[method] !== 'function') {
      fail(id, ERRORS.UNKNOWN_METHOD, `"${method}" is not available to this app`)
      return
    }
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
    touch(method)
    try {
      reply(id, { ok: true, result: await methods[method](params) })
    } catch (err) {
      if (err instanceof ApiError) {
        fail(id, err.code, err.message, err.details)
      } else {
        // Don't leak internals to another app; the details stay in our console.
        console.error('[contacts-api]', method, err)
        fail(id, ERRORS.STORAGE, 'The request could not be completed')
      }
    }
  }

  async function handleMcp(msg) {
    sawMcp = true
    touch(msg.method)
    const response = await mcp.handle(msg)
    // Null is a notification: JSON-RPC forbids replying to one.
    if (response) connection.postMessage(response)
  }

  const onMessage = (msg) => {
    if (isMcpMessage(msg)) {
      handleMcp(msg).catch((err) => console.error('[contacts-mcp]', err))
      return
    }
    if (!isRequest(msg)) return
    handle(msg).catch((err) => console.error('[contacts-api]', err))
  }

  connection.on('message', onMessage)

  // The address book as the caller last saw it, so `changed` can mean what it
  // says. The store emits for more than a change to the book: a freshness
  // re-read that found nothing new emits, and so does pure UI state (a search
  // query, a selection) in a window that is also serving this API. Announcing
  // those told a caller to re-read the whole book for nothing — and a caller
  // that re-reads on `changed` turned every launch into two full sweeps.
  //
  // `null` means the book has not been read yet. The first read is the caller's
  // own first answer, so it establishes the baseline rather than announcing.
  // Without `revision` we announce on every emit, which is the safe direction
  // to be wrong in: a caller can absorb a notice it did not need, but not a
  // change it was never told about.
  const currentRevision = () => {
    if (typeof revision !== 'function') return null
    try {
      return revision()
    } catch (_e) {
      // A fingerprint we cannot compute must not silence the notice.
      return null
    }
  }
  let announcedRevision = currentRevision()
  const hasRevisions = typeof revision === 'function'

  /** True when there is genuinely new data to tell the caller about. */
  function shouldAnnounce() {
    if (!hasRevisions) return true
    const now = currentRevision()
    if (now === null) return false // nothing readable yet, or unknowable
    if (announcedRevision === null) {
      // The first read of the book. Whatever the caller asks next carries it.
      announcedRevision = now
      return false
    }
    if (now === announcedRevision) return false
    announcedRevision = now
    return true
  }

  let changedTimer = null
  const unsubscribe = subscribe
    ? subscribe(() => {
        // Coalesced: one store change can emit several times (optimistic write,
        // then confirmation), and the client only needs to know "refetch".
        // Deciding *after* the wait is deliberate — an optimistic write that
        // rolls back inside it leaves the book as it was, and says nothing.
        if (changedTimer) return
        changedTimer = setTimeout(() => {
          changedTimer = null
          if (!shouldAnnounce()) return
          connection.postMessage({ $: CHANNEL, v: PROTOCOL_VERSION, type: 'changed' })
          // The MCP spelling of the same news: the contact resources a client
          // may be holding are no longer current.
          if (sawMcp) {
            connection.postMessage({ jsonrpc: JSONRPC, method: 'notifications/resources/list_changed' })
          }
        }, CHANGED_DEBOUNCE_MS)
      })
    : null

  connection.postMessage({ $: CHANNEL, v: PROTOCOL_VERSION, type: 'ready', methods: granted })

  return {
    granted,
    tools: mcp.tools.map((t) => t.name),
    stop() {
      if (typeof connection.off === 'function') connection.off('message', onMessage)
      if (changedTimer) clearTimeout(changedTimer)
      changedTimer = null
      if (unsubscribe) unsubscribe()
    },
  }
}
