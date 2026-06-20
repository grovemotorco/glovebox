import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import {
  NodeDaemonStorage,
  STATE_ARTIFACT,
  deleteResolutionName,
  type DaemonWorkspaceState,
  type DeleteResolutionCommand,
  type PendingDelete,
} from '@glovebox.md/sync/daemon'
import type { GlobalFlags } from '../cli/index.ts'
import { withNextActions } from '../cli/envelope.ts'
import { renderHelp } from '../cli/help.ts'
import { printJson, printSuccess, resolveOutputMode, usageError } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import {
  LockHeldError,
  acquireLock,
  isProcessAlive,
  processStartToken,
  readLockRecord,
  type LockRecord,
} from '../lib/lockfile.ts'
import { canonicalizeDir, gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { findMountForDir, loadRegistry } from '../lib/registry.ts'

type DeleteResolutionAction = 'confirm' | 'restore'

export interface SyncDeleteIntentView {
  fileId: string
  path: string
  held: PendingDelete['held'] | null
  observedMissingAtMs: number
}

export interface SyncDeletesResult {
  dir: string
  mountId: string
  workspaceId: string
  serverUrl: string
  daemon: { running: boolean; pid: number | null; signaled: boolean }
  heldDeleteIntents: number
  freeDeleteIntents: number
  deleteIntents: SyncDeleteIntentView[]
  action: null | {
    type: DeleteResolutionAction
    target: string
    matched: number
    paths: string[]
    queued: boolean
  }
}

export async function runSyncDeletes(
  target?: string,
  options: {
    action?: DeleteResolutionAction
    resolutionTarget?: string
    paths?: GloveboxPaths
    env?: NodeJS.ProcessEnv
    now?: () => number
    signalDaemon?: boolean
  } = {},
): Promise<SyncDeletesResult> {
  const env = options.env ?? process.env
  const paths = options.paths ?? gloveboxPaths(env)
  const now = options.now ?? (() => Date.now())
  const dir = await canonicalizeDir(target ?? process.cwd())
  if (!dir) {
    throw new Error(`no such directory: ${target ?? process.cwd()}`)
  }
  const registry = await loadRegistry(paths)
  const mount = findMountForDir(registry, dir)
  if (!mount) {
    throw new Error(`no mount covers ${dir} — run \`glovebox mount\` first`)
  }

  const storage = new NodeDaemonStorage(paths.stateDir(mount.mountId))
  const state = await readWorkspaceState(storage)
  const lockRecord = await readLockRecord(paths, mount.mountId)
  let daemonRecord = liveDaemonRecord(lockRecord)
  let signaled = false

  let actionResult: SyncDeletesResult['action'] = null
  if (options.action) {
    if (!state) {
      throw new Error('this mount has no daemon state yet — run `glovebox run` first')
    }
    const resolutionTarget = options.resolutionTarget
    if (!resolutionTarget) {
      throw new Error(`sync deletes --${options.action} requires <path|all>`)
    }
    const targets = selectHeldDeletes(state.pendingDeletes ?? [], resolutionTarget)
    if (targets.length === 0 && resolutionTarget !== 'all') {
      throw new Error(
        `no held delete matches "${resolutionTarget}" — run \`glovebox sync deletes\` to list held deletes`,
      )
    }
    const resolvedAtMs = now()
    const command: DeleteResolutionCommand = {
      id: randomUUID(),
      action: options.action,
      fileIds: targets.map((intent) => intent.fileId),
      createdAt: resolvedAtMs,
    }
    applyResolutionCommandToState(state, command)
    if (targets.length > 0) {
      await enqueueDeleteResolution(storage, command)
      if (daemonRecord !== null) {
        // A live daemon is the single writer of workspace-state.json; the
        // queued command above is the resolution channel. Writing state here
        // would race the daemon's own whole-file persists and revert its
        // progress, so only signal it to drain the queue.
        if (options.signalDaemon !== false) signaled = signalDaemon(daemonRecord)
      } else {
        // No live daemon owns the state file — persist the projected result
        // so a later `status` reflects it before the next `glovebox run` (the
        // queue is re-applied idempotently when the daemon next starts). Take
        // the mount lock for the write so a concurrently-starting daemon
        // cannot become the state owner between our liveness check and write.
        const wroteState = await writeProjectedStateUnderLock(
          paths,
          mount.mountId,
          storage,
          command,
        )
        if (!wroteState) {
          daemonRecord = liveDaemonRecord(await readLockRecord(paths, mount.mountId))
          if (daemonRecord !== null && options.signalDaemon !== false) {
            signaled = signalDaemon(daemonRecord)
          }
        }
      }
    }
    actionResult = {
      type: options.action,
      target: resolutionTarget,
      matched: targets.length,
      paths: targets.map((intent) => intent.path),
      queued: targets.length > 0,
    }
  }

  const outputState = state ?? null
  const intents = (outputState?.pendingDeletes ?? []).map(
    (intent): SyncDeleteIntentView => ({
      fileId: intent.fileId,
      path: intent.path,
      held: intent.held ?? null,
      observedMissingAtMs: intent.observedMissingAtMs,
    }),
  )

  return {
    dir: mount.dir,
    mountId: mount.mountId,
    workspaceId: mount.workspaceId,
    serverUrl: mount.serverUrl,
    daemon: { running: daemonRecord !== null, pid: daemonRecord?.pid ?? null, signaled },
    heldDeleteIntents: intents.filter((intent) => intent.held !== null).length,
    freeDeleteIntents: intents.filter((intent) => intent.held === null).length,
    deleteIntents: intents,
    action: actionResult,
  }
}

async function readWorkspaceState(
  storage: NodeDaemonStorage,
): Promise<DaemonWorkspaceState | null> {
  const bytes = await storage.read(STATE_ARTIFACT)
  if (bytes === null) return null
  return JSON.parse(new TextDecoder().decode(bytes)) as DaemonWorkspaceState
}

function selectHeldDeletes(deletes: PendingDelete[], target: string): PendingDelete[] {
  const held = deletes.filter((intent) => intent.held !== undefined)
  if (target === 'all') return held
  return held.filter((intent) => intent.path === target || intent.fileId === target)
}

function applyResolutionCommandToState(
  state: DaemonWorkspaceState,
  command: DeleteResolutionCommand,
): void {
  const ids = new Set(command.fileIds)
  if (command.action === 'confirm') {
    for (const intent of state.pendingDeletes ?? []) {
      if (ids.has(intent.fileId)) {
        delete intent.held
        intent.confirmedAtMs = command.createdAt
      }
    }
    return
  }

  state.pendingDeletes = (state.pendingDeletes ?? []).filter((intent) => !ids.has(intent.fileId))
  for (const fileId of ids) {
    const file = state.files[fileId]
    if (!file) continue
    file.lastWrittenHash = ''
    if (file.contentKind === 'opaque') {
      file.opaqueHash = ''
    }
  }
}

async function enqueueDeleteResolution(
  storage: NodeDaemonStorage,
  command: DeleteResolutionCommand,
): Promise<void> {
  // One file per command, named by its unique id: a concurrent `sync deletes`
  // enqueue or the daemon's drain can never overwrite or drop it. There is no
  // shared read-modify-write, so no lock is required.
  await storage.writeAtomic(deleteResolutionName(command.id), encodeJson(command))
}

async function writeProjectedStateUnderLock(
  paths: GloveboxPaths,
  mountId: string,
  storage: NodeDaemonStorage,
  command: DeleteResolutionCommand,
): Promise<boolean> {
  let lock
  try {
    lock = await acquireLock(paths, mountId)
  } catch (error) {
    if (error instanceof LockHeldError) return false
    throw error
  }
  try {
    const state = await readWorkspaceState(storage)
    if (state === null) return true
    applyResolutionCommandToState(state, command)
    await storage.writeAtomic(STATE_ARTIFACT, encodeJson(state))
    return true
  } finally {
    await lock.release()
  }
}

function liveDaemonRecord(record: LockRecord | null): LockRecord | null {
  return record !== null && isCurrentDaemonProcess(record) ? record : null
}

function signalDaemon(
  record: LockRecord,
  startTokenOf: (pid: number) => string | null = processStartToken,
): boolean {
  // PID-reuse guard: SIGUSR2's default disposition is to terminate, so the
  // lock's process-start token must match the currently-live process before
  // we signal it. If identity can't be positively confirmed we do NOT signal
  // — the daemon drains the spool on its next cycle regardless, so a missed
  // wake costs latency, never correctness.
  if (!isCurrentDaemonProcess(record, startTokenOf)) return false
  try {
    process.kill(record.pid, 'SIGUSR2')
    return true
  } catch {
    return false
  }
}

/** True only if the process at record.pid matches the lock's start token. */
export function isCurrentDaemonProcess(
  record: LockRecord,
  startTokenOf: (pid: number) => string | null = processStartToken,
): boolean {
  if (!isProcessAlive(record.pid)) return false
  if (record.processStartToken === undefined) return false
  const current = startTokenOf(record.pid)
  return current !== null && current === record.processStartToken
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function formatDeletes(result: SyncDeletesResult): void {
  if (result.action) {
    const verb = result.action.type === 'confirm' ? 'released' : 'queued restore for'
    printSuccess(`${verb} ${result.action.matched} held delete(s)`)
    if (result.daemon.running && result.daemon.signaled) {
      console.log(`  Daemon:    signaled pid ${result.daemon.pid}`)
    } else if (result.action.queued) {
      console.log(
        `  Daemon:    ${colors.dim}resolution will apply on the next daemon cycle${colors.reset}`,
      )
    }
  }

  console.log(`${colors.bold}${result.workspaceId}${colors.reset} ← ${result.dir}`)
  console.log(
    `  Deletes:   ${result.deleteIntents.length} pending (${result.heldDeleteIntents} held, ${result.freeDeleteIntents} free)`,
  )
  for (const intent of result.deleteIntents) {
    if (intent.held) {
      console.log(`    ${intent.path} — ${colors.yellow}HELD (${intent.held})${colors.reset}`)
    } else {
      console.log(`    ${intent.path} — free pending delete`)
    }
  }
}

async function deletes(args: string[], globals: GlobalFlags): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      list: { type: 'boolean', default: false },
      confirm: { type: 'string' },
      restore: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(
      renderHelp({
        name: 'glovebox sync deletes',
        summary: 'list or resolve pending local deletes',
        usage: [
          'glovebox sync deletes [dir] [--list]',
          'glovebox sync deletes [dir] --confirm <path|all>',
          'glovebox sync deletes [dir] --restore <path|all>',
        ],
        description:
          'Shows pending local delete intents. Held deletes are suspected bulk/startup wipes\nand never propagate until explicitly confirmed or restored.',
        args: [['dir', 'A mounted directory or any path inside one (default: cwd)']],
        options: [
          ['--list', 'List held and free pending deletes (default action)'],
          ['--confirm <path|all>', 'Release held delete(s) so the daemon can propagate them'],
          ['--restore <path|all>', 'Cancel held delete(s) and re-materialize from the server'],
        ],
        examples: [
          'glovebox sync deletes ./notes',
          'glovebox sync deletes ./notes --confirm all',
          'glovebox sync deletes ./notes --restore docs/a.md',
        ],
      }),
    )
    return
  }

  if (positionals.length > 1) {
    return usageError('sync deletes accepts at most one [dir]', 'glovebox sync deletes')
  }
  // `!== undefined`, not truthiness: `--confirm ""` is a provided-but-empty
  // value that must fail loudly with "requires <path|all>", not silently fall
  // through to a plain listing as if no action was requested.
  const wantsConfirm = values.confirm !== undefined
  const wantsRestore = values.restore !== undefined
  if (wantsConfirm && wantsRestore) {
    return usageError('choose only one of --confirm or --restore', 'glovebox sync deletes')
  }
  if (values.list && (wantsConfirm || wantsRestore)) {
    return usageError(
      '--list cannot be combined with --confirm or --restore',
      'glovebox sync deletes',
    )
  }

  const action: DeleteResolutionAction | undefined = wantsConfirm
    ? 'confirm'
    : wantsRestore
      ? 'restore'
      : undefined
  const result = await runSyncDeletes(positionals[0], {
    action,
    resolutionTarget: values.confirm ?? values.restore,
  })

  if (resolveOutputMode(globals) === 'json') {
    printJson(
      withNextActions(
        result,
        result.daemon.running
          ? [{ command: `glovebox status ${result.dir}`, description: 'Inspect updated state' }]
          : [
              {
                command: `glovebox run ${result.dir}`,
                description: 'Start the sync daemon for this mount',
              },
            ],
      ),
    )
    return
  }
  formatDeletes(result)
}

export default async function sync(args: string[], globals: GlobalFlags): Promise<void> {
  const [subcommand, ...rest] = args
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(
      renderHelp({
        name: 'glovebox sync',
        summary: 'inspect and resolve sync internals',
        usage: 'glovebox sync <subcommand> [options]',
        args: [['subcommand', 'deletes']],
        examples: ['glovebox sync deletes', 'glovebox sync deletes --confirm all'],
      }),
    )
    return
  }
  if (subcommand === 'deletes') {
    await deletes(rest, globals)
    return
  }
  return usageError(`unknown sync subcommand: ${subcommand}`, 'glovebox sync')
}
