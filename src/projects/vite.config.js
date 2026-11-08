import { defineConfig, loadEnv } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';

// Served under the old worker URL too: an already-installed cloud worker can
// upgrade without reloading any open editor or caching private data.
const retirementWorker = `// Private Projects: network only, no offline cache or write replay.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith('pm-shell-')).map(name => caches.delete(name)));
  await self.clients.claim();
})()));
`;

export default defineConfig(({ mode }) => {
  const privateMode = (process.env.VITE_PRIVATE_STORAGE ?? loadEnv(mode, process.cwd(), '').VITE_PRIVATE_STORAGE) === '1';
  return {
    plugins: [puterLocalhost('projects'), ...(privateMode ? [{
      name: 'private-projects',
      transformIndexHtml: {
        order: 'pre',
        handler: html => html.replace(/\s*<script src="https:\/\/js\.puter\.com\/v2\/" defer><\/script>/, '')
          .replace('Lightweight project management on your own Puter cloud.', 'Private project management stored on your Jetson.'),
      },
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'sw.js', source: retirementWorker }); },
    }] : [])],
    base: './',
    build: {
      outDir: privateMode ? 'dist-private' : 'dist',
      target: 'es2022',
      cssTarget: 'safari15',
    },
    server: { port: 5174 },
    test: { environment: 'node', include: ['tests/**/*.test.js'] },
  };
});
