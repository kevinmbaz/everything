import { it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { runReceiptOcr } from '../src/lib/ocr.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
it('selects an explicit private transport without creating a global SDK', async () => {
  expect(existsSync('src/lib/storage.js')).toBe(true);
  vi.stubEnv('VITE_PRIVATE_STORAGE','1');
  const fetch = vi.fn(async () => new Response(JSON.stringify({username:'Jetson storage',uuid:'jetson-owner',storage:'jetson',app:'expense'}),{status:200,headers:{'Content-Type':'application/json'}}));
  vi.stubGlobal('fetch',fetch); vi.stubGlobal('puter',undefined);
  const modulePath = '../src/lib/storage.js';
  const {isPrivateStorage,getStorage} = await import(/* @vite-ignore */ modulePath);
  expect(isPrivateStorage).toBe(true);
  const sdk = getStorage(); expect(sdk.mode).toBe('private');
  expect((await sdk.getUser()).storage).toBe('jetson');
  expect(fetch.mock.calls[0][0]).toBe('/api/session');
  expect(globalThis.puter).toBeUndefined();
});
it('rejects cloud OCR before calling an injected SDK in private mode', async () => {
  const ai = {chat:vi.fn(async () => ({message:{content:'{}'}})),img2txt:vi.fn()};
  await expect(runReceiptOcr(new File(['x'],'x.png'),{sdk:{mode:'private',ai}})).rejects.toThrow(/unavailable.*private/i);
  expect(ai.chat).not.toHaveBeenCalled(); expect(ai.img2txt).not.toHaveBeenCalled();
});
it('opts into the shared build plugin and retires workers before boot', () => {
  const vite = readFileSync('vite.config.js','utf8');
  expect(vite).toContain('../../private_storage/vite.mjs');
  expect(vite).toContain('dist-private');
  expect(vite).toContain('VITE_PRIVATE_STORAGE');
  const main = readFileSync('src/main.js','utf8');
  expect(main).toContain('await prepareStorageBrowser()');
  expect(main.indexOf('await prepareStorageBrowser()')).toBeLessThan(main.indexOf('await boot();'));
});
