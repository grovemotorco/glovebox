import { readFile } from 'node:fs/promises'
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
const devAppShellModule = '#dev-app-shell'
const resolvedDevAppShellModule = '\0glovebox-dev-app-shell'
const devAppShellHtml = resolve(rootDir, 'src/dev-app-shell.html')
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

function devAppShell(): Plugin {
  let transformDevAppShellHtml: ((html: string) => Promise<string>) | undefined
  return {
    name: 'glovebox-dev-app-shell',
    enforce: 'pre',
    configureServer(server) {
      transformDevAppShellHtml = (html) =>
        server.transformIndexHtml('/__glovebox/dev-app-shell', html)
    },
    resolveId(id) {
      if (id !== devAppShellModule) return null
      return resolvedDevAppShellModule
    },
    async load(id) {
      if (id !== resolvedDevAppShellModule) return null
      if (!transformDevAppShellHtml) {
        return devAppShellModuleSource(null)
      }

      this.addWatchFile(devAppShellHtml)
      const template = await readFile(devAppShellHtml, 'utf8')
      const html = await transformDevAppShellHtml(template)
      return devAppShellModuleSource(html)
    },
  }
}

function devAppShellModuleSource(html: string | null): string {
  const body = html === null ? 'Dev app shell is only available from the Vite dev server.' : html
  const status = html === null ? 503 : 200
  return `
const html = ${JSON.stringify(body)}
const status = ${status}
const headers = { 'content-type': 'text/html; charset=utf-8' }

export function createDevAppShellResponse(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Not Found', { status: 404 })
  }
  if (request.method === 'HEAD') {
    return new Response(null, { status, headers })
  }
  return new Response(html, { status, headers })
}
`
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
    devAppShell(),
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
    allowedHosts: ['api.glovebox.test'],
  },
})
