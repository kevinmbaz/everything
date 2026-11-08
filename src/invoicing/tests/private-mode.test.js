import { afterEach, describe, expect, it, vi } from 'vitest';

async function privateModules() {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
  vi.resetModules();
  return import('../src/lib/store.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('private Jetson deployment', () => {
  it('loads and saves clients through the real storage adapter without a Puter global', async () => {
    const values = new Map();
    const revisions = new Map();
    const fetch = vi.fn(async (path, options = {}) => {
      const url = new URL(path, 'https://private.test');
      if (url.pathname === '/api/session') {
        return Response.json({ username: 'Jetson storage', storage: 'jetson' });
      }
      expect(url.pathname).toBe('/api/kv');
      const key = url.searchParams.get('key');
      let revision = revisions.get(key) || 0;
      if (options.method === 'PUT') {
        expect(new Headers(options.headers).get('If-Match')).toBe(`"${revision}"`);
        values.set(key, JSON.parse(options.body).value);
        revisions.set(key, ++revision);
        return Response.json({ ok: true }, { headers: { ETag: `"${revision}"` } });
      }
      return Response.json({ value: values.get(key) ?? null }, { headers: { ETag: `"${revision}"` } });
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('puter', undefined);
    const { store } = await privateModules();
    await store.init();
    await store.addClient({ name: 'Private storage test' });
    expect(JSON.parse(values.get('invc:clients:v1'))[0].name).toBe('Private storage test');
    await store.init();
    expect(store.clients[0].name).toBe('Private storage test');
    expect(fetch).toHaveBeenCalled();
  });

  it('never enables paid email or public sharing even if another script supplies a Puter object', async () => {
    vi.stubGlobal('puter', { workers: { exec: vi.fn() } });
    await privateModules();
    const { mailerAvailable } = await import('../src/lib/mailer.js');
    const { publishDoc, shareUrl } = await import('../src/lib/share.js');
    expect(mailerAvailable()).toBe(false);
    expect(shareUrl({ share: { subdomain: 'elsewhere' } }, { shareToken: 'abc12345' })).toBeNull();
    await expect(publishDoc({}, { id: 'D1' })).rejects.toThrow(/private|disabled/i);
    expect(puter.workers.exec).not.toHaveBeenCalled();
  });

  it('keeps private offline copies separate from old Puter snapshots', async () => {
    await privateModules();
    const { SNAPSHOT_KEY, SNAPSHOT_ENABLED_KEY } = await import('../src/lib/snapshot.js');
    expect(SNAPSHOT_KEY).not.toBe('invoicing:snapshot:v1');
    expect(SNAPSHOT_ENABLED_KEY).not.toBe('invoicing:offline:v1');
  });
});
