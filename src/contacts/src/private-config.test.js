import { afterEach, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import config from '../vite.config.js'
afterEach(() => vi.unstubAllEnvs())
const resolved = () => typeof config === 'function' ? config({ mode: 'production', command: 'build' }) : config
it('opts into separate private output and network-only worker without losing local assets or build test gate', () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1')
  const c = resolved()
  expect(c.build.outDir).toBe('dist-private')
  const plugin = c.plugins.find(p => p.name === 'everything-private-storage')
  expect(plugin).toBeTruthy()
  let html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  for (const p of c.plugins) {
    const hook = p.transformIndexHtml
    if (hook) html = (typeof hook === 'function' ? hook : hook.handler)(html)
  }
  expect(html).not.toMatch(/js\.puter\.com|plausible\.io|hideWindow\(/)
  expect(html).toContain('/favicon.svg')
  expect(html).not.toContain('plausible.init')
  const emitted = []
  for (const p of c.plugins) p.generateBundle?.call({ emitFile: asset => emitted.push(asset) })
  expect(emitted.find(a => a.fileName === 'sw.js').source).toContain('contacts-shell-')
  expect(emitted.find(a => a.fileName === '.well-known/mcp.json').source).toContain('unavailable')
  expect(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).scripts.build).toBe('npm run test && vite build')
  expect(c.test.env.VITE_PRIVATE_STORAGE).toBe('0')
})
it('keeps default Puter output and plugin separate', () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '0')
  const c = resolved()
  expect(c.build.outDir || 'dist').toBe('dist')
  expect(c.plugins.some(p => p.name === 'everything-private-storage')).toBe(false)
})
