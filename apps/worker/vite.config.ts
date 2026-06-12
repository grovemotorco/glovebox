import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import type { Plugin } from 'vite-plus'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'

const isTest = !!process.env.VITEST
const rootDir = dirname(fileURLToPath(import.meta.url))
const serverAppShell = resolve(rootDir, 'src/components/AppShell.server.tsx')
const clientAppShell = resolve(rootDir, 'src/components/AppShell.client.tsx')
const appShellModule = '#app-shell'
const resolvedAppShellModule = '\0glovebox-app-shell'
const loroCrdtModule = 'loro-crdt'
const loroCrdtBrowserModule = 'loro-crdt/base64'

function appShellAlias(): Plugin {
  return {
    name: 'glovebox-worker-runtime-aliases',
    enforce: 'pre',
    async resolveId(id, importer) {
      const isClient =
        this.environment.name === 'client' || this.environment.config.consumer === 'client'
      if (id === loroCrdtModule && isClient) {
        return this.resolve(loroCrdtBrowserModule, importer, { skipSelf: true })
      }
      if (id !== appShellModule) return null
      return resolvedAppShellModule
    },
    load(id) {
      if (id !== resolvedAppShellModule) return null
      const target = this.environment.config.consumer === 'client' ? clientAppShell : serverAppShell
      return `export { AppShell, DevicePage, InviteAcceptPage } from ${JSON.stringify(target)}`
    },
  }
}

const rejectionGuardFlag = Symbol.for('glovebox.devUnhandledRejectionGuard')

function devUnhandledRejectionGuard(): Plugin {
  return {
    name: 'glovebox-dev-unhandled-rejection-guard',
    apply: 'serve',
    configureServer(server) {
      // Dev-only: allow the JS Self-Profiling API so perf probes can
      // attribute main-thread work (scripts/perf).
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Document-Policy', 'js-profiling')
        next()
      })
      // A page load before workerd is warm rejects the SSR fetch with
      // ECONNREFUSED; unhandled, that kills the whole dev-server process.
      const holder = globalThis as { [rejectionGuardFlag]?: boolean }
      if (holder[rejectionGuardFlag]) return
      holder[rejectionGuardFlag] = true
      process.on('unhandledRejection', (reason) => {
        console.error('[glovebox-dev] unhandled rejection (server kept alive):', reason)
      })
    },
  }
}

export default defineConfig({
  plugins: [
    appShellAlias(),
    !isTest && devUnhandledRejectionGuard(),
    tailwindcss(),
    !isTest &&
      tanstackStart({
        router: {
          entry: 'router.tsx',
        },
      }),
    !isTest && cloudflare({ viteEnvironment: { name: 'ssr' } }),
    viteReact(),
  ],
  // PORT/HOST come from portless (`portless api.glovebox vp dev`).
  server: {
    port: Number(process.env.PORT) || 8787,
    host: process.env.HOST || '127.0.0.1',
    strictPort: true,
  },
})
