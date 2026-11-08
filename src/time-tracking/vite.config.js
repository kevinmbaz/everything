import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';

export default defineConfig(async () => {
  const privateMode = process.env.VITE_PRIVATE_STORAGE === '1';
  const plugins = privateMode
    ? [(await import('../../private_storage/vite.mjs')).privateStoragePlugin({ cachePrefixes: ['hourly-'] })]
    : [puterLocalhost('time-tracking')];
  return {
    plugins,
    base: './',
    build: { outDir: privateMode ? 'dist-private' : 'dist', target: 'es2022', cssTarget: 'safari15' },
    server: { port: 5174 },
    test: { environment: 'node', include: ['tests/**/*.test.js'] },
  };
});
