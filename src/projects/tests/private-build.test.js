import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
afterEach(() => { vi.unstubAllEnvs(); });

describe('separate private build', () => {
  it('emits dist-private without an SDK and replaces old SW caching with a retirement worker', async () => {
    vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
    const result = await build({ root, logLevel: 'silent', build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
    const html = outputs.find(f => f.fileName === 'index.html').source;
    expect(html).not.toContain('js.puter.com');
    const worker = outputs.find(f => f.fileName === 'sw.js');
    expect(worker).toBeTruthy();
    expect(worker.source).toContain('skipWaiting');
    expect(worker.source).not.toContain("addEventListener('fetch'");
    const code = outputs.filter(f => f.type === 'chunk').map(f => f.code).join('\n');
    expect(code).toContain('Stored on your Jetson');
    expect(code).not.toMatch(/globalThis\.puter\s*=/);
    expect(code).toContain('Puter Drive links are unavailable');
  }, 60000);

  it('preserves the default SDK build', async () => {
    vi.stubEnv('VITE_PRIVATE_STORAGE', '0');
    const result = await build({ root, logLevel: 'silent', build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
    expect(outputs.find(f => f.fileName === 'index.html').source).toContain('https://js.puter.com/v2/');
  }, 60000);
});
