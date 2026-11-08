import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';

const privateStorage = process.env.VITE_PRIVATE_STORAGE === '1';
const privateBuild = {
  name: 'private-storage',
  transformIndexHtml(html) {
    return html.replace('<script src="https://js.puter.com/v2/" defer></script>', '')
      .replace('stored in your own Puter cloud', 'stored privately on your Jetson');
  },
};

/**
 * The service worker, written from the bundle that was just built.
 *
 * The app looks installable — manifest, maskable icons, a bottom tab bar, a
 * boot splash — but without this it is a plain network-dependent page: on a
 * train it opened to "Could not reach Puter" and stayed there. The shell is
 * precached under a name that changes with the build, so a new deploy never
 * serves half of one version and half of another, and old caches go on
 * activate.
 *
 * Generated rather than hand-written because the file names are hashed: a
 * hand-maintained list would be wrong the first time anyone changed a line.
 */
function serviceWorker() {
  return {
    name: 'invoicing-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => /\.(js|css)$/.test(name))
        .map((name) => `./${name}`);
      // Everything the first paint needs, plus the icons an installed app
      // shows before any of its own code runs.
      const shell = [
        './',
        './index.html',
        './manifest.json',
        './favicon.ico',
        './favicon-16x16.png',
        './favicon-32x32.png',
        './favicon-48x48.png',
        './apple-touch-icon.png',
        './icon-192.png',
        './icon-512.png',
        './icon-512-maskable.png',
        ...assets,
      ];
      // The cache name changes whenever the shell does, which is what makes
      // "clean up everything else on activate" safe.
      const version = `v${hash(shell.join('|'))}`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: swSource(version, shell) });
    },
  };
}

/** A short, stable hash of the shell list; only inequality matters. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function swSource(version, shell) {
  return `/* Generated at build time by vite.config.js — do not edit. */
const CACHE = 'invoicing-${version}';
const SHELL = ${JSON.stringify(shell, null, 2)};
/* The Puter SDK is loaded from its own origin. It is runtime-cached so an
   installed app has it offline, but nothing about the offline path may
   depend on it resolving: the app boots from its own local snapshot. */
const SDK = ${JSON.stringify(privateStorage ? '' : 'https://js.puter.com/')};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time and forgiving: a single 404 must not leave the whole
    // install rejected and the app permanently uncached.
    await Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('invoicing-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Storage is authoritative on the server, never in a worker cache.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  /* The app's own navigations: the cached shell first, so an offline launch
     paints instantly, with the network refreshing it in the background. */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      const fresh = fetch(request).then((response) => {
        if (response.ok) caches.open(CACHE).then((c) => c.put('./index.html', response.clone()));
        return response;
      }).catch(() => null);
      return cached || (await fresh) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  /* The SDK: network first so it stays current, cache as the fallback. An
     opaque response is fine — it replays exactly as it arrived. */
  if (SDK && request.url.startsWith(SDK)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
    return;
  }

  /* Everything else of ours: cache first (the file names are hashed, so a
     hit is never stale), then the network. */
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })());
  }
  /* Anything else (the user's own cloud) goes to the network untouched:
     caching someone's billing data in a browser cache is not this app's
     decision to make — the opt-in snapshot is. */
});
`;
}

export default defineConfig({
  base: './',
  plugins: [puterLocalhost('invoicing'), serviceWorker(), ...(privateStorage ? [privateBuild] : [])],
  build: {
    outDir: privateStorage ? 'dist-private' : 'dist',
    target: 'es2022',
    cssTarget: 'safari15',
  },
  server: {
    port: 5174,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
