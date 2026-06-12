import {
  base64ToBytes,
  bytesToBase64,
  type LoroRoomTransport,
  type LoroUpdateWireEvent,
  type SubmitUpdateInput,
  type SubmitUpdateResult,
} from '@glovebox/sync/loro'
import type { WorkspacePresenceTransport, WorkspacePresenceWireEvent } from '@glovebox/sync/client'

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

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
export class WorkspaceSocketTransport implements LoroRoomTransport, WorkspacePresenceTransport {
  readonly #options: TransportOptions
  readonly #subscribers = new Map<string, Set<(event: LoroUpdateWireEvent) => void>>()
  readonly #presenceSubscribers = new Set<(event: WorkspacePresenceWireEvent) => void>()
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
  #ws: WebSocket | null = null
  #ready: Promise<bigint> | null = null
  #readyResolve: ((peerId: bigint) => void) | null = null
  #closed = false
  #reconnectTimer: number | null = null
  #catchingUp = false
  #hasOpened = false
  /** Last per-file seq seen on a broadcast `content.loroUpdate`. */
  readonly #lastContentSeq = new Map<string, number>()

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

  async fetchSnapshot(fileId: string): Promise<Uint8Array> {
    await this.#waitUntilReady()
    return this.#requestSnapshot(fileId)
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
    const requestId = crypto.randomUUID()
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
      | { type: 'error'; message: string; requestId?: string }

    if (message.type === 'ready') {
      const wasReconnect = this.#hasOpened
      this.#hasOpened = true
      this.#options.onStatus('open')
      this.#readyResolve?.(BigInt(message.sessionPeerId))
      this.#flushOutbox()
      if (wasReconnect) void this.#catchUpSubscribedFiles().catch(() => {})
      return
    }

    if (message.type === 'snapshot.response') {
      const pending = this.#pending.get(message.requestId)
      if (!pending) return
      this.#pending.delete(message.requestId)
      pending.resolve(base64ToBytes(message.snapshotB64))
      return
    }

    if (message.type === 'content.loroUpdate') {
      this.#noteContentSeq(message.fileId, message.seq)
      this.#dispatch(message)
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

    if (message.type === 'error' && message.requestId) {
      const pending = this.#pending.get(message.requestId)
      if (pending) {
        this.#pending.delete(message.requestId)
        pending.reject(new Error(message.message))
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

  #requestSnapshot(fileId: string): Promise<Uint8Array> {
    const requestId = crypto.randomUUID()
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
    })
    const seed = this.#snapshotSeeds.get(fileId)
    this.#sendWhenReady({
      type: 'snapshot.get',
      requestId,
      fileId,
      ...(seed ? { observedPath: seed.observedPath, initialContent: seed.initialContent } : {}),
    })
    return promise
  }

  async #catchUpSubscribedFiles(): Promise<void> {
    if (this.#catchingUp) return
    if (this.#ws?.readyState !== WebSocket.OPEN) return

    this.#catchingUp = true
    try {
      await this.#waitUntilReady()
      for (const fileId of this.#subscribers.keys()) {
        await this.#catchUpFile(fileId)
      }
    } catch {
      // Opportunistic; the next reconnect (or seq gap) retries.
    } finally {
      this.#catchingUp = false
    }
  }

  /** Re-snapshot one file and replay it through the normal update path. */
  async #catchUpFile(fileId: string): Promise<void> {
    const snapshot = await this.#requestSnapshot(fileId)
    this.#dispatch({
      type: 'content.loroUpdate',
      fileId,
      loroUpdateB64: bytesToBase64(snapshot),
      contentVersionB64: '',
    })
  }

  /**
   * Per-file broadcast seqs are contiguous on a healthy socket; a jump means
   * we missed an update (or a tree event consumed the counter) — re-snapshot
   * that file rather than polling everything on a timer.
   */
  #noteContentSeq(fileId: string, seq: number | undefined): void {
    if (typeof seq !== 'number') return
    const last = this.#lastContentSeq.get(fileId)
    this.#lastContentSeq.set(fileId, seq)
    if (last !== undefined && seq > last + 1 && this.#subscribers.has(fileId)) {
      void this.#catchUpFile(fileId).catch(() => {})
    }
  }

  #dispatch(event: LoroUpdateWireEvent): void {
    const bucket = this.#subscribers.get(event.fileId)
    if (!bucket) return
    for (const handler of bucket) handler(event)
  }

  #dispatchPresence(event: WorkspacePresenceWireEvent): void {
    for (const handler of this.#presenceSubscribers) handler(event)
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
  }
}
