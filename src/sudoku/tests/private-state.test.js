import { describe, expect, it, vi } from 'vitest';
import { createPrivateStorage } from '../../../private_storage/client.mjs';
import { DEFAULT_SETTINGS } from '../src/game/settings.js';
import { emptyStats } from '../src/game/stats.js';
import { createGame } from '../src/game/state.js';
import { fromText, encode } from '../src/game/serialize.js';

const KEY = 'sudoku:state:v1';
const solution = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
const game = () => createGame({ puzzle: fromText('.' + solution.slice(1)), solution: fromText(solution), difficulty: 'easy', seed: 'test' });
const empty = () => ({ v: 1, snapshot: null, settings: { ...DEFAULT_SETTINGS }, stats: emptyStats(), gameId: null, settled: false });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function server(initial = null) {
  let value = initial, revision = initial ? 1 : 0;
  const calls = [];
  const response = (data, status = 200, tag = revision) => new Response(JSON.stringify(data), { status, headers: { ETag: `"${tag}"` } });
  const fetch = vi.fn(async (url, options) => {
    calls.push({ url, ...options });
    if (url === '/api/session') return response({ username: 'Owner', uuid: 'owner', app: 'sudoku', storage: 'jetson' });
    if (options.method === 'GET') return response({ value: value === null ? null : JSON.stringify(value) });
    if (options.headers['If-Match'] !== `"${revision}"`) return response({}, 409);
    value = JSON.parse(JSON.parse(options.body).value); revision++;
    return response({ ok: true });
  });
  return { fetch, calls, get value() { return value; }, get revision() { return revision; } };
}
async function setup(initial = null, prepare = vi.fn(async () => {})) {
  const { createPrivateSudoku } = await import('../src/game/private-state.js');
  const api = server(initial);
  const storage = createPrivateStorage({ app: 'sudoku', fetch: api.fetch });
  const controller = createPrivateSudoku({ storage, prepare });
  return { api, storage, controller, prepare };
}

describe('private Sudoku document', () => {
  it('uses defaults only for missing state, without importing browser data', async () => {
    const { controller, api } = await setup();
    expect(await controller.load()).toEqual(empty());
    expect(api.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
  });

  it.each([
    ['version', d => { d.v = 2; }],
    ['settings type', d => { d.settings.showTimer = 'yes'; }],
    ['unknown setting', d => { d.settings.unknown = true; }],
    ['stats version', d => { d.stats.v = 7; }],
    ['negative count', d => { d.stats.byDifficulty.easy.solved = -1; }],
    ['fractional count', d => { d.stats.byDifficulty.easy.played = 1.5; }],
    ['daily date', d => { d.stats.daily.lastDate = '2026-02-30'; }],
    ['streak invariant', d => { d.stats.daily.current = 2; }],
    ['unsafe streak count', d => { d.stats.daily.best = Number.MAX_SAFE_INTEGER + 1; }],
    ['unknown field', d => { d.unexpected = 1; }],
    ['snapshot board', d => { d.snapshot = { ...encode(game()), solution: '1'.repeat(81) }; d.gameId = 'game-1'; }],
    ['snapshot notes token', d => { d.snapshot = { ...encode(game()), notes: '0junk:2' }; d.gameId = 'game-1'; }],
    ['snapshot difficulty', d => { d.snapshot = { ...encode(game()), difficulty: 'invalid' }; d.gameId = 'game-1'; }],
    ['snapshot counter', d => { d.snapshot = { ...encode(game()), elapsedMs: -1 }; d.gameId = 'game-1'; }],
    ['missing game id', d => { d.snapshot = encode(game()); }],
    ['unsettled solved snapshot', d => { const g = game(); g.values.set(g.solution); d.snapshot = encode(g); d.gameId = 'game-1'; }],
    ['settled unfinished snapshot', d => { d.snapshot = encode(game()); d.gameId = 'game-1'; d.settled = true; }],
  ])('fails closed on invalid %s; never substitutes defaults', async (_name, corrupt) => {
    const raw = empty(); corrupt(raw);
    const { controller, api } = await setup(raw);
    await expect(controller.load()).rejects.toThrow(/Invalid private Sudoku/);
    expect(controller.ready).toBe(false);
    expect(controller.error).toBeTruthy();
    await expect(controller.load()).rejects.toThrow();
    expect(api.calls).toHaveLength(2);
  });

  it.each(['prepare', 'session', 'read'])('fails closed on %s failure', async stage => {
    const { controller, api } = await setup(null, stage === 'prepare' ? async () => { throw new Error('blocked'); } : undefined);
    if (stage !== 'prepare') api.fetch.mockImplementation(async url => {
      if (stage === 'read' && url === '/api/session') return new Response(JSON.stringify({ username: 'Owner', uuid: 'owner', app: 'sudoku', storage: 'jetson' }));
      return new Response('{}', { status: 403 });
    });
    await expect(controller.load()).rejects.toThrow();
    expect(controller.ready).toBe(false);
    expect(controller.error).toBeTruthy();
  });
  it('captures edits and serializes CAS writes; an older ack cannot mark a newer draft saved', async () => {
    const { controller, api } = await setup(); await controller.load();
    const draft = empty(); draft.settings.theme = 'dark';
    controller.capture(draft);
    const gate = deferred(); const fetch = api.fetch.getMockImplementation();
    api.fetch.mockImplementation(async (url, opts) => { if (opts.method === 'PUT') await gate.promise; return fetch(url, opts); });
    const first = controller.save();
    draft.settings.theme = 'light';
    controller.capture(draft);
    expect(controller.dirty).toBe(true);
    gate.resolve(); await first;
    expect(api.value.settings.theme).toBe('dark');
    expect(controller.dirty).toBe(true);
    await controller.save();
    expect(api.value.settings.theme).toBe('light');
    expect(api.calls.filter(c => c.method === 'PUT').map(c => c.headers['If-Match'])).toEqual(['"0"', '"1"']);
    expect(controller.dirty).toBe(false);
  });

  it('guards prehydration writes and exposes draft-only timer dirtiness', async () => {
    const { controller, api } = await setup();
    expect(() => controller.capture(empty())).toThrow(/loaded/);
    await expect(controller.save()).rejects.toThrow(/loaded/);
    expect(api.calls).toHaveLength(0);
    await controller.load();
    controller.markDirty();
    expect(controller.dirty).toBe(true);
    expect(api.calls).toHaveLength(2);
  });

  it.each([403, 409, 500, 'network', 'malformed'])('latches %s failure, retains latest draft and stops queued/future writes', async failure => {
    const { controller, api } = await setup(); await controller.load();
    const gate = deferred();
    api.fetch.mockImplementation(async () => {
      await gate.promise;
      if (failure === 'network') throw new Error('disconnected');
      return new Response(JSON.stringify(failure === 'malformed' ? { ok: false } : {}), { status: typeof failure === 'number' ? failure : 200, headers: { ETag: '"1"' } });
    });
    controller.capture(empty());
    const first = controller.save();
    const latest = empty(); latest.settings.theme = 'dark'; controller.capture(latest);
    const second = controller.save();
    const results = Promise.allSettled([first, second]); gate.resolve();
    expect((await results).map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(controller.dirty).toBe(true);
    expect(controller.error).toBeTruthy();
    expect(controller.draft.settings.theme).toBe('dark');
    const calls = api.fetch.mock.calls.length;
    await expect(controller.save()).rejects.toThrow();
    expect(api.fetch.mock.calls).toHaveLength(calls);
  });

  it('rejects a stale tab without rereading the CAS baseline', async () => {
    const { controller: a, api } = await setup();
    const { createPrivateSudoku } = await import('../src/game/private-state.js');
    const b = createPrivateSudoku({ storage: createPrivateStorage({ app: 'sudoku', fetch: api.fetch }), prepare: async () => {} });
    await a.load(); await b.load();
    a.capture(empty()); await a.save();
    const stale = empty(); stale.settings.theme = 'dark'; b.capture(stale);
    await expect(b.save()).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(api.value.settings.theme).toBe('system');
    expect(b.draft.settings.theme).toBe('dark');
    expect(api.calls.filter(c => c.url.startsWith('/api/kv') && c.method === 'GET')).toHaveLength(2);
  });

  it('starts and settles a puzzle atomically once, including daily stats across reopen', async () => {
    const { controller, api } = await setup(); await controller.load();
    const g = game(); g.daily = '2026-11-08';
    controller.startGame(g);
    await controller.save();
    expect(api.value.stats.byDifficulty.easy.played).toBe(1);
    expect(api.value.snapshot.daily).toBe(g.daily);
    g.elapsedMs = 12345; g.values.set(g.solution);
    controller.finishGame(g); controller.finishGame(g);
    await controller.save();
    expect(api.value.settled).toBe(true);
    expect(api.value.snapshot.values).toBe(solution);
    expect(api.value.stats.byDifficulty.easy).toEqual({ played: 1, solved: 1, flawless: 1, bestMs: 12345, totalMs: 12345 });
    expect(api.value.stats.daily).toEqual({ current: 1, best: 1, lastDate: g.daily });
    const reopened = await setup(api.value); await reopened.controller.load();
    reopened.controller.finishGame(g); await reopened.controller.save();
    expect(reopened.api.value.stats.byDifficulty.easy.solved).toBe(1);
  });

  it('preserves snapshot values, notes, eliminations, timer and settings; clear never resurrects an earlier queued save', async () => {
    const { controller, api } = await setup(); await controller.load();
    const g = game(); g.values[0] = 2; g.notes[0] = 3; g.eliminated[0] = 4; g.elapsedMs = 9876; g.hintsUsed = 2; g.mistakesMade = 1;
    controller.startGame(g);
    const raw = controller.draft; raw.settings.showTimer = false; controller.capture(raw);
    const first = controller.save();
    await first;
    expect(api.value.snapshot).toEqual(encode(g, api.value.snapshot.ts));
    expect(api.value.settings.showTimer).toBe(false);
    const old = controller.save(); controller.clearGame(); const cleared = controller.save();
    await Promise.all([old, cleared]);
    expect(api.value.snapshot).toBeNull();
    expect(api.value.gameId).toBeNull();
    expect(api.value.stats.byDifficulty.easy.played).toBe(1);
    expect(api.value.settings.showTimer).toBe(false);
  });

  it('does not settle a different puzzle or allow settlement of an unfinished game', async () => {
    const { controller } = await setup(); await controller.load();
    const g = game(); controller.startGame(g);
    expect(() => controller.finishGame(g)).toThrow();
    g.values.set(g.solution); g.seed = 'another';
    expect(() => controller.finishGame(g)).toThrow();
    expect(controller.draft.stats.byDifficulty.easy.solved).toBe(0);
  });

  it('failed settlement keeps coherent completed draft and cannot double-count or clear error', async () => {
    const { controller, api } = await setup(); await controller.load();
    const g = game(); controller.startGame(g); await controller.save();
    api.fetch.mockRejectedValue(new Error('offline'));
    g.values.set(g.solution); controller.finishGame(g);
    await expect(controller.save()).rejects.toThrow('offline');
    controller.finishGame(g);
    expect(controller.draft.settled).toBe(true);
    expect(controller.draft.stats.byDifficulty.easy.solved).toBe(1);
    expect(controller.dirty).toBe(true);
    expect(api.value.settled).toBe(false);
  });

  it('invalid local capture stays dirty and latches an error rather than allowing a later false Saved', async () => {
    const { controller } = await setup(); await controller.load();
    const invalid = empty(); invalid.settings.theme = 'broken';
    expect(() => controller.capture(invalid)).toThrow();
    expect(controller.dirty).toBe(true);
    expect(controller.error).toBeTruthy();
    await expect(controller.save()).rejects.toThrow();
  });

  it('clear is ordered after captured in-flight saves and retains settings/statistics', async () => {
    const { controller, api } = await setup(); await controller.load();
    const g = game(); controller.startGame(g);
    const gate = deferred(); const original = api.fetch.getMockImplementation();
    api.fetch.mockImplementation(async (url, opts) => { if (opts.method === 'PUT') await gate.promise; return original(url, opts); });
    const first = controller.save();
    const changed = controller.draft; changed.snapshot.elapsedMs = 1234; changed.settings.theme = 'dark'; controller.capture(changed);
    const second = controller.save();
    controller.clearGame(); const third = controller.save();
    expect(controller.dirty).toBe(true); gate.resolve();
    await Promise.all([first, second, third]);
    const writes = api.calls.filter(c => c.method === 'PUT');
    expect(writes.map(c => c.headers['If-Match'])).toEqual(['"0"', '"1"', '"2"']);
    expect(writes.map(c => JSON.parse(JSON.parse(c.body).value).snapshot?.elapsedMs ?? null)).toEqual([0, 1234, null]);
    expect(api.value.snapshot).toBeNull();
    expect(api.value.stats.byDifficulty.easy.played).toBe(1);
    expect(api.value.settings.theme).toBe('dark');
    expect(controller.dirty).toBe(false);
  });

  it('a committed settlement with a lost response stays uncertain without replay; reopen sees exactly one result', async () => {
    const { controller, api } = await setup(); await controller.load();
    const g = game(); controller.startGame(g); await controller.save();
    const original = api.fetch.getMockImplementation();
    api.fetch.mockImplementation(async (url, opts) => { await original(url, opts); throw new Error('response lost'); });
    g.values.set(g.solution); controller.finishGame(g);
    await expect(controller.save()).rejects.toThrow('response lost');
    expect(controller.dirty).toBe(true);
    expect(api.value.stats.byDifficulty.easy.solved).toBe(1);
    const reopened = await setup(api.value); await reopened.controller.load();
    reopened.controller.finishGame(g); await reopened.controller.save();
    expect(reopened.api.value.stats.byDifficulty.easy.solved).toBe(1);
  });

  it('awaits safe preparation, real session, then validated hydration exactly once', async () => {
    const gate = deferred();
    const { controller, api, prepare } = await setup(empty(), () => gate.promise);
    const loading = controller.load();
    expect(api.calls).toHaveLength(0);
    expect(controller.ready).toBe(false);
    gate.resolve();
    expect(await loading).toEqual(empty());
    expect(api.calls.map(c => c.url)).toEqual(['/api/session', `/api/kv?key=${encodeURIComponent(KEY)}`]);
    expect(controller.ready).toBe(true);
    await controller.load();
    expect(api.calls).toHaveLength(2);
    expect(controller.dirty).toBe(false);
  });
});
