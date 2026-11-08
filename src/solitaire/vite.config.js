import { defineConfig } from 'vite';
import puterLocalhost from '../../dev/puter-localhost.mjs';
import { privateStoragePlugin } from '../../private_storage/vite.mjs';
import { PRIVATE_CACHE_PREFIXES } from './src/services/private-config.js';

const privateMode = process.env.VITE_PRIVATE_STORAGE === '1';

export default defineConfig({
  plugins: privateMode ? [privateStoragePlugin({ cachePrefixes: PRIVATE_CACHE_PREFIXES })] : [puterLocalhost('solitaire')],
  base: './',
  // Keep HTML/worker policy and runtime selection tied to the same explicit flag.
  define: { 'import.meta.env.VITE_PRIVATE_STORAGE': JSON.stringify(privateMode ? '1' : '0') },
  build: { outDir: privateMode ? 'dist-private' : 'dist' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
