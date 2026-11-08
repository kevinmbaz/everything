// @vitest-environment happy-dom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const worker = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('../../../private_storage/browser.mjs', () => ({ preparePrivateBrowser: worker.prepare }))
let release, calls, sessionStatus
beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1')
  document.body.innerHTML = '<div id="app" aria-busy="true">Loading</div>'
  delete window.puter
  calls = []; sessionStatus = 200
  worker.prepare.mockImplementation(() => new Promise(resolve => { release = resolve }))
  vi.stubGlobal('fetch', vi.fn(async url => {
    calls.push(url)
    if (url === '/api/session') return new Response(JSON.stringify({ username: 'Actual owner', uuid: 'owner', storage: 'jetson', app: 'contacts' }), { status: sessionStatus })
    return new Response('{"value":null}', { headers: { ETag: '"0"' } })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('mounts editing only after worker preparation, real owner session and book hydration', async () => {
  await import('./main.js')
  expect(document.querySelector('[data-action="new"]')).toBeNull()
  expect(calls).toEqual([])
  expect(worker.prepare).toHaveBeenCalledWith({ cachePrefixes: ['contacts-shell-'] })
  release()
  await vi.waitFor(() => expect(document.querySelector('[data-action="new"]')).not.toBeNull())
  expect(calls).toEqual(['/api/session', '/api/kv?key=contacts%3Abook%3Av1'])
  expect(window.puter).toBeUndefined()
  expect(document.querySelector('[data-private-status]').textContent).toMatch(/Saved.*Jetson/i)
  expect(document.querySelector('[data-private-features]').textContent).toMatch(/Drive.*Calendar.*MCP/i)
  expect(document.querySelector('[data-action="smart-add"]').disabled).toBe(true)
})
it('fails closed on denied actual owner session instead of substituting a display identity', async () => {
  sessionStatus = 403
  await import('./main.js')
  release()
  await vi.waitFor(() => expect(document.body.textContent).toMatch(/403/))
  expect(document.querySelector('[data-action="new"]')).toBeNull()
  expect(calls).toEqual(['/api/session'])
})
