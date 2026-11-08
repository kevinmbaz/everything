import { deserialize, serialize, modeOf, findMode, rulesFor } from '../game/modes.js';
import { RANKS } from '../game/deck.js';
import { LEGACY_MODE, modeStats } from './stats.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
const natural = n => Number.isSafeInteger(n) && n >= 0;
export const validIdentity = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
const counters = c => object(c) && natural(c.played) && natural(c.won) && c.won <= c.played && (c.won === 0 ? c.bestMoves === null : natural(c.bestMoves));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = () => { throw new Error('Invalid private Solitaire state; no data was loaded or replaced.'); };

// Private snapshots are strict; the legacy serializer intentionally tolerates
// older/coerced fields. Never use that tolerance as a private migration path.
export function validatePrivateState(value) {
  if (!keys(value, ['v', 'mode', 'game', 'stats', 'settlements']) || value.v !== 1 || !findMode(value.mode)) fail();
  const current = value.game;
  if (!keys(current, ['id', 'started', 'won', 'board']) || !validIdentity(current.id) || typeof current.started !== 'boolean' || typeof current.won !== 'boolean') fail();
  const board = current.board;
  const game = deserialize(board);
  if (!game || !natural(board.m) || modeOf(game) !== value.mode || board.ts !== 0) fail();
  // Legacy Spider decoding round-trips string suit counts without normalizing them.
  if (game.kind === 'spider' && ![1, 2, 4].includes(board.n)) fail();
  // Key order is not significant, but unknown fields and lossy coercions are.
  const canonical = serialize(game, 0);
  if (!keys(board, Object.keys(canonical)) || Object.keys(canonical).some(k => !same(board[k], canonical[k]))) fail();
  if (current.won !== rulesFor(game).isWon(game) || (!current.started && (game.moves !== 0 || current.won))) fail();
  // Spider starts with five ten-card rows; draws/undo preserve whole rows.
  if (game.kind === 'spider' && (game.stock.length > 50 || game.stock.length % 10 !== 0)) fail();
  if (game.stock.some(c => c.faceUp) || game.waste?.some(c => !c.faceUp)) fail();
  for (const pile of game.tableau) {
    if (pile.length && !pile.at(-1).faceUp) fail();
    let faceUp = false;
    for (const c of pile) { if (faceUp && !c.faceUp) fail(); faceUp ||= c.faceUp; }
  }
  if (game.kind === 'klondike') {
    for (const pile of game.foundations) if (pile.some((c, i) => !c.faceUp || c.suit !== pile[0].suit || c.rank !== RANKS[i])) fail();
    if (!natural(game.redeals)) fail();
    if (game.scoring === 'vegas' && (game.id !== current.id || game.score !== -52 + 5 * game.foundations.flat().length || game.redeals > (game.draw === 3 ? 2 : 0))) fail();
  }
  const stats = value.stats;
  if (!keys(stats, ['v', 'played', 'won', 'bestMoves', 'ts', 'modes', 'vegas']) || stats.v !== 1 || !counters(stats) || !natural(stats.ts) || !object(stats.modes)) fail();
  for (const [mode, c] of Object.entries(stats.modes)) if (!findMode(mode) || mode === LEGACY_MODE || !keys(c, ['played', 'won', 'bestMoves']) || !counters(c)) fail();
  const c = modeStats(stats, value.mode);
  if ((current.started && c.played === 0) || (current.won && c.won === 0)) fail();
  const vegas = stats.vegas;
  if (!keys(vegas, ['devices', 'settled']) || !object(vegas.devices) || !Array.isArray(vegas.settled) || !Array.isArray(value.settlements)) fail();
  const ids = new Set();
  const banks = new Map();
  for (const entry of value.settlements) {
    if (!keys(entry, ['gameId', 'deviceId', 'score', 'outcome']) || !validIdentity(entry.gameId) || !validIdentity(entry.deviceId) || ids.has(entry.gameId) || !['won', 'abandoned'].includes(entry.outcome) || !Number.isInteger(entry.score) || entry.score < -52 || entry.score > 208 || (entry.score + 52) % 5 !== 0 || (entry.outcome === 'won' && entry.score !== 208)) fail();
    ids.add(entry.gameId);
    banks.set(entry.deviceId, (banks.get(entry.deviceId) || 0) + entry.score);
    if (entry.gameId === current.id && (!current.won || game.scoring !== 'vegas' || entry.outcome !== 'won' || entry.score !== game.score)) fail();
  }
  if (!same(vegas.settled, [...ids]) || Object.keys(vegas.devices).length !== banks.size) fail();
  for (const [id, d] of Object.entries(vegas.devices)) if (!validIdentity(id) || !keys(d, ['bank', 'ts']) || !Number.isSafeInteger(d.bank) || !natural(d.ts) || !banks.has(id) || d.bank !== banks.get(id)) fail();
  if (game.scoring === 'vegas' && current.won && !ids.has(current.id)) fail();
  return { state: structuredClone(value), game };
}
