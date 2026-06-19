import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { SYNC } from '@glovebox.md/core'
import { LoroFileDoc, versionDominates } from '@glovebox.md/sync'
import { base64ToBytes } from '@glovebox.md/sync/loro'
import {
  DEFAULT_DELETE_POLICY,
  NodeDaemonStorage,
  envelopeName,
  type DaemonWorkspaceState,
} from '@glovebox.md/sync/daemon'
import type { GlobalFlags } from '../cli/index.ts'
import { withNextActions } from '../cli/envelope.ts'
import { renderHelp } from '../cli/help.ts'
import { printJson, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { lockHolderPid } from '../lib/lockfile.ts'
import { parseSyncOverrides } from '../lib/overrides.ts'
import { canonicalizeDir, gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { findMountForDir, loadRegistry } from '../lib/registry.ts'

/**
 * Status reads the persisted state artifact DIRECTLY (plain JSON parse) —
 * never through `DaemonStateStore.load()`, whose reconcile persists
 * repairs. Works with or without a running daemon; artifact writes are
 * atomic, so a mid-cycle read sees a consistent (if slightly stale) pair.
 *
 * The INV-3 stack is the point of this command: a held delete that never
 * propagates is a support case unless the user can SEE why.
 */

export interface DeleteIntentView {
  fileId: string
  path: string
  held: 'bulk-startup' | 'bulk-window' | null
  observedMissingAtMs: number
  /** null while held — a hold never expires by time alone. */
  msUntilPropagation: number | null
}

export interface StatusResult {
  dir: string
  mountId: string
  workspaceId: string
  serverUrl: string
  daemon: { running: boolean; pid: number | null }
  /** False until the first run cycle has persisted daemon state. */
  adopted: boolean
  sentinelPresent: boolean
  /** Sentinel missing on an adopted mount — all delete processing frozen. */
  mountSuspect: boolean
  lastAckedSeq: number | null
  trackedFiles: number | null
  /** Markdown files whose doc version is ahead of the server watermark. */
  pendingPushes: number | null
  pendingRenames: number | null
  deleteIntents: DeleteIntentView[]
}

export async function runStatus(
  target?: string,
  options: { paths?: GloveboxPaths; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<StatusResult> {
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

  const overrides = parseSyncOverrides(env)
  const tombstoneDelayMs = overrides.deletePolicy?.tombstoneDelayMs ?? SYNC.deleteDelayMs
  const sentinelPath = overrides.deletePolicy?.sentinelPath ?? DEFAULT_DELETE_POLICY.sentinelPath

  const pid = await lockHolderPid(paths, mount.mountId)
  const sentinelPresent = await stat(join(mount.dir, sentinelPath)).then(
    () => true,
    () => false,
  )

  const storage = new NodeDaemonStorage(paths.stateDir(mount.mountId))
  const stateBytes = await storage.read('workspace-state.json')
  if (!stateBytes) {
    return {
      dir: mount.dir,
      mountId: mount.mountId,
      workspaceId: mount.workspaceId,
      serverUrl: mount.serverUrl,
      daemon: { running: pid !== null, pid },
      adopted: false,
      sentinelPresent,
      mountSuspect: false,
      lastAckedSeq: null,
      trackedFiles: null,
      pendingPushes: null,
      pendingRenames: null,
      deleteIntents: [],
    }
  }

  const state = JSON.parse(new TextDecoder().decode(stateBytes)) as DaemonWorkspaceState
  const files = Object.entries(state.files ?? {})

  let pendingPushes = 0
  for (const [fileId, fileState] of files) {
    if (fileState.contentKind !== 'markdown') {
      continue
    }
    const envelopeBytes = await storage.read(envelopeName(fileId))
    if (!envelopeBytes) {
      continue // Broken pair — the next daemon start refetches it.
    }
    try {
      const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as {
        snapshotB64: string
        syncedVVB64: string
      }
      const doc = LoroFileDoc.fromSnapshot(base64ToBytes(envelope.snapshotB64))
      const synced = base64ToBytes(envelope.syncedVVB64)
      // Derived pending (INV-6): unacked ops exist iff syncedVV does not
      // dominate the doc's version.
      if (!versionDominates(synced, doc.contentVersion())) {
        pendingPushes += 1
      }
    } catch {
      // Corrupt envelope = broken pair; the daemon repairs it, not status.
    }
  }

  const deleteIntents: DeleteIntentView[] = (state.pendingDeletes ?? []).map((intent) => ({
    fileId: intent.fileId,
    path: intent.path,
    held: intent.held ?? null,
    observedMissingAtMs: intent.observedMissingAtMs,
    msUntilPropagation: intent.held
      ? null
      : Math.max(0, intent.observedMissingAtMs + tombstoneDelayMs - now()),
  }))

  return {
    dir: mount.dir,
    mountId: mount.mountId,
    workspaceId: mount.workspaceId,
    serverUrl: mount.serverUrl,
    daemon: { running: pid !== null, pid },
    adopted: true,
    sentinelPresent,
    mountSuspect: !sentinelPresent,
    lastAckedSeq: state.lastAckedSeq ?? 0,
    trackedFiles: files.length,
    pendingPushes,
    pendingRenames: (state.pendingRenames ?? []).length,
    deleteIntents,
  }
}

function formatStatus(result: StatusResult): void {
  console.log(`${colors.bold}${result.workspaceId}${colors.reset} ← ${result.dir}`)
  console.log(`  Server:    ${result.serverUrl}`)
  console.log(
    `  Daemon:    ${
      result.daemon.running
        ? `${colors.green}running${colors.reset} (pid ${result.daemon.pid})`
        : `${colors.dim}stopped${colors.reset}`
    }`,
  )
  if (!result.adopted) {
    console.log(
      `  State:     ${colors.dim}not adopted yet — \`glovebox run\` performs the first sync${colors.reset}`,
    )
    return
  }
  if (result.mountSuspect) {
    console.log(
      `  Sentinel:  ${colors.red}MISSING — mount suspect; deletes are frozen (INV-3)${colors.reset}`,
    )
  } else {
    console.log(`  Sentinel:  present`)
  }
  console.log(`  Cursor:    seq ${result.lastAckedSeq}`)
  console.log(`  Files:     ${result.trackedFiles} tracked, ${result.pendingPushes} pending push`)
  if (result.pendingRenames! > 0) {
    console.log(`  Renames:   ${result.pendingRenames} pending`)
  }
  if (result.deleteIntents.length === 0) {
    console.log(`  Deletes:   none pending`)
    return
  }
  console.log(`  Deletes:   ${result.deleteIntents.length} intent(s):`)
  for (const intent of result.deleteIntents) {
    if (intent.held) {
      console.log(
        `    ${intent.path} — ${colors.yellow}HELD (${intent.held})${colors.reset}: will never propagate; restore the files or remount to clear`,
      )
    } else {
      const seconds = Math.ceil((intent.msUntilPropagation ?? 0) / 1000)
      console.log(
        `    ${intent.path} — propagates in ${colors.bold}${seconds}s${colors.reset} unless the file reappears`,
      )
    }
  }
}

export default async function status(args: string[], globals: GlobalFlags): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    strict: true,
  })

  if (values.help) {
    console.log(
      renderHelp({
        name: 'glovebox status',
        summary: 'show sync status for a mount',
        usage: 'glovebox status [dir] [options]',
        description:
          'Shows the sync cursor, tracked files, edits waiting to be pushed, and any\npending deletions. Works whether or not the mount is currently running.',
        args: [['dir', 'A mounted directory or any path inside one (default: cwd)']],
        examples: ['glovebox status', 'glovebox status ./notes', 'glovebox --json status ./notes'],
      }),
    )
    return
  }

  const result = await runStatus(positionals[0])
  const mode = resolveOutputMode(globals)
  if (mode === 'json') {
    printJson(
      withNextActions(
        result,
        result.daemon.running
          ? []
          : [
              {
                command: `glovebox run ${result.dir}`,
                description: 'Start the sync daemon for this mount',
              },
            ],
      ),
    )
  } else {
    formatStatus(result)
  }
}
