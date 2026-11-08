import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function config(privateMode) {
  vi.stubEnv('VITE_PRIVATE_STORAGE', privateMode ? '1' : '');
  vi.resetModules();
  return (await import('../vite.config.js')).default;
}

describe('private production build', () => {
  it('removes the external SDK only in the explicit private build', async () => {
    const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const privateConfig = await config(true);
    const plugin = privateConfig.plugins.find((p) => p?.name === 'private-storage');
    expect(plugin, 'private build must remove the remote SDK').toBeDefined();
    expect(plugin.transformIndexHtml(source)).not.toContain('https://js.puter.com');
    expect(privateConfig.build.outDir).toBe('dist-private');
    const cloudConfig = await config(false);
    expect(cloudConfig.plugins.some((p) => p?.name === 'private-storage')).toBe(false);
  });

  it('never serves storage API responses from the service worker cache', async () => {
    const settings = await config(true);
    const plugin = settings.plugins.find((p) => p.name === 'invoicing-service-worker');
    let source;
    plugin.generateBundle.call({ emitFile: (asset) => { source = asset.source; } }, {}, { 'assets/test.js': {} });
    const listeners = {};
    const self = { location: new URL('https://private.test'), addEventListener: (name, fn) => { listeners[name] = fn; } };
    vm.runInNewContext(source, { self, URL, caches: { match: async () => new Response('stale cached data') }, Request, Response });
    const respondWith = vi.fn();
    listeners.fetch({ request: new Request('https://private.test/api/kv?key=invc:clients:v1'), respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  });
});
