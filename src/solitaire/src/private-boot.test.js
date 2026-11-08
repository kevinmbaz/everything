import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dealMode, deserialize, serialize, rulesFor } from './game/modes.js';
import { emptyStats, recordGameStarted } from './services/stats.js';
const module = await import('./private-boot.js').catch(() => ({}));

function spiderSnapshot(suits = 1, draws = 0) {
  const mode = `spider-${suits}`;
  const game = dealMode(mode, () => 0.5);
  for (let i = 0; i < draws; i++) expect(rulesFor(game).draw(game).ok).toBe(true);
  return {
    v: 1, mode,
    game: { id: 'startup-spider', started: draws > 0, won: false, board: serialize(game, 0) },
    stats: draws > 0 ? recordGameStarted(emptyStats(), 0, mode) : emptyStats(),
    settlements: [],
  };
}

async function rejectsStartup(snapshot) {
  const before = structuredClone(snapshot);
  const storage = { getUser: vi.fn(async () => ({})), kv: { get: vi.fn(async () => snapshot), set: vi.fn() } };
  const startApp = vi.fn();
  await expect(module.bootSolitaire({ privateMode: true, prepare: async () => {}, storage, startApp }).then(() => undefined))
    .rejects.toThrow('Invalid private Solitaire state');
  expect(startApp).not.toHaveBeenCalled();
  expect(nodes.get('private-storage-status').dataset.state).toBe('error');
  expect(nodes.get('board').inert).toBe(true);
  expect(nodes.get('modeMenu').inert).toBe(true);
  for (const id of ['newgame', 'undo', 'mode', 'winNew', 'private-export']) expect(nodes.get(id).disabled).toBe(true);
  expect(storage.kv.set).not.toHaveBeenCalled();
  expect(snapshot).toEqual(before);
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let nodes;
beforeEach(() => {
  nodes = new Map();
  const document = { getElementById: id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, textContent: '', hidden: true, disabled: false });
    return nodes.get(id);
  }, querySelector: () => ({ textContent: '' }) };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it('mounts disabled private status before preparation and starts gameplay only after initial authoritative save', async () => {
  expect(module.bootSolitaire).toBeTypeOf('function');
  const prepared = deferred(), read = deferred(), saved = deferred();
  const prepare = vi.fn(() => prepared.promise);
  const storage = { getUser: vi.fn(async () => ({})), kv: { get: vi.fn(() => read.promise), set: vi.fn(() => saved.promise) } };
  const startApp = vi.fn();
  const boot = module.bootSolitaire({ privateMode: true, prepare, storage, startApp });
  expect(nodes.get('private-storage-panel').hidden).toBe(false);
  expect(nodes.get('board').inert).toBe(true);
  expect(nodes.get('newgame').disabled).toBe(true);
  expect(storage.getUser).not.toHaveBeenCalled();
  expect(startApp).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledWith({ cachePrefixes: ['solitaire-v'] });
  prepared.resolve();
  await vi.waitFor(() => expect(storage.kv.get).toHaveBeenCalled());
  read.resolve(null);
  await vi.waitFor(() => expect(storage.kv.set).toHaveBeenCalled());
  expect(startApp).not.toHaveBeenCalled();
  saved.resolve(true);
  const app = await boot;
  expect(startApp).toHaveBeenCalledWith(app);
  expect(nodes.get('board').inert).toBe(false);
  expect(nodes.get('private-storage-status').dataset.state).toBe('saved');
  expect(localStorage.getItem.mock.calls.every(([key]) => key === 'solitaire.private.device.v1')).toBe(true);
});

it('updates dirty/unload status synchronously and fails closed on write errors while retaining an exportable draft', async () => {
  expect(module.bootSolitaire).toBeTypeOf('function');
  const storage = { getUser: async () => ({}), kv: { get: async () => null, set: vi.fn(async () => true) } };
  const app = await module.bootSolitaire({ privateMode: true, prepare: async () => {}, storage, startApp: vi.fn() });
  const pending = deferred();
  storage.kv.set.mockImplementationOnce(() => pending.promise);
  app.rules.draw(app.game); app.changed();
  expect(nodes.get('private-storage-status').dataset.state).toBe('unsaved');
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  pending.reject(new Error('write denied'));
  await expect(app.flush()).rejects.toThrow('write denied');
  expect(nodes.get('private-storage-status').dataset.state).toBe('error');
  expect(nodes.get('private-storage-status').textContent).toContain('Export draft');
  expect(nodes.get('board').inert).toBe(true);
  expect(nodes.get('newgame').disabled).toBe(true);
  expect(nodes.get('private-export').disabled).toBe(false);
  expect(JSON.parse(app.exportState()).game.board.m).toBe(1);
});

it('rejects nonempty nine-card Spider stock before mounting or enabling gameplay or writing defaults', async () => {
  const snapshot = spiderSnapshot(1, 4);
  const game = deserialize(snapshot.game.board);
  // Preserve every card and its multiplicity/orientation: only the stock shape is invalid.
  game.tableau[0].push({ ...game.stock.pop(), faceUp: true });
  expect(game.stock).toHaveLength(9);
  snapshot.game.board = serialize(game, 0);
  expect(deserialize(snapshot.game.board)).not.toBe(null); // legacy acceptance is not private validation
  await rejectsStartup(snapshot);
});

it.each([1, 2, 4].flatMap(suits => [1, 11, 49, 51, 60].map(length => [suits, length])))(
  'rejects Spider-%i stock length %i with intact card multiplicities before mounting or writing defaults', async (suits, length) => {
    const snapshot = spiderSnapshot(suits);
    const game = deserialize(snapshot.game.board);
    while (game.stock.length > length) game.tableau[0].push({ ...game.stock.pop(), faceUp: true });
    while (game.stock.length < length) {
      const pile = game.tableau.find(p => p.length > 1);
      game.stock.push({ ...pile.pop(), faceUp: false });
      pile.at(-1).faceUp = true;
    }
    snapshot.game.board = serialize(game, 0);
    expect(deserialize(snapshot.game.board).stock).toHaveLength(length);
    await rejectsStartup(snapshot);
  },
);

it.each([1, 2, 4].flatMap(suits => [0, 1, 2, 3, 4, 5].map(draws => [suits, draws, 50 - 10 * draws])))(
  'hydrates numeric Spider-%i after %i legal draws with %i stock cards and permits safe draw/undo', async (suits, draws, length) => {
    const snapshot = spiderSnapshot(suits, draws);
    const storage = { getUser: async () => ({}), kv: { get: async () => structuredClone(snapshot), set: vi.fn(async () => true) } };
    const startApp = vi.fn();
    const app = await module.bootSolitaire({ privateMode: true, prepare: async () => {}, storage, startApp });
    expect(startApp).toHaveBeenCalledWith(app);
    expect(app.canPlay).toBe(true);
    expect(app.game.suits).toBe(suits);
    expect(app.game.stock).toHaveLength(length);
    expect(serialize(app.game, 0)).toEqual(snapshot.game.board);
    expect(nodes.get('board').inert).toBe(false);
    expect(storage.kv.set).not.toHaveBeenCalled();
    const before = serialize(app.game, 0);
    expect(app.rules.draw(app.game).ok).toBe(length > 0);
    if (length > 0) {
      app.changed();
      await app.flush();
      expect(app.game.stock).toHaveLength(length - 10);
      expect(app.rules.undo(app.game)).toBe(true);
      app.changed();
      await app.flush();
      expect(storage.kv.set).toHaveBeenCalledTimes(2);
    }
    expect(serialize(app.game, 0)).toEqual(before);
    expect(app.status).toBe('saved');
    expect(app.dirty).toBe(false);
  },
);

it.each([1, 2, 4])('rejects string Spider suit count "%s" on a valid stock before mounting or writing defaults', async suits => {
  const snapshot = spiderSnapshot(suits);
  snapshot.game.board.n = String(suits);
  const legacy = deserialize(snapshot.game.board);
  expect(legacy.stock).toHaveLength(50);
  expect(legacy.suits).toBe(String(suits)); // default serializer remains deliberately tolerant
  await rejectsStartup(snapshot);
});

it.each([
  ['zero', 0], ['unsupported integer', 3], ['fraction', 1.5], ['negative', -1],
  ['null', null], ['boolean', true], ['array', [1]], ['object', {}],
])('rejects non-variant Spider suit count (%s) without mounting or writing defaults', async (_label, suits) => {
  const snapshot = spiderSnapshot();
  snapshot.game.board.n = suits;
  await rejectsStartup(snapshot);
});

it.each([1, 2, 4])('rejects numeric Spider-%i when its declared mode differs', async suits => {
  const snapshot = spiderSnapshot(suits);
  snapshot.mode = suits === 1 ? 'spider-2' : 'spider-1';
  await rejectsStartup(snapshot);
});

it('keeps default Puter startup separate without preparing private browser or storage', async () => {
  expect(module.bootSolitaire).toBeTypeOf('function');
  const prepare = vi.fn(), startApp = vi.fn();
  await module.bootSolitaire({ privateMode: false, prepare, startApp });
  expect(startApp).toHaveBeenCalledWith();
  expect(prepare).not.toHaveBeenCalled();
  expect(localStorage.getItem).not.toHaveBeenCalled();
});
