/** Enable only in a private build; does not import Vite or add dependencies. */
export function privateStoragePlugin({ cachePrefixes } = {}) {
  if (!Array.isArray(cachePrefixes) || !cachePrefixes.length || [...cachePrefixes].some(p => typeof p !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p))) throw new TypeError('Explicit nonempty app-owned cache prefixes are required');
  const worker = `// Network only. Never force activation over a legacy editor.
self.addEventListener('activate', event => event.waitUntil((async () => {
  const prefixes = ${JSON.stringify(cachePrefixes)};
  const names = await caches.keys();
  await Promise.all(names.filter(name => prefixes.some(prefix => name.startsWith(prefix))).map(name => caches.delete(name)));
})()));
// No skipWaiting: a waiting worker activates naturally after legacy tabs close.
const optedIn = new Set();
self.addEventListener('message', event => {
  if (event.data?.type !== 'EVERYTHING_PRIVATE_READY' || event.data.version !== 1 || !event.source?.id || !event.source.url?.startsWith(self.registration.scope)) return;
  optedIn.add(event.source.id);
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => client.url.startsWith(self.registration.scope));
    // A restarted worker has forgotten previous opt-ins. Ask the live documents
    // again; only a successfully prepared page retains the responder. Neither
    // an in-scope URL nor an existing controller proves a page opted in.
    for (const client of windows) if (!optedIn.has(client.id)) {
      try { client.postMessage({ type: 'EVERYTHING_PRIVATE_RECHECK', version: 1 }); } catch {}
    }
    let ready = windows.length > 0 && windows.every(client => optedIn.has(client.id));
    if (ready) {
      try { await self.clients.claim(); } catch { ready = false; } // Waiting workers cannot claim.
    }
    event.ports[0]?.postMessage({ type: 'EVERYTHING_PRIVATE_NETWORK_ONLY', version: 1, ready });
  })());
});
`;
  return {
    name: 'everything-private-storage',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // Consume whole attributes, including quoted values: data-src and text
        // inside another value must never masquerade as the actual src/href.
        const attr = (tag, name) => {
          const attributes = tag.replace(/^<[^\s/>]+/, '');
          for (const match of attributes.matchAll(/([^\s/=>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
            if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
          }
          return '';
        };
        const puter = url => /^(?:https?:)?\/\/(?:[a-z0-9-]+\.)*puter\.com(?:[/:?#]|$)/i.test(url);
        const analytics = /google-analytics\.com|googletagmanager\.com|plausible\.io|umami\.|analytics\.|static\.cloudflareinsights\.com|clarity\.ms|cdn\.segment\.com|cdn\.mixpanel\.com|posthog\.com|usefathom\.com/i;
        return html.replace(/(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)[\s\S]*?<\/script\s*>/gi, (tag, opening) => {
          const src = attr(opening, 'src');
          return puter(src) || (/^(?:https?:)?\/\//i.test(src) && analytics.test(src)) || (!src && /\b(?:gtag|ga|fbq|plausible)\s*\(|\b(?:dataLayer|_paq)\s*[.=]/.test(tag)) ? '' : tag;
        }).replace(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => /\b(?:preconnect|dns-prefetch)\b/i.test(attr(tag, 'rel')) && (puter(attr(tag, 'href')) || (/^(?:https?:)?\/\//i.test(attr(tag, 'href')) && analytics.test(attr(tag, 'href')))) ? '' : tag);
      },
    },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker }); },
  };
}
