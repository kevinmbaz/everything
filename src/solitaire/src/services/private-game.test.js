import { describe, it, expect, vi } from 'vitest';
import { createPrivateStorage } from '../../../../private_storage/client.mjs';
import { MODES, rulesFor, serialize } from '../game/modes.js';
import { modeStats, vegasBank } from './stats.js';
import { RANKS } from '../game/deck.js';

const module = await import('./private-game.js').catch(() => ({}));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function server(value = null) {
  const calls = [];
  let revision = 0;
  const fetch = vi.fn(async (url, options) => {
    calls.push({ url, ...options });
    if (url === '/api/session') return Response.json({ app: 'solitaire', storage: 'jetson', username: 'Owner', uuid: 'owner' });
    if (options.method === 'GET') return Response.json({ value: value === null ? null : JSON.stringify(value) }, { headers: { ETag: `"${revision}"` } });
    if (options.headers['If-Match'] !== `"${revision}"`) return Response.json({}, { status: 409 });
    value = JSON.parse(JSON.parse(options.body).value);
    revision++;
    return Response.json({ ok: true }, { headers: { ETag: `"${revision}"` } });
  });
  return { calls, fetch, get value() { return value; }, storage: createPrivateStorage({ app: 'solitaire', fetch }) };
}

describe('private Solitaire startup', () => {
  it.each(MODES.map(m => m.key))('persists and hydrates real %s gameplay with mode and counted stats in one document', async mode => {
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await app.start();
    expect(app.newGame).toBeTypeOf('function');
    app.newGame(mode);
    expect(rulesFor(app.game).draw(app.game).ok).toBe(true);
    app.changed();
    await app.flush();
    const saved = structuredClone(remote.value);
    expect(saved.v).toBe(1);
    expect(saved.mode).toBe(mode);
    expect(saved.game.started).toBe(true);
    expect(saved.game.board).toEqual(serialize(app.game, 0));
    expect(modeStats(saved.stats, mode).played).toBe(1);
    const reopened = module.createPrivateGame({ storage: createPrivateStorage({ app: 'solitaire', fetch: remote.fetch }), prepare: async () => {}, deviceId: 'device-b' });
    await reopened.start();
    expect(serialize(reopened.game, 0)).toEqual(saved.game.board);
    expect(reopened.game.history).toEqual([]);
    rulesFor(reopened.game).draw(reopened.game);
    reopened.changed();
    await reopened.flush();
    expect(modeStats(remote.value.stats, mode).played).toBe(1);
  });
  it.each([
    ['version', s => { s.v = 2; }],
    ['unknown field', s => { s.fallback = true; }],
    ['mode', s => { s.mode = 'vegas-3'; }],
    ['negative moves', s => { s.game.board.m = -1; }],
    ['coerced moves', s => { s.game.board.m = '0'; }],
    ['duplicate cards', s => { s.game.board.s = s.game.board.s.slice(2) + s.game.board.s.slice(0, 2); s.game.board.t[0] = s.game.board.s.slice(0, 2); }],
    ['won flag', s => { s.game.won = true; }],
    ['started flag', s => { s.game.started = 'false'; }],
    ['negative counters', s => { s.stats.played = -1; }],
    ['wins exceed starts', s => { s.stats.won = 1; }],
    ['unknown stats mode', s => { s.stats.modes.other = { played: 0, won: 0, bestMoves: null }; }],
    ['legacy bank without ledger', s => { s.stats.vegas.devices.old = { bank: 100, ts: 1 }; }],
    ['duplicate ledger', s => { s.stats.vegas.settled = ['same', 'same']; }],
  ])('fails closed on invalid %s without replacing the server document', async (_label, corrupt) => {
    const seed = server();
    const original = module.createPrivateGame({ storage: seed.storage, prepare: async () => {}, deviceId: 'device-a' });
    await original.start();
    const bad = structuredClone(seed.value);
    corrupt(bad);
    const remote = server(bad);
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await expect(app.start()).rejects.toThrow(/Invalid private Solitaire state/);
    expect(app.canPlay).toBe(false);
    expect(app.game).toBe(null);
    expect(remote.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
  });
  it.each(['prepare', 'session', 'read'])('latches %s failure without local fallback or a playable board', async phase => {
    const storage = { getUser: vi.fn(async () => { if (phase === 'session') throw new Error('denied'); }), kv: { get: vi.fn(async () => { throw new Error('denied'); }) } };
    const app = module.createPrivateGame({ storage, prepare: async () => { if (phase === 'prepare') throw new Error('denied'); }, deviceId: 'device-a' });
    await expect(app.start()).rejects.toThrow('denied');
    expect(app.error?.message).toBe('denied');
    expect(app.canPlay).toBe(false);
    expect(app.newGame('vegas-1')).toBe(false);
    expect(app.game).toBe(null);
    if (phase === 'prepare') expect(storage.getUser).not.toHaveBeenCalled();
    if (phase !== 'read') expect(storage.kv.get).not.toHaveBeenCalled();
  });
  it('has exactly one startup so another start cannot hydrate over current gameplay', async () => {
    const remote = server();
    const prepare = vi.fn(async () => {});
    const app = module.createPrivateGame({ storage: remote.storage, prepare, deviceId: 'device-a' });
    const start = app.start();
    expect(app.start()).toBe(start);
    await start;
    rulesFor(app.game).draw(app.game);
    app.changed();
    const game = app.game;
    await app.start();
    expect(app.game).toBe(game);
    expect(app.game.moves).toBe(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    await app.flush();
  });
  it('captures coherent immutable writes, including pending changes, and never saves a newer generation on an older acknowledgement', async () => {
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await app.start();
    const first = deferred(), second = deferred();
    const seen = [];
    const set = remote.storage.kv.set;
    remote.storage.kv.set = async (key, value) => {
      seen.push(structuredClone(value));
      await (seen.length === 1 ? first : second).promise;
      return set(key, value);
    };
    rulesFor(app.game).draw(app.game);
    app.changed();
    expect(app.dirty).toBe(true); // even before transport begins
    expect(app.status).toBe('unsaved');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    rulesFor(app.game).draw(app.game);
    app.changed();
    expect(seen[0].game.board.m).toBe(1);
    expect(modeStats(seen[0].stats).played).toBe(1);
    first.resolve();
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(remote.value.game.board.m).toBe(1);
    expect(app.dirty).toBe(true);
    expect(app.status).toBe('unsaved');
    expect(seen[1].game.board.m).toBe(2);
    second.resolve();
    await app.flush();
    expect(remote.value.game.board.m).toBe(2);
    expect(app.dirty).toBe(false);
    expect(app.status).toBe('saved');
  });
  it.each(['denied', 'conflict', 'bad-ack', 'lost-response'])('keeps work dirty and blocks later play/writes after %s', async failure => {
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await app.start();
    const actualFetch = remote.fetch.getMockImplementation();
    remote.fetch.mockImplementationOnce(async (url, options) => {
      if (failure === 'denied' || failure === 'conflict') return Response.json({}, { status: failure === 'denied' ? 403 : 409 });
      await actualFetch(url, options); // committed, but client cannot safely acknowledge
      if (failure === 'lost-response') throw new Error('Response lost; outcome uncertain');
      return Response.json({ ok: true }, { headers: { ETag: 'invalid' } });
    });
    rulesFor(app.game).draw(app.game);
    app.changed();
    rulesFor(app.game).draw(app.game);
    app.changed();
    const waiting = app.flush();
    await expect(waiting).rejects.toThrow();
    expect(app.error).toBeTruthy();
    expect(app.canPlay).toBe(false);
    expect(app.dirty).toBe(true);
    expect(app.status).toBe(failure === 'conflict' ? 'conflict' : 'error');
    expect(JSON.parse(app.exportState()).game.board.m).toBe(2);
    const count = remote.fetch.mock.calls.length;
    expect(app.newGame('vegas-3')).toBe(false);
    expect(app.rules.draw(app.game).ok).toBe(false);
    expect(app.rules.undo(app.game)).toBe(false);
    app.changed();
    await expect(app.flush()).rejects.toThrow();
    expect(app.game.moves).toBe(2);
    expect(remote.fetch).toHaveBeenCalledTimes(count); // no refresh, retry or background overwrites
  });
  it.each(MODES.map(m => m.key))('settles a real final %s move atomically once, before celebration, and prohibits undo/reopen double wins', async mode => {
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await app.start();
    app.newGame(mode);
    const game = app.game;
    const cards = [...game.tableau.flat(), ...game.stock];
    cards.forEach(c => { c.faceUp = true; });
    const suits = [...new Set(cards.map(c => c.suit))];
    const piles = [];
    for (const suit of suits) {
      const copies = cards.filter(c => c.suit === suit && c.rank === 'A').length;
      for (let i = 0; i < copies; i++) piles.push(RANKS.map(rank => cards.filter(c => c.suit === suit && c.rank === rank)[i]));
    }
    game.stock = [];
    game.tableau.forEach((_, i) => { game.tableau[i] = []; });
    if (game.kind === 'spider') {
      game.foundations = piles.slice(1).map(p => p.reverse());
      const last = piles[0].reverse();
      game.tableau[0] = last.slice(0, -1);
      game.tableau[1] = last.slice(-1);
      expect(app.rules.applyMove(game, { from: 'tableau', fromIndex: 1, cardIndex: 0 }, { kind: 'tableau', index: 0 }, game.tableau[1].slice()).ok).toBe(true);
    } else {
      game.foundations = piles;
      game.tableau[0] = [game.foundations[0].pop()];
      if (game.scoring === 'vegas') game.score = 203;
      expect(app.rules.applyMove(game, { from: 'tableau', fromIndex: 0, cardIndex: 0 }, { kind: 'foundation', index: 0 }, game.tableau[0].slice()).ok).toBe(true);
    }
    expect(rulesFor(game).isWon(game)).toBe(true);
    app.changed();
    expect(modeStats(app.stats, mode).won).toBe(1); // not an animation callback
    app.changed(); // repeated callback cannot count again
    expect(app.rules.undo(game)).toBe(false);
    await app.flush();
    expect(remote.value.game.won).toBe(true);
    expect(modeStats(remote.value.stats, mode)).toEqual({ played: 1, won: 1, bestMoves: 1 });
    const reopened = module.createPrivateGame({ storage: createPrivateStorage({ app: 'solitaire', fetch: remote.fetch }), prepare: async () => {}, deviceId: 'device-b' });
    await reopened.start();
    reopened.changed();
    expect(reopened.rules.undo(reopened.game)).toBe(false);
    reopened.newGame(mode);
    await reopened.flush();
    expect(modeStats(remote.value.stats, mode).won).toBe(1);
    if (mode.startsWith('vegas')) {
      expect(vegasBank(remote.value.stats)).toBe(208);
      expect(remote.value.stats.vegas.devices).toEqual({ 'device-a': expect.objectContaining({ bank: 208 }) });
      expect(remote.value.settlements).toHaveLength(1);
    }
  });
  it('settles abandoned Vegas once even after undo to zero, keeping each settling device bank separate', async () => {
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await app.start();
    app.newGame('vegas-1');
    app.rules.draw(app.game); app.changed();
    expect(app.rules.undo(app.game)).toBe(true); app.changed();
    expect(app.game.moves).toBe(0);
    app.newGame('vegas-3');
    await app.flush();
    expect(vegasBank(remote.value.stats)).toBe(-52);
    expect(modeStats(remote.value.stats, 'vegas-1').played).toBe(1);
    const reopened = module.createPrivateGame({ storage: createPrivateStorage({ app: 'solitaire', fetch: remote.fetch }), prepare: async () => {}, deviceId: 'device-b' });
    await reopened.start();
    reopened.rules.draw(reopened.game); reopened.changed();
    reopened.newGame('klondike-3');
    reopened.newGame('klondike-1'); // untouched deals cost nothing
    await reopened.flush();
    expect(remote.value.stats.vegas.devices).toEqual({ 'device-a': expect.objectContaining({ bank: -52 }), 'device-b': expect.objectContaining({ bank: -52 }) });
    expect(vegasBank(remote.value.stats)).toBe(-104);
    expect(remote.value.settlements).toHaveLength(2);
    expect(remote.value.mode).toBe('klondike-1');
  });
  it('uses collision-resistant private game IDs and retains every settlement beyond the legacy hundred-game limit', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const remote = server();
      const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
      await app.start();
      app.newGame('vegas-1');
      const ids = new Set();
      for (let i = 0; i < 102; i++) {
        expect(ids.has(app.game.id)).toBe(false);
        ids.add(app.game.id);
        app.rules.draw(app.game); app.changed();
        app.newGame('vegas-1');
      }
      await app.flush();
      expect(remote.value.settlements).toHaveLength(102);
      expect(remote.value.stats.vegas.settled).toHaveLength(102);
      expect(vegasBank(remote.value.stats)).toBe(-52 * 102);
      const reopen = module.createPrivateGame({ storage: createPrivateStorage({ app: 'solitaire', fetch: remote.fetch }), prepare: async () => {}, deviceId: 'device-b' });
      await reopen.start();
      expect(vegasBank(reopen.stats)).toBe(-52 * 102);
    } finally { clock.mockRestore(); random.mockRestore(); }
  });
  it('validates captured outgoing accounting before any write and preserves invalid work as unsaved', async () => {
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: async () => {}, deviceId: 'device-a' });
    await app.start();
    app.newGame('vegas-1');
    await app.flush();
    const before = structuredClone(remote.value);
    const writes = remote.calls.filter(c => c.method === 'PUT').length;
    app.rules.draw(app.game);
    app.game.score = -51; // impossible payout; must not poison the authoritative document
    app.changed();
    await expect(app.flush()).rejects.toThrow('Invalid private Solitaire state');
    expect(app.canPlay).toBe(false);
    expect(app.dirty).toBe(true);
    expect(remote.value).toEqual(before);
    expect(remote.calls.filter(c => c.method === 'PUT')).toHaveLength(writes);
    expect(JSON.parse(app.exportState()).game.board.$).toBe(-51);
  });
  it('awaits worker preparation, authentication and hydration before exposing a playable board', async () => {
    expect(module.createPrivateGame, 'private authenticated startup is implemented').toBeTypeOf('function');
    const gate = deferred();
    const remote = server();
    const app = module.createPrivateGame({ storage: remote.storage, prepare: () => gate.promise, deviceId: 'device-a' });
    const loading = app.start();
    expect(app.canPlay).toBe(false);
    expect(app.game).toBe(null);
    expect(remote.calls).toHaveLength(0);
    gate.resolve();
    await loading;
    expect(remote.calls.slice(0, 2).map(c => c.url)).toEqual(['/api/session', '/api/kv?key=solitaire%3Astate%3Av1']);
    expect(app.canPlay).toBe(true);
    expect(app.game.kind).toBe('klondike');
    expect(app.game.moves).toBe(0);
  });
});
