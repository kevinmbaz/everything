import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPrivateGame } from './services/private-game.js';
import { modeStats } from './services/stats.js';

const ui = vi.hoisted(() => ({ render: vi.fn(), cloud: vi.fn(async () => false), drag: null }));
vi.mock('./ui/board.js', () => ({ render: ui.render }));
vi.mock('./ui/cardview.js', () => ({ preloadCardmeister: vi.fn() }));
vi.mock('./ui/animate.js', () => ({ createAnimator: () => ({ dropUnclaimed() {}, afterCard() {}, queueFlights() {}, queueFlips() {}, cancelCelebration() {}, startCelebration: vi.fn() }) }));
vi.mock('./ui/drag.js', () => ({ createDragController: options => { ui.drag = options; return { attachDrag() {}, attachStockTap() {}, cancelDrag() {} }; } }));
vi.mock('./services/puter-sync.js', () => ({ isSignedIn: ui.cloud, pullStats: ui.cloud, pushStats: ui.cloud, pullSave: ui.cloud, pushSave: ui.cloud, clearSave: ui.cloud }));

class Element extends EventTarget {
  constructor() { super(); this.children = []; this.dataset = {}; this.hidden = true; this.classList = { add() {}, remove() {} }; }
  appendChild(child) { this.children.push(child); }
  querySelectorAll() { return this.children.filter(c => c.className === 'menu-item'); }
  querySelector() { return null; }
  setAttribute() {}
  getAttribute() { return 'false'; }
  focus() {}
}
let elements;
beforeEach(() => {
  elements = new Map();
  const document = new EventTarget();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element();
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
  ui.render.mockClear(); ui.cloud.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

it('wires hydrated private gameplay, undo and mode changes without touching legacy local/cloud storage', async () => {
  const main = await import('./main.js');
  expect(main.startApp).toBeTypeOf('function');
  const storage = { getUser: async () => ({}), kv: { get: async () => null, set: vi.fn(async () => true) } };
  const app = createPrivateGame({ storage, prepare: async () => {}, deviceId: 'device-a' });
  await app.start();
  main.startApp(app);
  expect(ui.render.mock.calls.at(-1)[0].game).toBe(app.game);
  elements.get('board').dispatchEvent(new Event('stock-tap'));
  expect(app.game.moves).toBe(1);
  expect(modeStats(app.stats).played).toBe(1);
  elements.get('undo').onclick();
  expect(app.game.moves).toBe(0);
  const vegas = elements.get('modeMenu').children.find(c => c.dataset.mode === 'vegas-3');
  vegas.dispatchEvent(new Event('click'));
  expect(app.game.scoring).toBe('vegas');
  elements.get('board').dispatchEvent(new Event('stock-tap'));
  elements.get('newgame').onclick();
  await app.flush();
  expect(app.stats.vegas.devices['device-a'].bank).toBe(-52);
  expect(localStorage.getItem).not.toHaveBeenCalled();
  expect(localStorage.setItem).not.toHaveBeenCalled();
  expect(localStorage.removeItem).not.toHaveBeenCalled();
  expect(ui.cloud).not.toHaveBeenCalled();
  expect(storage.kv.set.mock.calls.at(-1)[1].mode).toBe('vegas-3');
});
