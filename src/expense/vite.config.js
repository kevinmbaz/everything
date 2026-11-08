import { defineConfig, loadEnv } from 'vite';

export default defineConfig(async ({ mode }) => {
  const privateMode = (process.env.VITE_PRIVATE_STORAGE ?? loadEnv(mode, process.cwd(), '').VITE_PRIVATE_STORAGE) === '1';
  const pluginUrl = new URL('../../private_storage/vite.mjs', import.meta.url).href;
  const plugins = privateMode ? [(await import(pluginUrl)).privateStoragePlugin({ cachePrefixes: ['expenses-'] })] : [];
  return {
  plugins,
  base: './',
  build: {
    outDir: privateMode ? 'dist-private' : 'dist',
    target: 'es2022',
    cssTarget: 'safari15',
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
  },
  };
});
