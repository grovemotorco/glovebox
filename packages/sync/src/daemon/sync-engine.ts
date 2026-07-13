import { SYNC, type OpaqueManifest, type WorkspaceTreeEntry } from '@glovebox.md/core'
import { normalizeEol } from '../fs/eol.ts'
import { isMarkdownFile } from '../fs/file-kind.ts'
import { sha256Hex } from '../fs/hash.ts'
import type { LocalFS } from '../fs/local-fs.ts'
import { base64ToBytes, bytesToBase64 } from '../loro/base64.ts'
import { LoroFileDoc, versionDominates } from '../loro/file-doc.ts'
import {
  LoroRoomClient,
  type SubmitUpdateInput,
  type SubmitUpdateResult,
} from '../loro/room-client.ts'
import type { EventsSinceResult, WireWorkspaceEvent } from '../client/sync-engine.ts'
import type { WorkspaceBatchWireOp } from '../server/workspace-server.ts'
import type { BatchAcceptedOp, BatchDeferredOp } from '../server/workspace-batch-applier.ts'
import { getSuffixedPath } from '../server/workspace-store.ts'
import { scanMount, type DaemonFileView } from './scanner.ts'
import {
  DELETE_RESOLUTION_DIR,
  DaemonStateStore,
  type DeleteResolutionCommand,
  type DaemonStorage,
  type PendingCreate,
  type PendingDelete,
  type PendingRename,
} from './state.ts'

/**
 * V2 daemon content cycle (spec-loro-sync-refactor.md):
 * pull → guarded checkout → scan → push → propagate tree ops → final
 * checkout, against a real directory through `LocalFS`. Push is delegated
 * per file to LoroRoomClient (ack-gated, idempotent retransmission); the
 * engine owns every import so `ImportStatus.pending` triggers snapshot
 * repair BEFORE the durable cursor advances; persistence is the
 * two-artifact DaemonStateStore.
 *
 * Anchoring rule (era-4 / INV-5 data-loss class): pull absorbs a dirty
 * file's disk text into the doc BEFORE importing remote updates. Local ops
 * must anchor at the local base the user actually saw — setTextContent
 * diffing against a post-import doc would emit deletions of the freshly
 * merged remote text and push them as deliberate edits.
 *
 * INV-3 deletion stack: an observed absence only ever becomes an INTENT.
 * Propagation requires, in order: the mount sentinel present this cycle
 * (`.glovebox.json` — a missing sentinel marks the whole mount suspect and
 * freezes all delete processing), no bulk-delete guard hold (startup guard:
 * first scan after boot seeing every tracked file missing; runtime guard:
 * too many absences inside a sliding window), and the tombstone delay
 * elapsed (which subsumes the rename-correction window — any reappearance
 * of the file, at its path or as a scanner-detected rename, cancels the
 * intent first). The server then applies its own stale-baseSeq rejection:
 * a file edited after the intent's baseSeq defers as remote-edit-wins and
 * the daemon resurrects the file instead.
 *
 * Opaque (non-markdown) files are watermark-only views — no Loro client,
 * no envelope. Content flows by derived LWW push (disk hash vs the
 * confirmed watermark; conflicts preserve the server's bytes in the
 * recovery store, INV-2) and by event-carried bytes on pull (guarded
 * writes, INV-5 analog). A rename across the md↔opaque boundary
 * re-derives the view's kind and transitions it in place (ISSUE-0043).
 *
 * Remaining wire-scope notes (ledger): a deferred rename drops the local
 * pending entry (server path wins remotely, local path stays until a
 * remote rename event arrives).
 */

export type BatchSubmitResult =
  | {
      type: 'ack'
      currentSeq: number
      acceptedOps: BatchAcceptedOp[]
      deferredOps: BatchDeferredOp[]
    }
  | { type: 'rejected'; reason: 'rate-limited' | 'forbidden'; retryAfterSec?: number }

export interface SubmitOpaqueInput {
  fileId: string
  observedPath: string
  /** Idempotency key — byte-identical retransmission reuses it. */
  opId: string
  /** Watermark of the version these bytes were based on; '' = expecting to create. */
  baseHashHex: string
  bytes: Uint8Array
}

export type SubmitOpaqueResult =
  | {
      type: 'ack'
      hashHex: string
      sizeBytes: number
      manifest: OpaqueManifest
      conflict: boolean
      /** Canonical row path (suffixed on create collision). */
      path?: string
    }
  | {
      type: 'rejected'
      reason: 'too-large' | 'rate-limited' | 'invalid-path' | 'forbidden'
      retryAfterSec?: number
    }

export interface OpaqueFetchResult {
  found: boolean
  /** 'markdown' = the row is alive but crossed the kind boundary. */
  contentKind?: 'markdown' | 'opaque'
  path?: string
  bytes?: Uint8Array
  hashHex?: string
  sizeBytes?: number
  manifest?: OpaqueManifest
}

export type DaemonFileOperationPhase =
  | 'scan.create'
  | 'scan.opaque-create'
  | 'scan.rename'
  | 'scan.kind'
  | 'scan.content-change'
  | 'push.flush'

type SubmitOpaqueRejectedReason = Extract<SubmitOpaqueResult, { type: 'rejected' }>['reason']

export type DaemonSyncWarning =
  | {
      type: 'file-operation-failed'
      phase: DaemonFileOperationPhase
      fileId?: string
      path: string
      reason: string
    }
  | {
      type: 'opaque-submit-failed'
      fileId: string
      path: string
      reason: string
    }
  | {
      type: 'opaque-submit-rejected'
      fileId: string
      path: string
      reason: SubmitOpaqueRejectedReason
      retryAfterSec?: number
    }
  | {
      type: 'delete-intents-held'
      held: NonNullable<PendingDelete['held']>
      count: number
      paths: string[]
      totalHeld: number
    }
  | {
      type: 'delete-resolution-invalid'
      name: string
    }

export interface DaemonTreeState {
  currentSeq: number
  entries: WorkspaceTreeEntry[]
}

export interface DaemonTransport {
  /** `snapshot.get` — server creates the file when it has no state yet. */
  fetchSnapshot(fileId: string, initialContent?: string, observedPath?: string): Promise<Uint8Array>
  /** `events.since` replay. */
  eventsSince(afterSeq: number): Promise<EventsSinceResult>
  /** `content.submit`, resolved by ack/deferral/rejection. */
  submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult>
  /** `opaque.submit` — LWW byte write, resolved by opaque.ack/rejection. */
  submitOpaque(input: SubmitOpaqueInput): Promise<SubmitOpaqueResult>
  /** `opaque.get` — current opaque bytes for one file (read-only). */
  fetchOpaque(
    fileId: string,
    existingBytes?: Uint8Array,
    options?: { metadataOnly?: boolean },
  ): Promise<OpaqueFetchResult>
  /** `tree.list` — live tree + seq watermark (the adoption surface). */
  listTree(): Promise<DaemonTreeState>
  /** `batch.submit` — structural ops (rename / delete intents). */
  submitBatch(ops: WorkspaceBatchWireOp[]): Promise<BatchSubmitResult>
}

/** INV-3 thresholds; defaults from core `SYNC`, injectable for tests. */
export interface DaemonDeletePolicy {
  tombstoneDelayMs: number
  renameCorrectionWindowMs: number
  bulkWindowMs: number
  bulkMinCount: number
  bulkRatio: number
  bulkRatioFloor: number
  sentinelPath: string
}

export const DEFAULT_DELETE_POLICY: DaemonDeletePolicy = {
  tombstoneDelayMs: SYNC.deleteDelayMs,
  renameCorrectionWindowMs: SYNC.renameCorrectionWindowMs,
  bulkWindowMs: SYNC.runtimeBulkDeleteWindowMs,
  bulkMinCount: SYNC.runtimeBulkDeleteMinCount,
  bulkRatio: SYNC.runtimeBulkDeleteRatio,
  bulkRatioFloor: SYNC.runtimeBulkDeleteRatioFloor,
  sentinelPath: '.glovebox.json',
}

export interface DaemonSyncEngineOptions {
  workspaceId: string
  mountId: string
  deviceId: string
  fs: LocalFS
  storage: DaemonStorage
  transport: DaemonTransport
  deletePolicy?: Partial<DaemonDeletePolicy>
  now?: () => number
  newOpId?: () => string
  newFileId?: () => string
  onWarning?: (warning: DaemonSyncWarning) => void
}

/** Scanner view plus the absorb anchor that travels with the watermark. */
interface EngineFileView extends DaemonFileView {
  /** Doc version materializing the lastWrittenHash bytes (INV-5 anchor). */
  lastWrittenVV: Uint8Array
}

interface DiskFileEntry {
  text: string
  contentHash: string
  sizeBytes: number
  nodeId: string | null
}

export class DaemonSyncEngine {
  readonly #options: DaemonSyncEngineOptions
  readonly #store: DaemonStateStore
  readonly #fs: LocalFS
  readonly #policy: DaemonDeletePolicy
  readonly #views = new Map<string, EngineFileView>()
  readonly #clients = new Map<string, LoroRoomClient>()
  readonly #pendingCreates = new Map<string, PendingCreate>()
  readonly #pendingDeletes = new Map<string, PendingDelete>()
  readonly #pendingRenames = new Map<string, PendingRename>()
  readonly #warnedHeldDeletes = new Set<string>()
  /** Absences adjudicated as remote-edit-wins — checkout re-materializes. */
  readonly #resurrect = new Set<string>()
  /** Files whose submit was deferred with history-pruned — repaired in push. */
  readonly #needsRepair = new Set<string>()
  /**
   * Remote renames (fileId → newPath) that bailed because another tracked
   * view still held the destination (ISSUE-0050 A): never collapse two
   * identities onto one path. Retried each cycle once the holder vacates
   * (it is pushed and server-suffixed, freeing the path). In-memory: a crash
   * mid-bail leaves only a cosmetic path divergence, never a byte swap.
   */
  readonly #renameReconcile = new Map<string, string>()
  /**
   * Opaque submit retransmission state (in-memory): byte-identical retries
   * reuse the opId so the server's idempotency store dedupes; any change to
   * the bytes or the base mints a fresh op.
   */
  readonly #opaqueInFlight = new Map<
    string,
    { opId: string; bytesHash: string; baseHash: string }
  >()
  /** Permanent refusals (too-large / invalid-path) keyed by the refused
   *  bytes' hash — stop resubmitting until the disk bytes change. */
  readonly #opaqueRefused = new Map<string, string>()
  /** Sentinel missing post-adoption: freeze all delete processing (INV-3). */
  #mountSuspect = false
  /** Tree adoption (ISSUE-0044) not yet completed for this state dir. */
  #needsAdoption = false
  #firstScanDone = false
  #cursor = 0
  #started = false
  readonly #now: () => number
  readonly #newOpId: () => string
  readonly #newFileId: () => string

  constructor(options: DaemonSyncEngineOptions) {
    this.#options = options
    this.#fs = options.fs
    this.#policy = { ...DEFAULT_DELETE_POLICY, ...options.deletePolicy }
    if (this.#policy.tombstoneDelayMs < this.#policy.renameCorrectionWindowMs) {
      // The tombstone delay subsumes the rename-correction window: every
      // reappearance before propagation cancels the intent, so the window
      // is only guaranteed while the delay covers it.
      throw new Error('tombstoneDelayMs must be >= renameCorrectionWindowMs')
    }
    this.#store = new DaemonStateStore(options.storage, {
      workspaceId: options.workspaceId,
      mountId: options.mountId,
      deviceId: options.deviceId,
      now: options.now,
    })
    this.#now = options.now ?? (() => Date.now())
    this.#newOpId = options.newOpId ?? (() => crypto.randomUUID())
    this.#newFileId = options.newFileId ?? (() => crypto.randomUUID())
  }

  #warn(warning: DaemonSyncWarning): void {
    this.#options.onWarning?.(warning)
  }

  /**
   * Per-file isolation boundary (ISSUE-0053 A): run one file's scan/push work
   * so a throw degrades to "that file didn't sync this cycle" — logged once
   * with path + reason — instead of aborting every later step of the cycle.
   *
   * The boundary isolates UNCONDITIONALLY: every signal that legitimately
   * aborts the whole cycle and re-pulls — snapshot-required (a value from
   * `eventsSince`, consumed in `#pull`), history-pruned (routed to
   * `#needsRepair`, never thrown), mount-suspect (a flag), adoption, and the
   * `isOpaqueFileRefusal` re-throws in `#adopt`/`#pull` — is raised BEFORE or
   * OUTSIDE these per-file loops, so nothing whole-cycle is ever in scope here
   * to re-raise.
   *
   * Retry semantics (AC-B) depend on where the throw lands. A network/server
   * failure (fetchSnapshot, the transitions' fetch) throws BEFORE any in-memory
   * mutation, so the file's watermark never advances and the next scan re-detects
   * it cleanly. A `#store` persist failure throws AFTER the in-memory view has
   * already rolled (the engine is in-memory-leads-storage everywhere): the bytes
   * still reach the server via the same cycle's flush/#pushOpaque, and the
   * durable watermark catches up on a later successful persist or on restart
   * (reload rebuilds from the last durable state). We deliberately do NOT try to
   * roll the in-memory view back here — undoing a partially-applied op (a doc
   * import, a registered view, a kind flip) cleanly is not generally possible,
   * and a half-rollback is worse than the self-healing lag (see ISSUE-0053).
   */
  async #runFileOp(
    phase: DaemonFileOperationPhase,
    fileId: string | undefined,
    path: string,
    op: () => Promise<void>,
  ): Promise<void> {
    try {
      await op()
    } catch (error) {
      this.#warn({
        type: 'file-operation-failed',
        phase,
        fileId,
        path,
        reason: errorReason(error),
      })
    }
  }

  #warnHeldDeletes(intents: PendingDelete[]): void {
    const fresh = intents.filter((intent) => {
      if (!intent.held) return false
      const key = `${intent.held}:${intent.fileId}`
      if (this.#warnedHeldDeletes.has(key)) return false
      this.#warnedHeldDeletes.add(key)
      return true
    })
    if (fresh.length === 0) return

    const byHold = new Map<NonNullable<PendingDelete['held']>, PendingDelete[]>()
    for (const intent of fresh) {
      if (!intent.held) continue
      const group = byHold.get(intent.held) ?? []
      group.push(intent)
      byHold.set(intent.held, group)
    }
    const totalHeld = [...this.#pendingDeletes.values()].filter((intent) => intent.held).length
    for (const [held, group] of byHold) {
      this.#warn({
        type: 'delete-intents-held',
        held,
        count: group.length,
        paths: group.map((intent) => intent.path),
        totalHeld,
      })
    }
  }

  /** Drop the warn-once dedup keys for a file leaving the held state, so a
   *  genuinely new hold of the SAME file later in this session warns again
   *  (the set is keyed by held-reason + fileId and would otherwise grow
   *  unbounded across delete/restore churn and silently suppress re-warns). */
  #clearHeldWarning(fileId: string): void {
    this.#warnedHeldDeletes.delete(`bulk-startup:${fileId}`)
    this.#warnedHeldDeletes.delete(`bulk-window:${fileId}`)
  }

  async #applyDeleteResolutionCommands(): Promise<void> {
    // Each command is its own file under DELETE_RESOLUTION_DIR. We read the
    // set present NOW; any file the CLI writes after this list() is a brand
    // new name we never saw and is drained next cycle — so there is no
    // shared read-modify-write to race, and no lock is needed. The startsWith
    // guard is defensive: a storage impl that ignores the prefix must never
    // cause us to read/delete envelopes or state as "commands".
    const names = (await this.#options.storage.list(DELETE_RESOLUTION_DIR))
      .filter((name) => name.startsWith(DELETE_RESOLUTION_DIR))
      .sort()
    if (names.length === 0) return

    const commands: { name: string; command: DeleteResolutionCommand }[] = []
    const consumedNames: string[] = []
    for (const name of names) {
      const bytes = await this.#options.storage.read(name)
      if (bytes === null) continue
      let command: DeleteResolutionCommand | null = null
      try {
        command = JSON.parse(new TextDecoder().decode(bytes)) as DeleteResolutionCommand
      } catch {
        command = null
      }
      if (
        !command ||
        !Array.isArray(command.fileIds) ||
        (command.action !== 'confirm' && command.action !== 'restore')
      ) {
        // A corrupt or unrecognized-action command must not wedge the drain —
        // drop it, but SURFACE it. Silently consuming a resolution whose action
        // we can't apply would strand the user's held deletes with no signal
        // that their confirm/restore was lost.
        this.#warn({ type: 'delete-resolution-invalid', name })
        await this.#options.storage.delete(name)
        continue
      }
      commands.push({ name, command })
      consumedNames.push(name)
    }
    commands.sort(
      (a, b) => a.command.createdAt - b.command.createdAt || a.name.localeCompare(b.name),
    )

    const projectedDeletes = new Map(
      [...this.#pendingDeletes].map(([fileId, intent]) => [fileId, { ...intent }]),
    )
    const restored = new Set<string>()
    let pendingChanged = false
    for (const { command } of commands) {
      for (const fileId of command.fileIds) {
        if (command.action === 'confirm') {
          const intent = projectedDeletes.get(fileId)
          if (intent?.held !== undefined) {
            delete intent.held
            intent.confirmedAtMs = command.createdAt
            this.#clearHeldWarning(fileId)
            pendingChanged = true
          }
          continue
        }
        if (command.action === 'restore') {
          // Only an actual pending delete is restorable. Restoring an id that
          // is NOT pending would wipe a live file's watermark and force a
          // resurrect-checkout over it (clobbering unsynced local edits) — a
          // stale/duplicate command must be a no-op, not a data hazard.
          if (projectedDeletes.delete(fileId)) {
            restored.add(fileId)
            pendingChanged = true
          }
        }
      }
    }
    // Persist the applied resolution (surviving deletes + restored-file
    // watermark clears, atomically) BEFORE deleting any command file, so a
    // crash re-applies the commands idempotently instead of dropping them.
    if (pendingChanged) {
      await this.#store.commitDeleteResolutions([...projectedDeletes.values()], restored)
      this.#pendingDeletes.clear()
      for (const [fileId, intent] of projectedDeletes) {
        this.#pendingDeletes.set(fileId, intent)
      }
      for (const fileId of restored) {
        this.#clearHeldWarning(fileId)
        this.#markForRestore(fileId)
      }
    }
    // Delete only the files we read; a command written after our list() keeps
    // its own file and is drained on the next cycle.
    for (const name of consumedNames) {
      await this.#options.storage.delete(name)
    }
  }

  /** In-memory restore authorization; persistence is the caller's atomic
   *  commitDeleteResolutions so the watermark clear can't outrun the intent
   *  removal across a crash. */
  #markForRestore(fileId: string): void {
    const view = this.#views.get(fileId)
    if (!view) return
    view.lastWrittenHash = ''
    this.#resurrect.add(fileId)
  }

  /** Reconcile persisted artifacts and hydrate docs. Does not touch disk. */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true

    const reconciled = await this.#store.load()
    this.#cursor = reconciled.state.lastAckedSeq
    // Fresh state (and pre-adoption legacy state) runs the tree adoption
    // pass first — binding disk files to existing fileIds by path is what
    // keeps a remount from re-creating the whole workspace (ISSUE-0044).
    this.#needsAdoption = reconciled.state.adoptedAt === undefined
    for (const create of reconciled.state.pendingCreates ?? []) {
      this.#pendingCreates.set(create.fileId, create)
    }
    for (const intent of reconciled.state.pendingDeletes) {
      this.#pendingDeletes.set(intent.fileId, intent)
    }
    this.#warnHeldDeletes([...this.#pendingDeletes.values()].filter((intent) => intent.held))
    for (const rename of reconciled.state.pendingRenames) {
      this.#pendingRenames.set(rename.fileId, rename)
    }
    for (const [fileId, fileState] of Object.entries(reconciled.state.files)) {
      this.#views.set(fileId, {
        fileId,
        path: fileState.path,
        contentKind: fileState.contentKind,
        nodeId: fileState.nodeId,
        lastWrittenHash: fileState.lastWrittenHash,
        // Missing anchor (pre-VV state file) degrades to the empty version:
        // absorb then merges as inserts-at-inception — union, never loss.
        lastWrittenVV: base64ToBytes(fileState.lastWrittenVVB64 ?? ''),
        sizeBytes: fileState.sizeBytes,
      })
    }

    for (const ready of reconciled.ready) {
      const client = await this.#attach(ready.fileId, {
        snapshot: ready.snapshot,
        syncedVersion: base64ToBytes(ready.syncedVVB64),
      })
      // A VV anchor citing ops outside the hydrated snapshot (stale state
      // paired with an older envelope) would crash forkAt — degrade to the
      // envelope's synced version: an older anchor can only duplicate
      // concurrent text, never delete it.
      const view = this.#views.get(ready.fileId)
      if (view && !versionDominates(client.getDoc().contentVersion(), view.lastWrittenVV)) {
        view.lastWrittenVV = base64ToBytes(ready.syncedVVB64)
      }
    }
    for (const broken of reconciled.refetch) {
      let snapshot: Uint8Array
      try {
        snapshot = await this.#options.transport.fetchSnapshot(broken.fileId)
      } catch (error) {
        if (!isOpaqueFileRefusal(error)) throw error
        // The row crossed md→opaque while the daemon was down — take the
        // server's path and transition the view; the first cycle's
        // opaque machinery reconciles content.
        const view = this.#views.get(broken.fileId)
        if (view) {
          const fetched = await this.#options.transport.fetchOpaque(broken.fileId).catch(() => null)
          if (fetched?.found && fetched.path) view.path = fetched.path
          await this.#transitionToOpaque(broken.fileId)
        }
        continue
      }
      const doc = LoroFileDoc.fromSnapshot(snapshot)
      await this.#attach(broken.fileId, { snapshot, syncedVersion: doc.contentVersion() })
      // The persisted anchor's lineage is gone with the envelope; re-anchor
      // at the fresh server doc (disk edits diff against server text).
      const view = this.#views.get(broken.fileId)
      if (view) view.lastWrittenVV = doc.contentVersion()
      await this.#persistMarkdown(broken.fileId)
      // Disk may hold an edit made while the pair was broken; the derived
      // guarded checkout refuses to stomp it and scan merges it instead.
    }
  }

  stop(): void {
    for (const client of this.#clients.values()) {
      client.disconnect()
    }
    this.#clients.clear()
    this.#started = false
  }

  /**
   * One full cycle: sentinel check → pull → guarded checkout → scan →
   * tree-op propagation → push → final checkout. Propagation runs BEFORE
   * push: a rename observed together with an edit carries a baseSeq from
   * before our own content submit — pushing first would advance the file's
   * seq past it and defer our own rename as remote-edit-wins. It runs
   * before the final checkout so a remote-edit-wins deferral resurrects
   * within the same cycle.
   */
  async runCycle(): Promise<void> {
    await this.#applyDeleteResolutionCommands()
    await this.#checkSentinel()
    if (this.#needsAdoption) {
      // Must complete before the first scan classifies disk files as
      // creates; a throw aborts the cycle and the next one retries.
      await this.#adopt()
      this.#needsAdoption = false
    }
    await this.#pull()
    await this.#reconcilePendingCreates()
    // A bailed remote rename (ISSUE-0050 A) re-applies once this cycle's
    // pull has relocated the tracked view that held its destination.
    await this.#retryRenameReconcile()
    await this.#checkoutCleanFiles()
    await this.#scan()
    await this.#propagateTreeOps()
    await this.#push()
    await this.#checkoutCleanFiles()
  }

  /** True when the last cycle found the mount sentinel missing. */
  mountSuspect(): boolean {
    return this.#mountSuspect
  }

  /**
   * The sentinel (`.glovebox.json`) witnesses that the directory is still
   * the adopted mount. A fresh mount (no tracked files) gets one written;
   * after adoption, absence means the volume may be gone or foreign —
   * nothing observed there may be treated as a deletion (ISSUE-0031).
   */
  async #checkSentinel(): Promise<void> {
    const present = await this.#fs.exists(this.#policy.sentinelPath).catch(() => false)
    if (present) {
      this.#mountSuspect = false
      return
    }
    if (this.#views.size === 0 && this.#pendingCreates.size === 0) {
      await this.#fs.writeFile(
        this.#policy.sentinelPath,
        `${JSON.stringify(
          {
            workspaceId: this.#options.workspaceId,
            mountId: this.#options.mountId,
            deviceId: this.#options.deviceId,
          },
          null,
          2,
        )}\n`,
      )
      this.#mountSuspect = false
      return
    }
    this.#mountSuspect = true
  }

  /**
   * Tree adoption (ISSUE-0044): bind disk files to the workspace's existing
   * fileIds BY PATH before the first scan can classify them as creates —
   * unmount keeps user files, so a remount must re-bind, not re-create.
   * Server-only files materialize through the resurrect-authorized
   * checkout; divergent text merges as union (INV-2); divergent opaque
   * bytes push LWW with the server copy preserved in the recovery store.
   * Idempotent over already-bound views, so a crash mid-pass (adoptedAt is
   * written LAST) just re-runs it.
   */
  async #adopt(): Promise<void> {
    const tree = await this.#options.transport.listTree()
    const freshMount = this.#views.size === 0
    const ownedPaths = new Set([...this.#views.values()].map((view) => view.path))

    for (const entry of tree.entries) {
      if (entry.tombstone) continue
      if (this.#views.has(entry.fileId)) continue
      // Another tracked file owns this path — the server's path policy
      // already adjudicated (or will); never double-bind a path.
      if (ownedPaths.has(entry.path)) continue
      ownedPaths.add(entry.path)
      await this.#bindTreeEntry(entry)
    }

    if (freshMount && this.#cursor === 0) {
      // Every bind hydrated at-or-past the tree's watermark — the replay
      // before it carries nothing the binds don't already reflect. With
      // pre-existing views the cursor must NOT jump (their unprocessed
      // events would be skipped).
      this.#cursor = tree.currentSeq
      await this.#store.setLastAckedSeq(tree.currentSeq)
    }
    await this.#store.markAdopted()
  }

  /**
   * Bind one server tree entry to whatever sits at its path on disk:
   * matching content binds clean; divergent text merges as union (INV-2);
   * divergent opaque bytes bind with NO confirmed base so the LWW push
   * preserves the server copy in the recovery store while the disk bytes
   * win; an absent disk file binds dirty and resurrect materializes it.
   */
  async #bindTreeEntry(entry: WorkspaceTreeEntry): Promise<void> {
    const disk = await this.#readDisk(entry.path)

    if (entry.contentKind === 'opaque') {
      this.#views.set(entry.fileId, {
        fileId: entry.fileId,
        path: entry.path,
        contentKind: 'opaque',
        nodeId: disk?.nodeId ?? null,
        lastWrittenHash:
          disk !== null && disk.contentHash === entry.contentHash ? disk.contentHash : '',
        lastWrittenVV: new Uint8Array(),
        sizeBytes: disk?.sizeBytes ?? 0,
      })
      if (disk === null) this.#resurrect.add(entry.fileId)
      await this.#persistOpaque(entry.fileId)
      return
    }

    const snapshot = await this.#options.transport.fetchSnapshot(entry.fileId)
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    this.#views.set(entry.fileId, {
      fileId: entry.fileId,
      path: entry.path,
      contentKind: 'markdown',
      nodeId: disk?.nodeId ?? null,
      lastWrittenHash: disk?.contentHash ?? '',
      lastWrittenVV: doc.contentVersion(),
      sizeBytes: disk?.sizeBytes ?? 0,
    })
    const client = await this.#attach(entry.fileId, {
      snapshot,
      syncedVersion: doc.contentVersion(),
    })
    if (disk === null) {
      this.#resurrect.add(entry.fileId)
    } else {
      const text = normalizeEol(disk.text)
      if (client.getTextContent() !== text) {
        // Divergent local copy: merge as inserts-at-inception — union,
        // never deletion of the server's text (INV-2).
        const view = this.#views.get(entry.fileId)!
        view.lastWrittenVV = client.getDoc().applyTextAtBase(new Uint8Array(), text)
      }
    }
    await this.#persistMarkdown(entry.fileId)
  }

  getText(fileId: string): string | null {
    const client = this.#clients.get(fileId)
    return client ? client.getTextContent() : null
  }

  files(): { fileId: string; path: string; contentKind: 'markdown' | 'opaque' }[] {
    return [...this.#views.values()].map((view) => ({
      fileId: view.fileId,
      path: view.path,
      contentKind: view.contentKind,
    }))
  }

  pendingDeletes(): PendingDelete[] {
    return [...this.#pendingDeletes.values()]
  }

  nextWakeMs(now?: number): number | null {
    if (this.#mountSuspect) return null
    const reference = now ?? this.#now()
    let earliest: number | null = null
    for (const intent of this.#pendingDeletes.values()) {
      if (intent.held !== undefined) continue
      const wake = intent.observedMissingAtMs + this.#policy.tombstoneDelayMs
      // Only schedule a wake for a delete that has NOT yet ripened. An
      // already-ripe delete that failed to propagate must not pin the runner
      // to its 1s wake floor (a busy-loop against a down/rate-limiting
      // server); reconnect (onConnect → kick) and the periodic rescan retry
      // it at a sane cadence.
      if (wake <= reference) continue
      if (earliest === null || wake < earliest) earliest = wake
    }
    return earliest
  }

  pendingRenames(): PendingRename[] {
    return [...this.#pendingRenames.values()]
  }

  lastAckedSeq(): number {
    return this.#cursor
  }

  hasPendingChanges(): boolean {
    for (const client of this.#clients.values()) {
      if (client.hasPendingChanges()) return true
    }
    return false
  }

  async #pull(): Promise<void> {
    const result = await this.#options.transport.eventsSince(this.#cursor)
    if (!result.ok) {
      // Cursor predates the replay window: every known file re-snapshots.
      // Local disk edits are absorbed first so the repair re-applies them.
      // Keys are copied first — repair deletes and re-inserts map entries.
      for (const fileId of Array.from(this.#clients.keys())) {
        await this.#absorbDiskIfDirty(fileId)
        try {
          await this.#repairFromSnapshot(fileId)
        } catch (error) {
          if (!isOpaqueFileRefusal(error)) throw error
          // The row crossed md→opaque inside the lost window — apply it
          // as the rename it was (path from the opaque read surface).
          const fetched = await this.#options.transport.fetchOpaque(fileId).catch(() => null)
          const view = this.#views.get(fileId)
          if (view && fetched?.found && fetched.path && fetched.path !== view.path) {
            await this.#applyRemoteRename({
              type: 'rename',
              fileId,
              newPath: fetched.path,
            } as WireWorkspaceEvent)
          } else {
            await this.#transitionToOpaque(fileId)
          }
        }
      }
      // Opaque events carry their bytes inline and are gone with the
      // window — re-poll each opaque view against the server instead.
      await this.#refreshOpaqueFromServer()
      await this.#advanceCursor(result.currentSeq)
      return
    }

    // Events apply strictly in seq order: a delete followed by a re-create
    // of the same path (different fileId) must free the path first, and a
    // create must precede its file's content events.
    const absorbed = new Set<string>()
    for (const event of result.events) {
      switch (event.type) {
        case 'content.loroUpdate': {
          const client = this.#clients.get(event.fileId)
          if (!client || !event.loroUpdateB64) break
          if (!absorbed.has(event.fileId)) {
            absorbed.add(event.fileId)
            await this.#absorbDiskIfDirty(event.fileId)
          }
          const status = client.getDoc().importBatchWithStatus([base64ToBytes(event.loroUpdateB64)])
          if (status.pending) {
            await this.#repairFromSnapshot(event.fileId)
          } else if (status.changed) {
            // A real remote edit cancels a local delete intent:
            // delete-vs-edit defers as remote-edit-wins, so the file
            // resurrects at checkout.
            if (this.#pendingDeletes.has(event.fileId)) {
              await this.#cancelDeleteIntent(event.fileId)
              this.#resurrect.add(event.fileId)
            }
          }
          await this.#persistMarkdown(event.fileId)
          break
        }
        case 'content.opaqueUpdate':
          await this.#applyRemoteOpaqueUpdate(event)
          break
        case 'create':
          await this.#applyRemoteCreate(event)
          break
        case 'rename':
          await this.#applyRemoteRename(event)
          break
        case 'delete':
          await this.#applyRemoteDelete(event)
          break
        default:
          break
      }
    }

    await this.#advanceCursor(result.currentSeq)
  }

  /**
   * Cross-replica file discovery: another replica registered a file. Attach
   * its doc and let checkout materialize it (the resurrect flag authorizes
   * writing a path we have no watermark for yet).
   */
  async #applyRemoteCreate(event: WireWorkspaceEvent): Promise<void> {
    const entry = event.entry as WorkspaceTreeEntry | undefined
    const path = entry?.path ?? event.path
    if (!path) return
    if (this.#mountSuspect) {
      // Pull must not mutate a directory whose mount sentinel is missing.
      // Throwing also prevents cursor advance, so the event is retried once
      // the intended volume returns instead of being durably forgotten.
      throw new Error(`mount sentinel missing; deferred remote create for ${event.fileId}`)
    }
    const existing = this.#views.get(event.fileId)
    if (existing) {
      if (this.#pendingCreates.has(event.fileId)) {
        // A prior attempt attached the view but crashed/failed before the
        // state write that completes the intent. Re-drive that atomic commit.
        if (existing.contentKind === 'markdown' && this.#clients.has(event.fileId)) {
          await this.#persistMarkdown(event.fileId)
        } else if (existing.contentKind === 'opaque') {
          await this.#persistOpaque(event.fileId)
        } else {
          return
        }
      }
      if (existing.path !== path) {
        await this.#applyRemoteRename({
          type: 'rename',
          fileId: event.fileId,
          newPath: path,
        } as WireWorkspaceEvent)
      }
      return
    }
    for (const view of this.#views.values()) {
      if (view.path === path) return // Local file occupies the path; scan owns it.
    }
    const pendingCreate = this.#pendingCreates.get(event.fileId)
    if (pendingCreate) {
      if (entry && (await this.#bindPendingCreateReplay(event, entry, pendingCreate))) return
      // Keep the intent durable until the authoritative view commit. Recovery
      // itself may fetch content and move a collision aside; journaling that
      // phase prevents a second crash from orphaning this already-created row.
      if (!entry) return
      await this.#reconcileAuthoritativePendingCreate(
        pendingCreate,
        entry,
        await this.#readDisk(pendingCreate.path),
      )
      return
    }
    const diskHash = await this.#fs.hash(path).catch(() => null)
    if (diskHash !== null) {
      if (entry && (await this.#diskMatchesEntry(entry, path, diskHash))) {
        // The entry's content already sits at the path: this is our own
        // create replayed after a crash between the server-side create and
        // the local persist (or an identical concurrent create). Re-creating
        // would suffix-duplicate the file — bind by path instead.
        await this.#bindTreeEntry(entry)
        return
      }
      await this.#moveUnknownLocalCollision(path)
    }
    if (entry?.contentKind === 'opaque') {
      this.#views.set(event.fileId, {
        fileId: event.fileId,
        path,
        contentKind: 'opaque',
        nodeId: null,
        lastWrittenHash: '',
        lastWrittenVV: new Uint8Array(),
        sizeBytes: 0,
      })
      // Authorizes the byte write: the content.opaqueUpdate event that
      // follows the create (or the checkout's opaque.get) materializes it.
      this.#resurrect.add(event.fileId)
      await this.#persistOpaque(event.fileId)
      return
    }
    const snapshot = await this.#options.transport.fetchSnapshot(event.fileId)
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    this.#views.set(event.fileId, {
      fileId: event.fileId,
      path,
      contentKind: 'markdown',
      nodeId: null,
      lastWrittenHash: '',
      lastWrittenVV: doc.contentVersion(),
      sizeBytes: 0,
    })
    await this.#attach(event.fileId, { snapshot, syncedVersion: doc.contentVersion() })
    this.#resurrect.add(event.fileId)
    await this.#persistMarkdown(event.fileId)
  }

  /**
   * A create request is side-effecting: the server can durably register the
   * file and broadcast its create just before SIGKILL prevents the daemon
   * from persisting the returned fileId. On restart the path is occupied by
   * the daemon's still-untracked bytes. Treating that as an arbitrary
   * collision suffix-preserves the bytes but severs their identity from the
   * file the daemon just created.
   *
   * The durable LOCAL pending-create record proves identity by fileId, path,
   * kind, and create-base hash. Server event metadata is only the CRDT anchor:
   * its VV must materialize the same create-base hash and remain forkable from
   * the canonical snapshot. A client-controlled origin ID is never treated as
   * authority. Missing, mismatched, invalid, or history-pruned evidence falls
   * back to the conservative unrelated-file suffix policy.
   */
  async #bindPendingCreateReplay(
    event: WireWorkspaceEvent,
    entry: WorkspaceTreeEntry,
    pending: PendingCreate,
  ): Promise<boolean> {
    // A collision phase means recovery already moved (or was about to move)
    // the path occupant. Disk absence is then daemon-authored, not a local
    // delete; finish the journaled isolation through authoritative recovery.
    if (pending.collision) return false
    if (pending.fileId !== event.fileId) return false
    if (pending.contentKind !== 'markdown' || entry.contentKind === 'opaque') return false
    if (pending.baseContentHash !== entry.contentHash) return false
    if (event.contentVersionB64 === undefined) return false

    let createVersion: Uint8Array
    try {
      createVersion = base64ToBytes(event.contentVersionB64)
    } catch {
      return false
    }

    // A transport failure is inconclusive, not evidence of an unrelated
    // collision. Abort this cycle and retry the proof without moving bytes.
    const snapshot = await this.#options.transport.fetchSnapshot(event.fileId)
    let doc: LoroFileDoc
    try {
      doc = LoroFileDoc.fromSnapshot(snapshot)
      if (!versionDominates(doc.contentVersion(), createVersion)) return false
      if (!versionDominates(createVersion, doc.shallowSinceVersion())) return false
      // Dominance proves lineage but not that the server stamped the RIGHT
      // point in that lineage. Materialize the claimed version and match it
      // to the create event's immutable content hash before using it as the
      // disk edit anchor (notably, '' is a valid VV only for an empty create).
      if (sha256Hex(doc.getTextContentAtVersion(createVersion)) !== entry.contentHash) return false
    } catch {
      return false
    }

    const disk = await this.#readDisk(entry.path)
    if (
      entry.path !== pending.path &&
      (disk === null ||
        pending.nodeId === null ||
        disk.nodeId === null ||
        pending.nodeId !== disk.nodeId)
    ) {
      // Server collision resolution can suffix this create after an earlier
      // remote event moved the still-untracked inode to that same suffix.
      // Only the exact journaled inode authorizes following the canonical
      // path; absence or path-only equality remains unrelated.
      return false
    }
    if (
      disk !== null &&
      (pending.nodeId === null || disk.nodeId === null || pending.nodeId !== disk.nodeId)
    ) {
      // The original path was atomically replaced after staging. Preserve the
      // replacement as an unrelated collision; only the journaled inode can
      // carry dirty same-file bytes back into this identity.
      return false
    }
    this.#views.set(event.fileId, {
      fileId: event.fileId,
      path: entry.path,
      contentKind: 'markdown',
      nodeId: disk?.nodeId ?? pending.nodeId,
      // The create event's entry is the materialization at createVersion.
      // A mismatch is the unseen post-create disk edit; guarded checkout
      // leaves it alone and scan absorbs it at createVersion.
      lastWrittenHash: pending.contentHash,
      lastWrittenVV: createVersion,
      sizeBytes: pending.sizeBytes,
    })
    await this.#attach(event.fileId, {
      snapshot,
      syncedVersion: doc.contentVersion(),
    })
    // Envelope + view entry + intent removal use one state commit. A crash
    // before it leaves the intent retryable; a crash after it leaves a fully
    // bound view and no orphan intent.
    await this.#persistMarkdown(event.fileId)
    return true
  }

  async #recordPendingCreate(create: PendingCreate): Promise<void> {
    await this.#setPendingCreate(create)
  }

  async #setPendingCreate(create: PendingCreate): Promise<void> {
    const projected = [
      ...[...this.#pendingCreates.values()].filter((pending) => pending.fileId !== create.fileId),
      create,
    ]
    await this.#store.setPendingCreates(projected)
    this.#pendingCreates.set(create.fileId, create)
  }

  async #discardPendingCreate(fileId: string): Promise<void> {
    if (!this.#pendingCreates.has(fileId)) return
    const projected = [...this.#pendingCreates.values()].filter(
      (pending) => pending.fileId !== fileId,
    )
    await this.#store.setPendingCreates(projected)
    this.#pendingCreates.delete(fileId)
  }

  #pendingCreateAtPath(path: string): PendingCreate | undefined {
    return [...this.#pendingCreates.values()].find((pending) => pending.path === path)
  }

  /**
   * Resolve every durable create intent that pull could not match to an
   * event. A create event may have fallen out of the replay window even
   * though snapshot.get already registered the row, while a request that
   * failed before its server effect has no row at all. One authoritative
   * tree read distinguishes those outcomes without trusting the path alone.
   *
   * Same-path/same-inode rows defer to scan, which can compare the staged
   * base with the fetched canonical snapshot and absorb a dirty edit at the
   * exact base. Every divergent case is reconciled immediately so an old
   * server row can never become permanently untracked.
   */
  async #reconcilePendingCreates(): Promise<void> {
    // A missing sentinel may mean the mounted volume disappeared. Do not
    // classify its now-absent staged inode or mutate the durable intent until
    // the mount identity is present again (same freeze as delete detection).
    if (this.#mountSuspect) return
    for (const pending of this.#pendingCreates.values()) {
      const view = this.#views.get(pending.fileId)
      if (!view) continue
      // An earlier recovery may have built the in-memory view but failed its
      // final state write. Re-drive that atomic completion even when the
      // create event was pruned and will not trigger #applyRemoteCreate again.
      if (view.contentKind === 'opaque') {
        await this.#persistOpaque(pending.fileId)
      } else if (this.#clients.has(pending.fileId)) {
        await this.#persistMarkdown(pending.fileId)
      }
    }
    const unresolved = [...this.#pendingCreates.values()].filter(
      (pending) => !this.#views.has(pending.fileId),
    )
    if (unresolved.length === 0) return

    const tree = await this.#options.transport.listTree()
    const entries = new Map(
      tree.entries
        .filter((entry) => !entry.tombstone)
        .map((entry) => [entry.fileId, entry] as const),
    )
    for (const pending of unresolved) {
      const disk = await this.#readDisk(pending.path)
      const entry = entries.get(pending.fileId)
      if (!entry) {
        // No server row proves that snapshot.get never took effect. Retain a
        // still-present staged inode for scan to retry with the same fileId;
        // retire an absent/replaced intent so the replacement can mint one.
        if (
          disk === null ||
          pending.nodeId === null ||
          disk.nodeId === null ||
          pending.nodeId !== disk.nodeId
        ) {
          await this.#discardPendingCreate(pending.fileId)
        }
        continue
      }

      const sameStagedFile =
        pending.collision === undefined &&
        entry.path === pending.path &&
        entry.contentKind !== 'opaque' &&
        disk !== null &&
        pending.nodeId !== null &&
        disk.nodeId !== null &&
        pending.nodeId === disk.nodeId
      const diskStillStagedBase =
        disk !== null &&
        (disk.contentHash === pending.contentHash ||
          sha256Hex(normalizeEol(disk.text)) === pending.baseContentHash)
      // Dirty bytes on the same inode need scan's exact create-base merge.
      // Unchanged staged bytes can be reconciled here even when canonical has
      // advanced and the create event/VV was pruned, avoiding a needless
      // duplicate suffix for a file with no unseen local edit.
      if (sameStagedFile && !diskStillStagedBase) continue

      await this.#reconcileAuthoritativePendingCreate(pending, entry, disk)
    }
  }

  /**
   * Reconcile a server row whose create event is unavailable and whose local
   * staged inode cannot safely be rebound by scan. An absent staged file is
   * attached with a nonempty watermark so normal delete-intent semantics run;
   * occupied/divergent paths reuse remote-create collision isolation.
   */
  async #reconcileAuthoritativePendingCreate(
    pending: PendingCreate,
    entry: WorkspaceTreeEntry,
    pendingDisk: DiskFileEntry | null,
  ): Promise<void> {
    let currentPending = this.#pendingCreates.get(pending.fileId) ?? pending
    let authoritativeDisk =
      entry.path === pending.path ? pendingDisk : await this.#readDisk(entry.path)

    let snapshot: Uint8Array | undefined
    let doc: LoroFileDoc | undefined
    if (entry.contentKind !== 'opaque') {
      // Fetch before any disk move. A transport failure leaves both the
      // occupant and durable intent untouched, so retry is side-effect free.
      snapshot = await this.#options.transport.fetchSnapshot(pending.fileId)
      doc = LoroFileDoc.fromSnapshot(snapshot)
      // The fetch is an unbounded race window. All canonical/base decisions
      // below must use a fresh disk observation; a user edit that landed while
      // awaiting the network is divergent data and goes through journaled
      // suffix isolation, never a stale guarded-checkout anchor.
      pendingDisk = await this.#readDisk(pending.path)
      authoritativeDisk =
        entry.path === pending.path ? pendingDisk : await this.#readDisk(entry.path)
      const canonicalHash = sha256Hex(doc.getTextContent())
      const diskNormalizedHash =
        authoritativeDisk === null ? null : sha256Hex(normalizeEol(authoritativeDisk.text))

      // Recovery may have written canonical bytes before crashing on the
      // state commit. Content equality is sufficient to finish that clean
      // bind even when atomic replacement changed the inode.
      if (
        authoritativeDisk !== null &&
        (authoritativeDisk.contentHash === canonicalHash || diskNormalizedHash === canonicalHash)
      ) {
        this.#views.set(pending.fileId, {
          fileId: pending.fileId,
          path: entry.path,
          contentKind: 'markdown',
          nodeId: authoritativeDisk.nodeId,
          lastWrittenHash: authoritativeDisk.contentHash,
          lastWrittenVV: doc.contentVersion(),
          sizeBytes: authoritativeDisk.sizeBytes,
        })
        await this.#attach(pending.fileId, {
          snapshot,
          syncedVersion: doc.contentVersion(),
        })
        await this.#persistMarkdown(pending.fileId)
        return
      }

      const sameStagedInode =
        entry.path === pending.path &&
        authoritativeDisk !== null &&
        pending.nodeId !== null &&
        authoritativeDisk.nodeId !== null &&
        pending.nodeId === authoritativeDisk.nodeId
      const diskStillStagedBase =
        authoritativeDisk !== null &&
        (authoritativeDisk.contentHash === pending.contentHash ||
          diskNormalizedHash === pending.baseContentHash)
      if (sameStagedInode && diskStillStagedBase) {
        const stagedDisk = authoritativeDisk!
        this.#views.set(pending.fileId, {
          fileId: pending.fileId,
          path: entry.path,
          contentKind: 'markdown',
          nodeId: stagedDisk.nodeId,
          lastWrittenHash: stagedDisk.contentHash,
          // If canonical advanced but the create VV was unavailable, never
          // claim the stale disk included those remote ops. We immediately
          // replace the proven-unchanged base with canonical bytes below.
          lastWrittenVV:
            canonicalHash === pending.baseContentHash
              ? doc.contentVersion()
              : doc.shallowSinceVersion(),
          sizeBytes: stagedDisk.sizeBytes,
        })
        await this.#attach(pending.fileId, {
          snapshot,
          syncedVersion: doc.contentVersion(),
        })
        // Persist before checkout and let the normal guarded checkout re-read
        // disk. If a user edits during fetch, its hash no longer matches this
        // staged watermark and scan preserves it from the conservative floor;
        // unchanged bytes are replaced with canonical content normally.
        await this.#persistMarkdown(pending.fileId)
        return
      }
    }

    // A previously staged isolation is authoritative evidence that an absent
    // source was moved by this recovery, not deleted by the user. Complete it
    // before considering normal absent-file semantics.
    if (currentPending.collision) {
      currentPending = await this.#isolatePendingCreateCollision(currentPending, entry.path)
      authoritativeDisk = await this.#readDisk(entry.path)
    }

    if (pendingDisk === null && authoritativeDisk === null && !currentPending.collision) {
      if (entry.contentKind === 'opaque') {
        this.#views.set(pending.fileId, {
          fileId: pending.fileId,
          path: entry.path,
          contentKind: 'opaque',
          nodeId: null,
          lastWrittenHash: pending.contentHash,
          lastWrittenVV: new Uint8Array(),
          sizeBytes: pending.sizeBytes,
        })
        await this.#persistOpaque(pending.fileId)
        return
      }
      const markdownDoc = doc!
      const anchor =
        sha256Hex(markdownDoc.getTextContent()) === pending.baseContentHash
          ? markdownDoc.contentVersion()
          : markdownDoc.shallowSinceVersion()
      this.#views.set(pending.fileId, {
        fileId: pending.fileId,
        path: entry.path,
        contentKind: 'markdown',
        nodeId: null,
        // Nonempty even for an initially empty file (SHA-256 of empty bytes):
        // checkout classifies absence as a local delete, never materializes it.
        lastWrittenHash: pending.contentHash,
        lastWrittenVV: anchor,
        sizeBytes: pending.sizeBytes,
      })
      await this.#attach(pending.fileId, {
        snapshot: snapshot!,
        syncedVersion: markdownDoc.contentVersion(),
      })
      await this.#persistMarkdown(pending.fileId)
      return
    }

    // A divergent occupant is unrelated to the staged inode. Journal its
    // exact suffix destination before the atomic move; the marker remains
    // until persist{Markdown,Opaque} commits the authoritative view.
    if (authoritativeDisk !== null) {
      currentPending = await this.#isolatePendingCreateCollision(currentPending, entry.path)
    }

    if (entry.contentKind === 'opaque') {
      this.#views.set(pending.fileId, {
        fileId: pending.fileId,
        path: entry.path,
        contentKind: 'opaque',
        nodeId: null,
        lastWrittenHash: '',
        lastWrittenVV: new Uint8Array(),
        sizeBytes: 0,
      })
      this.#resurrect.add(pending.fileId)
      await this.#persistOpaque(pending.fileId)
      return
    }

    const markdownDoc = doc!
    this.#views.set(pending.fileId, {
      fileId: pending.fileId,
      path: entry.path,
      contentKind: 'markdown',
      nodeId: null,
      lastWrittenHash: '',
      lastWrittenVV: markdownDoc.contentVersion(),
      sizeBytes: 0,
    })
    await this.#attach(pending.fileId, {
      snapshot: snapshot!,
      syncedVersion: markdownDoc.contentVersion(),
    })
    this.#resurrect.add(pending.fileId)
    await this.#persistMarkdown(pending.fileId)
  }

  async #isolatePendingCreateCollision(
    pending: PendingCreate,
    path: string,
  ): Promise<PendingCreate> {
    let current = pending
    for (;;) {
      const source = await this.#readDisk(path)
      const collision = current.collision
      if (collision) {
        const isolated = await this.#readDisk(collision.isolatedPath)
        const matches = (disk: DiskFileEntry | null): boolean =>
          disk !== null &&
          disk.contentHash === collision.contentHash &&
          (collision.nodeId === null || disk.nodeId === null || disk.nodeId === collision.nodeId)
        if (matches(isolated) && source === null) return current
        if (matches(source) && isolated === null) {
          await this.#fs.move(path, collision.isolatedPath)
          return current
        }
        // The recorded occupant was already isolated but a new file appeared
        // at the source, or either endpoint changed externally. Preserve the
        // current source through a fresh durable phase instead of moving an
        // unverified inode under the old record.
        if (source === null) return current
      } else if (source === null) {
        return current
      }

      const isolatedPath = await this.#nextLocalSuffixPath(path)
      current = {
        ...current,
        collision: {
          path,
          isolatedPath,
          contentHash: source!.contentHash,
          nodeId: source!.nodeId,
          sizeBytes: source!.sizeBytes,
        },
      }
      await this.#setPendingCreate(current)
    }
  }

  /**
   * Do the bytes at `path` already hold the server entry's content? Exact
   * for opaque (raw disk bytes). For markdown the server's `contentHash` is
   * over `normalizeEol`-d (LF) text (workspace-store), so a CRLF working
   * copy fails the raw-hash compare and must be normalized first — otherwise
   * the adopt-by-hash bind never fires for CRLF files and they
   * suffix-duplicate (ISSUE-0050 C, defeating ISSUE-0047 C for CRLF).
   */
  async #diskMatchesEntry(
    entry: WorkspaceTreeEntry,
    path: string,
    diskHash: string,
  ): Promise<boolean> {
    if (entry.contentHash === diskHash) return true
    if (entry.contentKind === 'opaque') return false
    const text = await this.#fs.readFile(path).catch(() => null)
    if (text === null) return false
    return sha256Hex(normalizeEol(text)) === entry.contentHash
  }

  /**
   * Relocate an unrelated local file occupying a path we need, preserving
   * its bytes at a free suffix (INV-2). One atomic move (ISSUE-0050 B):
   * never read→write-suffix→delete, where a crash between the write and the
   * delete leaves BOTH copies — the untracked leftover then re-registers as
   * a propagated duplicate (triplicate after re-pull), never self-healing.
   */
  async #moveUnknownLocalCollision(path: string): Promise<void> {
    await this.#fs.move(path, await this.#nextLocalSuffixPath(path))
  }

  async #nextLocalSuffixPath(path: string): Promise<string> {
    for (let suffix = 2; ; suffix += 1) {
      const candidate = getSuffixedPath(path, suffix)
      if ([...this.#views.values()].some((view) => view.path === candidate)) continue
      if ((await this.#fs.hash(candidate).catch(() => null)) !== null) continue
      return candidate
    }
  }

  /**
   * Make `newPath` safe to repoint a view onto, BEFORE any `view.path` write
   * (ISSUE-0050 A). Returns false — the caller bails, leaving the view at
   * its old path — when ANOTHER tracked view already owns `newPath`: two
   * identities must never collapse onto one path (`scanMount` would key both
   * by the same path, see the loser as missing → delete-intent → silent
   * content loss). Otherwise it frees the path and returns true: an
   * unrelated untracked local file there is unseen user data, relocated to a
   * suffix (INV-2) exactly as #applyRemoteCreate handles an occupied create
   * target; a free path, or one already holding this view's own bytes (a
   * crash-replayed move / echo), is left untouched.
   */
  async #clearRenameDestination(view: EngineFileView, newPath: string): Promise<boolean> {
    for (const other of this.#views.values()) {
      if (other !== view && other.path === newPath) return false
    }
    const destHash = await this.#fs.hash(newPath).catch(() => null)
    if (destHash === null || destHash === view.lastWrittenHash) return true
    await this.#moveUnknownLocalCollision(newPath)
    return true
  }

  /**
   * Re-attempt remote renames that bailed because their destination was held
   * by another tracked view (ISSUE-0050 A). The holder vacates once it is
   * pushed and the server suffixes its create (the `create` broadcast
   * re-enters as a rename and relocates it), freeing the path for this
   * retry; a still-held destination re-arms the entry, an absent/already-
   * moved view drops it.
   */
  async #retryRenameReconcile(): Promise<void> {
    if (this.#renameReconcile.size === 0) return
    for (const [fileId, newPath] of Array.from(this.#renameReconcile)) {
      this.#renameReconcile.delete(fileId)
      const view = this.#views.get(fileId)
      if (!view || view.path === newPath) continue
      await this.#applyRemoteRename({ type: 'rename', fileId, newPath } as WireWorkspaceEvent)
    }
  }

  /**
   * A remote replica's accepted rename: move the local view and disk file,
   * re-deriving the content kind when the path crossed the md↔opaque
   * boundary (ISSUE-0043). The destination is cleared first
   * (#clearRenameDestination) so the view is never repointed onto unrelated
   * local bytes — an unconditional repoint there folds foreign bytes into
   * this fileId's doc and swaps content server-side (ISSUE-0050 A).
   */
  async #applyRemoteRename(event: WireWorkspaceEvent): Promise<void> {
    const view = this.#views.get(event.fileId)
    if (!view || !event.newPath) return
    if (view.path === event.newPath) {
      this.#renameReconcile.delete(event.fileId)
      return // Our own rename echoing back.
    }
    const newPath = event.newPath
    const newKind = isMarkdownFile(newPath) ? 'markdown' : 'opaque'

    if (view.contentKind === 'opaque') {
      // The opaque watermark is the disk-byte hash, so the same clean-bytes
      // test recognizes an already-moved / echoed destination as ours.
      const oldPath = view.path
      const diskHash = await this.#fs.hash(oldPath).catch(() => null)
      if (!(await this.#clearRenameDestination(view, newPath))) {
        this.#renameReconcile.set(event.fileId, newPath)
        return
      }
      this.#renameReconcile.delete(event.fileId)
      view.path = newPath
      // Move the disk bytes only when they are exactly ours (INV-5 analog);
      // a dirty or absent file keeps the user's state at the old path. The
      // destination is provably free-or-ours now, so no occupancy guard.
      if (diskHash !== null && diskHash === view.lastWrittenHash) {
        const bytes = await this.#fs.readFileBytes(oldPath).catch(() => null)
        if (bytes !== null) {
          const writtenHash = await this.#fs.writeFileBytes(newPath, bytes)
          await this.#fs.deletePath(oldPath)
          const stat = await this.#fs.stat(newPath)
          Object.assign(view, {
            lastWrittenHash: writtenHash,
            sizeBytes: bytes.byteLength,
            nodeId: stat?.nodeId ?? view.nodeId,
          })
        }
      }
      if (newKind === 'markdown') {
        await this.#transitionToMarkdown(event.fileId)
        return
      }
      await this.#persistOpaque(event.fileId)
      return
    }

    const client = this.#clients.get(event.fileId)
    // An unseen local edit at the old path is absorbed (anchored) before
    // the move so the rename can never discard it (INV-2). It runs on the
    // old path, before #clearRenameDestination touches the destination.
    await this.#absorbDiskIfDirty(event.fileId)
    const oldPath = view.path
    const diskHash = await this.#fs.hash(oldPath).catch(() => null)
    if (!(await this.#clearRenameDestination(view, newPath))) {
      this.#renameReconcile.set(event.fileId, newPath)
      return
    }
    this.#renameReconcile.delete(event.fileId)
    view.path = newPath
    if (client && diskHash !== null && diskHash === view.lastWrittenHash) {
      const text = client.getTextContent()
      const writtenHash = await this.#fs.writeFile(newPath, text)
      await this.#fs.deletePath(oldPath)
      const stat = await this.#fs.stat(newPath)
      Object.assign(view, {
        lastWrittenHash: writtenHash,
        lastWrittenVV: client.getDoc().contentVersion(),
        sizeBytes: new TextEncoder().encode(text).byteLength,
        nodeId: stat?.nodeId ?? view.nodeId,
      })
    }
    if (newKind === 'opaque') {
      await this.#transitionToOpaque(event.fileId)
      return
    }
    await this.#persistMarkdown(event.fileId)
  }

  /**
   * md→opaque view transition (kind-boundary rename): detach the Loro
   * client, drop the envelope, persist watermark-only. The watermark KEEPS
   * its value — for a clean file it equals the server row's content hash
   * after its own kind transition, so the next opaque push names a
   * truthful LWW base; any unflushed text ops are covered by the disk
   * bytes the opaque push reads (content converges through LWW instead).
   */
  async #transitionToOpaque(fileId: string): Promise<void> {
    const view = this.#views.get(fileId)
    if (!view) return
    const client = this.#clients.get(fileId)
    if (client?.hasPendingChanges()) {
      // Unacked text ops cannot flow once the client detaches, and the
      // absorbed watermark would make the opaque push read the disk as
      // clean — strand the edit nowhere (INV-2): clear the base so the
      // push submits the full disk bytes; the server preserves its copy
      // as the conflict loser and the bytes (which include the edit) win.
      view.lastWrittenHash = ''
    }
    client?.disconnect()
    this.#clients.delete(fileId)
    this.#needsRepair.delete(fileId)
    view.contentKind = 'opaque'
    view.lastWrittenVV = new Uint8Array()
    await this.#persistOpaque(fileId)
    await this.#store.dropEnvelope(fileId)
  }

  /**
   * opaque→md view transition: markdown adoption of the existing fileId.
   * Disk bytes (decoded per the new extension) seed the server doc when it
   * has none — snapshot.get falls back to the row's materialized text, so
   * DEFAULT placeholder markdown is never fabricated — and a divergent
   * existing doc merges the disk text as inserts-at-inception (INV-2
   * union). With no disk file, resurrect authorizes the checkout write.
   */
  async #transitionToMarkdown(fileId: string): Promise<void> {
    const view = this.#views.get(fileId)
    if (!view) return
    this.#opaqueInFlight.delete(fileId)
    this.#opaqueRefused.delete(fileId)
    const disk = await this.#readDisk(view.path)
    const text = disk === null ? null : normalizeEol(disk.text)
    const snapshot = await this.#options.transport.fetchSnapshot(
      fileId,
      text ?? undefined,
      view.path,
    )
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    view.contentKind = 'markdown'
    view.nodeId = disk?.nodeId ?? view.nodeId
    view.lastWrittenHash = disk?.contentHash ?? ''
    view.lastWrittenVV = doc.contentVersion()
    view.sizeBytes = disk?.sizeBytes ?? 0
    const client = await this.#attach(fileId, { snapshot, syncedVersion: doc.contentVersion() })
    if (text === null) {
      this.#resurrect.add(fileId)
    } else if (client.getTextContent() !== text) {
      view.lastWrittenVV = client.getDoc().applyTextAtBase(new Uint8Array(), text)
    }
    await this.#persistMarkdown(fileId)
  }

  /**
   * A remote replica's accepted delete. Local unacked work wins over it
   * (INV-2): the file is re-created server-side under the same fileId.
   * Otherwise the delete stands — the disk file is removed only when its
   * bytes are exactly the ones we last wrote (guarded, INV-5 analog).
   */
  async #applyRemoteDelete(event: WireWorkspaceEvent): Promise<void> {
    const view = this.#views.get(event.fileId)
    if (!view) return
    const client = this.#clients.get(event.fileId)
    if (client) {
      await this.#absorbDiskIfDirty(event.fileId)
      if (client.hasPendingChanges()) {
        await this.#resurrectOnServer(event.fileId)
        return
      }
    }
    const diskHash = await this.#fs.hash(view.path).catch(() => null)
    if (view.contentKind === 'opaque' && diskHash !== null && diskHash !== view.lastWrittenHash) {
      // Local unpushed bytes survive a remote delete (INV-2): forget the
      // server watermark so the next push re-creates the file under the
      // same fileId (createOpaqueFile clears the tombstone).
      view.lastWrittenHash = ''
      this.#opaqueInFlight.delete(event.fileId)
      await this.#persistOpaque(event.fileId)
      return
    }
    if (diskHash !== null && diskHash === view.lastWrittenHash) {
      await this.#fs.deletePath(view.path)
    }
    await this.#finalizeDelete(event.fileId)
  }

  /**
   * Remote opaque bytes (hash event + object fetch). Guarded write (INV-5 analog):
   * only over bytes we wrote/confirmed, or onto an adjudicated absence
   * (canceled delete intent / resurrect authorization). A dirty disk keeps
   * the user's bytes — the next push submits them with a now-stale base,
   * the server preserves these remote bytes as the recovery loser, and
   * LWW converges (INV-2 held server-side).
   */
  async #applyRemoteOpaqueUpdate(event: WireWorkspaceEvent): Promise<void> {
    const view = this.#views.get(event.fileId)
    if (!view || view.contentKind !== 'opaque' || event.hashHex === undefined) return
    const newHash = event.hashHex
    if (newHash === view.lastWrittenHash) return // Our own echo / already confirmed.
    const diskHash = await this.#fs.hash(view.path).catch(() => null)
    if (diskHash === newHash) {
      // Disk already holds these bytes — roll the watermark only.
      view.lastWrittenHash = newHash
      view.sizeBytes = event.sizeBytes ?? view.sizeBytes
      await this.#persistOpaque(event.fileId)
      return
    }
    if (this.#mountSuspect) return // Never write into a possibly-foreign directory.
    if (diskHash === null) {
      if (this.#pendingDeletes.has(event.fileId)) {
        // A real remote edit cancels the intent (delete-vs-edit, INV-3).
        await this.#cancelDeleteIntent(event.fileId)
      } else if (!this.#resurrect.has(event.fileId) && view.lastWrittenHash !== '') {
        return // Unadjudicated absence — the INV-3 machinery owns it.
      }
      this.#resurrect.delete(event.fileId)
      const fetched = await this.#options.transport.fetchOpaque(event.fileId).catch(() => null)
      if (!fetched?.bytes || fetched.hashHex !== newHash) return
      const bytes = fetched.bytes
      await this.#writeOpaqueCheckout(event.fileId, view, bytes)
      return
    }
    if (diskHash !== view.lastWrittenHash) return // Dirty — push adjudicates by LWW.
    const existingBytes = await this.#fs.readFileBytes(view.path).catch(() => undefined)
    const fetched = await this.#options.transport
      .fetchOpaque(event.fileId, existingBytes)
      .catch(() => null)
    if (!fetched?.bytes || fetched.hashHex !== newHash) return
    const bytes = fetched.bytes
    await this.#writeOpaqueCheckout(event.fileId, view, bytes)
  }

  /**
   * Replay-window miss recovery for opaque views: the events that carried
   * the bytes are gone, so re-poll each view against the server. A file
   * missing server-side was deleted while we were behind — guarded local
   * delete (INV-5 analog) unless local bytes are unpushed (INV-2: forget
   * the watermark, push re-creates). Views never pushed ('' watermark)
   * just keep pushing.
   */
  async #refreshOpaqueFromServer(): Promise<void> {
    if (this.#mountSuspect) return
    for (const [fileId, view] of Array.from(this.#views)) {
      if (view.contentKind !== 'opaque') continue
      if (this.#pendingDeletes.has(fileId)) continue
      const diskHash = await this.#fs.hash(view.path).catch(() => null)
      const diskIsClean = diskHash !== null && diskHash === view.lastWrittenHash
      let fetched: OpaqueFetchResult
      try {
        fetched = await this.#options.transport.fetchOpaque(fileId, undefined, {
          metadataOnly: true,
        })
      } catch {
        continue // Outcome unknown — the next cycle re-polls.
      }
      if (!fetched.found) {
        if (view.lastWrittenHash === '') continue // Never created server-side yet.
        if (diskHash !== null && diskHash !== view.lastWrittenHash) {
          view.lastWrittenHash = ''
          this.#opaqueInFlight.delete(fileId)
          await this.#persistOpaque(fileId)
          continue
        }
        if (diskHash !== null) {
          await this.#fs.deletePath(view.path)
        }
        await this.#finalizeDelete(fileId)
        continue
      }
      if (fetched.contentKind === 'markdown') {
        // The row is alive but crossed opaque→md while we were behind the
        // replay window (the rename event is gone) — NEVER a deletion.
        // Apply it as the rename it was; the boundary transition follows.
        if (fetched.path && fetched.path !== view.path) {
          await this.#applyRemoteRename({
            type: 'rename',
            fileId,
            newPath: fetched.path,
          } as WireWorkspaceEvent)
        }
        continue
      }
      if (fetched.hashHex === view.lastWrittenHash) continue
      if (diskHash !== null && diskHash === fetched.hashHex) {
        view.lastWrittenHash = fetched.hashHex ?? view.lastWrittenHash
        await this.#persistOpaque(fileId)
        continue
      }
      if (diskIsClean) {
        if (!fetched.bytes) {
          const existingBytes = await this.#fs.readFileBytes(view.path).catch(() => undefined)
          try {
            fetched = await this.#options.transport.fetchOpaque(fileId, existingBytes)
          } catch {
            continue
          }
        }
        if (!fetched.bytes || fetched.hashHex === undefined) continue
        await this.#writeOpaqueCheckout(fileId, view, fetched.bytes)
      }
      // Dirty disk: keep the user's bytes; push adjudicates by LWW.
    }
  }

  /**
   * Local pending work survived a remote delete: re-create the server file
   * under the same fileId with exactly our text (snapshot.get with
   * initialContent is the create surface; it clears the tombstone and
   * re-registers the tree entry). The fresh doc replaces the local one.
   */
  async #resurrectOnServer(fileId: string): Promise<void> {
    const client = this.#clients.get(fileId)
    const view = this.#views.get(fileId)
    if (!client || !view) return
    const localText = client.getTextContent()
    client.disconnect()
    this.#clients.delete(fileId)

    const snapshot = await this.#options.transport.fetchSnapshot(fileId, localText, view.path)
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    const fresh = await this.#attach(fileId, { snapshot, syncedVersion: doc.contentVersion() })
    if (fresh.getTextContent() !== localText) {
      await fresh.setTextContent(localText)
      await fresh.flush()
    }
    // The old anchor cites ops of the discarded doc — re-anchor.
    view.lastWrittenVV = fresh.getDoc().contentVersion()
    await this.#persistMarkdown(fileId)
  }

  /**
   * Guarded checkout (INV-5): write doc text to disk only when the on-disk
   * bytes are the ones we last wrote (INV-4 watermark) or the file is
   * absent. A mismatch is an unseen local edit — scan merges it first.
   *
   * DERIVED over every tracked file, never queue-driven (INV-6): a "needs
   * checkout" set desynchronizes the moment a crash lands between the
   * cursor advance and the disk write — nothing would ever re-mark the
   * file, leaving disk behind the doc forever.
   */
  async #checkoutCleanFiles(): Promise<void> {
    for (const [fileId, view] of this.#views) {
      if (view.contentKind === 'opaque') {
        await this.#checkoutOpaque(fileId, view)
        continue
      }
      const client = this.#clients.get(fileId)
      if (!client) continue

      const onDiskHash = await this.#fs.hash(view.path).catch(() => null)
      if (onDiskHash === null) {
        // An open delete intent suppresses resurrection until a remote
        // edit cancels it (INV-3); a suspect mount freezes both directions
        // (no new intents, no writes into a possibly-foreign directory).
        if (this.#pendingDeletes.has(fileId) || this.#mountSuspect) continue
        // Materialization authority is DERIVED (INV-6), never only the
        // volatile resurrect flag: an empty watermark means the daemon
        // never wrote this file locally, so its absence cannot be a user
        // delete — a crash that loses the in-memory flag between an
        // adoption/remote-create bind and this checkout must not convert
        // a server-only file into an accepted delete intent.
        if (this.#resurrect.has(fileId) || view.lastWrittenHash === '') {
          await this.#writeCheckout(fileId, view, client)
          this.#resurrect.delete(fileId)
        } else {
          // First sight of the absence. Never write a missing file from
          // inferred doc presence — record the intent and let the INV-3
          // machinery (rename correction, remote-edit-wins) decide.
          await this.#recordDeleteIntent(fileId, view.path)
        }
        continue
      }

      // The file is back on disk — any open intent was a transient absence
      // (the rename-correction class: tmp+rename seen mid-flight).
      if (this.#pendingDeletes.has(fileId)) {
        await this.#cancelDeleteIntent(fileId)
      }
      this.#resurrect.delete(fileId)
      if (onDiskHash !== view.lastWrittenHash) continue
      if (sha256Hex(client.getTextContent()) === onDiskHash) continue
      await this.#writeCheckout(fileId, view, client)
    }
  }

  /**
   * Opaque checkout analog: owns absence observation/cancellation (INV-3)
   * and resurrect-authorized materialization (bytes fetched on demand).
   * The content direction itself is push (scan-derived LWW) and pull
   * (event-carried bytes) — a present file is never written here.
   */
  async #checkoutOpaque(fileId: string, view: EngineFileView): Promise<void> {
    const onDiskHash = await this.#fs.hash(view.path).catch(() => null)
    if (onDiskHash === null) {
      if (this.#pendingDeletes.has(fileId) || this.#mountSuspect) return
      // Materialization authority is DERIVED (INV-6): an empty watermark
      // means we never wrote this file locally — its absence cannot be a
      // user delete, even if a crash lost the in-memory resurrect flag.
      if (this.#resurrect.has(fileId) || view.lastWrittenHash === '') {
        let fetched: OpaqueFetchResult
        try {
          fetched = await this.#options.transport.fetchOpaque(fileId)
        } catch {
          return // Keep the authority; the next cycle retries.
        }
        if (fetched.found && fetched.contentKind !== 'markdown' && fetched.bytes) {
          // Re-check the absence: a file appearing on disk during the
          // fetch round-trip is an unseen local write — never stomp it
          // (scan/push adjudicate next cycle).
          if ((await this.#fs.hash(view.path).catch(() => null)) === null) {
            await this.#writeOpaqueCheckout(fileId, view, fetched.bytes)
          }
        } else if (!fetched.found && view.lastWrittenHash === '') {
          // Never reached the server AND gone from disk: nothing exists
          // anywhere — drop the view (no intent; there is no remote file
          // to delete).
          await this.#finalizeDelete(fileId)
          return
        }
        this.#resurrect.delete(fileId)
        return
      }
      await this.#recordDeleteIntent(fileId, view.path)
      return
    }
    // Back on disk — any open intent was a transient absence.
    if (this.#pendingDeletes.has(fileId)) {
      await this.#cancelDeleteIntent(fileId)
    }
    this.#resurrect.delete(fileId)
  }

  async #writeOpaqueCheckout(
    fileId: string,
    view: EngineFileView,
    bytes: Uint8Array,
  ): Promise<void> {
    const writtenHash = await this.#fs.writeFileBytes(view.path, bytes)
    const stat = await this.#fs.stat(view.path)
    Object.assign(view, {
      lastWrittenHash: writtenHash,
      sizeBytes: bytes.byteLength,
      nodeId: stat?.nodeId ?? view.nodeId,
    })
    await this.#persistOpaque(fileId)
  }

  async #writeCheckout(
    fileId: string,
    view: EngineFileView,
    client: LoroRoomClient,
  ): Promise<void> {
    const text = client.getTextContent()
    const writtenHash = await this.#fs.writeFile(view.path, text)
    const stat = await this.#fs.stat(view.path)
    Object.assign(view, {
      lastWrittenHash: writtenHash,
      lastWrittenVV: client.getDoc().contentVersion(),
      sizeBytes: new TextEncoder().encode(text).byteLength,
      nodeId: stat?.nodeId ?? view.nodeId,
    })
    // Envelope-first persist keeps the VV anchor citable (see absorb).
    await this.#persistMarkdown(fileId)
  }

  async #scan(): Promise<void> {
    const diff = await scanMount({ fs: this.#fs, files: this.#views.values() })
    const trackedBeforeScan = this.#views.size
    const isFirstScan = !this.#firstScanDone
    this.#firstScanDone = true

    for (const rename of diff.renames) {
      await this.#runFileOp('scan.rename', rename.fileId, rename.toPath, async () => {
        // A delete intent for a file that reappeared under a new path was a
        // move observed across scans — the rename correction cancels it.
        await this.#cancelDeleteIntent(rename.fileId)
        await this.#updateView(rename.fileId, {
          path: rename.toPath,
          nodeId: rename.entry.nodeId,
        })
        await this.#recordPendingRename(rename.fileId, rename.fromPath, rename.toPath)
      })
    }

    // Derived kind consistency (ISSUE-0043, INV-6 flavor): the view's kind
    // must always match the kind its path derives — a stale 'markdown'
    // view at a .png path absorbs the next disk edit as text, gets refused
    // invalid-path, and the repair/checkout interplay destroys the user's
    // bytes. Healing here (every scan, not only at rename time) also
    // covers a crash between the persisted path update and the transition,
    // and pre-fix legacy state.
    for (const [fileId, view] of Array.from(this.#views)) {
      const pathKind = isMarkdownFile(view.path) ? 'markdown' : 'opaque'
      if (view.contentKind === pathKind) continue
      await this.#runFileOp('scan.kind', fileId, view.path, async () => {
        if (pathKind === 'opaque') {
          await this.#transitionToOpaque(fileId)
        } else {
          await this.#transitionToMarkdown(fileId)
        }
      })
    }

    for (const create of diff.creates) {
      if (create.contentKind !== 'markdown') {
        const fileId = this.#newFileId()
        await this.#runFileOp('scan.opaque-create', fileId, create.path, async () => {
          // Opaque create: track watermark-only with NO confirmed base —
          // the derived push submits the bytes as expecting-to-create.
          this.#views.set(fileId, {
            fileId,
            path: create.path,
            contentKind: 'opaque',
            nodeId: create.nodeId,
            lastWrittenHash: '',
            lastWrittenVV: new Uint8Array(),
            sizeBytes: create.sizeBytes,
          })
          await this.#persistOpaque(fileId)
        })
        continue
      }
      let existingPending = this.#pendingCreateAtPath(create.path)
      if (
        existingPending &&
        (existingPending.nodeId === null ||
          create.nodeId === null ||
          existingPending.nodeId !== create.nodeId)
      ) {
        // The path was deleted/replaced while the daemon was down. Path alone
        // cannot authorize attaching the replacement to the staged fileId.
        // Re-check tree state before retiring it: snapshot.get may already
        // have registered the old identity while its create event was pruned.
        const tree = await this.#options.transport.listTree()
        const entry = tree.entries.find(
          (candidate) => candidate.fileId === existingPending!.fileId && !candidate.tombstone,
        )
        if (entry) {
          await this.#reconcileAuthoritativePendingCreate(
            existingPending,
            entry,
            await this.#readDisk(existingPending.path),
          )
          // The scan diff predates collision isolation/materialization and is
          // stale. A later cycle registers any preserved suffix separately.
          continue
        }
        await this.#discardPendingCreate(existingPending.fileId)
        existingPending = undefined
      }
      const fileId = existingPending?.fileId ?? this.#newFileId()
      await this.#runFileOp('scan.create', fileId, create.path, async () => {
        const text = normalizeEol(create.text ?? '')
        if (!existingPending) {
          // Identity must reach durable local state before snapshot.get can
          // register the file server-side. Retried scans reuse this fileId.
          await this.#recordPendingCreate({
            fileId,
            path: create.path,
            contentKind: 'markdown',
            contentHash: create.contentHash,
            baseContentHash: sha256Hex(text),
            nodeId: create.nodeId,
            sizeBytes: create.sizeBytes,
          })
        }
        const snapshot = await this.#options.transport.fetchSnapshot(fileId, text, create.path)
        const doc = LoroFileDoc.fromSnapshot(snapshot)
        const canonicalText = doc.getTextContent()
        const canonicalHash = sha256Hex(canonicalText)

        if (
          existingPending &&
          canonicalHash !== existingPending.baseContentHash &&
          canonicalHash !== sha256Hex(text)
        ) {
          // The create event/VV fell out of the replay window and the server
          // has advanced concurrently. With no exact base anchor, inception
          // merge duplicates the original text. Preserve the local bytes at
          // a suffix and materialize canonical at the original path instead.
          // Journal the move because this scan branch is itself a replay
          // recovery path: another crash must not reinterpret our move as a
          // user deletion or leave the accepted server row untracked.
          await this.#isolatePendingCreateCollision(existingPending, create.path)
          this.#views.set(fileId, {
            fileId,
            path: create.path,
            contentKind: 'markdown',
            nodeId: null,
            lastWrittenHash: '',
            lastWrittenVV: doc.contentVersion(),
            sizeBytes: 0,
          })
          await this.#attach(fileId, { snapshot, syncedVersion: doc.contentVersion() })
          this.#resurrect.add(fileId)
          await this.#persistMarkdown(fileId)
          return
        }

        this.#views.set(fileId, {
          fileId,
          path: create.path,
          contentKind: 'markdown',
          nodeId: create.nodeId,
          // Watermark is the OBSERVED disk bytes (raw), so a CRLF file is
          // recognized as our own even though the doc holds normalized text.
          lastWrittenHash: create.contentHash,
          lastWrittenVV: doc.contentVersion(),
          sizeBytes: create.sizeBytes,
        })
        const client = await this.#attach(fileId, { snapshot, syncedVersion: doc.contentVersion() })
        if (existingPending && canonicalHash === existingPending.baseContentHash) {
          if (canonicalText !== text) {
            // The unchanged canonical snapshot is the exact staged base.
            // Absorb edits made while down at that version, never inception.
            const view = this.#views.get(fileId)!
            view.lastWrittenVV = client.getDoc().applyTextAtBase(doc.contentVersion(), text)
          }
        } else if (client.getTextContent() !== text) {
          // The fileId already existed server-side with other content: merge
          // the disk text as inserts-at-inception — union, never deletion of
          // the server's text (INV-2).
          const view = this.#views.get(fileId)!
          view.lastWrittenVV = client.getDoc().applyTextAtBase(new Uint8Array(), text)
        }
        await this.#persistMarkdown(fileId)
      })
    }

    for (const change of diff.contentChanges) {
      const view = this.#views.get(change.fileId)
      if (!view) continue
      await this.#runFileOp('scan.content-change', change.fileId, view.path, async () => {
        // Content at the path means the absence behind any open intent was
        // transient (rename-correction class) — cancel before absorbing.
        if (this.#pendingDeletes.has(change.fileId)) {
          await this.#cancelDeleteIntent(change.fileId)
        }
        if (view.contentKind !== 'markdown') {
          // Opaque content is push-derived (disk hash vs watermark); only
          // the disk-facing meta rolls here.
          await this.#updateView(change.fileId, { nodeId: change.entry.nodeId })
          return
        }
        // #absorbObserved imports the disk text into the live doc, then the
        // persist commits it. We do NOT roll the in-memory watermark back if
        // the persist throws: the import cannot be cleanly undone (Loro's DAG
        // is append-only), and rewinding only the watermark would re-fork a
        // later edit off a stale base and duplicate text. On a persist failure
        // the imported ops still flush to the server this cycle and the durable
        // watermark catches up on the next successful persist or on restart.
        this.#absorbObserved(change.fileId, {
          text: change.entry.text ?? '',
          contentHash: change.entry.contentHash,
          sizeBytes: change.entry.sizeBytes,
          nodeId: change.entry.nodeId,
        })
        await this.#persistMarkdown(change.fileId)
      })
    }

    if (this.#mountSuspect) return // Absences on a suspect mount mean nothing.

    // Startup bulk guard (ISSUE-0013): the first scan after boot finding
    // EVERY tracked file missing is an unmounted volume or a foreign
    // directory, never a deliberate wipe — hold all of it regardless of
    // count (small workspaces would slip under the window thresholds).
    const startupWipe =
      isFirstScan && trackedBeforeScan > 0 && diff.deletes.length === trackedBeforeScan

    for (const del of diff.deletes) {
      await this.#recordDeleteIntent(del.fileId, del.path)
    }
    if (startupWipe) {
      // This cycle's guarded checkout already recorded some of these
      // absences (it runs before scan) — the hold upgrades them too.
      let changed = false
      for (const del of diff.deletes) {
        const intent = this.#pendingDeletes.get(del.fileId)
        if (intent && intent.held === undefined && intent.confirmedAtMs === undefined) {
          intent.held = 'bulk-startup'
          changed = true
        }
      }
      if (changed) {
        await this.#store.setPendingDeletes([...this.#pendingDeletes.values()])
        this.#warnHeldDeletes(
          diff.deletes
            .map((del) => this.#pendingDeletes.get(del.fileId))
            .filter((intent): intent is PendingDelete => intent?.held === 'bulk-startup'),
        )
      }
    }
  }

  /**
   * Record an observed absence as a delete INTENT — never an action. The
   * intent suppresses checkout resurrection and is adjudicated by the
   * propagation gates (sentinel, bulk guards, tombstone delay) and the
   * server's stale-baseSeq policy.
   */
  async #recordDeleteIntent(
    fileId: string,
    path: string,
    options: { held?: PendingDelete['held'] } = {},
  ): Promise<void> {
    if (this.#pendingDeletes.has(fileId)) return // Keep the first observation time.
    this.#pendingDeletes.set(fileId, {
      opId: this.#newOpId(),
      fileId,
      path,
      baseSeq: this.#cursor,
      observedMissingAtMs: this.#now(),
      held: options.held,
    })
    this.#applyBulkWindowGuard()
    await this.#store.setPendingDeletes([...this.#pendingDeletes.values()])
  }

  /**
   * Runtime sliding-window bulk guard: when the absences observed inside
   * the window cross the count threshold OR the tracked-files ratio (with
   * a small floor so single deletes in tiny workspaces still propagate),
   * every intent in the window is held. Holds are never released by time —
   * only reappearance cancels a held intent (a wipe must not propagate
   * just because it got old).
   */
  #applyBulkWindowGuard(): void {
    const now = this.#now()
    const recent = [...this.#pendingDeletes.values()].filter(
      (intent) =>
        intent.confirmedAtMs === undefined &&
        now - intent.observedMissingAtMs <= this.#policy.bulkWindowMs,
    )
    const tracked = Math.max(this.#views.size, 1)
    const hot =
      recent.length >= this.#policy.bulkMinCount ||
      (recent.length >= this.#policy.bulkRatioFloor &&
        recent.length / tracked >= this.#policy.bulkRatio)
    if (!hot) return
    const newlyHeld: PendingDelete[] = []
    for (const intent of recent) {
      if (intent.held === undefined && intent.confirmedAtMs === undefined) {
        intent.held = 'bulk-window'
        newlyHeld.push(intent)
      }
    }
    this.#warnHeldDeletes(newlyHeld)
  }

  async #recordPendingRename(fileId: string, fromPath: string, toPath: string): Promise<void> {
    const existing = this.#pendingRenames.get(fileId)
    this.#pendingRenames.set(fileId, {
      // A further move before the first one was acked replaces the op
      // wholesale (new opId — the old payload may have landed server-side
      // and must not be replayed by idempotency with a stale toPath).
      opId: this.#newOpId(),
      fileId,
      fromPath: existing?.fromPath ?? fromPath,
      toPath,
      baseSeq: this.#cursor,
    })
    await this.#store.setPendingRenames([...this.#pendingRenames.values()])
  }

  async #push(): Promise<void> {
    for (const [fileId, client] of this.#clients) {
      if (!client.hasPendingChanges()) continue
      // flush() never rejects — a server reject / transport error is handled
      // inside the room client (submit-error / history-pruned → #needsRepair,
      // drained below), leaving the synced version un-advanced so the file
      // stays dirty and retries. The throw this boundary isolates is the
      // persist; either way one file's failure no longer aborts #push.
      await this.#runFileOp(
        'push.flush',
        fileId,
        this.#views.get(fileId)?.path ?? fileId,
        async () => {
          await client.flush()
          await this.#persistMarkdown(fileId)
        },
      )
    }
    // history-pruned deferrals surfaced during flush: rebuild from a fresh
    // snapshot, re-apply unacked local text, resubmit under new opIds.
    // Copied first: repair can re-queue entries mid-loop.
    for (const fileId of Array.from(this.#needsRepair)) {
      this.#needsRepair.delete(fileId)
      await this.#repairFromSnapshot(fileId)
    }
    await this.#pushOpaque()
  }

  /**
   * Derived opaque push (INV-6 style — no dirty queue to desynchronize):
   * any opaque view whose disk bytes differ from the confirmed watermark
   * submits them LWW with the watermark as base ('' = expecting to
   * create). A conflict ack means the server preserved ITS previous bytes
   * as a recovery record and ours won — INV-2 held server-side. Runs after
   * #propagateTreeOps so an opaque edit cannot advance the file's seq past
   * a rename observed in the same cycle (same ordering rule as markdown).
   */
  async #pushOpaque(): Promise<void> {
    for (const [fileId, view] of this.#views) {
      if (view.contentKind !== 'opaque') continue
      if (this.#pendingDeletes.has(fileId)) continue
      let bytes: Uint8Array
      try {
        bytes = await this.#fs.readFileBytes(view.path)
      } catch {
        continue // Absent — the absence machinery owns it.
      }
      const bytesHash = sha256Hex(bytes)
      if (bytesHash === view.lastWrittenHash) continue
      if (this.#opaqueRefused.get(fileId) === bytesHash) continue

      // Byte-identical retransmission reuses the opId (server idempotency
      // replays the original ack); changed payload mints a fresh op.
      const flight = this.#opaqueInFlight.get(fileId)
      const opId =
        flight && flight.bytesHash === bytesHash && flight.baseHash === view.lastWrittenHash
          ? flight.opId
          : this.#newOpId()
      this.#opaqueInFlight.set(fileId, { opId, bytesHash, baseHash: view.lastWrittenHash })

      let result: SubmitOpaqueResult
      try {
        result = await this.#options.transport.submitOpaque({
          fileId,
          observedPath: view.path,
          opId,
          baseHashHex: view.lastWrittenHash,
          bytes,
        })
      } catch (error) {
        this.#warn({
          type: 'opaque-submit-failed',
          fileId,
          path: view.path,
          reason: errorReason(error),
        })
        continue // Outcome unknown — the same opId retries next cycle.
      }
      if (result.type === 'rejected') {
        this.#warn({
          type: 'opaque-submit-rejected',
          fileId,
          path: view.path,
          reason: result.reason,
          retryAfterSec: result.retryAfterSec,
        })
        this.#opaqueInFlight.delete(fileId)
        if (result.reason !== 'rate-limited') {
          // Permanent for this payload (too-large, or the server row is
          // still markdown because a boundary rename deferred): stop
          // resubmitting until the disk bytes change.
          this.#opaqueRefused.set(fileId, bytesHash)
        }
        continue
      }
      this.#opaqueInFlight.delete(fileId)
      this.#opaqueRefused.delete(fileId)
      const stat = await this.#fs.stat(view.path).catch(() => null)
      Object.assign(view, {
        lastWrittenHash: result.hashHex,
        sizeBytes: bytes.byteLength,
        nodeId: stat?.nodeId ?? view.nodeId,
      })
      try {
        await this.#persistOpaque(fileId)
        if (result.path !== undefined && result.path !== view.path) {
          // The server suffixed our create path (collision policy) — adopt
          // the canonical path like the remote rename it effectively is.
          await this.#applyRemoteRename({
            type: 'rename',
            fileId,
            newPath: result.path,
          } as WireWorkspaceEvent)
        }
      } catch (error) {
        // The bytes are acked server-side; only the durable bookkeeping failed.
        // Isolate it (ISSUE-0053 A) — a persist throw here must not abort the
        // whole cycle. The in-memory watermark advanced, so we won't resubmit;
        // restart reload re-derives from disk if the persist never lands.
        this.#warn({
          type: 'opaque-submit-failed',
          fileId,
          path: view.path,
          reason: errorReason(error),
        })
        continue
      }
    }
  }

  /**
   * Send eligible structural ops in one batch. Renames always flow (they
   * preserve content); a delete intent flows only past the full INV-3
   * gate: sentinel present, not bulk-held, tombstone delay elapsed. A
   * transport failure keeps everything for the next cycle — identical
   * opIds make the retry idempotent server-side.
   */
  async #propagateTreeOps(): Promise<void> {
    const renames = [...this.#pendingRenames.values()]
    const now = this.#now()
    const deletes = this.#mountSuspect
      ? []
      : [...this.#pendingDeletes.values()].filter(
          (intent) =>
            intent.held === undefined &&
            now - intent.observedMissingAtMs >= this.#policy.tombstoneDelayMs,
        )

    const ops: WorkspaceBatchWireOp[] = [
      ...renames.map(
        (rename): WorkspaceBatchWireOp => ({
          type: 'file.rename',
          opId: rename.opId,
          fileId: rename.fileId,
          baseSeq: rename.baseSeq,
          fromPath: rename.fromPath,
          toPath: rename.toPath,
        }),
      ),
      ...deletes.map(
        (intent): WorkspaceBatchWireOp => ({
          type: 'file.deleteIntent',
          opId: intent.opId,
          fileId: intent.fileId,
          baseSeq: intent.baseSeq,
          path: intent.path,
        }),
      ),
    ]
    if (ops.length === 0) return

    let result: BatchSubmitResult
    try {
      result = await this.#options.transport.submitBatch(ops)
    } catch {
      return // Outcome unknown — retry next cycle under the same opIds.
    }
    if (result.type === 'rejected') return // Rate-limited; next cycle retries.

    const accepted = new Set(result.acceptedOps.map((op) => op.opId))
    const deferred = new Map(result.deferredOps.map((op) => [op.opId, op.reason]))

    let renamesChanged = false
    for (const rename of renames) {
      if (!accepted.has(rename.opId) && !deferred.has(rename.opId)) continue
      // Deferred (remote-edit-wins / target-occupied): the server's path
      // stands; the local path stays until a remote rename event arrives.
      // Either way this pending entry is finished.
      this.#pendingRenames.delete(rename.fileId)
      renamesChanged = true
    }
    if (renamesChanged) {
      await this.#store.setPendingRenames([...this.#pendingRenames.values()])
    }

    for (const intent of deletes) {
      if (accepted.has(intent.opId)) {
        await this.#finalizeDelete(intent.fileId)
        continue
      }
      const reason = deferred.get(intent.opId)
      if (reason === 'remote-edit-wins') {
        // The file was edited past our observed cursor: the edit wins and
        // the file resurrects (pull may already have imported the edit;
        // checkout re-materializes either way).
        await this.#cancelDeleteIntent(intent.fileId)
        this.#resurrect.add(intent.fileId)
      } else if (reason === 'file-not-found') {
        await this.#finalizeDelete(intent.fileId) // Gone on both sides.
      }
      // Any other outcome: keep the intent; the next cycle retries.
    }
  }

  /** The delete stands (server applied it, or it was already gone). */
  async #finalizeDelete(fileId: string): Promise<void> {
    if (this.#pendingDeletes.delete(fileId)) {
      await this.#store.setPendingDeletes([...this.#pendingDeletes.values()])
    }
    const client = this.#clients.get(fileId)
    client?.disconnect()
    this.#clients.delete(fileId)
    this.#views.delete(fileId)
    this.#resurrect.delete(fileId)
    this.#needsRepair.delete(fileId)
    this.#opaqueInFlight.delete(fileId)
    this.#opaqueRefused.delete(fileId)
    this.#renameReconcile.delete(fileId)
    this.#clearHeldWarning(fileId)
    await this.#store.removeFile(fileId)
  }

  /**
   * Absorb an unseen local disk edit into the doc BEFORE remote imports, so
   * the edit's ops anchor at the base the user saw (see header comment).
   */
  async #absorbDiskIfDirty(fileId: string): Promise<void> {
    const view = this.#views.get(fileId)
    if (!view || view.contentKind !== 'markdown' || !this.#clients.has(fileId)) return
    if (this.#pendingDeletes.has(fileId)) return
    const entry = await this.#readDisk(view.path)
    if (entry === null || entry.contentHash === view.lastWrittenHash) return
    this.#absorbObserved(fileId, entry)
  }

  /**
   * Fold observed disk bytes into the doc, anchored at the version the disk
   * content was derived from (`lastWrittenVV`) — NOT at the doc's current
   * state, which may hold imported ops that never reached disk; diffing
   * against those would emit deletions of merged remote text (era-4 /
   * INV-5). The watermark pair (hash + VV) rolls to the observed bytes and
   * the version that materializes exactly them.
   *
   * Mutates the in-memory view ONLY: the rolled VV references the fork ops,
   * which exist solely in this doc until the next persistMarkdown writes
   * the envelope. Persisting the VV through a state-only meta write would
   * open a crash window where the state anchor cites ops the persisted
   * snapshot never saw — the next forkAt on that anchor dies in the wasm
   * DAG. Every caller persists via persistMarkdown (envelope first).
   */
  #absorbObserved(
    fileId: string,
    observed: { text: string; contentHash: string; sizeBytes: number; nodeId: string | null },
  ): void {
    const view = this.#views.get(fileId)
    const client = this.#clients.get(fileId)
    if (!view || !client) return
    const text = normalizeEol(observed.text)
    const doc = client.getDoc()
    const written =
      text === doc.getTextContent()
        ? doc.contentVersion()
        : doc.applyTextAtBase(view.lastWrittenVV, text)
    Object.assign(view, {
      lastWrittenHash: observed.contentHash,
      lastWrittenVV: written,
      sizeBytes: observed.sizeBytes,
      nodeId: observed.nodeId,
    })
  }

  async #readDisk(path: string): Promise<DiskFileEntry | null> {
    try {
      const bytes = await this.#fs.readFileBytes(path)
      const stat = await this.#fs.stat(path)
      return {
        text: new TextDecoder().decode(bytes),
        contentHash: sha256Hex(bytes),
        sizeBytes: bytes.byteLength,
        nodeId: stat?.nodeId ?? null,
      }
    } catch {
      return null
    }
  }

  async #attach(
    fileId: string,
    hydrate: { snapshot: Uint8Array; syncedVersion: Uint8Array },
  ): Promise<LoroRoomClient> {
    const client = new LoroRoomClient({
      fileId,
      observedPath: this.#views.get(fileId)?.path ?? `${fileId}.md`,
      deviceId: this.#options.deviceId,
      newOpId: this.#newOpId,
      hydrate,
      transport: {
        submitUpdate: (input) => this.#options.transport.submitUpdate(input),
        fetchSnapshot: (id) => this.#options.transport.fetchSnapshot(id),
        // The engine owns imports; room clients never see remote events.
        subscribe: () => () => {},
      },
    })
    await client.connect()
    client.onChange((reason) => {
      if (reason === 'history-pruned') this.#needsRepair.add(fileId)
    })
    this.#clients.set(fileId, client)
    return client
  }

  async #repairFromSnapshot(fileId: string): Promise<void> {
    const client = this.#clients.get(fileId)
    if (!client) return

    const localText = client.hasPendingChanges() ? client.getTextContent() : null
    client.disconnect()
    this.#clients.delete(fileId)

    const snapshot = await this.#options.transport.fetchSnapshot(fileId)
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    const fresh = await this.#attach(fileId, { snapshot, syncedVersion: doc.contentVersion() })
    if (localText !== null && localText !== fresh.getTextContent()) {
      await fresh.setTextContent(localText)
      await fresh.flush()
    }
    // The old anchor cites ops of the discarded doc — re-anchor at the
    // fresh doc so a later forkAt never references unknown history. The
    // hash watermark is unchanged, so absorb won't re-fire until disk
    // actually changes, and checkout rolls the full pair.
    const view = this.#views.get(fileId)
    if (view) view.lastWrittenVV = fresh.getDoc().contentVersion()
    await this.#persistMarkdown(fileId)
  }

  async #persistMarkdown(fileId: string): Promise<void> {
    const client = this.#clients.get(fileId)
    const view = this.#views.get(fileId)
    if (!client || !view) return
    const doc = client.getDoc()
    const synced = client.syncedVersion()
    await this.#store.persistMarkdownFile(
      fileId,
      {
        snapshot: doc.exportSnapshot(),
        syncedVVB64: bytesToBase64(synced ?? doc.contentVersion()),
      },
      {
        path: view.path,
        nodeId: view.nodeId,
        lastWrittenHash: view.lastWrittenHash,
        lastWrittenVVB64: bytesToBase64(view.lastWrittenVV),
        sizeBytes: view.sizeBytes,
      },
    )
    this.#pendingCreates.delete(fileId)
  }

  /** Watermark-only persistence — state entry, no Loro envelope. */
  async #persistOpaque(fileId: string): Promise<void> {
    const view = this.#views.get(fileId)
    if (!view || view.contentKind !== 'opaque') return
    await this.#store.persistOpaqueFile(fileId, {
      path: view.path,
      nodeId: view.nodeId,
      opaqueHash: view.lastWrittenHash,
      sizeBytes: view.sizeBytes,
    })
    this.#pendingCreates.delete(fileId)
  }

  /** Disk-facing meta only — never the VV anchor (see absorb for why). */
  async #updateView(
    fileId: string,
    meta: Partial<Pick<EngineFileView, 'path' | 'nodeId' | 'lastWrittenHash' | 'sizeBytes'>>,
  ): Promise<void> {
    const view = this.#views.get(fileId)
    if (!view) return
    Object.assign(view, meta)
    await this.#store.updateFileMeta(fileId, meta)
  }

  async #advanceCursor(seq: number): Promise<void> {
    if (seq === this.#cursor) return
    this.#cursor = seq
    await this.#store.setLastAckedSeq(seq)
  }

  async #cancelDeleteIntent(fileId: string): Promise<void> {
    if (!this.#pendingDeletes.delete(fileId)) return
    this.#clearHeldWarning(fileId)
    await this.#store.setPendingDeletes([...this.#pendingDeletes.values()])
  }
}

/** The server refused snapshot.get because the row is opaque (kind crossing). */
function isOpaqueFileRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes('opaque-file')
}

function errorReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  const reason = String(error)
  return reason.length > 0 ? reason : 'unknown error'
}
