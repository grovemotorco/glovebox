import { parseArgs } from 'node:util'
import { createGloveboxCliClient } from '@glovebox.md/api'
import {
  DaemonRunner,
  DaemonSyncEngine,
  NodeDaemonStorage,
  WsDaemonTransport,
  createNodeFS,
  type DaemonSyncWarning,
} from '@glovebox.md/sync/daemon'
import type { GlobalFlags } from '../cli/index.ts'
import type { NextAction } from '../cli/envelope.ts'
import { renderHelp } from '../cli/help.ts'
import { printError, printHint, printWarn } from '../cli/output.ts'
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
    /** Emit newline-delimited JSON events instead of human log lines. */
    json?: boolean
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
  const reporter = createRunReporter(options.json ?? false, {
    dir: mount.dir,
    workspaceId: mount.workspaceId,
    mountId: mount.mountId,
    serverUrl: mount.serverUrl,
  })

  // Surface the most common run-time failure (no/expired token) up front, as
  // a clear hint rather than an opaque "WebSocket connection failed" later.
  const haveCredential = (await getToken(paths, mount.serverUrl)) !== null
  if (!haveCredential) {
    reporter.log(
      'warn',
      `No stored credentials for ${mount.serverUrl} — the server may reject this connection. ` +
        `Sign in: glovebox auth login --server ${mount.serverUrl} --workspace ${mount.workspaceId}`,
    )
  }

  const lock = await acquireLock(paths, mount.mountId)

  let exiting = false
  let teardown: () => Promise<void> = async () => {}
  let runner: DaemonRunner | null = null
  let deleteResolutionKickPending = false
  let runnerStarted = false
  const shutdown = async (code: number, terminal?: TerminalPayload): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    await teardown()
    await lock.release()
    reporter.terminal(code, terminal)
    process.exit(code)
  }
  const requestDeleteResolutionCycle = (): void => {
    deleteResolutionKickPending = true
    // Only kick once the runner is actually RUNNING. Between `runner =
    // createdRunner` and the end of `await createdRunner.start()`, the runner is
    // assigned but still stopped, so `kick()` is a no-op; leaving the flag
    // latched lets the post-start replay below deliver the wake instead of
    // dropping it until the next periodic cycle.
    if (runner === null || !runnerStarted) return
    deleteResolutionKickPending = false
    reporter.log('info', 'delete resolution requested; running a sync cycle')
    void runner.kick()
  }
  const handleSigint = () => void shutdown(0)
  const handleSigterm = () => void shutdown(0)
  const handleSigusr2 = () => requestDeleteResolutionCycle()

  process.on('SIGINT', handleSigint)
  process.on('SIGTERM', handleSigterm)
  process.on('SIGUSR2', handleSigusr2)

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
        reporter.connected()
        hints.poke()
      },
      onAuthRequired: (reason) => {
        reporter.log(
          'error',
          `server rejected credentials (${reason}) — refresh with ` +
            `\`glovebox auth login --server ${mount.serverUrl} --workspace ${mount.workspaceId}\`; retrying with stored token`,
        )
      },
      onStopped: (reason, code) => {
        const message = `server closed this mount: ${reason} (close code ${code})`
        reporter.log('error', message)
        void shutdown(1, {
          message,
          code: 'SERVER_CLOSED',
          fix: 'the workspace may have been revoked or deleted — check `glovebox whoami`',
          nextActions: [
            {
              command: 'glovebox whoami',
              description: 'Check which workspaces this credential can reach',
            },
          ],
        })
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
      onWarning: (warning) => reporter.log('warn', renderDaemonSyncWarning(warning)),
    })

    // The WebSocket layer reports connection failures without a cause
    // (undici's ErrorEvent is empty) — when one shows up, probe the TLS
    // handshake directly ONCE and name the real problem.
    let tlsDiagnosed = false
    const createdRunner = new DaemonRunner({
      engine,
      intervalMs:
        options.rescanIntervalSec !== undefined
          ? options.rescanIntervalSec * 1000
          : overrides.rescanIntervalMs,
      onCycleError: (error) => {
        const message = error instanceof Error ? error.message : String(error)
        reporter.log('error', `sync cycle failed: ${message}`)
        if (!tlsDiagnosed && message.includes('WebSocket connection failed')) {
          tlsDiagnosed = true
          if (!haveCredential) {
            reporter.log(
              'info',
              `Not authenticated — run \`glovebox auth login --server ${mount.serverUrl} --workspace ${mount.workspaceId}\`, then restart.`,
            )
          }
          void diagnoseTlsTrust(mount.serverUrl).then((problem) => {
            if (problem) {
              reporter.log(
                'error',
                `TLS preflight against ${mount.serverUrl}: ${problem.code} — ${problem.message}`,
              )
              if (problem.certTrust) {
                reporter.log('error', TLS_TRUST_HINT)
              }
            }
          })
        }
      },
    })
    runner = createdRunner

    const hints = createHintDebouncer(() => {
      void createdRunner.kick()
    }, overrides.watchDebounceMs ?? 200)
    const watcher = startWatchHints(mount.dir, () => hints.poke())

    teardown = async () => {
      watcher.close()
      hints.cancel()
      createdRunner.stop()
      // Let an in-flight cycle finish its persistence writes — kill -9
      // mid-write is survivable, but a clean stop shouldn't rely on the
      // crash reconcile.
      await createdRunner.settle()
      transport.stop()
    }

    // Emit the start banner before starting the loop so it precedes any
    // first-cycle connection diagnostics.
    reporter.start()
    await createdRunner.start()
    runnerStarted = true
    if (deleteResolutionKickPending) {
      requestDeleteResolutionCycle()
    }
  } catch (error) {
    process.off('SIGINT', handleSigint)
    process.off('SIGTERM', handleSigterm)
    process.off('SIGUSR2', handleSigusr2)
    await teardown()
    await lock.release()
    // Ensure the --json NDJSON stream always ends on a terminal line, even when
    // setup/start throws after the `start` event (else stdout ends on start/log
    // while the failure goes only to stderr). Human mode's terminal() is a
    // no-op, so the rethrow still surfaces the error via the top-level handler.
    reporter.terminal(1, {
      message: error instanceof Error ? error.message : String(error),
      code:
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'RUN_FAILED',
    })
    throw error
  }

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

function renderDaemonSyncWarning(warning: DaemonSyncWarning): string {
  switch (warning.type) {
    case 'file-operation-failed':
      return `sync file failed during ${warning.phase}: ${warning.path} (${warning.fileId ?? 'unknown file'}): ${warning.reason}`
    case 'opaque-submit-failed':
      return `opaque sync failed: ${warning.path} (${warning.fileId}): ${warning.reason}`
    case 'opaque-submit-rejected': {
      const retry =
        warning.retryAfterSec === undefined ? '' : `; retry after ${warning.retryAfterSec}s`
      return `opaque sync rejected: ${warning.path} (${warning.fileId}): ${warning.reason}${retry}`
    }
    case 'delete-intents-held': {
      const shown = warning.paths.slice(0, 5).join(', ')
      const more = warning.paths.length > 5 ? `, +${warning.paths.length - 5} more` : ''
      return `${warning.count} deletion(s) held (${warning.held}): ${shown}${more}. Review with \`glovebox sync deletes\`; release with \`glovebox sync deletes --confirm all\` or restore with \`glovebox sync deletes --restore all\`.`
    }
    case 'delete-resolution-invalid':
      return `dropped an unrecognized delete-resolution command (${warning.name}); re-run \`glovebox sync deletes --confirm <path|all>\` or \`--restore <path|all>\` to retry.`
  }
}

type LogLevel = 'info' | 'warn' | 'error'

interface TerminalPayload {
  message: string
  code: string
  fix?: string
  nextActions?: NextAction[]
}

interface RunReporter {
  start(): void
  connected(): void
  log(level: LogLevel, message: string): void
  /** Final output: a `result` envelope on a clean stop (code 0), else `error`. */
  terminal(code: number, payload?: TerminalPayload): void
}

interface RunContext {
  dir: string
  workspaceId: string
  mountId: string
  serverUrl: string
}

/**
 * Output adapter for the foreground daemon. Human mode keeps the familiar
 * `[glovebox] …` log lines (diagnostics on stderr). JSON mode emits typed,
 * newline-delimited JSON to stdout — one object per line, the LAST line always
 * the standard `result`/`error` envelope, so a tool reading only the final line
 * gets exactly what it expects (the NDJSON-with-HATEOAS-terminal shape).
 */
export function createRunReporter(json: boolean, ctx: RunContext): RunReporter {
  if (!json) {
    return {
      start() {
        console.log(
          `[glovebox] syncing ${ctx.dir} ↔ workspace ${ctx.workspaceId} (mount ${ctx.mountId})`,
        )
        console.log('[glovebox] foreground daemon — Ctrl-C to stop')
      },
      connected() {
        console.log(`[glovebox] connected to ${ctx.serverUrl}`)
      },
      log(level, message) {
        if (level === 'warn') printWarn(message)
        else if (level === 'error') printError(message)
        else printHint(message)
      },
      terminal() {
        // Human mode: the process simply exits; there is no terminal line.
      },
    }
  }

  const emit = (event: Record<string, unknown>): void => {
    console.log(JSON.stringify({ ...event, ts: new Date().toISOString() }))
  }
  return {
    start() {
      emit({
        type: 'start',
        command: 'glovebox run',
        dir: ctx.dir,
        workspaceId: ctx.workspaceId,
        mountId: ctx.mountId,
      })
    },
    connected() {
      emit({ type: 'connected', serverUrl: ctx.serverUrl })
    },
    log(level, message) {
      emit({ type: 'log', level, message })
    },
    terminal(code, payload) {
      if (code === 0) {
        emit({
          type: 'result',
          ok: true,
          command: 'glovebox run',
          result: {
            dir: ctx.dir,
            workspaceId: ctx.workspaceId,
            mountId: ctx.mountId,
            reason: 'stopped',
          },
          nextActions: [
            {
              command: `glovebox status ${ctx.dir}`,
              description: 'Inspect sync status for this mount',
            },
          ],
        })
        return
      }
      emit({
        type: 'error',
        ok: false,
        command: 'glovebox run',
        error: { message: payload?.message ?? 'daemon stopped', code: payload?.code ?? 'STOPPED' },
        ...(payload?.fix ? { fix: payload.fix } : {}),
        nextActions: payload?.nextActions ?? [],
      })
    },
  }
}

/**
 * Parse a human-friendly duration into whole seconds. Accepts a bare number
 * (seconds, the historical form) or a `s`/`m`/`h` suffix. Returns null on a
 * malformed or non-positive value so the caller can report a usage error.
 */
export function parseDurationSeconds(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim())
  if (!match) return null
  const factor = match[2] === 'h' ? 3600 : match[2] === 'm' ? 60 : 1
  const seconds = Number(match[1]) * factor
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

export default async function run(args: string[], globals: GlobalFlags): Promise<void> {
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
    console.log(
      renderHelp({
        name: 'glovebox run',
        summary: 'start syncing a mount (runs in the foreground)',
        usage: 'glovebox run [dir] [options]',
        description:
          'Watches the directory and syncs changes both ways over a live connection\nuntil you stop it (Ctrl-C). Only one `run` per mount at a time.\n\nWith --json, emits newline-delimited JSON events (start/connected/log) and a\nterminal result/error line.',
        args: [['dir', 'A mounted directory or any path inside one (default: cwd)']],
        options: [
          [
            '--rescan-interval <dur>',
            'How often to do a full rescan, e.g. 30m, 1h, or bare seconds (default 30m)',
          ],
        ],
        examples: [
          'glovebox run ./notes',
          'glovebox run',
          'glovebox run ./notes --rescan-interval 10m',
          'glovebox --json run ./notes   # newline-delimited JSON events',
        ],
      }),
    )
    return
  }

  let rescanIntervalSec: number | undefined
  if (values['rescan-interval']) {
    const parsed = parseDurationSeconds(values['rescan-interval'])
    if (parsed === null) {
      printError('--rescan-interval must be a positive duration, e.g. 30m, 1h, or 1800')
      process.exitCode = 1
      return
    }
    rescanIntervalSec = parsed
  }

  // The daemon streams NDJSON only on explicit --json (not auto-on-pipe): a
  // long-running process under a supervisor shouldn't have its log format flip
  // based on TTY. Humans and log scrapers keep the `[glovebox] …` lines.
  await runRun(positionals[0], { rescanIntervalSec, json: globals.json })
}
