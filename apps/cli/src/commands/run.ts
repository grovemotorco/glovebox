import { parseArgs } from 'node:util'
import { createGloveboxCliClient } from '@glovebox.md/api'
import {
  DaemonRunner,
  DaemonSyncEngine,
  NodeDaemonStorage,
  WsDaemonTransport,
  createNodeFS,
} from '@glovebox.md/sync/daemon'
import type { GlobalFlags } from '../cli/index.ts'
import { printError } from '../cli/output.ts'
import { getToken } from '../lib/auth-store.ts'
import { acquireLock } from '../lib/lockfile.ts'
import { parseSyncOverrides } from '../lib/overrides.ts'
import { canonicalizeDir, gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { findMountForDir, loadRegistry } from '../lib/registry.ts'
import { TLS_TRUST_HINT, diagnoseTlsTrust, ensureSystemCaTrust } from '../lib/tls.ts'
import { workspaceWsUrl } from '../lib/url.ts'
import { createHintDebouncer, startWatchHints } from '../lib/watcher.ts'

/**
 * Foreground daemon — ONE process per mount (the V1 process model):
 * NodeFS + NodeDaemonStorage + WsDaemonTransport + DaemonSyncEngine +
 * DaemonRunner, plus watcher hints. The per-mount lock is mandatory (two
 * daemons on one dir corrupt watermark bookkeeping); SIGINT/SIGTERM stop
 * cleanly (kill -9 mid-cycle is a survived case — the two-artifact
 * reconcile exists for exactly that). Exit codes: 0 clean signal stop,
 * 1 fatal (no mount, lock held, server revoked/deleted the workspace).
 *
 * Lock discipline: every failure path between `acquireLock` and process
 * exit releases the lock — an in-process throw must not leave a live-pid
 * lock that nothing will ever judge stale.
 */

export async function runRun(
  target: string | undefined,
  options: {
    rescanIntervalSec?: number
    paths?: GloveboxPaths
    env?: NodeJS.ProcessEnv
  } = {},
): Promise<void> {
  const env = options.env ?? process.env
  const paths = options.paths ?? gloveboxPaths(env)
  const dir = await canonicalizeDir(target ?? process.cwd())
  if (!dir) {
    throw new Error(`no such directory: ${target ?? process.cwd()}`)
  }
  const registry = await loadRegistry(paths)
  const mount = findMountForDir(registry, dir)
  if (!mount) {
    throw new Error(`no mount covers ${dir} — run \`glovebox mount <dir> --workspace <id>\` first`)
  }

  if (mount.serverUrl.startsWith('https://')) {
    // Trust the OS store (where `portless trust`/mkcert install dev CAs) —
    // same semantics as --use-system-ca, scoped to this process.
    ensureSystemCaTrust()
  }

  const overrides = parseSyncOverrides(env)
  const lock = await acquireLock(paths, mount.mountId)

  let exiting = false
  let teardown: () => Promise<void> = async () => {}
  const shutdown = async (code: number): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    await teardown()
    await lock.release()
    process.exit(code)
  }

  try {
    const transport = new WsDaemonTransport({
      url: async () =>
        workspaceWsUrl(
          mount.serverUrl,
          mount.workspaceId,
          await resolveWorkspaceSocketToken({
            paths,
            serverUrl: mount.serverUrl,
            workspaceId: mount.workspaceId,
          }),
        ),
      backoffInitialMs: overrides.backoffInitialMs,
      onConnect: () => {
        console.log(`[glovebox] connected to ${mount.serverUrl}`)
        hints.poke()
      },
      onAuthRequired: (reason) => {
        printError(
          `server rejected credentials (${reason}) — refresh with ` +
            `\`glovebox auth device --server ${mount.serverUrl} --workspace ${mount.workspaceId}\`; retrying with stored token`,
        )
      },
      onStopped: (reason, code) => {
        printError(`server closed this mount: ${reason} (close code ${code})`)
        void shutdown(1)
      },
      onHint: () => hints.poke(),
    })

    const engine = new DaemonSyncEngine({
      workspaceId: mount.workspaceId,
      mountId: mount.mountId,
      deviceId: mount.deviceId,
      fs: await createNodeFS(mount.dir),
      storage: new NodeDaemonStorage(paths.stateDir(mount.mountId)),
      transport,
      deletePolicy: overrides.deletePolicy,
    })

    // The WebSocket layer reports connection failures without a cause
    // (undici's ErrorEvent is empty) — when one shows up, probe the TLS
    // handshake directly ONCE and name the real problem.
    let tlsDiagnosed = false
    const runner = new DaemonRunner({
      engine,
      intervalMs:
        options.rescanIntervalSec !== undefined
          ? options.rescanIntervalSec * 1000
          : overrides.rescanIntervalMs,
      onCycleError: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        printError(`sync cycle failed: ${message}`)
        if (!tlsDiagnosed && message.includes('WebSocket connection failed')) {
          tlsDiagnosed = true
          void diagnoseTlsTrust(mount.serverUrl).then((problem) => {
            if (problem) {
              printError(
                `TLS preflight against ${mount.serverUrl}: ${problem.code} — ${problem.message}`,
              )
              if (problem.certTrust) {
                printError(TLS_TRUST_HINT)
              }
            }
          })
        }
      },
    })

    const hints = createHintDebouncer(() => {
      void runner.kick()
    }, overrides.watchDebounceMs ?? 200)
    const watcher = startWatchHints(mount.dir, () => hints.poke())

    teardown = async () => {
      watcher.close()
      hints.cancel()
      runner.stop()
      // Let an in-flight cycle finish its persistence writes — kill -9
      // mid-write is survivable, but a clean stop shouldn't rely on the
      // crash reconcile.
      await runner.settle()
      transport.stop()
    }

    process.on('SIGINT', () => void shutdown(0))
    process.on('SIGTERM', () => void shutdown(0))

    await runner.start()
  } catch (error) {
    await teardown()
    await lock.release()
    throw error
  }

  console.log(
    `[glovebox] syncing ${mount.dir} ↔ workspace ${mount.workspaceId} (mount ${mount.mountId})`,
  )
  console.log('[glovebox] foreground daemon — Ctrl-C to stop')

  // Block until a signal or terminal close ends the process.
  return new Promise<never>(() => {})
}

export async function resolveWorkspaceSocketToken(options: {
  paths: GloveboxPaths
  serverUrl: string
  workspaceId: string
  fetch?: typeof fetch
  mintSocketToken?: (apiKey: string) => Promise<string>
}): Promise<string | undefined> {
  const credential = await getToken(options.paths, options.serverUrl)
  if (!credential) return undefined
  if (!credential.startsWith('gbx_')) return credential
  if (options.mintSocketToken) {
    return options.mintSocketToken(credential)
  }
  const minted = await createGloveboxCliClient({
    baseUrl: options.serverUrl,
    apiKey: credential,
    fetch: options.fetch,
  }).auth.mintWorkspaceSocketToken({ workspaceId: options.workspaceId })
  // Null token = socket auth not configured on the server — connect tokenless.
  return minted.token ?? undefined
}

export default async function run(args: string[], _globals: GlobalFlags): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'rescan-interval': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(`glovebox run [dir] — run the sync daemon for a mount (foreground)

One process per mount, guarded by a mandatory lockfile. The first cycle
adopts the directory (sentinel write; existing files bind to workspace
files by path, unknown paths become creates). Watcher events only hint a
rescan — the jittered rescan loop is the correctness backstop.

Arguments:
  dir                        A mounted directory or any path inside one (default: cwd)

Options:
      --rescan-interval <s>  Periodic full-rescan interval in seconds
                             (default ${1800}, jittered)
  -h, --help                 Show this help message`)
    return
  }

  const rescanIntervalSec = values['rescan-interval']
    ? Number(values['rescan-interval'])
    : undefined
  if (
    rescanIntervalSec !== undefined &&
    (!Number.isFinite(rescanIntervalSec) || rescanIntervalSec <= 0)
  ) {
    printError('--rescan-interval must be a positive number of seconds')
    process.exitCode = 1
    return
  }

  await runRun(positionals[0], { rescanIntervalSec })
}
