// "Smart Add" — paste an email signature, business card text, or any blurb and
// let Puter AI extract structured fields, which then open in the editor for
// review. This is the app's only use of AI, and it goes through puter.ai.
import { toast } from '../toast.js'
import { privateMode } from '../storage.js'
import { icons } from '../icons.js'
import { openEditor } from './editor.js'
import { confirmDialog } from './confirm.js'
import { trapTab, focusKeeper, backdropDismisser } from './modal.js'
import { normalizeContact } from '../model.js'

const SYSTEM_PROMPT = `You extract structured contact details from messy text such as email signatures or business cards.
Respond with ONLY a minified JSON object (no markdown, no commentary) matching exactly this schema:
{"firstName":"","lastName":"","company":"","jobTitle":"","emails":[{"label":"","value":""}],"phones":[{"label":"","value":""}],"urls":[{"label":"","value":""}],"addresses":[{"label":"","street":"","city":"","state":"","postalCode":""}],"birthday":"","notes":"","tags":[]}
Rules:
- Use only labels from these sets — email: Personal|Work|Other; phone: Mobile|Home|Work|Main|Other; url: Website|Work|Blog|Other; address: Home|Work|Other.
- Split each address into its parts: street (number, name, and unit/suite), city, state (or province/region, as written), and postalCode (ZIP/postcode). Leave any part you can't find as "".
- birthday must be YYYY-MM-DD or "".
- Omit any value you cannot find (use empty string or empty array). Never invent data.`

function extractText(resp) {
  if (resp == null) return ''
  if (typeof resp === 'string') return resp
  const content = resp.message && resp.message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (p && p.text) || '').join('')
  if (typeof resp.text === 'string') return resp.text
  return ''
}

function parseContactJson(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON found')
  return JSON.parse(s.slice(start, end + 1))
}

export function openSmartAdd() {
  if (privateMode) return toast('Smart Add / AI is unavailable in private mode. Add contacts manually or import a local vCard.', 'info')
  const overlay = document.createElement('div')
  overlay.className = 'overlay overlay--editor'
  overlay.innerHTML = `
    <div class="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="smart-title">
      <header class="modal__head">
        <div class="modal__head-main">
          <span class="modal__head-icon">${icons.sparkles}</span>
          <h2 id="smart-title" class="modal__title">Smart add</h2>
        </div>
        <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icons.close}</button>
      </header>
      <div class="modal__body">
        <p class="modal__lead">Paste an email signature, business card, or any contact details. AI will turn it into a contact you can review before saving.</p>
        <textarea class="input" data-text rows="7" aria-label="Text to extract contact details from" placeholder="Jane Doe&#10;Head of Design, Acme Inc.&#10;jane@acme.com · +1 555 0142&#10;acme.com"></textarea>
        <p class="form-error" data-error hidden></p>
      </div>
      <footer class="modal__foot">
        <span class="modal__hint">Powered by Puter AI</span>
        <div class="modal__foot-right">
          <button type="button" class="btn btn--soft" data-action="close">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="extract">${icons.sparkles}<span>Extract</span></button>
        </div>
      </footer>
    </div>`

  const restoreFocus = focusKeeper()
  document.body.appendChild(overlay)
  document.body.classList.add('has-overlay')
  requestAnimationFrame(() => overlay.classList.add('overlay--in'))

  const panel = overlay.querySelector('.modal')
  const textEl = overlay.querySelector('[data-text]')
  const errorEl = overlay.querySelector('[data-error]')
  const extractBtn = overlay.querySelector('[data-action="extract"]')
  let confirming = false
  let closed = false
  let extracting = false

  const close = () => {
    closed = true
    overlay.classList.remove('overlay--in')
    document.removeEventListener('keydown', onKey, true)
    document.body.classList.remove('has-overlay')
    setTimeout(() => overlay.remove(), 180)
    restoreFocus()
  }
  // Close, but confirm first if there's text that would be thrown away.
  const requestClose = async () => {
    if (confirming) return
    if (!textEl.value.trim()) return close()
    confirming = true
    const discard = await confirmDialog({
      title: 'Discard text?',
      message: "The text you pasted hasn't been turned into a contact yet.",
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    })
    confirming = false
    if (discard) close()
  }
  const onKey = (e) => {
    if (confirming) return
    if (trapTab(e, panel)) return
    if (e.key === 'Escape') requestClose()
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') extract()
  }

  async function extract() {
    // The disabled button already blocks a second click, but Cmd/Ctrl+Enter
    // bypasses it — guard here so a repeat while the request is in flight
    // can't fire a duplicate AI call.
    if (extracting) return
    const text = textEl.value.trim()
    if (!text) {
      textEl.focus()
      return
    }
    if (!window.puter || !window.puter.ai || typeof window.puter.ai.chat !== 'function') {
      errorEl.textContent = 'AI is unavailable right now.'
      errorEl.hidden = false
      return
    }
    errorEl.hidden = true
    extracting = true
    extractBtn.disabled = true
    extractBtn.classList.add('is-loading')
    try {
      const resp = await window.puter.ai.chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        { model: 'gpt-5-nano', temperature: 0 },
      )
      // The user may have cancelled while the request was in flight; if so,
      // don't surprise them by springing the editor open after the fact.
      if (closed) return
      const parsed = parseContactJson(extractText(resp))
      const contact = normalizeContact(parsed)
      const hasAnything =
        contact.firstName ||
        contact.lastName ||
        contact.company ||
        contact.emails.length ||
        contact.phones.length
      if (!hasAnything) throw new Error('Nothing useful found')
      close()
      // Open the editor pre-filled so the user can verify before saving.
      openEditor({ ...contact, id: undefined, createdAt: undefined }, { source: 'smart_add' })
      toast('Review the extracted details, then save', 'info')
    } catch (err) {
      const msg = String(err && err.message ? err.message : err)
      errorEl.textContent = /credit/i.test(msg)
        ? "You're out of Puter AI credits. Add the contact manually instead."
        : "Couldn't read those details. Try adding more text, or enter them manually."
      errorEl.hidden = false
    } finally {
      extracting = false
      extractBtn.disabled = false
      extractBtn.classList.remove('is-loading')
    }
  }

  const isBackdropDismiss = backdropDismisser(overlay)
  overlay.addEventListener('click', (e) => {
    if (isBackdropDismiss(e)) return requestClose()
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'close') requestClose()
    else if (action === 'extract') extract()
  })
  document.addEventListener('keydown', onKey, true)
  textEl.focus()
}
