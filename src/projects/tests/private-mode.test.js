import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

describe('private frontend policy', () => {
  it('disables cloud pickers even if a previous SDK exists, and never opens its IndexedDB mirror', async () => {
    vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
    vi.stubGlobal('puter', { ui: { showOpenFilePicker: vi.fn(), showSaveFilePicker: vi.fn() } });
    const open = vi.fn(); vi.stubGlobal('indexedDB', { open });
    const { canPickFiles, canSaveFiles, pickFiles, saveToPuter } = await import('../src/lib/puterui.js');
    expect(canPickFiles()).toBe(false); expect(canSaveFiles()).toBe(false);
    await expect(pickFiles()).rejects.toThrow(/unavailable/i);
    await expect(saveToPuter(new Blob(), 'x')).rejects.toThrow(/unavailable/i);
    const { mirror } = await import('../src/lib/mirror.js');
    expect(mirror.available()).toBe(false);
    expect(await mirror.get('meta:v1')).toBeNull();
    await mirror.set('meta:v1', {}); expect(open).not.toHaveBeenCalled();
  });

  it('records private text edits immediately, before the persistence debounce', async () => {
    vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
    const { persistInput } = await import('../src/lib/private-browser.js');
    const save = vi.fn();
    persistInput(save, 500)('local draft');
    expect(save).toHaveBeenCalledWith('local draft');
  });

  it('warns before unloading unsaved private edits without flushing or replaying', async () => {
    const { warnBeforeUnload, privateSaveState } = await import('../src/lib/private-browser.js');
    const event = { preventDefault: vi.fn(), returnValue: null };
    warnBeforeUnload(event, { dirty: true });
    expect(event.preventDefault).toHaveBeenCalled(); expect(event.returnValue).toBe('');
    expect(privateSaveState({ dirty: true }, { error: new Error('failure') })).toMatch(/Not saved/);
    expect(privateSaveState({ dirty: true }, { conflict: new Error() })).toMatch(/Conflict/);
    expect(privateSaveState({ dirty: false }, {})).toMatch(/Saved/);
  });

  it('never boots the private store before retiring an old service worker', async () => {
    const { preparePrivateBrowser } = await import('../src/lib/private-browser.js');
    const old = { scriptURL: 'https://app.test/sw.js' };
    const replacement = { scriptURL: 'https://app.test/sw.js?private=1', state: 'activated' };
    const sw = Object.assign(new EventTarget(), {
      controller: old,
      getRegistrations: vi.fn(async () => []),
      register: vi.fn(async () => { sw.controller = replacement; return { active: replacement }; }),
    });
    const caches = { keys: vi.fn(async () => ['pm-shell-v2', 'other-app']), delete: vi.fn(async () => true) };
    await preparePrivateBrowser({ serviceWorker: sw, caches, baseURL: 'https://app.test/' });
    expect(sw.register).toHaveBeenCalledWith('https://app.test/sw.js?private=1', { scope: 'https://app.test/', updateViaCache: 'none' });
    expect(caches.delete.mock.calls).toEqual([['pm-shell-v2']]);
  });

  it('keeps raw SDK access isolated to the explicit cloud adapter', () => {
    for (const name of ['main.js', 'lib/store.js', 'lib/puterui.js', 'views/auth.js', 'views/settings.js', 'ui/navdrawer.js']) {
      const text = readFileSync(resolve(root, 'src', name), 'utf8');
      expect(text, name).not.toMatch(/\bputer\.(auth|fs|kv|ui|env)\b/);
    }
  });
});
