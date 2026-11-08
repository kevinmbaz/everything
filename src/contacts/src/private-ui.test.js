// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
vi.mock('../../../private_storage/browser.mjs', () => ({ preparePrivateBrowser: vi.fn(async () => {}) }))

let store, openEditor, backend, release, rejectWrite
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
function type(el, value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })) }

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1')
  document.body.innerHTML = ''
  backend = { book: null, revision: 0, writes: [] }
  release = null; rejectWrite = false
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/api/session') return new Response(JSON.stringify({ username: 'Owner', uuid: 'owner', storage: 'jetson', app: 'contacts' }))
    if (options.method === 'GET') return new Response(JSON.stringify({ value: backend.book && JSON.stringify(backend.book) }), { headers: { ETag: `"${backend.revision}"` } })
    backend.writes.push(JSON.parse(JSON.parse(options.body).value))
    await new Promise(resolve => { release = resolve })
    if (rejectWrite) return new Response('{}', { status: 403 })
    backend.book = backend.writes.at(-1)
    return new Response('{"ok":true}', { headers: { ETag: `"${++backend.revision}"` } })
  }))
  window.puter = { kv: { list: vi.fn(async () => []), set: vi.fn(async () => true) } }
  ;({ store } = await import('./store.js'))
  ;({ openEditor } = await import('./ui/editor.js'))
  await store.load()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('private actual contact forms', () => {
  it.each([
    ['same UID', 'shared:id', 'Different person'],
    ['different UID, duplicate identity', 'other:id', 'First person'],
  ])('deduplicates overlapping DOM drops: %s', async (_label, laterId, laterName) => {
    const { mountApp } = await import('./ui/app.js')
    const root = document.createElement('div'); document.body.append(root); mountApp(root)
    const importing = vi.spyOn(store, 'importMany')
    const drop = (id, name) => {
      const event = new Event('drop', { bubbles: true, cancelable: true })
      event.dataTransfer = { types: ['Files'], files: [new File([`BEGIN:VCARD\nVERSION:3.0\nUID:${id}\nFN:${name}\nEND:VCARD`], 'contacts.vcf', { type: 'text/vcard' })] }
      root.dispatchEvent(event)
    }
    drop('shared:id', 'First person')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    drop(laterId, laterName)
    await vi.waitFor(() => expect(importing).toHaveBeenCalledTimes(2))
    release()
    await importing.mock.results[0].value
    // The later drop must finish as a skip without another network write.
    await tick()
    expect(backend.writes).toHaveLength(1)
    await expect(importing.mock.results[1].value).resolves.toEqual({ written: 0, skipped: 1, failed: 0 })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Already in your address book'))
    expect(backend.book.contacts).toHaveLength(1)
    expect(store.get('shared:id').firstName).toBe('First')
  })
  it.each([
    ['save', 'pending:id', 'Different person'],
    ['save', 'other:id', 'Pending person'],
    ['saveMany', 'pending:id', 'Different person'],
    ['saveMany', 'other:id', 'Pending person'],
  ])('deduplicates imports after pending new contacts from %s (%s)', async (method, id, firstName) => {
    const original = { id: 'pending:id', firstName: 'Pending person' }
    const saving = method === 'save' ? store.save(original) : store.saveMany([original])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const progress = vi.fn()
    const importing = store.importMany([{ id, firstName }], { onProgress: progress })
    release(); await saving; await tick()
    expect(backend.writes).toHaveLength(1)
    await expect(importing).resolves.toEqual({ written: 0, skipped: 1, failed: 0 })
    expect(progress.mock.calls).toEqual([[0, 0]])
    expect(store.get('pending:id').firstName).toBe('Pending person')
  })
  it('retains invocation snapshots and progress for an import queued behind another import', async () => {
    const first = store.importMany([{ id: 'first', firstName: 'First' }])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const later = [{ id: 'later', firstName: 'Captured', emails: [{ value: 'original@example.org' }] }]
    const progress = vi.fn()
    const options = { concurrency: 1, onProgress: progress }
    const second = store.importMany(later, options)
    later[0].firstName = 'Changed'; later[0].emails[0].value = 'changed@example.org'; later.push({ firstName: 'Unwanted' })
    options.onProgress = vi.fn(); options.concurrency = 0
    release(); release = null
    await first
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await expect(second).resolves.toEqual({ written: 1, skipped: 0, failed: 0 })
    expect(store.get('later')).toMatchObject({ firstName: 'Captured', emails: [{ label: 'Personal', value: 'original@example.org' }] })
    expect(progress.mock.calls).toEqual([[0, 1], [1, 1]])
    expect(options.onProgress).not.toHaveBeenCalled()
  })
  it.each(['save', 'saveMany'])('captures queued %s values before a subsequent additive import', async method => {
    const { getStorage } = await import('./storage.js')
    const first = store.importMany([{ id: 'first', firstName: 'First' }])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const original = { id: 'queued', firstName: 'Captured', emails: [{ value: 'captured@example.org' }] }
    const saving = method === 'save' ? store.save(original) : store.saveMany([original])
    const last = store.importMany([{ id: 'later', firstName: 'Other', emails: [{ value: 'captured@example.org' }] }])
    original.firstName = 'Changed'; original.emails[0].value = 'changed@example.org'
    expect(getStorage().dirty).toBe(true)
    release(); release = null; await first
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(backend.writes[1].contacts.find(c => c.id === 'queued').firstName).toBe('Captured')
    release(); await saving
    await expect(last).resolves.toEqual({ written: 0, skipped: 1, failed: 0 })
    expect(backend.writes).toHaveLength(2)
    expect(getStorage().dirty).toBe(false)
  })
  it('reports failed rather than skipped queued imports after the first import fails', async () => {
    const first = store.importMany([{ id: 'same', firstName: 'First' }])
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const progress = vi.fn()
    const second = store.importMany([{ id: 'same', firstName: 'Second' }], { onProgress: progress })
    const third = store.importMany([{ id: 'third', firstName: 'Third' }])
    rejectWrite = true; release()
    expect(await Promise.all([first, second, third])).toEqual([
      { written: 0, skipped: 0, failed: 1 },
      { written: 0, skipped: 0, failed: 1 },
      { written: 0, skipped: 0, failed: 1 },
    ])
    expect(progress.mock.calls).toEqual([[0, 1], [1, 1]])
    expect(backend.writes).toHaveLength(1)
    expect(store.all).toEqual([])
    const { getStorage } = await import('./storage.js')
    expect(getStorage().dirty).toBe(true)
    expect(getStorage().error).toBeTruthy()
  })
  it('directs private bulk failures to export and manual reload, not retry', async () => {
    const saving = store.save({ id: 'keep', firstName: 'Keep' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(); await saving; release = null
    const { mountApp } = await import('./ui/app.js')
    const root = document.createElement('div'); document.body.append(root); mountApp(root)
    store.setUI({ selectMode: true, checked: new Set(['keep']) })
    click(root.querySelector('[data-action="bulk-delete"]'))
    click(document.querySelector('[data-confirm="ok"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    rejectWrite = true; release()
    await vi.waitFor(() => expect(document.body.textContent).toMatch(/Deleted 0 of 1/))
    expect(document.body.textContent).toMatch(/Deleted 0 of 1.*export.*reload/i)
    expect(document.body.textContent).not.toContain('try again for the rest')
    expect(store.get('keep')).not.toBeNull()
  })
  it('blocks draft export until avatar decoding finishes, then exports the chosen photo', async () => {
    let image
    vi.stubGlobal('Image', class { constructor() { image = this; this.width = 480; this.height = 480 } })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local')
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,YQ==')
    openEditor()
    const modal = document.querySelector('.overlay--editor')
    type(modal.querySelector('[name="firstName"]'), 'Avatar draft')
    const input = modal.querySelector('input[type="file"]')
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'avatar.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change'))
    create.mockClear()
    click(modal.querySelector('[data-action="export-draft"]'))
    expect(download).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(modal.querySelector('[data-error]').hidden).toBe(false)
    expect(modal.querySelector('[data-error]').textContent).toMatch(/photo.*processing/i)
    image.onload(); await tick()
    click(modal.querySelector('[data-action="export-draft"]'))
    expect(download).toHaveBeenCalledTimes(1)
    const exported = await create.mock.calls[0][0].text()
    expect(exported).toContain('FN:Avatar draft')
    expect(exported).toContain('PHOTO;ENCODING=b;TYPE=JPEG:YQ==')
    expect(backend.writes).toHaveLength(0)
  })
  it('keeps a pending avatar decode as an unsaved draft instead of saving the old photo', async () => {
    let image
    vi.stubGlobal('Image', class { constructor() { image = this; this.width = 480; this.height = 480 } })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,YQ==')
    openEditor()
    const modal = document.querySelector('.overlay--editor')
    type(modal.querySelector('[name="firstName"]'), 'Avatar person')
    const input = modal.querySelector('input[type="file"]')
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'avatar.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change'))
    click(modal.querySelector('[data-action="save"]'))
    await tick()
    expect(backend.writes).toHaveLength(0)
    expect(modal.querySelector('[data-error]').textContent).toMatch(/photo.*processing/i)
    image.onload()
    await tick()
    click(modal.querySelector('[data-action="save"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(() => expect(store.all).toHaveLength(1))
    expect(backend.book.contacts[0].photo).toBe('data:image/jpeg;base64,YQ==')
  })
  it('does not discard edits typed during a delayed deletion acknowledgement', async () => {
    const { normalizeContact } = await import('./model.js')
    const c = normalizeContact({ id: 'deleted', firstName: 'Original' })
    const saving = store.save(c)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(); await saving
    release = null
    openEditor(store.get(c.id))
    const modal = document.querySelector('.overlay--editor')
    click(modal.querySelector('[data-action="delete"]'))
    click(document.querySelector('[data-confirm="ok"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    type(modal.querySelector('[name="notes"]'), 'Newer local work')
    release()
    await vi.waitFor(() => expect(store.get(c.id)).toBeNull())
    await new Promise(r => setTimeout(r, 220))
    expect(modal.isConnected).toBe(true)
    expect(modal.querySelector('[name="notes"]').value).toBe('Newer local work')
    expect(modal.querySelector('[data-error]').textContent).toMatch(/deleted.*newer.*unsaved/i)
  })
  it('imports local vCards with literal IDs and explicitly reports a partial failed import', async () => {
    const { mountApp } = await import('./ui/app.js')
    const root = document.createElement('div'); document.body.append(root)
    mountApp(root)
    const cards = ['first:id', 'second:id'].map((id, i) => `BEGIN:VCARD\nVERSION:3.0\nUID:${id}\nFN:Person ${i}\nEND:VCARD`).join('\n')
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    drop.dataTransfer = { types: ['Files'], files: [new File([cards], 'people.vcf', { type: 'text/vcard' })] }
    root.dispatchEvent(drop)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const firstRelease = release
    release()
    await vi.waitFor(() => expect(release).not.toBe(firstRelease))
    expect(store.get('first:id')).toBeTruthy()
    rejectWrite = true; release()
    await vi.waitFor(() => expect(document.body.textContent).toMatch(/Imported 1.*1 failed/i))
    expect(store.all).toHaveLength(1)
    expect(document.querySelector('[data-private-status]').textContent).toMatch(/Not saved/)
  })
  it('never replaces an existing literal ID during additive import', async () => {
    const { normalizeContact } = await import('./model.js')
    const c = normalizeContact({ id: 'same:id', firstName: 'Original' })
    const saving = store.save(c)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(); await saving
    release = null
    const imported = store.importMany([{ ...c, firstName: 'Different identity' }])
    // Must resolve as an explicit duplicate, not start another overwrite.
    await expect(imported).resolves.toEqual({ written: 0, skipped: 1, failed: 0 })
    expect(store.get(c.id).firstName).toBe('Original')
    expect(release).toBeNull()
  })
  it('shows unsaved draft status before transport and exports the current rejected draft locally', async () => {
    const { mountApp } = await import('./ui/app.js')
    const root = document.createElement('div'); document.body.append(root)
    mountApp(root)
    openEditor()
    const modal = document.querySelector('.overlay--editor')
    type(modal.querySelector('[name="firstName"]'), 'Draft snapshot')
    expect(root.querySelector('[data-private-status]').textContent).toMatch(/unsaved/i)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    click(modal.querySelector('[data-action="export-draft"]'))
    expect(create).toHaveBeenCalled()
    expect(await create.mock.calls[0][0].text()).toContain('FN:Draft snapshot')
    create.mockRestore()
  })
  it('keeps a contact visible while deletion is delayed and after rejection in the actual editor', async () => {
    const { normalizeContact } = await import('./model.js')
    const c = normalizeContact({ id: 'existing', firstName: 'Keep me' })
    const saving = store.save(c)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(); await saving
    release = null; rejectWrite = true
    openEditor(store.get(c.id))
    const modal = document.querySelector('.overlay--editor')
    click(modal.querySelector('[data-action="delete"]'))
    click(document.querySelector('[data-confirm="ok"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(store.get(c.id)).not.toBeNull()
    release()
    await vi.waitFor(() => expect(modal.querySelector('[data-error]').hidden).toBe(false))
    expect(modal.querySelector('[data-error]').textContent).toMatch(/403/)
    expect(store.get(c.id).firstName).toBe('Keep me')
    expect(modal.isConnected).toBe(true)
  })
  it('explicitly disables AI, telemetry, Calendar, Drive and headless/MCP bridges even with an SDK present', async () => {
    window.puter.env = 'app'
    window.puter.ui = { launchApp: vi.fn(), onItemsOpened: vi.fn() }
    window.puter.ai = { chat: vi.fn() }
    window.plausible = vi.fn()
    const { openSmartAdd } = await import('./ui/smartadd.js')
    const { createCalendar } = await import('./calendar.js')
    const { startDropImport } = await import('./ui/dropimport.js')
    const { startApiServer } = await import('./api/server.js')
    const { track } = await import('./analytics.js')
    openSmartAdd()
    expect(document.querySelector('#smart-title')).toBeNull()
    expect(document.body.textContent).toMatch(/Smart Add.*unavailable.*private/i)
    expect(createCalendar().supported()).toBe(false)
    const drop = startDropImport({ win: window, target: document, onFiles: vi.fn() })
    const connection = { postMessage: vi.fn(), on: vi.fn() }
    expect(startApiServer({ connection, callerApp: 'calendar', methods: {} })).toBeNull()
    track('Contact Added')
    expect(window.puter.ui.onItemsOpened).not.toHaveBeenCalled()
    expect(window.puter.ui.launchApp).not.toHaveBeenCalled()
    expect(window.puter.ai.chat).not.toHaveBeenCalled()
    expect(connection.postMessage).not.toHaveBeenCalled()
    expect(window.plausible).not.toHaveBeenCalled()
    drop.stop()
  })
  it('keeps newer edits during acknowledgement and reuses the newly created ID on follow-up save', async () => {
    openEditor()
    const modal = document.querySelector('.overlay--editor')
    const field = modal.querySelector('[name="firstName"]')
    type(field, 'First snapshot')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    click(modal.querySelector('[data-action="save"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    type(field, 'Newer draft')
    release()
    await vi.waitFor(() => expect(store.all).toHaveLength(1))
    await new Promise(r => setTimeout(r, 220))
    expect(modal.isConnected).toBe(true)
    expect(field.value).toBe('Newer draft')
    expect(modal.querySelector('[data-action="save"]').disabled).toBe(false)
    const id = store.all[0].id
    release = null
    click(modal.querySelector('[data-action="save"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(() => expect(store.get(id).firstName).toBe('Newer draft'))
    expect(backend.book.contacts).toHaveLength(1)
    expect(backend.book.contacts[0].id).toBe(id)
    await vi.waitFor(() => expect(modal.isConnected).toBe(false))
  })
  it('keeps rejected form text and unload warning with an actionable visible error', async () => {
    rejectWrite = true
    openEditor()
    const modal = document.querySelector('.overlay--editor')
    type(modal.querySelector('[name="firstName"]'), 'Unsaved person')
    click(modal.querySelector('[data-action="save"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await vi.waitFor(() => expect(modal.querySelector('[data-error]').hidden).toBe(false))
    expect(modal.querySelector('[data-error]').textContent).toMatch(/403.*export|export.*reload/i)
    expect(modal.querySelector('[name="firstName"]').value).toBe('Unsaved person')
    expect(store.all).toEqual([])
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
  })
  it('uses private hydration and publishes only an acknowledged contact', async () => {
    openEditor()
    const modal = document.querySelector('.overlay--editor')
    type(modal.querySelector('[name="firstName"]'), 'Alice')
    click(modal.querySelector('[data-action="save"]'))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(store.all).toEqual([])
    release()
    await vi.waitFor(() => expect(store.all).toHaveLength(1))
    expect(backend.book.contacts[0].firstName).toBe('Alice')
    expect(window.puter.kv.list).not.toHaveBeenCalled()
    expect(window.puter.kv.set).not.toHaveBeenCalled()
    await tick()
  })
})
