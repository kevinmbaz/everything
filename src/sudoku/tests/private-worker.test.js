import { afterEach, expect, it, vi } from 'vitest';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { requestPuzzle, disposeWorker } from '../src/game/puzzles.js';
import { hasUniqueSolution } from '../src/engine/solver.js';
import { generateDaily } from '../src/engine/generator.js';
import { toText } from '../src/game/serialize.js';
let threads = [];
afterEach(async () => { disposeWorker(); await Promise.all(threads.map(t => t.terminate())); threads = []; vi.unstubAllGlobals(); });

it('the unchanged module-worker path actually generates the deterministic daily and matches the real inline engine', async () => {
  const messages = [];
  vi.stubGlobal('Worker', class {
    constructor(url, options) {
      expect(url.pathname).toMatch(/engine\/generator\.worker\.js$/);
      expect(options.type).toBe('module');
      this.thread = new ThreadWorker(new URL('./fixtures/generator-worker-node.mjs', import.meta.url), { type: 'module' });
      threads.push(this.thread);
    }
    addEventListener(type, callback) {
      this.thread.on(type, data => {
        if (type === 'message') { messages.push(data); callback({ data }); } else callback(data);
      });
    }
    postMessage(data) { this.thread.postMessage(data); }
    terminate() { this.thread.terminate(); }
  });
  const result = await requestPuzzle({ difficulty: 'easy', daily: '2026-11-08', timeoutMs: 10000 });
  expect(messages).toHaveLength(1); // A silent inline fallback cannot pass.
  expect(messages[0].ok).toBe(true);
  expect(hasUniqueSolution(result.puzzle)).toBe(true);
  const inline = generateDaily('2026-11-08', 'easy');
  expect(toText(result.puzzle)).toBe(toText(inline.puzzle));
  expect(toText(result.solution)).toBe(toText(inline.solution));
}, 15000);
