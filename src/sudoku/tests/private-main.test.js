// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import html from '../index.html?raw';
import { Blob as NodeBlob } from 'node:buffer';
import { DEFAULT_SETTINGS } from '../src/game/settings.js';
import { emptyStats } from '../src/game/stats.js';
import { encode, fromText } from '../src/game/serialize.js';
import { createGame } from '../src/game/state.js';

const hooks = vi.hoisted(() => ({ prepare: vi.fn(), request: vi.fn() }));
vi.mock('../../../private_storage/browser.mjs', () => ({ preparePrivateBrowser: hooks.prepare }));
vi.mock('../src/game/puzzles.js', () => ({ requestPuzzle: hooks.request }));
const solution = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
const game = () => createGame({ puzzle: fromText('..' + solution.slice(2)), solution: fromText(solution), difficulty: 'easy', seed: 'ui' });
const documentState = () => ({ v: 1, snapshot: encode(game()), settings: { ...DEFAULT_SETTINGS }, stats: emptyStats(), gameId: 'ui-1', settled: false });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let saved, calls, failure, listeners;
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.stubEnv('VITE_PRIVATE_STORAGE', '1');
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/g, '');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  listeners = [];
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, callback, options) => { listeners.push([target, type, callback, options]); add(type, callback, options); });
  }
  saved = documentState(); calls = []; failure = null;
  hooks.prepare.mockReset().mockResolvedValue(undefined);
  hooks.request.mockReset().mockImplementation(async () => ({ ...game(), givens: 79 }));
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private local read'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private local write'); });
  let revision = 1;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    calls.push({ url, ...options });
    if (url === '/api/session') return new Response(JSON.stringify({ app: 'sudoku', storage: 'jetson', username: 'Owner', uuid: 'owner' }));
    if (options.method === 'PUT') {
      if (failure) return new Response('{}', { status: failure });
      saved = JSON.parse(JSON.parse(options.body).value); revision++;
      return new Response('{"ok":true}', { headers: { ETag: `"${revision}"` } });
    }
    return new Response(JSON.stringify({ value: saved === null ? null : JSON.stringify(saved) }), { headers: { ETag: `"${revision}"` } });
  }));
});
afterEach(() => { for (const [target, type, callback, options] of listeners) target.removeEventListener(type, callback, options); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const start = async () => { const m = await import('../src/main.js'); await m.boot; await settle(); };
const click = id => document.getElementById(id).click();
const key = value => document.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
const visibility = hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};
async function startMode(mode) {
  if (mode === 'normal') {
    vi.stubEnv('VITE_PRIVATE_STORAGE', '0');
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(key => key === 'sudoku.save.v2' ? JSON.stringify(saved.snapshot) : null),
      setItem: vi.fn((key, value) => { if (key === 'sudoku.save.v2') saved.snapshot = JSON.parse(value); }),
      removeItem: vi.fn(),
    });
  }
  await start();
}

it.each([
  ['private', 'success', true], ['private', 'rejection', true],
  ['normal', 'success', true], ['normal', 'rejection', true],
  ['private', 'success', false], ['private', 'rejection', false],
  ['normal', 'success', false], ['normal', 'rejection', false],
])('%s generation %s excludes waiting after hidden-visible (settles hidden: %s)', async (mode, outcome, hiddenAtSettlement) => {
  await startMode(mode);
  await vi.advanceTimersByTimeAsync(1000);
  const gate = deferred(); hooks.request.mockReturnValue(gate.promise);
  click('new-game-btn'); await settle();
  expect(hooks.request).toHaveBeenCalledTimes(1);
  visibility(true); await settle();
  await vi.advanceTimersByTimeAsync(5000);
  visibility(false);
  await vi.advanceTimersByTimeAsync(5000);
  visibility(true); await settle();
  expect(saved.snapshot.seed).toBe('ui');
  expect(saved.snapshot.elapsedMs).toBe(1000);
  visibility(hiddenAtSettlement);
  if (outcome === 'success') gate.resolve({ ...game(), seed: 'replacement', givens: 79 });
  else gate.reject(new Error('generator failed'));
  await settle();
  window.dispatchEvent(new Event('pagehide')); await settle();
  const banked = outcome === 'success' ? 0 : 1000;
  expect(saved.snapshot.seed).toBe(outcome === 'success' ? 'replacement' : 'ui');
  expect(saved.snapshot.elapsedMs).toBe(banked);
  await vi.advanceTimersByTimeAsync(5000);
  window.dispatchEvent(new Event('pagehide')); await settle();
  const elapsed = banked + (hiddenAtSettlement ? 0 : 5000);
  expect(saved.snapshot.elapsedMs).toBe(elapsed);
  visibility(false);
  await vi.advanceTimersByTimeAsync(1000);
  click('pause-btn'); await settle();
  expect(saved.snapshot.elapsedMs).toBe(elapsed + 1000);
});

it.each([
  ['private', 'success'], ['private', 'rejection'],
  ['normal', 'success'], ['normal', 'rejection'],
])('%s paused generation %s blocks resume while pending and preserves the correct clock afterwards', async (mode, outcome) => {
  await startMode(mode);
  await vi.advanceTimersByTimeAsync(1000);
  click('pause-btn'); await settle();
  const gate = deferred(); hooks.request.mockReturnValue(gate.promise);
  click('new-game-btn'); await settle();
  click('pause-btn'); key('p');
  visibility(true); await vi.advanceTimersByTimeAsync(5000);
  visibility(false); await vi.advanceTimersByTimeAsync(5000);
  window.dispatchEvent(new Event('pagehide')); await settle();
  expect(saved.snapshot.elapsedMs).toBe(1000);
  if (outcome === 'success') gate.resolve({ ...game(), seed: 'replacement', givens: 79 });
  else gate.reject(new Error('generator failed'));
  await settle();
  await vi.advanceTimersByTimeAsync(5000);
  window.dispatchEvent(new Event('pagehide')); await settle();
  expect(saved.snapshot.elapsedMs).toBe(outcome === 'success' ? 5000 : 1000);
  expect(document.getElementById('veil').hidden).toBe(outcome === 'success');
  if (outcome === 'rejection') {
    click('veil-btn'); await vi.advanceTimersByTimeAsync(1000);
    click('pause-btn'); await settle();
    expect(saved.snapshot.elapsedMs).toBe(2000);
  }
});

it.each(['private', 'normal'])('%s resume while hidden waits for visibility before restarting the timer', async mode => {
  await startMode(mode);
  await vi.advanceTimersByTimeAsync(1000);
  click('pause-btn'); await settle();
  visibility(true);
  click('veil-btn');
  await vi.advanceTimersByTimeAsync(5000);
  window.dispatchEvent(new Event('pagehide')); await settle();
  expect(saved.snapshot.elapsedMs).toBe(1000);
  visibility(false);
  await vi.advanceTimersByTimeAsync(1000);
  click('pause-btn'); await settle();
  expect(saved.snapshot.elapsedMs).toBe(2000);
});

it('a late resume callback cannot restart a timer frozen by storage failure', async () => {
  await start();
  await vi.advanceTimersByTimeAsync(1000);
  failure = 500;
  click('pause-btn'); await settle();
  expect(document.getElementById('app').inert).toBe(true);
  // Exercise the retained callback directly; inert blocks ordinary user clicks.
  document.getElementById('veil-btn').onclick();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await downloadDraft()).snapshot.elapsedMs).toBe(1000);
});

it.each(['generating', 'paused', 'playing'])('normal late cloud adoption respects the %s board timer', async phase => {
  await startMode('normal');
  const cloud = deferred();
  const puter = {
    auth: { isSignedIn: vi.fn(async () => true), signIn: vi.fn(async () => {}), getUser: vi.fn(async () => ({ username: 'Test' })) },
    kv: { get: vi.fn(key => key === 'sudoku:save' ? cloud.promise : Promise.resolve(null)), set: vi.fn(async () => {}) },
  };
  vi.stubGlobal('puter', puter);
  click('account-btn');
  for (let i = 0; i < 4; i++) await settle();
  expect(puter.kv.get).toHaveBeenCalledWith('sudoku:save');
  await vi.advanceTimersByTimeAsync(1000);
  const generation = deferred(); hooks.request.mockReturnValue(generation.promise);
  if (phase !== 'playing') click(phase === 'generating' ? 'new-game-btn' : 'pause-btn');
  await settle();
  cloud.resolve(encode({ ...game(), seed: 'cloud' })); await settle();
  await vi.advanceTimersByTimeAsync(5000);
  window.dispatchEvent(new Event('pagehide')); await settle();
  expect(saved.snapshot.elapsedMs).toBe(phase === 'playing' ? 5000 : 1000);
  expect(saved.snapshot.seed).toBe(phase === 'playing' ? 'cloud' : 'ui');
  expect(document.getElementById('veil').hidden).toBe(phase === 'playing');
  if (phase === 'generating') {
    generation.reject(new Error('generator failed')); await settle();
  } else if (phase === 'paused') click('veil-btn');
  await vi.advanceTimersByTimeAsync(1000);
  click('pause-btn'); await settle();
  expect(saved.snapshot.elapsedMs).toBe(phase === 'playing' ? 6000 : 2000);
});

it('atomically autosaves moves, notes, hint use, timer and settings without local or cloud storage', async () => {
  await start();
  key('n'); key('1'); await settle();
  expect(saved.snapshot.notes).toBe('0:1');
  key('n'); key('4'); await settle();
  expect(saved.snapshot.values[0]).toBe('4');
  expect(saved.snapshot.mistakesMade).toBe(1);
  await vi.advanceTimersByTimeAsync(6000);
  click('pause-btn'); await settle();
  expect(saved.snapshot.elapsedMs).toBeGreaterThanOrEqual(6000);
  document.querySelector('[data-theme-choice="dark"]').click(); await settle();
  expect(saved.settings.theme).toBe('dark');
  click('settings-btn');
  document.querySelector('input[aria-label="Show the clock"]').click(); await settle();
  expect(saved.settings.showTimer).toBe(false);
  expect(Storage.prototype.getItem).not.toHaveBeenCalled();
  expect(Storage.prototype.setItem).not.toHaveBeenCalled();
  expect(calls.every(c => c.url.startsWith('/api/'))).toBe(true);
});

it('saves a completed board and statistics in one mutation, and reopening cannot recount it', async () => {
  await start();
  key('5'); key('ArrowRight'); key('3'); await settle();
  expect(saved.snapshot.values).toBe(solution);
  expect(saved.settled).toBe(true);
  expect(saved.stats.byDifficulty.easy.solved).toBe(1);
  key('z'); await settle();
  expect(saved.stats.byDifficulty.easy.solved).toBe(1);
  const writes = calls.filter(c => c.method === 'PUT').map(c => JSON.parse(JSON.parse(c.body).value));
  expect(writes.filter(d => d.snapshot.values === solution)).toHaveLength(1);
  expect(writes.at(-1).stats.byDifficulty.easy.solved).toBe(1);
});

it('warns on dirty unload, freezes failed work visibly and never retries or falsely reports Saved', async () => {
  await start(); failure = 409;
  key('4');
  const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  await settle();
  expect(document.getElementById('private-save-status').textContent).toContain('Not saved');
  expect(document.getElementById('app').inert).toBe(true);
  expect(document.querySelector('#board [role="gridcell"]').textContent).toContain('4');
  const writes = calls.filter(c => c.method === 'PUT').length;
  await vi.advanceTimersByTimeAsync(10000); click('new-game-btn'); key('2'); await settle();
  expect(calls.filter(c => c.method === 'PUT')).toHaveLength(writes);
  expect(hooks.request).not.toHaveBeenCalled();
  expect(document.getElementById('private-export').disabled).toBe(false);
});

it('generates only after authenticated empty state and saves initial board and played count together', async () => {
  saved = null; await start();
  expect(hooks.request).toHaveBeenCalledTimes(1);
  expect(saved.stats.byDifficulty.easy.played).toBe(1);
  expect(saved.snapshot.seed).toBe('ui');
  expect(saved.gameId).toBeTruthy();
});

it('keeps corrupt server state fail-closed without puzzle creation or autosave', async () => {
  saved.v = 9; await start();
  expect(document.getElementById('app').inert).toBe(true);
  expect(document.getElementById('private-save-status').textContent).toContain('could not load');
  expect(hooks.request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);
  expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
});

it('persists reading a hint immediately, including without applying it', async () => {
  await start(); click('hint-btn'); await settle();
  expect(saved.snapshot.hintsUsed).toBe(1);
  click('hint-btn'); await settle();
  expect(saved.snapshot.hintsUsed).toBe(1);
});

it('never adopts a generated replacement after an in-flight save has failed', async () => {
  await start();
  const gate = deferred(); hooks.request.mockReturnValue(gate.promise);
  failure = 500;
  key('4'); click('new-game-btn'); click('confirm-yes'); await settle();
  expect(hooks.request).toHaveBeenCalledTimes(1);
  gate.resolve({ ...game(), seed: 'replacement', givens: 79 }); await settle();
  expect(document.querySelector('#board [role="gridcell"]').textContent).toContain('4');
  expect(document.getElementById('app').inert).toBe(true);
  expect(saved.snapshot.seed).toBe('ui');
});

it('late generator failure cannot restart a timer already frozen by storage failure', async () => {
  await start(); await vi.advanceTimersByTimeAsync(1000);
  const gate = deferred(); hooks.request.mockReturnValue(gate.promise);
  failure = 500; key('4'); click('new-game-btn'); click('confirm-yes'); await settle();
  gate.reject(new Error('generator failed')); await settle();
  await vi.advanceTimersByTimeAsync(10000);
  const draft = await downloadDraft();
  expect(draft.snapshot.elapsedMs).toBe(1000);
  expect(draft.snapshot.values[0]).toBe('4');
});

it('failed completion dismisses the modal so the retained draft can be downloaded', async () => {
  await start(); failure = 500;
  key('5'); key('ArrowRight'); key('3'); await settle();
  expect(document.getElementById('solved-dialog').open).toBe(false);
  expect(document.getElementById('private-save-status').textContent).toContain('Not saved');
});

async function downloadDraft() {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = vi.fn(); });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  click('private-export');
  return JSON.parse(await URL.createObjectURL.mock.calls[0][0].text());
}

it('draft download preserves a saved paused state and includes the actual snapshot without claiming a server write', async () => {
  await start(); key('4'); click('pause-btn'); await settle();
  const writes = calls.filter(c => c.method === 'PUT').length;
  const draft = await downloadDraft();
  expect(draft.snapshot.values[0]).toBe('4');
  expect(draft.settings).toEqual(saved.settings);
  expect(document.getElementById('private-save-status').textContent).toContain('Saved');
  expect(calls.filter(c => c.method === 'PUT')).toHaveLength(writes);
  const leaving = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(false);
});

it('failure freezes the timer even after returning from a hidden tab; export retains the unsaved work', async () => {
  await start(); await vi.advanceTimersByTimeAsync(1000); failure = 500; key('4'); await settle();
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(10000);
  const draft = await downloadDraft();
  expect(draft.snapshot.values[0]).toBe('4');
  expect(draft.snapshot.elapsedMs).toBe(1000);
  expect(document.getElementById('private-save-status').textContent).toContain('Not saved');
});

it('a failed records reset stays a draft and cannot reopen a modal over recovery controls', async () => {
  saved.stats.byDifficulty.easy.played = 4;
  await start(); failure = 500;
  click('stats-btn'); click('stats-reset'); click('confirm-yes'); await settle();
  expect(saved.stats.byDifficulty.easy.played).toBe(4);
  expect(document.getElementById('stats-dialog').open).toBe(false);
  const draft = await downloadDraft();
  expect(draft.stats.byDifficulty.easy.played).toBe(0);
  expect(document.getElementById('private-save-status').textContent).toContain('Not saved');
});

it('the normal Puter mode still restores and saves locally without private session or preparation', async () => {
  vi.stubEnv('VITE_PRIVATE_STORAGE', '0');
  const local = { getItem: vi.fn(key => key === 'sudoku.save.v2' ? JSON.stringify(saved.snapshot) : null), setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal('localStorage', local);
  await start();
  expect(document.getElementById('private-storage-panel')).toBeNull();
  expect(hooks.prepare).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
  expect(hooks.request).not.toHaveBeenCalled();
  key('4'); await vi.advanceTimersByTimeAsync(400);
  const savedGame = local.setItem.mock.calls.find(([key]) => key === 'sudoku.save.v2');
  expect(JSON.parse(savedGame[1]).values[0]).toBe('4');
});

it('blocks editor, timer, generation and autosave until safe prepare/session/hydration', async () => {
  const gate = deferred(); hooks.prepare.mockReturnValue(gate.promise);
  const m = await import('../src/main.js');
  expect(document.getElementById('app').inert).toBe(true);
  click('new-game-btn'); key('5');
  await vi.advanceTimersByTimeAsync(10000);
  expect(hooks.request).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
  gate.resolve(); await m.boot; await settle();
  expect(hooks.prepare).toHaveBeenCalledWith({ cachePrefixes: ['sudoku-private-'] });
  expect(document.getElementById('app').inert).toBe(false);
  expect(document.querySelectorAll('#board [role="gridcell"]')).toHaveLength(81);
  expect(document.getElementById('private-save-status').textContent).toContain('Saved');
  expect(hooks.request).not.toHaveBeenCalled();
  expect(Storage.prototype.getItem).not.toHaveBeenCalled();
  expect(Storage.prototype.setItem).not.toHaveBeenCalled();
});
