// Entry point: gate on Puter auth, then mount the app and load contacts.
// One exception: when another Puter app launches us as its contacts API (see
// src/api/), there is no UI to mount — see bootService() at the bottom.
import './styles.css'
import { hasPuter, isPuterApp, isSignedIn } from './env.js'
import { privateMode, getStorage } from './storage.js'
import { escapeHtml } from './format.js'
import { store } from './store.js'
import { mountApp } from './ui/app.js'
import { readLaunchContext } from './api/protocol.js'
import { createMethods } from './api/methods.js'
import { startApiServer } from './api/server.js'
import { createSampleDataPopulator } from './demo.js'

window.contacts = { populateSampleData: createSampleDataPopulator(() =>
  !privateMode && !launch.serviceMode && (isPuterApp() || isSignedIn()) ? store : null,
) }

// The browser HTTP cache can otherwise hand back stale KV responses right after
// a write (add a contact, reload, it's missing). Force no-store on Puter API
// calls while leaving the static SDK on the CDN cacheable.
const nativeFetch = window.fetch.bind(window)
window.fetch = function (input, init) {
  try {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (/\/\/([^/]*\.)?puter\.(com|local)/i.test(url) && !url.includes('js.puter.com')) {
      init = Object.assign({}, init, { cache: 'no-store' })
    }
  } catch (_e) {
    /* fall through with the original init */
  }
  return nativeFetch(input, init)
}

const root = document.getElementById('app')

function fatal(title, message) {
  root.removeAttribute('aria-busy')
  root.innerHTML = `
    <div class="gate">
      <div class="gate__card">
        <h1 class="gate__title">${title}</h1>
        <p class="gate__lead">${message}</p>
        <button class="btn btn--primary btn--lg" onclick="location.reload()">Reload</button>
      </div>
    </div>`
}

function showSignIn() {
  root.removeAttribute('aria-busy')
  root.innerHTML = `
    <div class="gate">
      <div class="gate__card">
        <img class="gate__mark" src="/icon.svg" width="76" height="76" alt="" />
        <h1 class="gate__title">Contacts</h1>
        <p class="gate__lead">Your private address book, synced to your Puter cloud. Free, no ads — your data stays in your account.</p>
        <button class="btn btn--primary btn--lg" data-signin>Sign in</button>
        <p class="gate__error" data-signin-error hidden></p>
      </div>
    </div>`
  const btn = root.querySelector('[data-signin]')
  const errEl = root.querySelector('[data-signin-error]')
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.classList.add('is-loading')
    errEl.hidden = true
    try {
      await window.puter.auth.signIn()
      boot()
    } catch (_e) {
      // A cancelled popup is normal; a real failure should say something.
      errEl.textContent = 'Sign-in didn’t complete. Please try again.'
      errEl.hidden = false
      btn.disabled = false
      btn.classList.remove('is-loading')
    }
  })
}

// Who (if anyone) launched us, and how — resolved once at startup, before any
// sign-in flow, so a boot after signing in still knows its caller.
let launch = { callerApp: '', serviceMode: false, inPuterApp: false }

async function boot() {
  let email = ''
  try {
    const user = await window.puter.auth.getUser()
    email = (user && (user.email || user.username)) || ''
  } catch (_e) {
    /* non-fatal: the menu just won't show an address */
  }

  mountApp(root, { email })
  setWindowTitle('Contacts')

  // Launched by an app we serve, but with a window of our own (the caller asked
  // for the UI, not the headless service). Serve the API too, so the caller
  // isn't forced to open a second, hidden instance to talk to us.
  if (launch.callerApp) serveApi(launch.callerApp)

  try {
    await store.load()
  } catch (_e) {
    // store.error is set; render() shows a retry affordance.
  }
}

/* ---- App-to-app API ------------------------------------------------------ */

// How long a headless service instance stays alive with nothing to do. The
// client re-launches us on demand, and closing the window frees the connection
// on both sides, so a short-lived service is the tidy default.
const SERVICE_IDLE_MS = 5 * 60 * 1000

function setWindowTitle(title) {
  try {
    if (window.puter.ui && typeof window.puter.ui.setWindowTitle === 'function') {
      window.puter.ui.setWindowTitle(title)
    }
  } catch (_e) {
    /* ignore — only meaningful inside the Puter desktop */
  }
}

/** Hand the API to the app that launched us. Returns the server, or null when
 *  that app has no grant (see api/protocol.js). */
function serveApi(callerApp, { onActivity } = {}) {
  let connection = null
  try {
    connection = window.puter.ui.parentApp()
  } catch (_e) {
    return null
  }
  if (!connection) return null
  return startApiServer({
    connection,
    callerApp,
    methods: createMethods({ store }),
    subscribe: (fn) => store.subscribe(fn),
    // So a `changed` notice means the address book changed, and not that the
    // store emitted — which it also does for a re-read and for UI state.
    revision: () => store.revision(),
    onActivity,
  })
}

/**
 * Headless boot: another app launched us purely to use the contacts API, so
 * there is no UI to mount and no window to show. index.html has already hidden
 * the window (before this bundle loaded, to avoid a flash); we hide again here
 * because that early attempt is best-effort.
 *
 * The panel rendered below is a safety net — it is what the user would see if
 * hiding failed, or if they un-hide the window from the taskbar.
 */
function bootService() {
  hideWindow()
  setWindowTitle('Contacts')

  let idleTimer = null
  let server = null
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (server) server.stop()
      exit()
    }, SERVICE_IDLE_MS)
  }
  server = serveApi(launch.callerApp, { onActivity: touch })

  if (!server) {
    // Not an app we serve. Don't linger as an invisible process: close the
    // window if we can, and otherwise show it with an explanation rather than
    // leaving a hidden instance the user can't see.
    console.warn(
      `[contacts] "${launch.callerApp || 'an unidentified app'}" is not allowed to use the contacts API`,
    )
    renderServicePanel(launch.callerApp, false)
    if (!exit()) showWindow()
    return
  }

  renderServicePanel(launch.callerApp, true)
  touch()
}

function renderServicePanel(callerApp, allowed) {
  root.removeAttribute('aria-busy')
  root.innerHTML = `
    <div class="gate">
      <div class="gate__card">
        <img class="gate__mark" src="/icon.svg" width="76" height="76" alt="" />
        <h1 class="gate__title">Contacts</h1>
        <p class="gate__lead" data-service-lead></p>
      </div>
    </div>`
  // The caller's name comes from the launch URL, so it goes in as text, never
  // as markup.
  const app = callerApp ? callerApp[0].toUpperCase() + callerApp.slice(1) : 'Another app'
  root.querySelector('[data-service-lead]').textContent = allowed
    ? `${app} is using your contacts. Nothing leaves your Puter account, and you can close this window at any time.`
    : `${app} asked to use your contacts and was not allowed to. You can close this window.`
}

function hideWindow() {
  try {
    window.puter.ui.hideWindow()
  } catch (_e) {
    /* best-effort: an older desktop may not support it */
  }
}

function showWindow() {
  try {
    window.puter.ui.showWindow()
  } catch (_e) {
    /* best-effort */
  }
}

/** Close this instance. Returns false when the SDK can't (nothing happened). */
function exit() {
  try {
    if (typeof window.puter.exit !== 'function') return false
    window.puter.exit(0)
    return true
  } catch (_e) {
    return false
  }
}

async function init() {
  if (privateMode) {
    try {
      const user = await getStorage().ready()
      await store.load()
      mountApp(root, { email: user.username })
    } catch (error) {
      fatal('Private storage unavailable', escapeHtml(error.message))
    }
    return
  }
  if (!hasPuter) {
    fatal('Connection problem', 'Could not reach Puter. Check your connection and reload.')
    return
  }
  launch = readLaunchContext(window)
  if (launch.serviceMode) {
    bootService()
    return
  }
  if (!isPuterApp() && !isSignedIn()) {
    showSignIn()
    return
  }
  boot()
}

// Register the offline app-shell service worker on the open web. It only caches
// same-origin static assets (never Puter API/SDK traffic), so it cannot affect
// cloud data or auth. Skipped in dev, inside the Puter desktop shell, and where
// service workers are unavailable; failures are non-fatal (progressive
// enhancement only).
if (!privateMode && import.meta.env.PROD && 'serviceWorker' in navigator && !isPuterApp()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

init()
