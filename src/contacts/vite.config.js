import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'
import puterLocalhost from '../../dev/puter-localhost.mjs'
import { privateStoragePlugin } from '../../private_storage/vite.mjs'

export default defineConfig(({ mode }) => {
  const privateMode = loadEnv(mode, process.cwd(), '').VITE_PRIVATE_STORAGE === '1'
  return {
    plugins: privateMode ? [
      privateStoragePlugin({ cachePrefixes: ['contacts-shell-'] }),
      {
        name: 'contacts-private-features',
        transformIndexHtml: {
          order: 'pre',
          handler: html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, tag => /hideWindow\(\)|plausible\.init/.test(tag) ? '' : tag),
        },
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: '.well-known/mcp.json', source: JSON.stringify({ available: false, reason: 'MCP and headless cross-app bridges are unavailable in private mode.' }) })
        },
      },
    ] : [puterLocalhost('contacts')],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    build: { target: 'es2020', sourcemap: false, outDir: privateMode ? 'dist-private' : 'dist' },
    test: {
      environment: 'node',
      include: ['src/**/*.test.js'],
      // Keep original Puter tests meaningful during the private build pretest.
      // Dedicated private tests explicitly opt in with vi.stubEnv.
      env: { VITE_PRIVATE_STORAGE: '0' },
    },
  }
})
