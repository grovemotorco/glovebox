import type { OpaqueManifest, WorkspaceTreeEntry } from '@glovebox/core'
import { LoroFileDoc } from '../loro/file-doc.ts'
import { base64ToBytes, bytesToBase64 } from '../loro/base64.ts'
import {
  LoroRoomClient,
  type SubmitUpdateInput,
  type SubmitUpdateResult,
} from '../loro/room-client.ts'
import { sha256Hex } from '../fs/hash.ts'
import {
  WorkspaceStateStore,
  type ClientStateStorage,
  type WorkspaceState,
} from './workspace-state.ts'

/**
 * Browser V1 sync engine (spec-browser-v1-client.md): event-driven
 * pull/push over the workspace socket, with IndexedDB persistence and the
 * startup reconcile from WorkspaceStateStore. Push is delegated per file to
 * LoroRoomClient (ack-gated, idempotent retransmission); the engine owns
 * every import — catch-up batches and live broadcasts — so
 * `ImportStatus.pending` always triggers snapshot repair BEFORE the durable
 * cursor advances.
 */

export interface WireWorkspaceEvent {
  type: 'content.loroUpdate' | 'content.opaqueUpdate' | 'create' | 'rename' | 'delete' | 'update'
  fileId: string
  seq?: number
  loroUpdateB64?: string
  hashHex?: string
  sizeBytes?: number
  manifest?: OpaqueManifest
  contentVersionB64?: string
  originDeviceId?: string
  /** Tree-event payload (create/rename/delete). The browser V1 engine only
   *  advances its cursor over these; the V2 daemon applies them. */
  path?: string
  oldPath?: string
  newPath?: string
  entry?: WorkspaceTreeEntry
}

export type EventsSinceResult =
  | { ok: true; currentSeq: number; events: WireWorkspaceEvent[] }
  | { ok: false; reason: 'snapshot-required'; currentSeq: number }

export interface WorkspaceSyncTransport {
  assignSessionPeerId?(): Promise<bigint>
  /** `snapshot.get` — server creates the file (registering it in the tree
   *  at `observedPath`) when it has no state yet. */
  fetchSnapshot(fileId: string, initialContent?: string, observedPath?: string): Promise<Uint8Array>
  /** `events.since` replay. */
  eventsSince(afterSeq: number): Promise<EventsSinceResult>
  /** `content.submit`, resolved by ack/deferral/rejection. */
  submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult>
  /** Live broadcast stream (all files), in socket order. */
  subscribeEvents(handler: (event: WireWorkspaceEvent) => void): () => void
}

export interface SyncEngineOptions {
  workspaceId: string
  deviceId: string
  storage: ClientStateStorage
  transport: WorkspaceSyncTransport
  now?: () => number
  newOpId?: () => string
}

export type SyncEngineChange =
  | { type: 'file-changed'; fileId: string; reason: 'local-edit' | 'remote-update' | 'hydrated' }
  | { type: 'repair'; fileId: string; reason: 'history-pruned' | 'import-pending' }
  /**
   * A structural event (create/rename/delete) forwarded in the engine's
   * single-cursor seq order — gap-free, because a real seq gap is filled by
   * `#pull` before any later event is emitted. The tree consumer applies it
   * incrementally instead of refetching on a content-induced seq jump
   * (ISSUE-0048 Phase B).
   */
  | { type: 'tree-event'; event: WireWorkspaceEvent }
  /**
   * The replay window was lost (snapshot-required): the consumer does its
   * one legitimate full tree refetch. This is the only structural refetch
   * the engine asks for.
   */
  | { type: 'tree-resync' }

export class WorkspaceSyncEngine {
  readonly #options: SyncEngineOptions
  readonly #store: WorkspaceStateStore
  readonly #files = new Map<string, { client: LoroRoomClient; path: string }>()
  /** In-flight openFile attaches, keyed by fileId, so concurrent opens of the
   *  same file share one fetch+attach and resolve to the SAME client. */
  readonly #opening = new Map<string, Promise<LoroRoomClient>>()
  readonly #listeners = new Set<(change: SyncEngineChange) => void>()
  #state: WorkspaceState | null = null
  #unsubscribe: (() => void) | null = null
  #started = false
  /** Serializes pull/import/persist work against live event handling. */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: SyncEngineOptions) {
    this.#options = options
    this.#store = new WorkspaceStateStore(options.storage, {
      workspaceId: options.workspaceId,
      deviceId: options.deviceId,
      now: options.now,
    })
  }

  /**
   * Reconcile persisted state, hydrate ready files locally, refetch broken
   * ones, then catch up via `events.since` and go live.
   */
  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true

    const reconciled = await this.#store.load()
    this.#state = reconciled.state

    for (const ready of reconciled.ready) {
      await this.#attachFile(ready.fileId, ready.fileState.path, {
        snapshot: ready.snapshot,
        syncedVersion: base64ToBytes(ready.syncedVVB64),
      })
      this.#emit({ type: 'file-changed', fileId: ready.fileId, reason: 'hydrated' })
    }
    for (const broken of reconciled.refetch) {
      await this.#refetchFile(broken.fileId, broken.fileState.path)
    }

    this.#unsubscribe = this.#options.transport.subscribeEvents((event) => {
      this.#enqueue(() => this.#handleLiveEvent(event)).catch(() => {})
    })

    await this.#enqueue(() => this.#pull())
    // Anything that survived the reload unacked retransmits now.
    for (const file of this.#files.values()) {
      await file.client.flush()
    }
    await this.#persistAll()
  }

  stop(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const file of this.#files.values()) {
      file.client.disconnect()
    }
    this.#files.clear()
    this.#started = false
  }

  /** Open (and create if needed) a file; returns its room client. */
  async openFile(fileId: string, path: string, initialContent?: string): Promise<LoroRoomClient> {
    const existing = this.#files.get(fileId)
    if (existing) return existing.client
    // Dedupe concurrent opens of the same file: the #files check above only
    // guards the synchronous entry, so without this two overlapping callers
    // would each run #fetchAndAttach across the snapshot round-trip, leaving
    // the engine tracking the last-attached client while a caller holds the
    // first (edits + lifecycle ops then target different clients).
    const inFlight = this.#opening.get(fileId)
    if (inFlight) return inFlight
    const attach = (async () => {
      const client = await this.#fetchAndAttach(fileId, path, initialContent)
      await this.#persistFile(fileId)
      return client
    })()
    this.#opening.set(fileId, attach)
    try {
      return await attach
    } finally {
      this.#opening.delete(fileId)
    }
  }

  getText(fileId: string): string | null {
    const file = this.#files.get(fileId)
    return file ? file.client.getTextContent() : null
  }

  client(fileId: string): LoroRoomClient | null {
    return this.#files.get(fileId)?.client ?? null
  }

  updateFilePath(fileId: string, path: string): void {
    const file = this.#files.get(fileId)
    if (!file) return
    file.path = path
    file.client.setObservedPath(path)
  }

  closeFile(fileId: string): void {
    const file = this.#files.get(fileId)
    if (!file) return
    file.client.disconnect()
    this.#files.delete(fileId)
    this.#store.removeFile(fileId).catch(() => {})
  }

  async resurrectDeletedFile(fileId: string): Promise<LoroRoomClient | null> {
    const file = this.#files.get(fileId)
    if (!file) return null

    const localText = file.client.getTextContent()
    file.client.disconnect()
    this.#files.delete(fileId)

    const client = await this.#fetchAndAttach(fileId, file.path, localText)
    if (client.getTextContent() !== localText) {
      await client.setTextContent(localText)
      await client.flush()
    }
    await this.#persistFile(fileId)
    this.#emit({ type: 'file-changed', fileId, reason: 'hydrated' })
    return client
  }

  lastAckedSeq(): number {
    return this.#state?.lastAckedSeq ?? 0
  }

  onChange(listener: (change: SyncEngineChange) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Drain pending pushes and persist everything. */
  async flush(): Promise<void> {
    for (const file of this.#files.values()) {
      await file.client.flush()
    }
    await this.#enqueue(async () => {})
    await this.#persistAll()
  }

  /**
   * Catch up from the event log now. Live broadcasts only repair gaps when
   * a LATER event arrives to expose them — a dropped tail event needs an
   * explicit pull (reconnect, resume-from-idle).
   */
  async pull(): Promise<void> {
    await this.#enqueue(() => this.#pull())
  }

  async #attachFile(
    fileId: string,
    path: string,
    hydrate?: { snapshot: Uint8Array; syncedVersion: Uint8Array },
  ): Promise<LoroRoomClient> {
    const client = new LoroRoomClient({
      fileId,
      observedPath: path,
      deviceId: this.#options.deviceId,
      newOpId: this.#options.newOpId,
      hydrate,
      transport: {
        assignSessionPeerId: this.#options.transport.assignSessionPeerId?.bind(
          this.#options.transport,
        ),
        submitUpdate: (input) => this.#options.transport.submitUpdate(input),
        fetchSnapshot: (id) => this.#options.transport.fetchSnapshot(id),
        // The engine owns imports (it must see ImportStatus and the seq
        // cursor); room clients never receive remote events directly.
        subscribe: () => () => {},
      },
    })
    await client.connect()
    // Persist on every local commit, not just acks: the snapshot may carry
    // unacked ops while the watermark stays behind them — on reload the
    // pair hydrates with pending work intact and flush() retransmits
    // (INV-2: a reload never drops an unacked edit).
    const raw = client.getDoc().unwrap() as unknown as {
      subscribeLocalUpdates?: (handler: (update: Uint8Array) => void) => () => void
    }
    raw.subscribeLocalUpdates?.(() => {
      this.#enqueue(() => this.#persistFile(fileId)).catch(() => {})
    })
    client.onChange((reason) => {
      if (reason === 'local-edit') {
        // Ack landed — persist the new watermark pair.
        this.#enqueue(() => this.#persistFile(fileId)).catch(() => {})
        this.#emit({ type: 'file-changed', fileId, reason: 'local-edit' })
      }
      if (reason === 'history-pruned') {
        this.#enqueue(() => this.#repairFromSnapshot(fileId, 'history-pruned')).catch(() => {})
      }
    })
    this.#files.set(fileId, { client, path })
    return client
  }

  async #fetchAndAttach(
    fileId: string,
    path: string,
    initialContent?: string,
  ): Promise<LoroRoomClient> {
    const snapshot = await this.#options.transport.fetchSnapshot(fileId, initialContent, path)
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    return this.#attachFile(fileId, path, {
      snapshot,
      syncedVersion: doc.contentVersion(),
    })
  }

  async #refetchFile(fileId: string, path: string): Promise<void> {
    await this.#fetchAndAttach(fileId, path)
    await this.#persistFile(fileId)
    this.#emit({ type: 'file-changed', fileId, reason: 'hydrated' })
  }

  async #pull(): Promise<void> {
    if (!this.#state) return
    const result = await this.#options.transport.eventsSince(this.#state.lastAckedSeq)
    if (!result.ok) {
      // Cursor predates the replay window: every known file re-snapshots,
      // then the cursor jumps to the server head. Keys are copied first —
      // repair deletes and re-inserts map entries, and mutating a Map
      // during for..of revisits the re-inserted key forever.
      const fileIds = Array.from(this.#files.keys())
      for (const fileId of fileIds) {
        await this.#repairFromSnapshot(fileId, 'import-pending')
      }
      this.#state.lastAckedSeq = result.currentSeq
      await this.#store.setLastAckedSeq(result.currentSeq)
      // The window is gone — structural events may have been missed too; the
      // tree consumer does its one legitimate full refetch (ISSUE-0048).
      this.#emit({ type: 'tree-resync' })
      return
    }

    const updatesByFile = new Map<string, Uint8Array[]>()
    for (const event of result.events) {
      if (event.type === 'content.loroUpdate' && event.loroUpdateB64) {
        const bucket = updatesByFile.get(event.fileId) ?? []
        bucket.push(base64ToBytes(event.loroUpdateB64))
        updatesByFile.set(event.fileId, bucket)
      } else if (event.type === 'create' || event.type === 'rename' || event.type === 'delete') {
        // Forward structural events in seq order; this replay already filled
        // the gap that triggered it, so they reach the tree consumer
        // gap-free and apply incrementally (ISSUE-0048 Phase B).
        this.#emit({ type: 'tree-event', event })
      }
    }

    for (const [fileId, updates] of updatesByFile) {
      const file = this.#files.get(fileId)
      if (!file) continue // Unknown file: tree ops are out of V1 scope.
      const status = file.client.importRemoteUpdates(updates)
      if (status.pending) {
        await this.#repairFromSnapshot(fileId, 'import-pending')
      }
      if (status.changed) this.#emit({ type: 'file-changed', fileId, reason: 'remote-update' })
      await this.#persistFile(fileId)
    }

    this.#state.lastAckedSeq = result.currentSeq
    await this.#store.setLastAckedSeq(result.currentSeq)
  }

  async #handleLiveEvent(event: WireWorkspaceEvent): Promise<void> {
    if (!this.#state || event.seq === undefined) return
    if (event.seq <= this.#state.lastAckedSeq) return

    if (event.seq > this.#state.lastAckedSeq + 1) {
      // Gap (dropped or out-of-order broadcast): fill via replay, which
      // also covers this event.
      await this.#pull()
      return
    }

    if (event.type === 'content.loroUpdate' && event.loroUpdateB64) {
      const file = this.#files.get(event.fileId)
      if (file) {
        const status = file.client.importRemoteUpdates([base64ToBytes(event.loroUpdateB64)])
        if (status.pending) {
          await this.#repairFromSnapshot(event.fileId, 'import-pending')
        }
        if (status.changed) {
          this.#emit({ type: 'file-changed', fileId: event.fileId, reason: 'remote-update' })
        }
        await this.#persistFile(event.fileId)
      }
    } else if (event.type === 'create' || event.type === 'rename' || event.type === 'delete') {
      // Contiguous with the cursor (the gap branch above pulled otherwise),
      // so this structural event reaches the tree consumer in seq order
      // (ISSUE-0048 Phase B).
      this.#emit({ type: 'tree-event', event })
    }

    this.#state.lastAckedSeq = event.seq
    await this.#store.setLastAckedSeq(event.seq)
  }

  /**
   * Snapshot repair: rebuild the doc from a fresh server snapshot,
   * re-applying any unacked local text on top (Loro diffs minimally), then
   * reconnect the push pipeline so it retransmits under new opIds.
   */
  async #repairFromSnapshot(
    fileId: string,
    reason: 'history-pruned' | 'import-pending',
  ): Promise<void> {
    const file = this.#files.get(fileId)
    if (!file) return

    const localText = file.client.hasPendingChanges() ? file.client.getTextContent() : null
    file.client.disconnect()
    this.#files.delete(fileId)

    const snapshot = await this.#options.transport.fetchSnapshot(fileId)
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    const client = await this.#attachFile(fileId, file.path, {
      snapshot,
      syncedVersion: doc.contentVersion(),
    })
    if (localText !== null && localText !== client.getTextContent()) {
      await client.setTextContent(localText)
      await client.flush()
    }
    await this.#persistFile(fileId)
    this.#emit({ type: 'repair', fileId, reason })
  }

  async #persistFile(fileId: string): Promise<void> {
    const file = this.#files.get(fileId)
    if (!file) return
    const doc = file.client.getDoc()
    const synced = file.client.syncedVersion()
    await this.#store.persistFile(
      fileId,
      {
        snapshot: doc.exportSnapshot(),
        syncedVVB64: bytesToBase64(synced ?? doc.contentVersion()),
      },
      {
        path: file.path,
        contentKind: 'markdown',
        lastKnownServerHash: sha256Hex(doc.getTextContent()),
      },
    )
  }

  async #persistAll(): Promise<void> {
    for (const fileId of this.#files.keys()) {
      await this.#persistFile(fileId)
    }
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task, task)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #emit(change: SyncEngineChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change)
      } catch {
        // Listeners must not break the engine.
      }
    }
  }
}
