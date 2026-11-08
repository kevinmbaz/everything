import { expect, it, vi, afterEach } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it('selects a real private Tasks session without installing a global SDK', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
  const before = globalThis.puter;
  const { storage, isPrivateStorage } = await import('../src/lib/storage.js');
  expect(isPrivateStorage).toBe(true);
  expect(storage.mode).toBe('private');
  expect(globalThis.puter).toBe(before);
  expect(storage.auth.signIn).toBeUndefined();
  const { store } = await import('../src/lib/store.js');
  expect(store.cloud).toBe(storage);
  expect(store.isPrivate).toBe(true);
});
