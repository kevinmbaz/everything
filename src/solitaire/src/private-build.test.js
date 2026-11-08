import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('enables an SDK-free private HTML/network-only worker build with the real app-owned cache prefix and preserved local assets', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
  vi.resetModules();
  const { default: config } = await import('../vite.config.js');
  expect(config.build.outDir).toBe('dist-private');
  expect(config.define?.['import.meta.env.VITE_PRIVATE_STORAGE']).toBe('"1"');
  const plugin = config.plugins.find(p => p.name === 'everything-private-storage');
  expect(plugin).toBeTruthy();
  const transformed = plugin.transformIndexHtml.handler(html);
  expect(transformed).not.toContain('https://js.puter.com');
  expect(transformed).toContain('icon-128.png');
  expect(transformed).toContain('/src/entry.js');
  const emitFile = vi.fn();
  plugin.generateBundle.call({ emitFile });
  const worker = emitFile.mock.calls[0][0];
  expect(worker.fileName).toBe('sw.js');
  expect(worker.source).not.toContain("addEventListener('fetch'");
  expect(worker.source).toContain('["solitaire-v"]');
  const legacy = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  expect(legacy).toContain("const CACHE = 'solitaire-v2'");
});
it('keeps default build directory and SDK intact without private plugin', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '0');
  vi.resetModules();
  const { default: config } = await import('../vite.config.js');
  expect(config.build.outDir).toBe('dist');
  expect(config.define?.['import.meta.env.VITE_PRIVATE_STORAGE']).toBe('"0"');
  expect(config.plugins.some(p => p.name === 'everything-private-storage')).toBe(false);
  expect(html).toContain('https://js.puter.com/v2/');
});
