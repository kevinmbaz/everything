// Test-only browser Worker protocol bridge. Runs the real generator module in
// a separate Node worker thread, without mocking its computation or replies.
import { parentPort } from 'node:worker_threads';
globalThis.self = {
  addEventListener(type, callback) {
    if (type === 'message') parentPort.on('message', data => callback({ data }));
  },
  postMessage(data) { parentPort.postMessage(data); },
};
await import('../../src/engine/generator.worker.js');
