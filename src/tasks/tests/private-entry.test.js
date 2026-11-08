import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
const source = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
it('transforms the actual Tasks HTML without SDK/analytics and omits the legacy worker generator', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1'); vi.resetModules();
  try {
    const { default: config } = await import('../vite.config.js');
    expect(config.build.outDir).toBe('dist-private');
    expect(config.plugins.some(p => p.name === 'tasks-service-worker')).toBe(false);
    const plugin = config.plugins.find(p => p.name === 'everything-private-storage');
    const html = plugin.transformIndexHtml.handler(source('index.html'));
    expect(html).not.toMatch(/<script[^>]+src=["'][^"']*(?:puter\.com|plausible)/i);
    expect(html).not.toMatch(/<link[^>]+(?:preconnect|dns-prefetch)[^>]*puter\.com/i);
    const assets = []; plugin.generateBundle.call({ emitFile: asset => assets.push(asset) });
    expect(assets).toHaveLength(1); expect(assets[0].fileName).toBe('sw.js');
    expect(assets[0].source).toContain('tasks-');
    expect(assets[0].source).not.toMatch(/self\.skipWaiting\s*\(|addEventListener\(['"]fetch/);
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});
it('retains the default Puter build and its original worker generator', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '0'); vi.resetModules();
  try {
    const { default: config } = await import('../vite.config.js');
    expect(config.build.outDir).toBe('dist');
    expect(config.plugins.some(p => p.name === 'tasks-service-worker')).toBe(true);
    expect(source('index.html')).toContain('js.puter.com');
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});
it('private startup prepares the legacy worker before boot and bypasses the SDK/mirror gate', () => {
  const main = source('src/main.js');
  const start = main.slice(main.indexOf('async function start()'));
  expect(start.indexOf('if (isPrivateStorage)')).toBeGreaterThanOrEqual(0);
  expect(start.indexOf('await preparePrivateBrowser')).toBeLessThan(start.indexOf('mountSharedViewer();'));
  expect(start).toMatch(/await preparePrivateBrowser[\s\S]*?await boot\(\);[\s\S]*?return;/);
  expect(main).toContain('if (!isPrivateStorage) registerServiceWorker()');
  expect(main).toContain('if (isPrivateStorage) return; // No remote merge, replay or collaboration polling');
});
it('private build uses only the shared network worker and retires actual tasks caches', () => {
  const config = source('vite.config.js');
  expect(config.includes("process.env.VITE_PRIVATE_STORAGE === '1'")).toBe(true);
  expect(config.includes("outDir: isPrivate ? 'dist-private' : 'dist'")).toBe(true);
  expect(config.includes("privateStoragePlugin({ cachePrefixes: ['tasks-'] })")).toBe(true);
  expect(config.includes('isPrivate ?')).toBe(true);
  expect(source('src/main.js').includes("cachePrefixes: ['tasks-']")).toBe(true);
});
it('private status never promises an offline save and warns before unload', () => {
  const main = source('src/main.js');
  expect(main).toContain('beforeunload');
  expect(main).toContain('Unsaved changes');
  expect(main).toContain('Saved to Jetson');
  expect(main.includes("const hasQuickDraft = () => !!document.getElementById('quick-add-input')?.value.trim()")).toBe(true);
  expect(main.includes('Conflict —')).toBe(true);
});
