import { createPrivateStorage } from '../../../private_storage/client.mjs'
import { preparePrivateBrowser } from '../../../private_storage/browser.mjs'
import { normalizeContact, validateContact } from './model.js'

export const BOOK_KEY = 'contacts:book:v1'
const invalid = () => new Error('Invalid contact book. Keep this tab open; export drafts before manually reloading.')
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const hasControl = value => [...value].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
const textFields = ['id', 'firstName', 'lastName', 'nickname', 'company', 'jobTitle', 'birthday', 'notes', 'photo']
const bytes = text => new TextEncoder().encode(text).byteLength
const equalJson = (a, b) => a === b || (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equalJson(a[k], b[k])))
function validateBook(value) {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.contacts) || Object.keys(value).some(k => !['version', 'contacts'].includes(k))) throw invalid()
  const ids = new Set()
  for (const c of value.contacts) {
    if (!plain(c) || textFields.some(k => typeof c[k] !== 'string') || !c.id || hasControl(c.id) || ids.has(c.id)) throw invalid()
    ids.add(c.id)
    if (typeof c.favorite !== 'boolean' || !['createdAt', 'updatedAt'].every(k => Number.isSafeInteger(c[k]) && c[k] > 0)) throw invalid()
    for (const k of ['emails', 'phones', 'urls']) {
      if (!Array.isArray(c[k]) || c[k].some(e => !plain(e) || typeof e.label !== 'string' || typeof e.value !== 'string')) throw invalid()
    }
    if (!Array.isArray(c.tags) || c.tags.some(t => typeof t !== 'string')) throw invalid()
    if (!Array.isArray(c.addresses) || c.addresses.some(a => !plain(a) || ['label', 'country', 'street', 'street2', 'city', 'state', 'postalCode', 'poBox'].some(k => typeof a[k] !== 'string'))) throw invalid()
  }
  for (const c of value.contacts) {
    if (!validateContact(c).valid || !equalJson(c, normalizeContact(c))) throw invalid()
    if (c.photo && !/^(data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+|https?:\/\/[^\s]+)$/i.test(c.photo)) throw invalid()
    if (bytes(JSON.stringify(c)) > 400 * 1024) throw new Error('Contact exceeds the 400 KiB limit, including its avatar.')
  }
  if (bytes(JSON.stringify({ value: JSON.stringify(value) })) > 8 * 1024 * 1024) throw new Error('Contact book exceeds the 8 MiB request limit. Export contacts and reduce avatar sizes before reloading.')
  return value
}
export function createContactsStorage({ fetch = globalThis.fetch, prepare = preparePrivateBrowser } = {}) {
  const client = createPrivateStorage({ app: 'contacts', fetch })
  let boot, book
  let queue = Promise.resolve(), pending = 0, failure = null
  const events = new EventTarget()
  const drafts = new Set()
  const notify = () => events.dispatchEvent(new Event('state'))
  client.events.addEventListener('state', notify)
  function contactId(key) {
    if (typeof key !== 'string' || !key.startsWith('contact:') || key.length <= 8 || hasControl(key)) throw invalid()
    return key.slice(8)
  }
  function mutate(key, value, deleting = false) {
    // Capture the caller's value before waiting for any preceding mutation.
    let captured
    try {
      const id = contactId(key)
      captured = deleting ? { id } : structuredClone(value)
      if (captured.id !== id) throw invalid()
      if (!deleting) validateBook({ version: 1, contacts: [captured] })
    } catch (error) {
      failure = error
      notify()
      return Promise.reject(error)
    }
    pending++
    notify()
    const result = queue.then(async () => {
      await ready()
      if (failure) throw failure
      const next = { version: 1, contacts: book.contacts.filter(c => c.id !== captured.id).concat(deleting ? [] : [captured]) }
      validateBook(next)
      await client.kv.set(BOOK_KEY, next)
      book = next
    }).catch(error => { failure = error; throw error }).finally(() => { pending--; notify() })
    queue = result.catch(() => {})
    return result
  }
  function ready() {
    return boot ??= (async () => {
      await prepare({ cachePrefixes: ['contacts-shell-'] })
      const user = await client.getUser()
      book = validateBook(await client.kv.get(BOOK_KEY) ?? { version: 1, contacts: [] })
      return user
    })()
  }
  return {
    ready, events,
    setDraft(token, dirty) { if (dirty) drafts.add(token); else drafts.delete(token); notify() },
    get dirty() { return drafts.size > 0 || pending > 0 || !!failure || client.dirty },
    get error() { return failure || client.error },
    get conflict() { return client.conflict },
    kv: {
      set: (key, value) => mutate(key, value),
      del: key => mutate(key, null, true),
      async get(key) {
        const id = contactId(key)
        await ready()
        return structuredClone(book.contacts.find(c => c.id === id) || null)
      },
      async list() {
        await ready()
        return book.contacts.map(value => ({ key: `contact:${value.id}`, value: structuredClone(value) }))
      },
    },
  }
}
