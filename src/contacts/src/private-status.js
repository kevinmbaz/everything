import { getStorage } from './storage.js'

/** Persistent transport feedback, outside the re-rendered contact list. */
export function mountPrivateStatus(root) {
  const storage = getStorage()
  const banner = document.createElement('section')
  banner.className = 'private-storage-banner'
  banner.style.cssText = 'padding:8px 16px;border-bottom:1px solid currentColor;font-size:12px;flex:none'
  banner.innerHTML = '<div data-private-status role="status" aria-live="polite"></div><div data-private-features>Private mode: Smart Add / AI, Drive import, Calendar, cloud sharing and headless/MCP cross-app bridges are unavailable. Local vCard import/export and avatars remain available. Import is additive: existing IDs and duplicate identities are skipped, never replaced; partial failures are reported. Email links open your external mail client; Contacts does not send mail.</div>'
  root.querySelector('.app-shell').prepend(banner)
  const status = banner.querySelector('[data-private-status]')
  const render = () => {
    status.textContent = storage.error
      ? `Not saved — ${storage.error.message} Copy/export unsaved drafts before manually reloading. No automatic retry.`
      : storage.dirty ? 'Unsaved changes / saving to Jetson…' : 'Saved to private Jetson storage'
    status.setAttribute('role', storage.error ? 'alert' : 'status')
  }
  storage.events.addEventListener('state', render)
  window.addEventListener('beforeunload', event => {
    if (root.isConnected && storage.dirty) { event.preventDefault(); event.returnValue = '' }
  })
  render()
}
