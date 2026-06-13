import { LoroFileDoc } from './file-doc.ts'
import { base64ToBytes } from './base64.ts'
import type { LoroContentVersion, LoroSnapshot, LoroUpdate } from './types.ts'

export { base64ToBytes, bytesToBase64 } from './base64.ts'

/**
 * Wire event shape that arrives over the workspace WebSocket. Mirrors the
 * `content.loroUpdate` variant of `WorkspaceChangeEvent` from `@glovebox/core`,
 * but kept narrow here so this module has no dependency on the workspace
 * tree event types.
 */
export interface LoroUpdateWireEvent {
  type: 'content.loroUpdate'
  fileId: string
  loroUpdateB64: string
  contentVersionB64: string
  originDeviceId?: string
  seq?: number
}

/**
 * Server response to a submit. `ack` confirms the server holds everything up
 * to the submitted version (`applied: false` means it already knew the ops —
 * e.g. an idempotent replay). `deferred` means nothing was applied and the
 * client must repair from the included snapshot before submitting again.
 */
export type SubmitUpdateResult =
  | { type: 'ack'; applied: boolean; contentVersionB64: string }
  | {
      type: 'deferred'
      reason: 'history-pruned'
      snapshotB64: string
      contentVersionB64: string
    }
  /**
   * Refused by server policy, nothing applied. `rate-limited` is retryable;
   * anything else is permanent for this payload.
   */
  | {
      type: 'rejected'
      reason: 'too-large' | 'rate-limited' | 'invalid-path' | 'forbidden'
      retryAfterSec?: number
    }

export interface LoroRoomTransport {
  /**
   * Optional server-minted Loro peer ID for this connection/session. When
   * present, the room client applies it before producing local ops.
   */
  assignSessionPeerId?(): Promise<bigint>
  /**
   * Submit a Loro update batch to the server and resolve with its ack or
   * deferral. A rejection means the outcome is unknown (transport failure);
   * the room client retransmits the identical payload under the same opId,
   * which the server's idempotency store makes safe.
   */
  submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult>
  /** Subscribe to incoming `content.loroUpdate` events for one fileId. */
  subscribe(fileId: string, handler: (event: LoroUpdateWireEvent) => void): () => void
  /** Fetch the current canonical snapshot for the file (initial hydrate). */
  fetchSnapshot(fileId: string): Promise<LoroSnapshot>
}

export interface SubmitUpdateInput {
  fileId: string
  baseContentVersion: LoroContentVersion
  loroUpdate: LoroUpdate
  observedPath: string
  /** Idempotency key — repeats are no-ops on the server. */
  opId: string
}

export interface LoroRoomClientOptions {
  fileId: string
  observedPath: string
  /**
   * Stable device identity, forwarded for diagnostics/bookkeeping. Echoes are
   * NOT filtered by it (tabs of one profile share a deviceId); see
   * `#handleIncoming` — import idempotency suppresses them instead.
   */
  deviceId: string
  transport: LoroRoomTransport
  /**
   * Hydrate from a locally persisted snapshot+watermark pair (IndexedDB
   * reconcile) instead of fetching the server snapshot on connect. The
   * watermark must come from the SAME persisted record as the snapshot;
   * unacked ops contained in the snapshot stay pending and retransmit.
   */
  hydrate?: { snapshot: LoroSnapshot; syncedVersion: LoroContentVersion }
  /** Test override for opId generation. */
  newOpId?: () => string
}

/**
 * Browser-side client for a single Loro-backed file. Maintains a local
 * `LoroFileDoc`, submits user edits to the server, and applies remote updates
 * received via the workspace WebSocket. Editor integration is out of scope —
 * `getTextContent` / `setTextContent` are the user-facing surface.
 */
export class LoroRoomClient {
  readonly #options: Required<Pick<LoroRoomClientOptions, 'newOpId'>> &
    Omit<LoroRoomClientOptions, 'newOpId'>
  #observedPath: string
  #doc: LoroFileDoc | null = null
  #unsubscribe: (() => void) | null = null
  #initialized = false
  #initPromise: Promise<void> | null = null
  #sessionPeerId: bigint | undefined
  /**
   * Last server-confirmed version. Advanced only when a submit is acked —
   * pending work is always derived as `doc.contentVersion() ≠ #syncedVersion`
   * (INV-6), never queued separately.
   */
  #syncedVersion: LoroContentVersion | null = null
  /**
   * The one unacknowledged submit. Kept byte-identical across transport
   * failures so retransmission reuses the same opId (server idempotency
   * replays the original ack if the first attempt actually landed).
   */
  #inFlight: {
    opId: string
    base: LoroContentVersion
    update: LoroUpdate
    target: LoroContentVersion
  } | null = null
  #repairNeeded = false
  #unsubscribeLocalUpdates: (() => void) | null = null
  #submitQueue: Promise<void> = Promise.resolve()
  readonly #listeners = new Set<(event: LoroRoomChangeReason) => void>()

  constructor(options: LoroRoomClientOptions) {
    this.#options = {
      ...options,
      newOpId: options.newOpId ?? defaultOpId,
    }
    this.#observedPath = options.observedPath
  }

  /**
   * Connect to the room: fetch the canonical snapshot, hydrate the local doc,
   * subscribe to incoming updates. Idempotent — concurrent connects share the
   * same in-flight initialization promise.
   */
  async connect(): Promise<void> {
    if (this.#initialized) return
    if (!this.#initPromise) {
      this.#initPromise = this.#initialize().catch((error: unknown) => {
        this.#initialized = false
        this.#initPromise = null
        this.#doc = null
        this.#syncedVersion = null
        throw error
      })
    }
    return this.#initPromise
  }

  async #initialize(): Promise<void> {
    this.#sessionPeerId = await this.#options.transport.assignSessionPeerId?.()
    if (this.#options.hydrate) {
      this.#doc = LoroFileDoc.fromSnapshot(this.#options.hydrate.snapshot, {
        peerId: this.#sessionPeerId,
      })
      this.#syncedVersion = this.#options.hydrate.syncedVersion
    } else {
      const snapshot = await this.#options.transport.fetchSnapshot(this.#options.fileId)
      this.#doc = LoroFileDoc.fromSnapshot(snapshot, { peerId: this.#sessionPeerId })
      this.#syncedVersion = this.#doc.contentVersion()
    }
    this.#inFlight = null
    this.#repairNeeded = false
    this.#unsubscribeLocalUpdates = subscribeLocalUpdates(this.#doc, () => {
      this.#scheduleSubmit()
    })
    this.#unsubscribe = this.#options.transport.subscribe(this.#options.fileId, (event) =>
      this.#handleIncoming(event),
    )
    this.#initialized = true
    this.#emit('connected')
  }

  disconnect(): void {
    this.#unsubscribeLocalUpdates?.()
    this.#unsubscribeLocalUpdates = null
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#initialized = false
    this.#initPromise = null
    this.#doc = null
    this.#syncedVersion = null
    this.#inFlight = null
    this.#repairNeeded = false
  }

  /**
   * Apply a user edit. Runs the diff through Loro (preserving CRDT semantics),
   * exports the update bytes, and submits to the server. The server will
   * eventually echo the canonical update back; importing that echo is a
   * version-vector no-op.
   */
  async setTextContent(content: string): Promise<void> {
    this.#requireConnected()
    const doc = this.#doc!
    doc.setTextContent(content)
    await this.#submitQueue
  }

  getTextContent(): string {
    this.#requireConnected()
    return this.#doc!.getTextContent()
  }

  getDoc(): LoroFileDoc {
    this.#requireConnected()
    return this.#doc!
  }

  /** Subscribe to local + remote text changes (any cause). */
  onChange(listener: (reason: LoroRoomChangeReason) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #handleIncoming(event: LoroUpdateWireEvent): void {
    if (!this.#doc) return
    if (event.fileId !== this.#options.fileId) return

    const bytes = base64ToBytes(event.loroUpdateB64)
    if (bytes.byteLength === 0) return

    // Own echoes are NOT filtered by originDeviceId: two tabs of one browser
    // profile share a deviceId, so device-based suppression silently dropped
    // the other tab's edits. Importing an echo of ops this doc already holds
    // is a version-vector no-op (changed=false, no emit) — idempotency is the
    // suppression. The compare below is versions only; materializing the full
    // text here would make every remote keystroke O(doc).
    this.importRemoteUpdates([bytes])
  }

  /**
   * Import server-originated update bytes into the open doc and surface
   * Loro's pending-dependency signal to the owner of the workspace cursor.
   */
  importRemoteUpdates(updates: readonly (LoroUpdate | LoroSnapshot)[]): {
    changed: boolean
    pending: boolean
  } {
    this.#requireConnected()
    const status = this.#doc!.importBatchWithStatus(updates)
    if (status.changed) this.#emit('remote-update')
    return status
  }

  /** Keep future submits aligned with the tree row after a live rename. */
  setObservedPath(path: string): void {
    this.#observedPath = path
  }

  /** Server-confirmed watermark; null before connect. */
  syncedVersion(): LoroContentVersion | null {
    return this.#syncedVersion
  }

  /**
   * Whether the local doc holds ops the server has not acknowledged yet
   * (including a submit that is still in flight or awaiting retransmission).
   */
  hasPendingChanges(): boolean {
    if (!this.#doc || !this.#syncedVersion) return false
    return !versionsEqual(this.#syncedVersion, this.#doc.contentVersion())
  }

  /**
   * Drive the submit pipeline until everything pending is acked, a transport
   * error leaves a retransmission waiting for the next flush, or a deferral
   * requires repair. Never rejects.
   */
  flush(): Promise<void> {
    this.#scheduleSubmit()
    return this.#submitQueue
  }

  #scheduleSubmit(): void {
    this.#submitQueue = this.#submitQueue.then(() => this.#drainSubmits()).catch(() => {})
  }

  async #drainSubmits(): Promise<void> {
    while (this.#doc && this.#syncedVersion && !this.#repairNeeded) {
      if (!this.#inFlight) {
        if (!this.hasPendingChanges()) return
        const update = this.#doc.exportUpdateSince(this.#syncedVersion)
        if (update.byteLength === 0) return
        this.#inFlight = {
          opId: this.#options.newOpId(),
          base: this.#syncedVersion,
          update,
          target: this.#doc.contentVersion(),
        }
      }

      const flight = this.#inFlight
      let result: SubmitUpdateResult
      try {
        result = await this.#options.transport.submitUpdate({
          fileId: this.#options.fileId,
          baseContentVersion: flight.base,
          loroUpdate: flight.update,
          observedPath: this.#observedPath,
          opId: flight.opId,
        })
      } catch {
        // Outcome unknown — keep the flight byte-identical for the next
        // flush/edit so the server's idempotency store can dedupe.
        this.#emit('submit-error')
        return
      }

      if (result.type === 'deferred') {
        // Our base predates the server's history floor. Nothing we export
        // from this doc can apply anymore; stop submitting until the repair
        // path (M2 pull) resets the doc from the returned snapshot.
        this.#inFlight = null
        this.#repairNeeded = true
        this.#emit('history-pruned')
        return
      }

      if (result.type === 'rejected') {
        if (result.reason === 'rate-limited') {
          // Keep the flight byte-identical; a later flush/edit retries once
          // the window drains.
          this.#emit('submit-error')
          return
        }
        // Permanent refusal for this payload (too-large). Keep the ops local
        // but suspend auto-submit; the app must shrink the doc or repair.
        this.#inFlight = null
        this.#repairNeeded = true
        this.#emit('submit-error')
        return
      }

      // The flight covered the doc up to its export-time version; only an
      // ack moves the synced watermark (never optimistic).
      this.#syncedVersion = flight.target
      this.#inFlight = null
      this.#emit('local-edit')
    }
  }

  #requireConnected(): void {
    if (!this.#initialized || !this.#doc) {
      throw new Error('LoroRoomClient is not connected; call connect() first.')
    }
  }

  #emit(reason: LoroRoomChangeReason): void {
    for (const listener of this.#listeners) {
      try {
        listener(reason)
      } catch {
        // Don't let one bad listener kill the room.
      }
    }
  }
}

export type LoroRoomChangeReason =
  | 'connected'
  | 'local-edit'
  | 'remote-update'
  /** A submit failed in transport; the payload is held for retransmission. */
  | 'submit-error'
  /**
   * The server deferred our submit with `history-pruned`. Local pending ops
   * cannot apply until the doc is reset from a fresh server snapshot (the M2
   * pull/repair path); auto-submit is suspended until reconnect.
   */
  | 'history-pruned'

function defaultOpId(): string {
  // Best-effort cross-runtime UUID v4 — falls back to randomBytes when
  // crypto.randomUUID is unavailable.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function versionsEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function subscribeLocalUpdates(
  doc: LoroFileDoc,
  handler: (update: LoroUpdate) => void,
): () => void {
  const rawDoc = doc.unwrap() as unknown as {
    subscribeLocalUpdates?: (handler: (update: LoroUpdate) => void) => () => void
  }
  if (typeof rawDoc.subscribeLocalUpdates !== 'function') {
    return () => {}
  }
  return rawDoc.subscribeLocalUpdates(handler)
}
