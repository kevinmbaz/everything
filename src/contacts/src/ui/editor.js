// Add/edit contact form, shown as a modal panel.
import { store } from '../store.js'
import { privateMode, getStorage } from '../storage.js'
import { contactToVCard } from '../vcard.js'
import { toast } from '../toast.js'
import { icons } from '../icons.js'
import { track } from '../analytics.js'
import { confirmDialog } from './confirm.js'
import { trapTab, focusKeeper, backdropDismisser } from './modal.js'
import { initials, avatarColor } from '../avatar.js'
import {
  createContact,
  validateContact,
  isValidEmail,
  displayName,
  EMAIL_LABELS,
  PHONE_LABELS,
  URL_LABELS,
} from '../model.js'
import { escapeHtml, escapeAttr } from '../format.js'
import { COUNTRY_OPTIONS, defaultCountryCode } from '../countries.js'
import { addressFormat, fieldLabel } from '../address.js'

// `valueLabel` is the accessible name for a row's value input — placeholders
// alone don't reliably name a field for assistive tech.
const GROUPS = {
  emails: { labels: EMAIL_LABELS, type: 'email', placeholder: 'name@example.com', addLabel: 'Add email', valueLabel: 'Email address' },
  phones: { labels: PHONE_LABELS, type: 'tel', placeholder: 'Phone number', addLabel: 'Add phone', valueLabel: 'Phone number' },
  urls: { labels: URL_LABELS, type: 'url', placeholder: 'https://example.com', addLabel: 'Add link', valueLabel: 'Link URL' },
}

// One input/select for a single address field, per the country's format.
function addressFieldControl(key, format, addr) {
  const label = fieldLabel(format, key)
  if (key === 'state' && format.states) {
    // Keep an existing value that isn't in this country's list (e.g. after
    // switching countries) so it isn't silently dropped.
    const states =
      addr.state && !format.states.includes(addr.state) ? [addr.state, ...format.states] : format.states
    const opts = states
      .map((s) => `<option value="${escapeAttr(s)}" ${s === addr.state ? 'selected' : ''}>${escapeHtml(s)}</option>`)
      .join('')
    return `<select class="input" data-addr-field="state" aria-label="${escapeAttr(label)}"><option value="">${escapeHtml(label)}</option>${opts}</select>`
  }
  return `<input class="input" data-addr-field="${key}" value="${escapeAttr(addr[key] || '')}" placeholder="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" />`
}

// The country-dependent field rows (everything except country + label).
function addressFieldsHtml(countryCode, addr) {
  const format = addressFormat(countryCode)
  return format.rows
    .map((row) => {
      const cells = row.map((key) => addressFieldControl(key, format, addr)).join('')
      return `<div class="address-row address-row--${row.length}">${cells}</div>`
    })
    .join('')
}

// A full address block: country selector, dynamic fields, free-text label.
function addressBlockHtml(addr = {}) {
  const country = addr.country || ''
  const selected = (code) => (code === country ? ' selected' : '')
  return `
    <div class="address-block" data-address>
      <div class="address-block__head">
        <select class="input" data-addr-field="country" aria-label="Country/Region">
          <option value=""${selected('')}>Country/Region</option>
          ${COUNTRY_OPTIONS.map((o) => `<option value="${escapeAttr(o.code)}"${selected(o.code)}>${escapeHtml(o.name)}</option>`).join('')}
        </select>
        <button type="button" class="icon-btn repeat-row__remove" data-action="remove-address" aria-label="Remove address">${icons.close}</button>
      </div>
      <div class="address-fields" data-address-fields>${addressFieldsHtml(country, addr)}</div>
      <input class="input" data-addr-field="label" value="${escapeAttr(addr.label || '')}" placeholder="Label" aria-label="Address label" />
    </div>`
}

function collectAddresses(panel) {
  const out = []
  panel.querySelectorAll('[data-address]').forEach((block) => {
    const addr = { label: '', country: '', street: '', street2: '', city: '', state: '', postalCode: '', poBox: '' }
    block.querySelectorAll('[data-addr-field]').forEach((el) => {
      addr[el.dataset.addrField] = el.value.trim()
    })
    if (addr.street || addr.street2 || addr.city || addr.state || addr.postalCode || addr.poBox) out.push(addr)
  })
  return out
}

function optionList(labels, selected) {
  const all = labels.includes(selected) || !selected ? labels : [selected, ...labels]
  return all
    .map((l) => `<option value="${escapeAttr(l)}" ${l === selected ? 'selected' : ''}>${escapeHtml(l)}</option>`)
    .join('')
}

function rowHtml(group, entry = { label: '', value: '' }) {
  const cfg = GROUPS[group]
  const label = entry.label || cfg.labels[0]
  const valueField =
    cfg.type === 'textarea'
      ? `<textarea class="input repeat-row__value" rows="2" placeholder="${escapeAttr(cfg.placeholder)}" aria-label="${escapeAttr(cfg.valueLabel)}">${escapeHtml(entry.value)}</textarea>`
      : `<input class="input repeat-row__value" type="${cfg.type}" value="${escapeAttr(entry.value)}" placeholder="${escapeAttr(cfg.placeholder)}" aria-label="${escapeAttr(cfg.valueLabel)}" />`
  return `
    <div class="repeat-row">
      <select class="input input--label repeat-row__label" aria-label="Label">${optionList(cfg.labels, label)}</select>
      ${valueField}
      <button type="button" class="icon-btn repeat-row__remove" data-action="remove-row" aria-label="Remove">${icons.close}</button>
    </div>`
}

function groupHtml(group, label, entries) {
  const rows = (entries && entries.length ? entries : []).map((e) => rowHtml(group, e)).join('')
  return `
    <div class="form-group" data-group="${group}">
      <span class="form-label">${escapeHtml(label)}</span>
      <div class="repeat" data-rows>${rows}</div>
      <button type="button" class="add-row" data-action="add-row" data-group="${group}">${icons.plus}<span>${escapeHtml(GROUPS[group].addLabel)}</span></button>
    </div>`
}

function collectGroup(panel, group) {
  const rows = panel.querySelectorAll(`.form-group[data-group="${group}"] .repeat-row`)
  const out = []
  rows.forEach((row) => {
    const label = row.querySelector('.repeat-row__label').value
    const value = row.querySelector('.repeat-row__value').value.trim()
    if (value) out.push({ label, value })
  })
  return out
}

/**
 * Open the editor. Pass an existing contact to edit, or a partial / nothing to
 * create. Returns nothing; saving updates the store and selection directly.
 * `source` tags where a *new* contact came from ('manual' | 'smart_add') for
 * analytics; it's ignored when editing an existing contact.
 */
export function openEditor(contact, { source = 'manual' } = {}) {
  const isEdit = !!(contact && store.get(contact.id))
  const c = contact || {}
  // Mint the id up front for a brand-new contact: the avatar color is keyed
  // off the id, so previewing without one (falling back to the typed name)
  // would show a color that visibly changes the moment the contact is saved.
  const draftId = c.id || createContact({}).id

  // A year-less birthday is stored as 0000-MM-DD. A native <input type="date">
  // can't represent year 0000 (it would show blank and then get wiped on save),
  // so display it on a neutral leap year and remember the "hide year" flag.
  const bdayParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.birthday || '')
  const birthdayNoYear = !!bdayParts && bdayParts[1] === '0000'
  const birthdayInputValue = birthdayNoYear ? `2000-${bdayParts[2]}-${bdayParts[3]}` : c.birthday || ''

  const overlay = document.createElement('div')
  overlay.className = 'overlay overlay--editor'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="editor-title">
      <header class="modal__head">
        <div class="modal__head-main">
          <button type="button" class="avatar avatar--md editor-avatar" data-action="pick-photo" data-avatar title="Set photo" aria-label="Set photo">
            <span class="editor-avatar__badge" aria-hidden="true">${icons.edit}</span>
          </button>
          <div class="modal__head-text">
            <h2 id="editor-title" class="modal__title">${isEdit ? 'Edit contact' : 'New contact'}</h2>
            <button type="button" class="editor-photo-remove" data-action="remove-photo" hidden>Remove photo</button>
          </div>
        </div>
        <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icons.close}</button>
      </header>

      <form class="modal__body" data-form novalidate>
        <p class="form-error" data-error hidden></p>

        <div class="form-row">
          <label class="field-input">
            <span class="form-label">First name</span>
            <input class="input" name="firstName" value="${escapeAttr(c.firstName || '')}" autocomplete="given-name" />
          </label>
          <label class="field-input">
            <span class="form-label">Last name</span>
            <input class="input" name="lastName" value="${escapeAttr(c.lastName || '')}" autocomplete="family-name" />
          </label>
        </div>

        <label class="field-input">
          <span class="form-label">Nickname</span>
          <input class="input" name="nickname" value="${escapeAttr(c.nickname || '')}" autocomplete="nickname" />
        </label>

        <div class="form-row">
          <label class="field-input">
            <span class="form-label">Company</span>
            <input class="input" name="company" value="${escapeAttr(c.company || '')}" autocomplete="organization" />
          </label>
          <label class="field-input">
            <span class="form-label">Job title</span>
            <input class="input" name="jobTitle" value="${escapeAttr(c.jobTitle || '')}" autocomplete="organization-title" />
          </label>
        </div>

        ${groupHtml('emails', 'Email', c.emails)}
        ${groupHtml('phones', 'Phone', c.phones)}
        ${groupHtml('urls', 'Links', c.urls)}

        <div class="form-group" data-address-group>
          <span class="form-label">Address</span>
          <div class="addresses" data-addresses>${(c.addresses || []).map((a) => addressBlockHtml(a)).join('')}</div>
          <button type="button" class="add-row" data-action="add-address">${icons.plus}<span>Add address</span></button>
        </div>

        <div class="form-row">
          <!-- Not a wrapping <label>: it would hold two controls and nest the
               "Hide year" label inside it (both invalid HTML), so the date
               input gets an explicit for/id association instead. -->
          <div class="field-input">
            <label class="form-label" for="editor-birthday">Birthday</label>
            <input class="input" type="date" id="editor-birthday" name="birthday" value="${escapeAttr(birthdayInputValue)}" />
            <label class="checkline">
              <input type="checkbox" name="birthdayNoYear" ${birthdayNoYear ? 'checked' : ''} />
              <span>Hide year</span>
            </label>
          </div>
          <label class="field-input">
            <span class="form-label">Tags</span>
            <input class="input" name="tags" value="${escapeAttr((c.tags || []).join(', '))}" placeholder="friend, vip" />
          </label>
        </div>

        <label class="field-input">
          <span class="form-label">Notes</span>
          <textarea class="input" name="notes" rows="3" placeholder="Anything worth remembering">${escapeHtml(c.notes || '')}</textarea>
        </label>

        <label class="toggle">
          <input type="checkbox" name="favorite" ${c.favorite ? 'checked' : ''} />
          <span class="toggle__track"><span class="toggle__thumb"></span></span>
          <span>Add to favorites</span>
        </label>
      </form>

      <footer class="modal__foot">
        ${isEdit ? `<button type="button" class="btn btn--ghost-danger" data-action="delete">${icons.trash}<span>Delete</span></button>` : '<span></span>'}
        <div class="modal__foot-right">
          ${privateMode ? '<button type="button" class="btn btn--soft" data-action="export-draft">Export draft</button>' : ''}
          <button type="button" class="btn btn--soft" data-action="close">Cancel</button>
          <button type="button" class="btn btn--primary" data-action="save">${isEdit ? 'Save changes' : 'Add contact'}</button>
        </div>
      </footer>
    </div>`

  const restoreFocus = focusKeeper()
  document.body.appendChild(overlay)
  document.body.classList.add('has-overlay')
  requestAnimationFrame(() => overlay.classList.add('overlay--in'))

  const panel = overlay.querySelector('.modal')
  const form = overlay.querySelector('[data-form]')
  const errorEl = overlay.querySelector('[data-error]')
  const avatarEl = overlay.querySelector('[data-avatar]')
  const removePhotoBtn = overlay.querySelector('[data-action="remove-photo"]')
  const saveBtn = overlay.querySelector('[data-action="save"]')

  let photoData = c.photo || ''
  let photoPending = 0
  let closed = false
  // A brand-new contact that already has content (e.g. pre-filled by Smart Add)
  // counts as unsaved work, so dismissing it should confirm just like typed edits.
  const prefilled =
    !isEdit &&
    !!(
      c.firstName ||
      c.lastName ||
      c.company ||
      c.jobTitle ||
      c.birthday ||
      c.notes ||
      c.photo ||
      (c.emails && c.emails.length) ||
      (c.phones && c.phones.length) ||
      (c.urls && c.urls.length) ||
      (c.addresses && c.addresses.length) ||
      (c.tags && c.tags.length) ||
      c.favorite
    )
  let dirty = prefilled
  let confirming = false
  let saving = false
  let generation = 0
  function markDirty() {
    dirty = true; generation++
    if (privateMode) getStorage().setDraft(overlay, true)
  }
  if (privateMode) getStorage().setDraft(overlay, prefilled)
  const beforeUnload = event => {
    if (dirty || saving || getStorage().dirty) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  if (privateMode) window.addEventListener('beforeunload', beforeUnload)

  // Hidden image picker, scoped to this modal so it's cleaned up on close.
  const photoInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' })
  photoInput.style.display = 'none'
  overlay.appendChild(photoInput)
  photoInput.addEventListener('change', () => {
    const file = photoInput.files && photoInput.files[0]
    photoInput.value = ''
    if (file) setPhotoFromFile(file)
  })

  const close = () => {
    closed = true
    if (privateMode) {
      window.removeEventListener('beforeunload', beforeUnload)
      getStorage().setDraft(overlay, false)
    }
    overlay.classList.remove('overlay--in')
    document.removeEventListener('keydown', onKey, true)
    document.body.classList.remove('has-overlay')
    setTimeout(() => overlay.remove(), 180)
    restoreFocus()
  }

  // Close, but guard against silently discarding unsaved edits.
  const requestClose = async () => {
    if (confirming || (privateMode && saving)) return
    if (!dirty) return close()
    confirming = true
    const discard = await confirmDialog({
      title: 'Discard changes?',
      message: 'Your unsaved edits to this contact will be lost.',
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
    if (e.key === 'Escape') {
      e.stopPropagation()
      requestClose()
      return
    }
    // Save on Cmd/Ctrl+Enter from anywhere, or on a bare Enter from a single-line
    // input — textareas keep Enter for newlines, selects keep it for choosing.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target.tagName === 'INPUT')) {
      e.preventDefault()
      save()
    }
  }

  const badge = `<span class="editor-avatar__badge" aria-hidden="true">${icons.edit}</span>`

  const paintAvatar = () => {
    if (photoData) {
      avatarEl.style.background = 'transparent'
      avatarEl.innerHTML = `<img src="${escapeAttr(photoData)}" alt="" />${badge}`
      removePhotoBtn.hidden = false
      return
    }
    const preview = {
      id: draftId,
      firstName: form.firstName.value,
      lastName: form.lastName.value,
      nickname: form.nickname.value,
      company: form.company.value,
    }
    avatarEl.style.background = avatarColor(preview)
    avatarEl.innerHTML = `${escapeHtml(initials(preview))}${badge}`
    removePhotoBtn.hidden = true
  }

  // Downscale + compress to a small JPEG so the avatar fits comfortably inside
  // the contact's KV value (kept well under the 400 KB limit).
  function fileToDataUrl(file, max = 480, quality = 0.82) {
    return new Promise((resolve, reject) => {
      if (!file.type || !file.type.startsWith('image/')) return reject(new Error('Not an image'))
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Could not load image'))
      }
      img.src = url
    })
  }

  async function setPhotoFromFile(file) {
    if (privateMode) { photoPending++; markDirty() }
    try {
      const decoded = await fileToDataUrl(file)
      if (privateMode && closed) return
      photoData = decoded
      markDirty()
      paintAvatar()
    } catch (_e) {
      toast('Could not use that image', 'error')
    } finally {
      if (privateMode) photoPending--
    }
  }

  // Recombine the date field with the "hide year" flag into the stored value.
  const readBirthday = () => {
    const v = form.birthday.value
    if (!v) return ''
    return form.birthdayNoYear.checked ? `0000-${v.slice(5)}` : v
  }

  const collect = () => {
    const data = {
      id: draftId,
      createdAt: c.createdAt,
      firstName: form.firstName.value,
      lastName: form.lastName.value,
      company: form.company.value,
      jobTitle: form.jobTitle.value,
      nickname: form.nickname.value,
      birthday: readBirthday(),
      tags: form.tags.value,
      notes: form.notes.value,
      photo: photoData,
      favorite: form.favorite.checked,
      emails: collectGroup(panel, 'emails'),
      phones: collectGroup(panel, 'phones'),
      urls: collectGroup(panel, 'urls'),
      addresses: collectAddresses(panel),
    }
    return isEdit ? data : createContact(data)
  }

  // Flag every email field that isn't a valid address; returns the first one.
  function markBadEmails() {
    let firstBad = null
    panel.querySelectorAll('.form-group[data-group="emails"] .repeat-row').forEach((row) => {
      const input = row.querySelector('.repeat-row__value')
      const value = input.value.trim()
      if (value && !isValidEmail(value)) {
        input.classList.add('input--error')
        input.setAttribute('aria-invalid', 'true')
        if (!firstBad) firstBad = input
      }
    })
    return firstBad
  }

  function clearFieldErrors() {
    panel.querySelectorAll('.input--error').forEach((el) => {
      el.classList.remove('input--error')
      el.removeAttribute('aria-invalid')
    })
  }

  async function save() {
    // Guard against a second click (or Cmd+Enter) before the first write
    // settles — a double submit would otherwise re-save and double up the
    // toast/analytics for the same contact.
    if (saving) return
    if (privateMode && photoPending) {
      errorEl.textContent = 'Photo is still processing. Wait before saving or exporting this draft.'
      errorEl.hidden = false
      return
    }
    const draft = collect()
    const { valid, errors } = validateContact(draft)
    clearFieldErrors()
    if (!valid) {
      errorEl.textContent = errors.general || errors.emails || errors.birthday || 'Please check the form.'
      errorEl.hidden = false
      const firstBad = errors.emails ? markBadEmails() : null
      ;(firstBad || errorEl).scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      if (firstBad) firstBad.focus()
      return
    }
    errorEl.hidden = true
    saving = true
    saveBtn.disabled = true
    saveBtn.classList.add('is-loading')
    const submittedGeneration = generation
    try {
      const saved = await store.save(draft)
      store.setUI({ selectedId: saved.id })
      if (privateMode && generation !== submittedGeneration) {
        errorEl.textContent = 'Earlier changes saved. Newer edits are still unsaved; save again.'
        errorEl.hidden = false
        saving = false
        saveBtn.disabled = false
        saveBtn.classList.remove('is-loading')
        return
      }
      if (!isEdit) track('Contact Added', { method: source })
      toast(isEdit ? 'Contact updated' : `${displayName(saved)} added`, 'success')
      close()
    } catch (error) {
      errorEl.textContent = privateMode
        ? `${error.message} Not saved. Copy/export your draft before manually reloading; automatic retry is disabled.`
        : 'Could not save to your cloud. Please try again.'
      errorEl.hidden = false
      saving = false
      saveBtn.disabled = false
      saveBtn.classList.remove('is-loading')
    }
  }

  async function remove() {
    // Mirror requestClose's guard: while this nested confirm is open, the
    // editor's own key handler must stand down so Esc/Tab belong to the dialog
    // on top — otherwise Escape would close the editor out from under it.
    if (confirming || (privateMode && saving)) return
    confirming = true
    const ok = await confirmDialog({
      title: `Delete ${displayName(c)}?`,
      message: 'This permanently removes the contact from your cloud.',
      confirmLabel: 'Delete',
      danger: true,
    })
    confirming = false
    if (!ok) return
    const submittedGeneration = generation
    if (privateMode) { saving = true; saveBtn.disabled = true }
    try {
      await store.remove(c.id)
      if (privateMode && generation !== submittedGeneration) {
        errorEl.textContent = 'Contact deleted. Newer edits remain unsaved; export them or save to recreate this contact.'
        errorEl.hidden = false
        return
      }
      toast('Contact deleted', 'success', 6000, {
        label: 'Undo',
        onClick: async () => {
          try {
            // saveMany, not importMany: restore exactly by id — de-dup would
            // skip a contact that shares an email/phone with another one.
            const { failed } = await store.saveMany([c])
            if (failed) throw new Error('restore failed')
            store.setUI({ selectedId: c.id })
            toast('Contact restored', 'success')
          } catch (_e) {
            toast('Could not restore', 'error')
          }
        },
      })
      close()
    } catch (error) {
      if (privateMode) {
        errorEl.textContent = `${error.message} Not deleted. Export your draft before manually reloading.`
        errorEl.hidden = false
      }
      toast('Could not delete the contact', 'error')
    } finally {
      if (privateMode) { saving = false; saveBtn.disabled = false }
    }
  }

  const isBackdropDismiss = backdropDismisser(overlay)
  overlay.addEventListener('click', (e) => {
    if (isBackdropDismiss(e)) return requestClose()
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'close') requestClose()
    else if (action === 'export-draft') {
      if (privateMode && photoPending) {
        errorEl.textContent = 'Photo is still processing. Wait before saving or exporting this draft.'
        errorEl.hidden = false
        return
      }
      const url = URL.createObjectURL(new Blob([contactToVCard(collect(), { preserveIds: true })], { type: 'text/vcard;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url; link.download = 'contact-draft.vcf'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    else if (action === 'save') save()
    else if (action === 'delete') remove()
    else if (action === 'pick-photo') photoInput.click()
    else if (action === 'remove-photo') {
      photoData = ''
      markDirty()
      paintAvatar()
    } else if (action === 'add-row') {
      const group = e.target.closest('[data-action="add-row"]').dataset.group
      const rows = overlay.querySelector(`.form-group[data-group="${group}"] [data-rows]`)
      rows.insertAdjacentHTML('beforeend', rowHtml(group))
      rows.lastElementChild.querySelector('.repeat-row__value').focus()
    } else if (action === 'remove-row') {
      const row = e.target.closest('.repeat-row')
      // Removing a filled-in row is an edit: the discard guard must know.
      if (row.querySelector('.repeat-row__value').value.trim()) markDirty()
      row.remove()
    } else if (action === 'add-address') {
      const list = overlay.querySelector('[data-addresses]')
      list.insertAdjacentHTML('beforeend', addressBlockHtml({ country: defaultCountryCode() }))
      list.lastElementChild.querySelector('[data-addr-field="street"]')?.focus()
    } else if (action === 'remove-address') {
      const block = e.target.closest('.address-block')
      // Same as remove-row, using the fields that make an address non-empty
      // (country/label alone don't count — collectAddresses drops those).
      const filled = [...block.querySelectorAll('[data-addr-field]')].some(
        (el) => !['country', 'label'].includes(el.dataset.addrField) && el.value.trim(),
      )
      if (filled) markDirty()
      block.remove()
    }
  })

  form.addEventListener('input', (e) => {
    markDirty()
    if (e.target.classList && e.target.classList.contains('input--error')) {
      e.target.classList.remove('input--error')
      e.target.removeAttribute('aria-invalid')
    }
    if (['firstName', 'lastName', 'nickname', 'company'].includes(e.target.name)) paintAvatar()
  })

  // Reshape an address block's fields when its country changes, keeping any
  // values the new layout still has a place for.
  form.addEventListener('change', (e) => {
    markDirty()
    if (!(e.target.matches && e.target.matches('[data-addr-field="country"]'))) return
    const block = e.target.closest('[data-address]')
    const addr = {}
    block.querySelectorAll('[data-addr-field]').forEach((el) => {
      addr[el.dataset.addrField] = el.value
    })
    addr.country = e.target.value
    block.querySelector('[data-address-fields]').innerHTML = addressFieldsHtml(e.target.value, addr)
  })

  form.addEventListener('submit', (e) => e.preventDefault())
  document.addEventListener('keydown', onKey, true)

  paintAvatar()

  // Focus the first empty primary field.
  const firstField = form.firstName.value ? form.querySelector('input[name="company"]') : form.firstName
  ;(firstField || form.firstName).focus()
}
