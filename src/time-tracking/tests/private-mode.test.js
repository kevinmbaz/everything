import { afterEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); delete globalThis.localStorage; delete globalThis.window; });
it('private selection never reads the legacy mirror or installs an SDK stub', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1'); vi.resetModules();
  globalThis.localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  globalThis.window = {};
  const { offline } = await import('../src/lib/offline.js');
  expect(globalThis.localStorage.getItem).not.toHaveBeenCalled();
  expect(() => offline.installStub()).toThrow(/private/i);
  expect(globalThis.window.puter).toBeUndefined();
  const { storage, isPrivateStorage } = await import('../src/lib/storage.js');
  expect(isPrivateStorage).toBe(true); expect(storage.mode).toBe('private');
});
it('private startup retires the worker before boot and skips cloud background replay', () => {
  const main = source('src/main.js');
  expect(main).toMatch(/if \(isPrivateStorage\)\s*\{[\s\S]*?await preparePrivateBrowser[\s\S]*?await boot\(\)/);
  expect(main).toMatch(/setupOfflineBanner\(\);\s*if \(isPrivateStorage\) \{[^]*?return;\s*\}[^]*?syncPending\(\)/);
  expect(main).toContain('!isPrivateStorage &&');
});
it('even the normal worker never caches authenticated private API responses', () => {
  const handlers = {};
  runInNewContext(source('public/sw.js'), {
    URL, self: { location: { origin: 'https://hourly.test' }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: { match: vi.fn(() => Promise.resolve(null)) }, fetch: vi.fn(async () => ({ ok: false })),
  });
  const event = { request: { method: 'GET', url: 'https://hourly.test/api/session', mode: 'cors' }, respondWith: vi.fn() };
  handlers.fetch(event);
  expect(event.respondWith).not.toHaveBeenCalled();
});
it('private builds use shared SDK stripping and network-only worker plugin in separate output', () => {
  const config = source('vite.config.js');
  expect(config).toContain('../../private_storage/vite.mjs');
  expect(config).toContain('dist-private');
  expect(config).toContain('privateStoragePlugin');
  expect(config).toContain('hourly-');
});
