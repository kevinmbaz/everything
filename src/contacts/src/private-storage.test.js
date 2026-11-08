import { describe, it, expect, vi } from 'vitest'
import { createContactsStorage } from './private-storage.js'
import { normalizeContact } from './model.js'

function server(initial = null) {
  let book = initial, revision = initial ? 1 : 0
  const requests = []
  const fetch = vi.fn(async (url, options) => {
    requests.push({ url, ...options })
    if (url === '/api/session') return new Response(JSON.stringify({ username: 'Owner', uuid: 'owner', storage: 'jetson', app: 'contacts' }))
    if (options.method === 'GET') return new Response(JSON.stringify({ value: book === null ? null : JSON.stringify(book) }), { headers: { ETag: `"${revision}"` } })
    if (options.headers['If-Match'] !== `"${revision}"`) return new Response('{}', { status: 409 })
    book = JSON.parse(JSON.parse(options.body).value)
    revision++
    return new Response('{"ok":true}', { headers: { ETag: `"${revision}"` } })
  })
  return { fetch, requests, get book() { return book } }
}

describe('private contact book', () => {
  it.each([
    { username: 'Owner', uuid: 'owner', storage: 'jetson', app: 'tasks' },
    { username: 'Owner', storage: 'jetson', app: 'contacts' },
  ])('rejects a mismatched or incomplete owner session before reading the book', async session => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(session)))
    const storage = createContactsStorage({ fetch, prepare: async () => {} })
    await expect(storage.ready()).rejects.toThrow(/session/)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/session'])
  })
  it('does not read a session when safe worker preparation fails', async () => {
    const fetch = vi.fn()
    const storage = createContactsStorage({ fetch, prepare: async () => { throw new Error('Close legacy tabs') } })
    await expect(storage.ready()).rejects.toThrow('Close legacy tabs')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps an uncertain timed-out write dirty and never publishes a late response', async () => {
    const backend = server()
    let finish
    const fetch = async (url, options) => {
      if (options.method === 'PUT') return new Promise(resolve => { finish = resolve })
      return backend.fetch(url, options)
    }
    const storage = createContactsStorage({ fetch, prepare: async () => {} })
    await storage.ready()
    vi.useFakeTimers()
    try {
      const saving = storage.kv.set('contact:a', normalizeContact({ id: 'a', firstName: 'Draft' }))
      const rejected = expect(saving).rejects.toMatchObject({ code: 'ETIMEDOUT', uncertain: true })
      await vi.advanceTimersByTimeAsync(30001)
      await rejected
      expect(storage.dirty).toBe(true)
      finish(new Response('{"ok":true}', { headers: { ETag: '"1"' } }))
      await vi.advanceTimersByTimeAsync(1)
      expect(await storage.kv.list()).toEqual([])
      await expect(storage.kv.del('contact:a')).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    } finally { vi.useRealTimers() }
  })
  it.each([
    ['semantic email', c => ({ ...c, emails: [{ label: 'Work', value: 'not-an-email' }] })],
    ['unsafe photo', c => ({ ...c, photo: 'javascript:alert(1)' })],
    ['unknown lossy field', c => ({ ...c, extra: 'must not silently disappear' })],
    ['oversize contact', c => ({ ...c, notes: 'x'.repeat(410000) })],
    ['noncanonical fields', c => ({ ...c, firstName: ' Untrimmed ' })],
  ])('rejects %s before hydration or mutation', async (_label, change) => {
    const bad = change(normalizeContact({ id: 'a', firstName: 'A' }))
    const backend = server({ version: 1, contacts: [bad] })
    const storage = createContactsStorage({ fetch: backend.fetch, prepare: async () => {} })
    await expect(storage.ready()).rejects.toThrow(/Invalid contact book|limit/)
  })
  it('enforces the whole-book wire size limit without sending or publishing an oversized mutation', async () => {
    const contacts = Array.from({ length: 24 }, (_, i) => normalizeContact({ id: String(i), firstName: 'A', notes: 'x'.repeat(340000) }))
    const backend = server({ version: 1, contacts })
    const storage = createContactsStorage({ fetch: backend.fetch, prepare: async () => {} })
    await storage.ready()
    const writes = backend.requests.length
    await expect(storage.kv.set('contact:overflow', normalizeContact({ id: 'overflow', firstName: 'Overflow', notes: 'x'.repeat(340000) }))).rejects.toThrow(/limit/)
    expect(backend.requests).toHaveLength(writes)
    expect(await storage.kv.list()).toHaveLength(24)
    expect(storage.dirty).toBe(true)
  })
  it.each(['set', 'del'])('latches stale %s and never refreshes its whole-book baseline', async method => {
    const c = normalizeContact({ id: 'a', firstName: 'Original' })
    const backend = server({ version: 1, contacts: [c] })
    const fresh = createContactsStorage({ fetch: backend.fetch, prepare: async () => {} })
    const stale = createContactsStorage({ fetch: backend.fetch, prepare: async () => {} })
    await Promise.all([fresh.ready(), stale.ready()])
    await fresh.kv.set('contact:a', { ...c, firstName: 'Other tab' })
    expect((await stale.kv.list())[0].value.firstName).toBe('Original')
    await expect(stale.kv[method]('contact:a', { ...c, firstName: 'Stale' })).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(stale.dirty).toBe(true)
    expect(stale.conflict).toBeTruthy()
    expect(await stale.kv.get('contact:a')).toEqual(c)
    await expect(stale.kv.set('contact:a', c)).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(backend.requests.filter(r => r.method === 'PUT')).toHaveLength(2)
    expect(backend.book.contacts[0].firstName).toBe('Other tab')
  })
  it('deletes a contact by a captured literal identifier without affecting its neighbors', async () => {
    const contacts = ['a', 'a:b'].map(id => normalizeContact({ id, firstName: id }))
    const backend = server({ version: 1, contacts })
    const storage = createContactsStorage({ fetch: backend.fetch, prepare: async () => {} })
    await storage.ready()
    await storage.kv.del('contact:a')
    expect(await storage.kv.get('contact:a')).toBe(null)
    expect(backend.book.contacts).toEqual([contacts[1]])
  })
  it('serializes captured mutations as native JSON without losing other contacts or truncating listing', async () => {
    const contacts = Array.from({ length: 1501 }, (_, i) => normalizeContact({ id: `id:${i}`, firstName: `Contact ${i}` }))
    const backend = server({ version: 1, contacts })
    let release
    const fetch = async (url, options) => {
      if (options.method === 'PUT' && !release) await new Promise(resolve => { release = resolve })
      return backend.fetch(url, options)
    }
    const storage = createContactsStorage({ fetch, prepare: async () => {} })
    await storage.ready()
    const c = normalizeContact({ id: ' literal:id ', firstName: 'Before', photo: 'data:image/png;base64,YQ==' })
    const first = storage.kv.set(`contact:${c.id}`, c)
    c.firstName = 'Changed after call'
    const second = storage.kv.set('contact:second', normalizeContact({ id: 'second', firstName: 'Second' }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(storage.dirty).toBe(true)
    expect((await storage.kv.list()).length).toBe(1501)
    release()
    await Promise.all([first, second])
    expect(storage.dirty).toBe(false)
    const list = await storage.kv.list()
    expect(list).toHaveLength(1503)
    expect(list.find(r => r.key === 'contact: literal:id ').value).toMatchObject({ id: ' literal:id ', firstName: 'Before', photo: c.photo })
    const writes = backend.requests.filter(r => r.method === 'PUT')
    expect(writes.map(r => r.headers['If-Match'])).toEqual(['"1"', '"2"'])
    expect(backend.book).toMatchObject({ version: 1, contacts: expect.any(Array) })
    list[0].value.firstName = 'Do not leak mutable state'
    expect((await storage.kv.list())[0].value.firstName).toBe('Contact 0')
  })
  it.each([
    { version: 2, contacts: [] },
    { version: 1, contacts: {} },
    { version: 1, contacts: [{ id: '' }] },
    { version: 1, contacts: [{ id: 'literal' }] },
    'not native JSON',
  ])('rejects malformed books without hydrating or replacing them: %j', async (value) => {
    const backend = server(value)
    const storage = createContactsStorage({ fetch: backend.fetch, prepare: async () => {} })
    await expect(storage.ready()).rejects.toThrow(/Invalid contact book/)
    await expect(storage.kv.list()).rejects.toThrow(/Invalid contact book/)
    expect(backend.requests.filter(r => r.method !== 'GET')).toHaveLength(0)
  })
  it('prepares workers before the actual owner session and hydration; absent book lists empty', async () => {
    const backend = server()
    let release
    const prepare = vi.fn(() => new Promise(resolve => { release = resolve }))
    const storage = createContactsStorage({ fetch: backend.fetch, prepare })
    const ready = storage.ready()
    expect(backend.requests).toHaveLength(0)
    release()
    expect(await ready).toMatchObject({ username: 'Owner', app: 'contacts' })
    expect(await storage.kv.list('contact:*', true)).toEqual([])
    expect(prepare).toHaveBeenCalledWith({ cachePrefixes: ['contacts-shell-'] })
    expect(backend.requests.map(r => r.url)).toEqual(['/api/session', '/api/kv?key=contacts%3Abook%3Av1'])
    expect(globalThis.window?.puter).toBeUndefined()
  })
})
