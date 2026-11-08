import { dealMode, DEFAULT_MODE, serialize, modeOf, rulesFor, findMode } from '../game/modes.js';
import { emptyStats, recordGameStarted, recordGameWon } from './stats.js';
import { validatePrivateState } from './private-state.js';

export const PRIVATE_KEY = 'solitaire:state:v1';

export function createPrivateGame({ storage, prepare, deviceId }) {
  let game = null;
  let ready = false;
  let state = null;
  let queue = Promise.resolve();
  let startup;
  let error = null;
  let generation = 0;
  let acknowledged = 0;
  const events = new EventTarget();
  const notify = () => events.dispatchEvent(new Event('state'));
  storage.events?.addEventListener('state', notify);
  const failure = () => error || storage.conflict || storage.error;
  const canPlay = () => ready && !failure();
  const canMove = () => canPlay() && !state.game.won;
  function settle(outcome) {
    if (game.scoring !== 'vegas' || !state.game.started || state.stats.vegas.settled.includes(state.game.id)) return;
    const now = Date.now();
    const devices = state.stats.vegas.devices;
    state.stats.vegas = {
      devices: { ...devices, [deviceId]: { bank: (devices[deviceId]?.bank || 0) + game.score, ts: now } },
      // Unlike legacy cloud sync this ledger is never silently truncated.
      settled: [...state.stats.vegas.settled, state.game.id],
    };
    state.stats.ts = now;
    state.settlements.push({ gameId: state.game.id, deviceId, score: game.score, outcome });
  }
  const dirty = () => generation !== acknowledged || !!storage.dirty || !!failure();
  function capture() {
    state.game.board = serialize(game, 0);
    const saving = ++generation;
    let captured;
    try { captured = validatePrivateState(state).state; }
    catch (cause) {
      error = cause;
      queue = Promise.reject(cause);
      queue.catch(() => {});
      notify();
      return queue;
    }
    notify();
    queue = queue.then(async () => {
      if (failure()) throw failure();
      await storage.kv.set(PRIVATE_KEY, captured);
      acknowledged = saving;
      notify();
    }).catch(cause => { error = cause; notify(); throw cause; });
    // The UI observes the latched error; every queued rejection is handled,
    // while flush() still rejects for callers explicitly awaiting the result.
    queue.catch(() => {});
    return queue;
  }
  return {
    events,
    get game() { return game; },
    get stats() { return state?.stats; },
    get error() { return failure(); },
    get dirty() { return dirty(); },
    get status() { return storage.conflict ? 'conflict' : failure() ? 'error' : !ready ? 'loading' : dirty() ? 'unsaved' : 'saved'; },
    get canPlay() { return canPlay(); },
    get rules() {
      const rules = rulesFor(game);
      return {
        ...rules,
        canPickUp: (...args) => canMove() && rules.canPickUp(...args),
        canDrop: (...args) => canMove() && rules.canDrop(...args),
        canDraw: (...args) => canMove() && rules.canDraw(...args),
        applyMove: (...args) => canMove() ? rules.applyMove(...args) : { ok: false },
        draw: (...args) => canMove() ? rules.draw(...args) : { ok: false },
        undo: (...args) => canMove() && rules.undo(...args),
      };
    },
    exportState() { return state ? JSON.stringify(state, null, 2) : null; },
    start() {
      return startup ??= (async () => {
        await prepare();
        await storage.getUser();
        state = await storage.kv.get(PRIVATE_KEY);
        if (state === null) {
          game = dealMode(DEFAULT_MODE);
          state = { v: 1, mode: DEFAULT_MODE, game: { id: crypto.randomUUID(), started: false, won: false, board: null }, stats: emptyStats(), settlements: [] };
          await capture();
        } else ({ state, game } = validatePrivateState(state));
        ready = true;
        notify();
      })().catch(cause => { error = cause; notify(); throw cause; });
    },
    newGame(mode) {
      if (!canPlay() || !findMode(mode)) return false;
      settle('abandoned');
      game = dealMode(mode);
      const id = crypto.randomUUID();
      if (game.scoring === 'vegas') game.id = id;
      state.mode = mode;
      state.game = { id, started: false, won: false, board: null };
      capture();
    },
    changed() {
      if (!canMove()) return false;
      if (!state.game.started) {
        state.game.started = true;
        state.stats = recordGameStarted(state.stats, Date.now(), modeOf(game));
      }
      if (rulesFor(game).isWon(game)) {
        state.game.won = true;
        state.stats = recordGameWon(state.stats, game.moves, Date.now(), modeOf(game));
        settle('won');
      }
      capture();
    },
    flush() { return queue; },
  };
}
