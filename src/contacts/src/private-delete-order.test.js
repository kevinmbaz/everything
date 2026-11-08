// @vitest-environment happy-dom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
vi.mock('../../../private_storage/browser.mjs', () => ({ preparePrivateBrowser: vi.fn(async () => {}) }))

let store, storage, backend, pending, rejectWrite
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1')
  backend = { book: null, revision: 0, writes: [] }
  pending = []; rejectWrite = false
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/api/session') return new Response(JSON.stringify({ username: 'Owner', uuid: 'owner', storage: 'jetson', app: 'contacts' }))
    if (options.method === 'GET') return new Response(JSON.stringify({ value: backend.book && JSON.stringify(backend.book) }), { headers: { ETag: `"${backend.revision}"` } })
    const captured = JSON.parse(JSON.parse(options.body).value)
    backend.writes.push(captured)
    await new Promise(resolve => pending.push(resolve))
    if (rejectWrite) return new Response('{}', { status: 403 })
    backend.book = captured
    return new Response('{"ok":true}', { headers: { ETag: `"${++backend.revision}"` } })
  }))
  ;({ store } = await import('./store.js'))
  storage = (await import('./storage.js')).getStorage()
  await store.load()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
async function waiting() {
  await vi.waitFor(() => expect(pending).toHaveLength(1))
}
async function ack() {
  await waiting()
  pending.shift()()
}
it.each([
  ['save', 'remove'], ['saveMany', 'remove'], ['importMany', 'remove'],
  ['save', 'removeMany'], ['saveMany', 'removeMany'], ['importMany', 'removeMany'],
])('deletes a pending new %s with %s, capturing IDs/options and publishing cleanup only after ack', async (create, remove) => {
  const contact = { id: 'pending', firstName: 'Pending' }
  const saving = create === 'save' ? store.save(contact) : store[create]([contact])
  await waiting()
  const ids = ['pending', 'missing']
  const progress = vi.fn()
  const options = { concurrency: 1, onProgress: progress }
  const deleting = remove === 'remove' ? store.remove(ids[0]) : store.removeMany(ids, options)
  ids.splice(0, ids.length, 'unwanted')
  options.concurrency = 0; options.onProgress = vi.fn()
  expect(store.get('pending')).toBeNull()
  expect(progress).not.toHaveBeenCalled()
  await ack(); await saving
  store.setUI({ selectedId: 'pending' })
  store.setChecked(['pending', 'other'])
  await waiting()
  expect(store.get('pending')).not.toBeNull()
  expect(store.ui.selectedId).toBe('pending')
  expect(store.ui.checked.has('pending')).toBe(true)
  expect(storage.dirty).toBe(true)
  await ack()
  expect(await deleting).toBe(remove === 'remove' ? undefined : 1)
  expect(store.get('pending')).toBeNull()
  expect(backend.book.contacts).toEqual([])
  expect(store.ui.selectedId).toBeNull()
  expect([...store.ui.checked]).toEqual(['other'])
  expect(progress.mock.calls).toEqual(remove === 'remove' ? [] : [[0, 1], [1, 1]])
  expect(options.onProgress).not.toHaveBeenCalled()
  expect(storage.dirty).toBe(false)
})

it('filters missing and already-deleted IDs when its FIFO turn begins', async () => {
  await seed()
  const first = store.remove('target')
  const progress = vi.fn()
  const later = store.removeMany(['target', 'missing'], { onProgress: progress })
  const last = store.remove('missing')
  expect(progress).not.toHaveBeenCalled()
  expect(storage.dirty).toBe(true)
  await ack(); await first
  expect(await later).toBe(0)
  expect(await last).toBeUndefined()
  expect(progress.mock.calls).toEqual([[0, 0]])
  expect(backend.writes).toHaveLength(2)
  expect(backend.book.contacts).toEqual([])
  expect(storage.dirty).toBe(false)
})

it.each([1, 6])('keeps partial bulk deletes and reports all latched failures with concurrency %s', async concurrency => {
  for (const id of ['a', 'b', 'c']) await seed(id)
  store.setChecked(['a', 'b', 'c'])
  store.setUI({ selectedId: 'b' })
  const progress = vi.fn()
  const states = []
  storage.events.addEventListener('state', () => states.push(storage.dirty))
  const deleting = store.removeMany(['a', 'missing', 'b', 'c'], { concurrency, onProgress: progress })
  const laterProgress = vi.fn()
  const later = store.removeMany(['a', 'b', 'missing'], { onProgress: laterProgress })
  await waiting()
  expect(progress.mock.calls).toEqual([[0, 3]])
  expect(laterProgress).not.toHaveBeenCalled()
  expect([...store.ui.checked]).toEqual(['a', 'b', 'c'])
  await ack()
  await waiting()
  expect(store.get('a')).toBeNull()
  expect([...store.ui.checked]).toEqual(['b', 'c'])
  rejectWrite = true
  await ack()
  expect(await deleting).toBe(1)
  expect(await later).toBe(0)
  expect(progress.mock.calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]])
  expect(laterProgress.mock.calls).toEqual([[0, 1], [1, 1]])
  expect(store.all.map(c => c.id)).toEqual(['b', 'c'])
  expect(backend.book.contacts.map(c => c.id)).toEqual(['b', 'c'])
  expect([...store.ui.checked]).toEqual(['b', 'c'])
  expect(store.ui.selectedId).toBe('b')
  expect(backend.writes).toHaveLength(5)
  expect(states.every(Boolean)).toBe(true)
  expect(storage.dirty).toBe(true)
  expect(storage.error).toBeTruthy()
})

it.each(['remove', 'removeMany'])('rejected %s drains queued save/import/delete work without publication or more HTTP writes', async method => {
  await seed()
  store.setUI({ selectedId: 'target' })
  store.setChecked(['target'])
  const progress = vi.fn()
  const deleting = (method === 'remove' ? store.remove('target') : store.removeMany(['target'], { onProgress: progress })).catch(error => error)
  const saving = store.save({ id: 'new', firstName: 'New' }).catch(error => error)
  const importing = store.importMany([{ id: 'import', firstName: 'Import' }])
  const bulkProgress = vi.fn()
  const bulk = store.removeMany(['target', 'missing'], { onProgress: bulkProgress })
  const last = store.remove('target').catch(error => error)
  rejectWrite = true
  await ack()
  if (method === 'remove') expect(await deleting).toBeInstanceOf(Error)
  else expect(await deleting).toBe(0)
  expect(await saving).toBeInstanceOf(Error)
  expect(await importing).toEqual({ written: 0, skipped: 0, failed: 1 })
  expect(await bulk).toBe(0)
  expect(await last).toBeInstanceOf(Error)
  expect(progress.mock.calls).toEqual(method === 'remove' ? [] : [[0, 1], [1, 1]])
  expect(bulkProgress.mock.calls).toEqual([[0, 1], [1, 1]])
  expect(store.all.map(c => c.id)).toEqual(['target'])
  expect(backend.book.contacts.map(c => c.id)).toEqual(['target'])
  expect(store.ui.selectedId).toBe('target')
  expect([...store.ui.checked]).toEqual(['target'])
  expect(backend.writes).toHaveLength(2)
  expect(storage.dirty).toBe(true)
  expect(storage.error).toBeTruthy()
})

it('skips uncommitted IDs after a failed creation without claiming a successful delete', async () => {
  const saving = store.save({ id: 'new', firstName: 'New' }).catch(error => error)
  const single = store.remove('new')
  const progress = vi.fn()
  const bulk = store.removeMany(['new', 'missing'], { onProgress: progress })
  rejectWrite = true
  await ack()
  expect(await saving).toBeInstanceOf(Error)
  expect(await single).toBeUndefined()
  expect(await bulk).toBe(0)
  expect(progress.mock.calls).toEqual([[0, 0]])
  expect(backend.writes).toHaveLength(1)
  expect(store.all).toEqual([])
  expect(storage.dirty).toBe(true)
  expect(storage.error).toBeTruthy()
})

async function seed(id = 'target') {
  const saving = store.save({ id, firstName: id, tags: ['old'] })
  await ack(); await saving
}

it.each(['remove', 'removeMany'])('later %s follows an earlier queued tag update and remains deleted', async method => {
  await seed()
  const states = []
  storage.events.addEventListener('state', () => states.push(storage.dirty))
  const blocker = store.importMany([{ id: 'blocker', firstName: 'Blocker' }])
  await waiting()
  const earlierUpdate = store.renameTag('old', 'new')
  const laterDelete = method === 'remove' ? store.remove('target') : store.removeMany(['target'])
  await ack(); await blocker
  await waiting()
  // Assert FIFO before releasing the next acknowledgement, never await a
  // later delete ahead of the earlier update (which would deadlock the fix).
  expect(backend.writes.at(-1).contacts.find(c => c.id === 'target')?.tags).toEqual(['new'])
  expect(store.get('target').tags).toEqual(['old'])
  await ack(); await earlierUpdate
  await waiting()
  expect(store.get('target').tags).toEqual(['new'])
  expect(backend.writes.at(-1).contacts.some(c => c.id === 'target')).toBe(false)
  await ack(); await laterDelete
  expect(store.get('target')).toBeNull()
  expect(backend.book.contacts.some(c => c.id === 'target')).toBe(false)
  expect(states.slice(0, -1).every(Boolean)).toBe(true)
  expect(states.at(-1)).toBe(false)
  expect(storage.dirty).toBe(false)
})
