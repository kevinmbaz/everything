import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import puterLocalhost from '../../dev/puter-localhost.mjs';
import { privateStoragePlugin } from '../../private_storage/vite.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  const privateMode = (process.env.VITE_PRIVATE_STORAGE ?? env.VITE_PRIVATE_STORAGE) === '1';
  return {
    plugins: [puterLocalhost('sudoku'), ...(privateMode ? [
      // Source audit: Sudoku has no legacy service worker or cache name.
      privateStoragePlugin({ cachePrefixes: ['sudoku-private-'] }),
      {
        name: 'sudoku-private-no-local-theme',
        transformIndexHtml: { order: 'pre', handler: html => html.replace(/<script id="local-theme">[\s\S]*?<\/script>/, '') },
      },
    ] : [])],
    // Keep relative assets and the original local module generation worker.
    base: './',
    build: { target: 'es2022', outDir: privateMode ? 'dist-private' : 'dist' },
    test: { environment: 'node', include: ['tests/**/*.test.js'] },
  };
});
