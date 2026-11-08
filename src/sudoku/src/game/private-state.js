import { createPrivateStorage } from '../../../../private_storage/client.mjs';
import { preparePrivateBrowser } from '../../../../private_storage/browser.mjs';
import { DEFAULT_SETTINGS, normalizeSettings } from './settings.js';
import { emptyStats, normalizeStats, recordStart, recordSolved } from './stats.js';
import { decode, encode } from './serialize.js';
import { isSolved, isFlawless } from './state.js';
import { isDifficulty } from '../engine/generator.js';

const invalid = () => new Error('Invalid private Sudoku document; keep this tab open and inspect stored state before reloading.');
const integer = n => Number.isSafeInteger(n) && n >= 0;
const date = d => d === null || (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d);
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
};

/** Strict validation: normalizers must not silently repair server data. */
export function validatePrivateDocument(raw) {
  if (!raw || raw.v !== 1 || Object.keys(raw).sort().join(',') !== 'gameId,settings,settled,snapshot,stats,v' || typeof raw.settled !== 'boolean') throw invalid();
  if (!same(raw.settings, normalizeSettings(raw.settings)) || !same(raw.stats, normalizeStats(raw.stats))) throw invalid();
  const { stats } = raw;
  if (!integer(stats.ts) || !integer(stats.daily.current) || !integer(stats.daily.best) || !date(stats.daily.lastDate) || stats.daily.best < stats.daily.current || (stats.daily.lastDate === null) !== (stats.daily.current === 0)) throw invalid();
  for (const record of Object.values(stats.byDifficulty)) {
    if (!['played', 'solved', 'flawless', 'totalMs'].every(k => integer(record[k])) || record.flawless > record.solved || (record.bestMs !== null && !integer(record.bestMs))) throw invalid();
  }
  if (raw.snapshot === null) {
    if (raw.gameId !== null || raw.settled) throw invalid();
  } else {
    const s = raw.snapshot, game = decode(s);
    if (!game || typeof raw.gameId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.gameId) || !isDifficulty(s.difficulty) || !date(s.daily)) throw invalid();
    if (!(s.seed === null || typeof s.seed === 'string' || Number.isFinite(s.seed)) || !['ts', 'elapsedMs', 'hintsUsed', 'mistakesMade'].every(k => integer(s[k]))) throw invalid();
    if (!same(s, encode(game, s.ts)) || isSolved(game) !== raw.settled) throw invalid();
  }
  return structuredClone(raw);
}

export const PRIVATE_KEY = 'sudoku:state:v1';
// No legacy service worker/cache exists in this app. Own only this explicit prefix.
export const PRIVATE_CACHE_PREFIXES = ['sudoku-private-'];
const emptyDocument = () => ({ v: 1, snapshot: null, settings: { ...DEFAULT_SETTINGS }, stats: emptyStats(), gameId: null, settled: false });

export function createPrivateSudoku({ storage = createPrivateStorage({ app: 'sudoku' }), prepare = preparePrivateBrowser } = {}) {
  let loading, document, error = null, ready = false;
  let generation = 0, acknowledged = 0, queued = -1, pending = null, queue = Promise.resolve();
  const events = new EventTarget();
  const notify = () => events.dispatchEvent(new Event('state'));
  storage.events.addEventListener('state', notify);
  const requireReady = () => { if (!ready) throw new Error('Private Sudoku has not loaded'); };
  const capture = raw => {
    requireReady();
    try { document = validatePrivateDocument(raw); }
    catch (cause) { error = cause; generation++; notify(); throw cause; }
    generation++;
    notify();
    return structuredClone(document);
  };
  return {
    events,
    capture,
    startGame(game) {
      requireReady();
      return capture({ ...document, snapshot: encode(game), gameId: crypto.randomUUID(), settled: false, stats: recordStart(document.stats, game.difficulty) });
    },
    finishGame(game) {
      requireReady();
      const snapshot = encode(game);
      if (!isSolved(game) || !document.snapshot || !['puzzle', 'solution', 'difficulty', 'seed', 'daily'].every(k => snapshot[k] === document.snapshot[k])) throw invalid();
      if (document.settled) return structuredClone(document);
      return capture({ ...document, snapshot, settled: true, stats: recordSolved(document.stats, {
        difficulty: game.difficulty, elapsedMs: game.elapsedMs, flawless: isFlawless(game), dailyDate: game.daily,
      }) });
    },
    clearGame() {
      requireReady();
      return capture({ ...document, snapshot: null, gameId: null, settled: false });
    },
    get draft() { return document ? structuredClone(document) : null; },
    get ready() { return ready; },
    get error() { return error || storage.error; },
    get dirty() { return generation !== acknowledged || storage.dirty || Boolean(error && ready); },
    markDirty() { requireReady(); generation++; notify(); },
    async save() {
      requireReady();
      if (error) throw error;
      if (queued === generation) return pending;
      const captured = structuredClone(document), token = generation;
      queued = token;
      pending = queue.then(async () => {
        if (error) throw error;
        await storage.kv.set(PRIVATE_KEY, captured);
        acknowledged = token;
        notify();
      }).catch(cause => { error = cause; notify(); throw cause; });
      queue = pending.catch(() => {});
      return pending;
    },
    load() {
      return loading ??= (async () => {
        await prepare({ cachePrefixes: PRIVATE_CACHE_PREFIXES });
        await storage.getUser();
        document = validatePrivateDocument(await storage.kv.get(PRIVATE_KEY) ?? emptyDocument());
        ready = true;
        return structuredClone(document);
      })().catch(cause => { error = cause; throw cause; });
    },
  };
}
