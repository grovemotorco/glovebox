import {
  base64ToBytes,
  bytesToBase64,
  type LoroRoomTransport,
  type LoroUpdateWireEvent,
  type SubmitUpdateInput,
  type SubmitUpdateResult,
} from '@glovebox.md/sync/loro'
import type { OpaqueManifest } from '@glovebox.md/core'
import type {
  EventsSinceResult,
  WireWorkspaceEvent,
  WorkspacePresenceTransport,
  WorkspacePresenceWireEvent,
  WorkspaceSyncTransport,
} from '@glovebox.md/sync/client'
import type {
  BatchAcceptedOp,
  BatchDeferredOp,
  WorkspaceBatchWireOp,
} from '@glovebox.md/sync/server'
import { randomUuid } from './random.ts'
import { isTreeWireEvent, type TreeWireEvent } from './tree-events.ts'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

/** Outcome of a `batch.submit` (structural rename / delete ops). */
export type BatchSubmitResult =
  | {
      type: 'ack'
      currentSeq: number
      acceptedOps: BatchAcceptedOp[]
      deferredOps: BatchDeferredOp[]
    }
  | { type: 'rejected'; reason: 'rate-limited' | 'forbidden'; retryAfterSec?: number }

export interface SnapshotSeed {
  observedPath: string
  initialContent?: string
}

interface TransportOptions {
  /** Resolved per (re)connect so short-lived socket tokens stay fresh. */
  getUrl: () => string | Promise<string>
  deviceId: string
  onStatus: (status: ConnectionStatus) => void
}

/**
 * One workspace WebSocket multiplexing Loro room sync and presence.
 * Reconnects with backoff, replays pending submits under their original
 * opId (server idempotency dedupes), and re-snapshots subscribed files
 * after a reconnect to catch up on missed updates.
 */
export class WorkspaceSocketTransport
  implements LoroRoomTransport, WorkspacePresenceTransport, WorkspaceSyncTransport
{
  readonly #options: TransportOptions
  readonly #subscribers = new Map<string, Set<(event: LoroUpdateWireEvent) => void>>()
  readonly #presenceSubscribers = new Set<(event: WorkspacePresenceWireEvent) => void>()
  readonly #treeSubscribers = new Set<(event: TreeWireEvent) => void>()
  readonly #eventSubscribers = new Set<(event: WireWorkspaceEvent) => void>()
  readonly #snapshotSeeds = new Map<string, SnapshotSeed>()
  readonly #outbox: unknown[] = []
  readonly #pending = new Map<
    string,
    {
      resolve: (bytes: Uint8Array) => void
      reject: (error: Error) => void
    }
  >()
  readonly #pendingSubmits = new Map<
    string,
    {
      resolve: (result: SubmitUpdateResult) => void
      reject: (error: Error) => void
    }
  >()
  readonly #pendingBatches = new Map<
    string,
    {
      resolve: (result: BatchSubmitResult) => void
      reject: (error: Error) => void
    }
  >()
  readonly #pendingEvents = new Map<
    string,
    {
      resolve: (result: EventsSinceResult) => void
      reject: (error: Error) => void
    }
  >()
  #ws: WebSocket | null = null
  #ready: Promise<bigint> | null = null
  #readyResolve: ((peerId: bigint) => void) | null = null
  #closed = false
  #reconnectTimer: number | null = null

  constructor(options: TransportOptions) {
    this.#options = options
    this.#connect()
  }

  /**
   * Seed metadata for a file's first snapshot request. `snapshot.get` is the
   * create surface on this wire: a path + initial content here is how a new
   * file enters the workspace tree.
   */
  registerSnapshotSeed(fileId: string, seed: SnapshotSeed): void {
    this.#snapshotSeeds.set(fileId, seed)
  }

  async assignSessionPeerId(): Promise<bigint> {
    return this.#waitUntilReady()
  }

  async fetchSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    await this.#waitUntilReady()
    return this.#requestSnapshot(fileId, initialContent, observedPath)
  }

  async eventsSince(afterSeq: number): Promise<EventsSinceResult> {
    await this.#waitUntilReady()
    const requestId = randomUuid()
    const promise = new Promise<EventsSinceResult>((resolve, reject) => {
      this.#pendingEvents.set(requestId, { resolve, reject })
    })
    this.#sendWhenReady({ type: 'events.since', requestId, afterSeq })
    return promise
  }

  async submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    const promise = new Promise<SubmitUpdateResult>((resolve, reject) => {
      this.#pendingSubmits.set(input.opId, { resolve, reject })
    })
    this.#sendWhenReady({
      type: 'content.submit',
      fileId: input.fileId,
      observedPath: input.observedPath,
      opId: input.opId,
      baseContentVersionB64: bytesToBase64(input.baseContentVersion),
      loroUpdateB64: bytesToBase64(input.loroUpdate),
    })
    return promise
  }

  /**
   * Submit structural tree ops (rename / delete intents). Correlated by
   * `requestId`; the server adjudicates per-op `baseSeq` (INV-3) and returns
   * accepted/deferred ops, so a stale baseSeq surfaces as a deferred op rather
   * than a thrown error.
   */
  async submitBatch(ops: WorkspaceBatchWireOp[]): Promise<BatchSubmitResult> {
    await this.#waitUntilReady()
    const requestId = randomUuid()
    const promise = new Promise<BatchSubmitResult>((resolve, reject) => {
      this.#pendingBatches.set(requestId, { resolve, reject })
    })
    this.#sendWhenReady({ type: 'batch.submit', requestId, ops })
    return promise
  }

  subscribe(fileId: string, handler: (event: LoroUpdateWireEvent) => void): () => void {
    let bucket = this.#subscribers.get(fileId)
    if (!bucket) {
      bucket = new Set()
      this.#subscribers.set(fileId, bucket)
    }
    bucket.add(handler)
    return () => bucket?.delete(handler)
  }

  sendPresence(stateJson: string): void {
    this.#sendWhenReady({ type: 'presence.set', stateJson })
  }

  async fetchPresenceState(): Promise<Uint8Array> {
    await this.#waitUntilReady()
    const requestId = randomUuid()
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
    })
    this.#sendWhenReady({ type: 'presence.get', requestId })
    return promise
  }

  subscribePresence(handler: (event: WorkspacePresenceWireEvent) => void): () => void {
    this.#presenceSubscribers.add(handler)
    return () => this.#presenceSubscribers.delete(handler)
  }

  subscribeTreeEvents(handler: (event: TreeWireEvent) => void): () => void {
    this.#treeSubscribers.add(handler)
    return () => this.#treeSubscribers.delete(handler)
  }

  subscribeEvents(handler: (event: WireWorkspaceEvent) => void): () => void {
    this.#eventSubscribers.add(handler)
    return () => this.#eventSubscribers.delete(handler)
  }

  close(): void {
    this.#closed = true
    if (this.#reconnectTimer !== null) window.clearTimeout(this.#reconnectTimer)
    this.#ws?.close()
  }

  #connect(): void {
    if (this.#closed) return
    this.#options.onStatus('connecting')
    this.#ready = new Promise((resolve) => {
      this.#readyResolve = resolve
    })
    void this.#openSocket()
  }

  async #openSocket(): Promise<void> {
    let url: string
    try {
      url = await this.#options.getUrl()
    } catch {
      this.#handleClose()
      return
    }
    if (this.#closed) return

    const ws = new WebSocket(url)
    this.#ws = ws
    ws.addEventListener('open', () => {
      this.#send({ type: 'hello', deviceId: this.#options.deviceId })
    })
    ws.addEventListener('message', (event) => this.#handleMessage(String(event.data)))
    ws.addEventListener('close', () => this.#handleClose())
    ws.addEventListener('error', () => this.#handleClose())
  }

  #handleMessage(raw: string): void {
    const message = JSON.parse(raw) as
      | { type: 'ready'; sessionPeerId: string }
      | {
          type: 'snapshot.response'
          requestId: string
          fileId: string
          snapshotB64: string
          contentVersionB64: string
        }
      | {
          type: 'content.loroUpdate'
          fileId: string
          loroUpdateB64: string
          contentVersionB64: string
          originDeviceId?: string
          seq?: number
        }
      | {
          type: 'content.opaqueUpdate'
          fileId: string
          hashHex: string
          sizeBytes: number
          manifest: OpaqueManifest
          originDeviceId?: string
          seq?: number
        }
      | {
          type: 'events.batch'
          requestId: string
          currentSeq: number
          events: WireWorkspaceEvent[]
        }
      | {
          type: 'events.snapshot-required'
          requestId: string
          currentSeq: number
        }
      | { type: 'ack'; opId: string; fileId: string; contentVersionB64: string; applied: boolean }
      | {
          type: 'submit.deferred'
          opId: string
          fileId: string
          reason: 'history-pruned'
          snapshotB64: string
          contentVersionB64: string
        }
      | {
          type: 'submit.rejected'
          opId: string
          fileId: string
          reason: 'too-large' | 'rate-limited' | 'invalid-path'
          retryAfterSec?: number
        }
      | { type: 'presence.update'; dataB64: string }
      | { type: 'presence.leave'; key: string }
      | { type: 'presence.state'; requestId: string; dataB64: string }
      | { type: 'presence.rejected'; reason: 'rate-limited'; retryAfterSec?: number }
      | {
          type: 'batch.ack'
          requestId: string
          currentSeq: number
          acceptedOps: BatchAcceptedOp[]
          deferredOps: BatchDeferredOp[]
        }
      | {
          type: 'batch.rejected'
          requestId: string
          reason: 'rate-limited' | 'forbidden'
          retryAfterSec?: number
        }
      | TreeWireEvent
      | { type: 'error'; message: string; requestId?: string }

    if (message.type === 'ready') {
      // Reconnect recovery is the engine's job: the worker re-pulls through
      // the single workspace-seq cursor on reopen (ISSUE-0048 Phase B). The
      // old per-file snapshot catch-up is gone — the engine owns imports.
      this.#options.onStatus('open')
      this.#readyResolve?.(BigInt(message.sessionPeerId))
      this.#flushOutbox()
      return
    }

    if (message.type === 'snapshot.response') {
      const pending = this.#pending.get(message.requestId)
      if (!pending) return
      this.#pending.delete(message.requestId)
      pending.resolve(base64ToBytes(message.snapshotB64))
      return
    }

    if (message.type === 'events.batch') {
      const pending = this.#pendingEvents.get(message.requestId)
      if (!pending) return
      this.#pendingEvents.delete(message.requestId)
      pending.resolve({
        ok: true,
        currentSeq: message.currentSeq,
        events: message.events,
      })
      return
    }

    if (message.type === 'events.snapshot-required') {
      const pending = this.#pendingEvents.get(message.requestId)
      if (!pending) return
      this.#pendingEvents.delete(message.requestId)
      pending.resolve({
        ok: false,
        reason: 'snapshot-required',
        currentSeq: message.currentSeq,
      })
      return
    }

    if (message.type === 'content.loroUpdate') {
      this.#dispatchEvent(message)
      this.#dispatch(message)
      return
    }

    if (message.type === 'content.opaqueUpdate') {
      this.#dispatchEvent(message)
      return
    }

    if (isTreeWireEvent(message)) {
      this.#dispatchEvent(message)
      this.#dispatchTree(message)
      return
    }

    if (message.type === 'presence.update') {
      this.#dispatchPresence({ type: 'update', data: base64ToBytes(message.dataB64) })
      return
    }

    if (message.type === 'presence.leave') {
      this.#dispatchPresence({ type: 'leave', key: message.key })
      return
    }

    if (message.type === 'presence.state') {
      const pending = this.#pending.get(message.requestId)
      if (!pending) return
      this.#pending.delete(message.requestId)
      pending.resolve(base64ToBytes(message.dataB64))
      return
    }

    if (message.type === 'presence.rejected') {
      // Fire-and-forget: the heartbeat republishes after the window.
      return
    }

    if (message.type === 'ack') {
      const pending = this.#pendingSubmits.get(message.opId)
      if (!pending) return
      this.#pendingSubmits.delete(message.opId)
      pending.resolve({
        type: 'ack',
        applied: message.applied,
        contentVersionB64: message.contentVersionB64,
      })
      return
    }

    if (message.type === 'submit.deferred') {
      const pending = this.#pendingSubmits.get(message.opId)
      if (!pending) return
      this.#pendingSubmits.delete(message.opId)
      pending.resolve({
        type: 'deferred',
        reason: message.reason,
        snapshotB64: message.snapshotB64,
        contentVersionB64: message.contentVersionB64,
      })
      return
    }

    if (message.type === 'submit.rejected') {
      const pending = this.#pendingSubmits.get(message.opId)
      if (!pending) return
      this.#pendingSubmits.delete(message.opId)
      pending.resolve({
        type: 'rejected',
        reason: message.reason,
        retryAfterSec: message.retryAfterSec,
      })
      return
    }

    if (message.type === 'batch.ack') {
      const pending = this.#pendingBatches.get(message.requestId)
      if (!pending) return
      this.#pendingBatches.delete(message.requestId)
      pending.resolve({
        type: 'ack',
        currentSeq: message.currentSeq,
        acceptedOps: message.acceptedOps,
        deferredOps: message.deferredOps,
      })
      return
    }

    if (message.type === 'batch.rejected') {
      const pending = this.#pendingBatches.get(message.requestId)
      if (!pending) return
      this.#pendingBatches.delete(message.requestId)
      pending.resolve({
        type: 'rejected',
        reason: message.reason,
        retryAfterSec: message.retryAfterSec,
      })
      return
    }

    if (message.type === 'error' && message.requestId) {
      const pending = this.#pending.get(message.requestId)
      if (pending) {
        this.#pending.delete(message.requestId)
        pending.reject(new Error(message.message))
        return
      }
      const pendingBatch = this.#pendingBatches.get(message.requestId)
      if (pendingBatch) {
        this.#pendingBatches.delete(message.requestId)
        pendingBatch.reject(new Error(message.message))
        return
      }
      const pendingEvents = this.#pendingEvents.get(message.requestId)
      if (pendingEvents) {
        this.#pendingEvents.delete(message.requestId)
        pendingEvents.reject(new Error(message.message))
      }
    }
  }

  #handleClose(): void {
    if (this.#closed) return
    this.#options.onStatus('closed')
    this.#rejectPendingRequests(new Error('WebSocket closed before response'))
    this.#ready = new Promise((resolve) => {
      this.#readyResolve = resolve
    })
    if (this.#reconnectTimer === null) {
      this.#reconnectTimer = window.setTimeout(() => {
        this.#reconnectTimer = null
        this.#connect()
      }, 500)
    }
  }

  async #waitUntilReady(): Promise<bigint> {
    if (!this.#ready) this.#connect()
    return this.#ready!
  }

  #requestSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    const requestId = randomUuid()
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
    })
    const registeredSeed = this.#snapshotSeeds.get(fileId)
    const seed =
      observedPath !== undefined || initialContent !== undefined
        ? {
            observedPath: observedPath ?? registeredSeed?.observedPath ?? `${fileId}.md`,
            initialContent,
          }
        : registeredSeed
    this.#sendWhenReady({
      type: 'snapshot.get',
      requestId,
      fileId,
      ...(seed ? { observedPath: seed.observedPath, initialContent: seed.initialContent } : {}),
    })
    return promise
  }

  #dispatch(event: LoroUpdateWireEvent): void {
    const bucket = this.#subscribers.get(event.fileId)
    if (!bucket) return
    for (const handler of bucket) handler(event)
  }

  #dispatchEvent(event: WireWorkspaceEvent): void {
    for (const handler of this.#eventSubscribers) handler(event)
  }

  #dispatchPresence(event: WorkspacePresenceWireEvent): void {
    for (const handler of this.#presenceSubscribers) handler(event)
  }

  #dispatchTree(event: TreeWireEvent): void {
    for (const handler of this.#treeSubscribers) handler(event)
  }

  #send(message: unknown): void {
    this.#ws?.send(JSON.stringify(message))
  }

  #sendWhenReady(message: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#send(message)
      return
    }
    this.#outbox.push(message)
  }

  #flushOutbox(): void {
    while (this.#outbox.length > 0 && this.#ws?.readyState === WebSocket.OPEN) {
      this.#send(this.#outbox.shift())
    }
  }

  #rejectPendingRequests(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error)
    }
    this.#pending.clear()
    // Rejecting a submit tells the room client the outcome is unknown; it
    // keeps the flight and retransmits under the same opId after reconnect.
    for (const pending of this.#pendingSubmits.values()) {
      pending.reject(error)
    }
    this.#pendingSubmits.clear()
    // Batch ops are not auto-retried; a rejection surfaces to the caller,
    // which refreshes the tree and lets the user retry.
    for (const pending of this.#pendingBatches.values()) {
      pending.reject(error)
    }
    this.#pendingBatches.clear()
    for (const pending of this.#pendingEvents.values()) {
      pending.reject(error)
    }
    this.#pendingEvents.clear()
  }
}
