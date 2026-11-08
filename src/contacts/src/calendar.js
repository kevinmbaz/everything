/**
 * The user's calendar, borrowed from the Calendar app.
 *
 * This is the other direction of the door Contacts already opens: the Calendar
 * reads this address book to suggest guests (see src/api/), and here we read and
 * write its events over the same kind of AppConnection
 * (https://docs.puter.com/Objects/AppConnection/). We launch Calendar in service
 * mode — no UI, `background: true` so the desktop never puts a window on screen
 * — and talk to the connection `puter.ui.launchApp` hands back. Calendar only
 * answers apps on its own allowlist, so this works because the desktop tells it,
 * from the calling process rather than from anything we could claim, that the
 * caller is `contacts`.
 *
 * ── What this is deliberately not ────────────────────────────────────────────
 * There is no cached copy of the calendar here, and no background syncing. The
 * Calendar's client caches our address book because it matches it against every
 * keystroke in the guest field; nothing in Contacts asks the calendar anything
 * per keystroke. Our two questions — "what's coming up with this person?" and
 * "is this birthday already on the calendar?" — are asked at most once per
 * contact the user opens, are answered from the live calendar, and are worth
 * nothing when stale. A short-lived connection with an idle close is the whole
 * mechanism.
 *
 * Everything degrades to "no calendar": on the open web there is no desktop to
 * launch anything into (puter.env !== 'app'), Calendar may not be installed, and
 * the user may not have it. Reads answer with null and the UI shows nothing;
 * writes reject with a message the caller can put in a toast. After a failure we
 * back off, doubling, so a missing Calendar costs one launch attempt rather than
 * one per contact — but only for failures that mean *unreachable*. A refusal
 * the Calendar sent us (`CalendarApiError`) proves the opposite and clears the
 * backoff, so one "no event with that id" cannot take the calendar away from
 * every contact card for a minute.
 */

/* ---- The contract with the Calendar app ---------------------------------- */
// Mirrored from calendar.puter.com/src/js/api/protocol.js — a published contract
// between the two apps. Change them together and bump VERSION when the shape
// changes.
const CHANNEL = 'calendar-api'
const VERSION = 1
const SERVICE_ARG = 'calendar-api'
const APP_NAME = 'calendar'

const IDLE_CLOSE_MS = 15_000 // close the service window this long after the last call
const REQUEST_TIMEOUT_MS = 8000
const LAUNCH_TIMEOUT_MS = 12_000 // includes the Calendar's own boot
const RETRY_AFTER_MS = 60_000 // after a failure, don't try again for a while
const MAX_RETRY_MS = 10 * 60 * 1000 // …doubling per failure, up to this

/** How far ahead "what's coming up with this person" looks. */
export const UPCOMING_DAYS = 90

/** How far ahead we look for a birthday already on the calendar. A yearly event
 *  has exactly one occurrence in any 400-day window, so this finds it wherever
 *  in the year it sits. (400 days is also the calendar's own cap.) */
export const BIRTHDAY_WINDOW_DAYS = 400

const DAY_MS = 86_400_000

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/**
 * An error the Calendar itself sent back: it read our request, understood it,
 * and said no. Distinct from every other failure here — a launch that never
 * landed, a timeout, a window that closed — because those mean the Calendar is
 * unreachable and this one means the opposite. `code` is the API's own
 * (`not_found`, `bad_request`, `invalid`, `storage_error`, …).
 */
export class CalendarApiError extends Error {
  constructor(code, message) {
    super(message || code || 'The request failed')
    this.name = 'CalendarApiError'
    this.code = code || ''
    // A reply proves the service is alive, whatever it says. Callers use this
    // to keep an application-level "no" from being read as "the app is gone".
    this.fromCalendar = true
  }
}

export function createCalendar({
  getPuter = () => (typeof window !== 'undefined' ? window.puter : undefined),
  appName = APP_NAME,
  now = () => Date.now(),
  idleCloseMs = IDLE_CLOSE_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  launchTimeoutMs = LAUNCH_TIMEOUT_MS,
  retryAfterMs = RETRY_AFTER_MS,
  maxRetryMs = MAX_RETRY_MS,
} = {}) {
  let conn = null // the live AppConnection, or null
  let connecting = null // in-flight connect(), so callers share one launch
  let pending = new Map() // request id -> { resolve, reject, timer }
  let nextId = 1
  let idleTimer = null
  let generation = 0 // bumped by disconnect(), so a late launch is abandoned
  let blockedUntil = 0 // set after a failure, so we stop retrying for a bit
  let failures = 0 // consecutive failures, for how long that block lasts
  const listeners = new Set()

  /** Can we talk to other apps at all? Only true inside the Puter desktop. */
  function supported() {
    if (import.meta.env.VITE_PRIVATE_STORAGE === '1') return false
    const p = getPuter()
    return Boolean(p && p.env === 'app' && p.ui && typeof p.ui.launchApp === 'function')
  }

  /** Is launching the Calendar something we should try right now? */
  function available() {
    return supported() && now() >= blockedUntil
  }

  /** Stop trying for a while, doubling the wait for a Calendar that keeps
   *  failing: a missing or denied one must not turn every selected contact into
   *  another doomed launch. Cleared by the first success. */
  function backOff(err) {
    failures += 1
    const wait = Math.min(retryAfterMs * 2 ** (failures - 1), maxRetryMs)
    blockedUntil = now() + wait
    if (err) console.warn('[contacts] calendar unavailable:', err.message || err)
  }

  /** A Calendar that answered at all is a Calendar we can reach. */
  function succeeded() {
    failures = 0
    blockedUntil = 0
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  /** Let the service window go once we've been quiet for a moment. */
  function scheduleIdleClose() {
    clearIdle()
    if (!conn) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (pending.size) return scheduleIdleClose()
      disconnect()
    }, idleCloseMs)
  }

  function rejectPending(reason) {
    const err = new Error(reason)
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(err)
    }
    pending = new Map()
  }

  /** Drop the connection. `gone: true` means the service already closed itself,
   *  so there is nothing left to close from this side. */
  function disconnect({ gone = false } = {}) {
    clearIdle()
    generation++
    const c = conn
    conn = null
    connecting = null
    rejectPending('The calendar service closed')
    if (c && !gone) closeQuietly(c)
  }

  function closeQuietly(connection) {
    try {
      connection.close()
    } catch (_e) {
      /* already gone */
    }
  }

  /** Tell subscribers the calendar changed under us, so anything showing its
   *  events can ask again. A listener that throws is its own problem. */
  function announce() {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch (err) {
        console.warn('[contacts] calendar listener failed:', err && err.message)
      }
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.$ !== CHANNEL) return
    if (msg.type === 'changed') {
      // Only covers changes the instance we launched can see — which is exactly
      // the writes we made ourselves, and that is what this is for: the "next
      // with this person" list should not still say "no upcoming events" a
      // moment after we put one there.
      announce()
      return
    }
    const entry = msg.id ? pending.get(msg.id) : null
    if (!entry) return // a reply we no longer care about, or the `ready` notice
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.ok) entry.resolve(msg.result)
    else {
      const err = msg.error || {}
      entry.reject(new CalendarApiError(err.code, err.message))
    }
  }

  /**
   * Launch the Calendar in service mode and wait for it to say hello. Resolves
   * to the AppConnection; rejects (and backs off) if it never arrives.
   */
  function connect() {
    if (conn) return Promise.resolve(conn)
    if (connecting) return connecting
    if (!available()) return Promise.reject(new Error('Calendar is not available here'))

    const p = getPuter()
    const gen = generation
    connecting = new Promise((resolve, reject) => {
      let settled = false
      let opened = null // set once launchApp resolves
      let timer = null

      // Never leave a service window behind: if it opened but never said hello,
      // close it on the way out.
      const giveUp = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (opened) closeQuietly(opened)
        reject(err)
      }
      timer = setTimeout(() => giveUp(new Error('Calendar did not respond')), launchTimeoutMs)

      // `background: true` asks the desktop not to show the window at all.
      // Older desktops ignore it and show one, which Calendar then hides itself
      // — a brief flash rather than a broken launch.
      Promise.resolve(
        p.ui.launchApp({ name: appName, args: { service: SERVICE_ARG }, background: true }),
      )
        .then((connection) => {
          if (!connection || connection.usesSDK === false) {
            throw new Error('Calendar did not open with messaging support')
          }
          opened = connection
          // Timed out, or torn down (dispose) while the launch was in flight.
          // Either way the window is ours to clean up.
          if (settled || gen !== generation) {
            closeQuietly(connection)
            giveUp(new Error('Calendar was closed'))
            return
          }
          connection.on('message', onMessage)
          connection.on('close', () => {
            if (conn === connection) {
              disconnect({ gone: true })
              return
            }
            // Closed before it ever said hello. That is the ordinary shape of
            // "the Calendar is not going to serve us" — not installed, not
            // allowed, nobody signed in — because the service exits as soon as
            // it works that out. Waiting out the launch timeout instead only
            // delays the backoff, and blocks every caller sharing this launch
            // for twelve seconds first. `giveUp` is a no-op once we're settled,
            // so a close arriving after an idle disconnect changes nothing.
            giveUp(new Error('Calendar closed before it was ready'))
          })
          // The service announces itself once it's listening; treat that as the
          // handshake, so the first real request can't race its own listener.
          const ready = (msg) => {
            if (!msg || msg.$ !== CHANNEL || msg.type !== 'ready') return
            if (typeof connection.off === 'function') connection.off('message', ready)
            if (settled) return
            if (gen !== generation) {
              closeQuietly(connection)
              giveUp(new Error('Calendar was closed'))
              return
            }
            settled = true
            clearTimeout(timer)
            conn = connection
            resolve(connection)
          }
          connection.on('message', ready)
        })
        .catch(giveUp)
    })
      .catch((err) => {
        backOff(err)
        throw err
      })
      .finally(() => {
        connecting = null
      })

    return connecting
  }

  /**
   * Call a Calendar API method. Rejects on transport failure, on a timeout, or
   * — as a `CalendarApiError`, carrying the API's own `code` — with whatever the
   * Calendar refused us for. Only the first two count against the Calendar's
   * reachability; see the note at the top of the file.
   *
   * @param {string} method 'search' | 'create' | 'update' | 'delete' | 'ping'
   * @param {object} [params]
   */
  async function call(method, params = {}) {
    const connection = await connect()
    const id = `c${nextId++}`
    clearIdle()
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Calendar timed out on "${method}"`))
      }, requestTimeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
    try {
      // postMessage can throw synchronously (the window closed under us before
      // its `close` event was delivered). The pending entry must go with it, or
      // its timer would later reject a promise nobody holds.
      connection.postMessage({ $: CHANNEL, v: VERSION, id, method, params })
      const value = await result
      // A working Calendar clears any earlier backoff.
      succeeded()
      return value
    } catch (err) {
      const entry = pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(id)
      }
      if (err instanceof CalendarApiError) {
        // The Calendar answered — it just answered "no". That is a fact about
        // this one request (an id that is gone, a window we may not write to
        // while it is offline), not about whether the Calendar can be reached,
        // and treating it as the latter took every contact card's upcoming
        // events away for a minute over one failed undo. It counts as proof the
        // service is alive, exactly like a success.
        succeeded()
      } else if (now() >= blockedUntil) {
        // Anything else — a timeout, a closed window, a launch that never
        // landed — really is the Calendar being unreachable. Back off, or a
        // service that opens but cannot answer is relaunched for every contact.
        backOff()
      }
      throw err
    } finally {
      scheduleIdleClose()
    }
  }

  return {
    /** True where talking to another app is possible at all. Safe to call on
     *  every render — unlike `available()`, it doesn't go quiet during a
     *  backoff, so the UI doesn't flicker over a transient failure. */
    supported,

    /** True when a launch of the Calendar is worth attempting right now. */
    available,

    /**
     * Called when the calendar changed under a live connection (i.e. after a
     * write of ours). Returns an unsubscribe function.
     */
    onChange(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /**
     * The next events involving any of `emails`, soonest first. Never throws and
     * never blocks a render: `null` means we couldn't ask (no desktop, no
     * Calendar, a failed launch) as opposed to `[]`, which means we asked and
     * there is nothing coming up.
     *
     * @param {string[]} emails the contact's addresses
     * @param {{ limit?: number, days?: number }} [options]
     * @returns {Promise<Array<object>|null>}
     */
    async upcomingWith(emails, { limit = 3, days = UPCOMING_DAYS } = {}) {
      const guest = (Array.isArray(emails) ? emails : [emails])
        .map((e) => text(e).trim().toLowerCase())
        .filter(Boolean)
      if (!guest.length || !available()) return null
      const from = now()
      try {
        const result = await call('search', { guest, from, to: from + days * DAY_MS, limit })
        return (result && Array.isArray(result.events) && result.events) || []
      } catch (_e) {
        // Silence is right here: this decorates a contact card, and a calendar
        // we couldn't reach is not something to interrupt someone with. `call`
        // has already decided whether this counts against the Calendar — a
        // refusal it sent us does not, so the next card asks again.
        return null
      }
    },

    /** Events matching a text query in a window. Rejects like `call`. */
    search: (params) => call('search', params).then((r) => (r && r.events) || []),

    /** Add an event; resolves to the created event. */
    create: (event) => call('create', { event }).then((r) => r && r.event),

    /** Patch an event (or, with an occurrence id, a single occurrence). */
    update: (id, patch) => call('update', { id, patch }).then((r) => r && r.event),

    /** Delete an event (or cancel a single occurrence). */
    remove: (id) => call('delete', { id }),

    /** The raw call, for anything the helpers above don't cover. */
    call,

    /** Close the service window and forget everything about this session. */
    dispose() {
      disconnect()
      listeners.clear()
      failures = 0
      blockedUntil = 0
    },
  }
}
