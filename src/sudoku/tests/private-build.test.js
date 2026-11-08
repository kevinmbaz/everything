import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import config from '../vite.config.js';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
afterEach(() => vi.unstubAllEnvs());
const getConfig = () => typeof config === 'function' ? config({ mode: 'test' }) : config;
function transform(config, input) {
  return config.plugins.reduce((value, plugin) => {
    const hook = plugin.transformIndexHtml;
    return hook ? (typeof hook === 'function' ? hook(value) : hook.handler(value)) : value;
  }, input);
}
it('keeps the default Puter HTML/build separate and unchanged', () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '0');
  const normal = getConfig();
  expect(normal.build.outDir ?? 'dist').toBe('dist');
  expect(transform(normal, html)).toContain('https://js.puter.com/v2/');
  expect(transform(normal, html)).toContain("localStorage.getItem('sudoku.settings.v1')");
});
it('private config strips SDK and local theme replay, keeps local assets and emits network-only app-owned worker', () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
  const privateConfig = getConfig();
  expect(privateConfig.build.outDir).toBe('dist-private');
  const output = transform(privateConfig, html);
  expect(output).not.toContain('https://js.puter.com');
  expect(output).not.toContain('localStorage');
  expect(output).toContain('icon-96.png');
  expect(output).toContain('src/main.js');
  const emitFile = vi.fn();
  for (const plugin of privateConfig.plugins) plugin.generateBundle?.call({ emitFile });
  expect(emitFile).toHaveBeenCalledTimes(1);
  const worker = emitFile.mock.calls[0][0];
  expect(worker.fileName).toBe('sw.js');
  expect(worker.source).toContain('sudoku-private-');
  expect(worker.source).not.toMatch(/addEventListener\(['"]fetch|caches\.open|\.skipWaiting\(/);
});
