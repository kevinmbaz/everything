/**
 * Drop a .vcf anywhere on the app and it imports — the gesture people try
 * before they go looking for the menu item.
 *
 * Two kinds of drop reach an app, and they arrive by completely different
 * routes:
 *
 *   - A file dragged from the *host OS* (Finder, a download, a mail
 *     attachment) lands as an ordinary HTML5 drop, with a File in
 *     `dataTransfer.files`. This is the only kind on the open web.
 *   - A file dragged from the *Puter desktop* fires no DOM drag event at all —
 *     the desktop is dragging its own element, in its own document, and our
 *     window is an iframe underneath it. Puter delivers those to us through
 *     `puter.ui.onItemsOpened` instead, as cloud items to read.
 *
 * Both funnel into one importer, so a dropped card behaves the same wherever
 * it came from. Registering `onItemsOpened` also covers opening a .vcf *with*
 * Contacts from the desktop, which should do exactly the same thing.
 *
 * The module is transport-only: it decides what was dropped and hands over
 * something that reads like a file (`name` + `text()`). The importing itself
 * stays in app.js, shared with the file picker.
 */

const VCARD_NAME = /\.(vcf|vcard)$/i

/**
 * Whether a dropped thing looks like a vCard. The name is the reliable signal:
 * browsers disagree on the MIME type for .vcf (Chrome says `text/vcard`, some
 * say `text/x-vcard`, others send nothing at all), and a Puter item carries no
 * type in the first place.
 */
export function isVCardFile(file) {
  if (!file) return false
  return VCARD_NAME.test(file.name || '') || /vcard/i.test(file.type || '')
}

/** True when a drag is carrying files, rather than selected text or a link. */
function hasFiles(dataTransfer) {
  if (!dataTransfer || !dataTransfer.types) return false
  return Array.from(dataTransfer.types).includes('Files')
}

/**
 * Adapt a Puter FSItem to the shape the importer wants — the same `name` and
 * `text()` a File has, so neither path needs a special case downstream.
 */
function itemAsFile(item) {
  return {
    name: item.name,
    async text() {
      // read() goes through puter.fs under our own permissions, and is always
      // current. readURL is the pre-signed URL the desktop minted for this
      // exact file when it handed it to us — the fallback for a file whose
      // path isn't otherwise ours to read.
      try {
        return await (await item.read()).text()
      } catch (err) {
        if (!item.readURL) throw err
        const res = await fetch(item.readURL)
        if (!res.ok) throw new Error(`Could not read "${item.name}" (${res.status})`)
        return await res.text()
      }
    },
  }
}

/**
 * Make the app a drop target for contact files.
 *
 * @param {object} deps
 * @param {Element} [deps.zone] the drop indicator, shown while a file is over
 *   the window (hidden via the `hidden` attribute when idle)
 * @param {(files: Array<{name: string, text: () => Promise<string>}>) => void} deps.onFiles
 *   called with the vCard files of a drop
 * @param {(files: Array<{name: string}>) => void} [deps.onRejected] called
 *   instead when something was dropped but none of it was a vCard, so a drop
 *   never just vanishes
 * @param {EventTarget} [deps.target] where to listen (the document by default)
 * @param {Window} [deps.win] for the Puter SDK, injectable for tests
 * @returns {{ stop: () => void }}
 */
export function startDropImport({
  zone = null,
  onFiles,
  onRejected = null,
  target = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null,
}) {
  const show = () => zone && zone.removeAttribute('hidden')
  const hide = () => zone && zone.setAttribute('hidden', '')

  function deliver(files) {
    const vcards = files.filter(isVCardFile)
    if (vcards.length) onFiles(vcards)
    else if (files.length && onRejected) onRejected(files)
  }

  // dragenter/dragleave fire for *every* element the pointer crosses, so a
  // plain boolean flickers the indicator as the cursor moves across the list.
  // Counting enters against leaves is the standard fix.
  let depth = 0

  const onDragEnter = (e) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    depth += 1
    show()
  }

  const onDragOver = (e) => {
    if (!hasFiles(e.dataTransfer)) return
    // Without this the browser takes the drop itself and navigates away to the
    // file — the app is simply gone. Every drag needs it, not just ours.
    e.preventDefault()
    try {
      e.dataTransfer.dropEffect = 'copy'
    } catch (_e) {
      /* read-only in some browsers mid-drag; the cursor hint is cosmetic */
    }
    // A drag that began outside the window can deliver its first event here
    // rather than at dragenter (and a re-entry after an unbalanced leave, too).
    if (!depth) {
      depth = 1
      show()
    }
  }

  // Deliberately not gated on hasFiles(): if a browser stops reporting the
  // drag's types once it is leaving, the counter must still come back down —
  // an indicator stuck over the whole app is far worse than one leave too many.
  // Leaving the window balances the enters, so this reaches zero on its own.
  const onDragLeave = () => {
    depth = Math.max(0, depth - 1)
    if (!depth) hide()
  }

  const onDrop = (e) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    depth = 0
    hide()
    deliver([...(e.dataTransfer.files || [])])
  }

  // A cancelled drag (Escape, or a drop rejected by the OS) fires neither drop
  // nor a final dragleave in every browser — without this the indicator sticks.
  const onDragEnd = () => {
    depth = 0
    hide()
  }

  const listeners = [
    ['dragenter', onDragEnter],
    ['dragover', onDragOver],
    ['dragleave', onDragLeave],
    ['drop', onDrop],
    ['dragend', onDragEnd],
  ]
  if (target) for (const [type, fn] of listeners) target.addEventListener(type, fn)

  // The Puter route. onItemsOpened holds a single callback, so this is
  // registered once per app instance (from mountApp) and never in service mode.
  const ui = import.meta.env.VITE_PRIVATE_STORAGE !== '1' && win && win.puter && win.puter.ui
  if (ui && typeof ui.onItemsOpened === 'function') {
    try {
      ui.onItemsOpened((items) => {
        const files = (Array.isArray(items) ? items : []).filter((i) => i && !i.isDirectory)
        // Wrapped before filtering, not after: the wrapper keeps the name the
        // filter reads, and text() is only ever called on what survives it.
        deliver(files.map(itemAsFile))
      })
    } catch (_e) {
      /* an older desktop without it — OS drops still work */
    }
  }

  return {
    stop() {
      if (target) for (const [type, fn] of listeners) target.removeEventListener(type, fn)
      hide()
    },
  }
}
