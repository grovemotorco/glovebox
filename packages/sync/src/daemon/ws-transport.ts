import type { EventsSinceResult, WireWorkspaceEvent } from '../client/sync-engine.ts'
import type { SubmitUpdateInput, SubmitUpdateResult } from '../loro/room-client.ts'
import type { WorkspaceBatchWireOp, WorkspaceServerMessage } from '../server/workspace-server.ts'
import { base64ToBytes, bytesToBase64 } from '../loro/base64.ts'
import {
  assembleOpaqueWirePayload,
  buildOpaqueWirePayload,
  type OpaqueObjectPayload,
} from '../opaque-wire.ts'
import type {
  BatchSubmitResult,
  DaemonTransport,
  DaemonTreeState,
  OpaqueFetchResult,
  SubmitOpaqueInput,
  SubmitOpaqueResult,
} from './sync-engine.ts'

/**
 * `DaemonTransport` over a real WebSocket (M8). The daemon is cycle-driven,
 * not broadcast-driven — the socket is a request/response channel
 * (`requestId` correlation for snapshot.get / events.since / batch.submit,
 * `opId` for content.submit), and incoming broadcasts are surfaced only as
 * `onHint` for a debounced `runner.kick()` (INV-8: hints carry zero
 * correctness weight; the jittered rescan loop is the backstop).
 *
 * Failure model: in-flight requests reject when the socket closes or the
 * connection attempt they parked on fails. The engine and `LoroRoomClient`
 * already treat rejection as outcome-unknown and retransmit byte-identical
 * flights under the same opId — the server's idempotency store (M0.2)
 * makes that safe, so this transport never queues or replays anything
 * itself.
 *
 * Close-code policy: 4401 (unauthenticated) fires `onAuthRequired` and
 * keeps reconnecting — `url()` is resolved fresh per attempt, so a
 * re-minted token heals the connection without restarting the daemon.
 * 4403 (access-revoked) and 4410 (workspace-deleted) are terminal: the
 * transport stops, rejects everything in flight, and reports via
 * `onStopped`. Anything else is a transient failure → backoff + jitter
 * reconnect, `onConnect` on success (the CLI kicks a cycle there).
 *
 * Also implements the browser engine's `WorkspaceSyncTransport` shape
 * (`subscribeEvents`) — same wire, same mapping — so a `WorkspaceSyncEngine`
 * can ride a live socket in tests and tools.
 */

export type WsTransportStopReason = 'access-revoked' | 'workspace-deleted'

export const WS_CLOSE_UNAUTHENTICATED = 4401
export const WS_CLOSE_ACCESS_REVOKED = 4403
export const WS_CLOSE_WORKSPACE_DELETED = 4410

export interface WsDaemonTransportOptions {
  /**
   * WS endpoint, resolved fresh for every connection attempt (re-reads or
   * re-mints the token after a 4401). May throw to signal "no credentials
   * right now" — the attempt fails and backoff continues.
   */
  url: () => string | Promise<string>
  /** 4401 received: the token was rejected after upgrade. */
  onAuthRequired?: (reason: string) => void
  /** 4403/4410 received: terminal — the transport has stopped. */
  onStopped?: (reason: WsTransportStopReason, code: number) => void
  /** A broadcast arrived — debounce into `runner.kick()`. */
  onHint?: (event: WireWorkspaceEvent) => void
  /** Connection (re)established — a good moment to kick a cycle. */
  onConnect?: () => void
  backoffInitialMs?: number
  backoffMaxMs?: number
  /** Uniform [0,1) jitter source (seeded in tests). */
  random?: () => number
  /** Defaults to `globalThis.WebSocket` (Node ≥ 22, browsers). */
  WebSocketImpl?: typeof WebSocket
  /** Timer injection for tests. */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface PendingRequest<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export class WsDaemonTransport implements DaemonTransport {
  readonly #options: WsDaemonTransportOptions
  readonly #WebSocketImpl: typeof WebSocket
  readonly #backoffInitialMs: number
  readonly #backoffMaxMs: number
  readonly #random: () => number
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void

  readonly #pendingSnapshots = new Map<string, PendingRequest<Uint8Array>>()
  readonly #pendingEvents = new Map<string, PendingRequest<EventsSinceResult>>()
  readonly #pendingBatches = new Map<string, PendingRequest<BatchSubmitResult>>()
  readonly #pendingSubmits = new Map<string, PendingRequest<SubmitUpdateResult>>()
  readonly #pendingOpaqueSubmits = new Map<string, PendingRequest<SubmitOpaqueResult>>()
  readonly #pendingOpaqueGets = new Map<string, PendingRequest<OpaqueFetchResult>>()
  readonly #pendingOpaqueGetObjects = new Map<string, OpaqueObjectPayload[]>()
  readonly #pendingTrees = new Map<string, PendingRequest<DaemonTreeState>>()
  readonly #eventHandlers = new Set<(event: WireWorkspaceEvent) => void>()

  #socket: WebSocket | null = null
  #connectAttempt: Promise<WebSocket> | null = null
  #reconnectTimer: unknown = null
  #consecutiveFailures = 0
  #stopped: { reason: WsTransportStopReason; code: number } | 'manual' | null = null
  #requestCounter = 0

  constructor(options: WsDaemonTransportOptions) {
    this.#options = options
    const impl = options.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!impl) {
      throw new Error('No WebSocket implementation available; pass WebSocketImpl')
    }
    this.#WebSocketImpl = impl
    this.#backoffInitialMs = options.backoffInitialMs ?? 500
    this.#backoffMaxMs = options.backoffMaxMs ?? 30_000
    this.#random = options.random ?? Math.random
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number))
  }

  // --- DaemonTransport ------------------------------------------------------

  async fetchSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    const requestId = this.#nextRequestId()
    return this.#request(this.#pendingSnapshots, requestId, {
      type: 'snapshot.get',
      requestId,
      fileId,
      initialContent,
      observedPath,
    })
  }

  async eventsSince(afterSeq: number): Promise<EventsSinceResult> {
    const requestId = this.#nextRequestId()
    return this.#request(this.#pendingEvents, requestId, {
      type: 'events.since',
      requestId,
      afterSeq,
    })
  }

  async submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    return this.#request(this.#pendingSubmits, input.opId, {
      type: 'content.submit',
      fileId: input.fileId,
      observedPath: input.observedPath,
      opId: input.opId,
      baseContentVersionB64: bytesToBase64(input.baseContentVersion),
      loroUpdateB64: bytesToBase64(input.loroUpdate),
    })
  }

  async submitOpaque(input: SubmitOpaqueInput): Promise<SubmitOpaqueResult> {
    const payload = buildOpaqueWirePayload(input.bytes)
    return this.#request(this.#pendingOpaqueSubmits, input.opId, {
      type: 'opaque.submit',
      fileId: input.fileId,
      observedPath: input.observedPath,
      opId: input.opId,
      baseHashHex: input.baseHashHex,
      hashHex: payload.hashHex,
      sizeBytes: payload.sizeBytes,
      manifest: payload.manifest,
      objects: payload.objects,
    })
  }

  async fetchOpaque(
    fileId: string,
    existingBytes?: Uint8Array,
    options: { metadataOnly?: boolean } = {},
  ): Promise<OpaqueFetchResult> {
    const requestId = this.#nextRequestId()
    const existingPayload =
      existingBytes === undefined || options.metadataOnly === true
        ? undefined
        : buildOpaqueWirePayload(existingBytes)
    if (existingPayload) {
      this.#pendingOpaqueGetObjects.set(requestId, existingPayload.objects)
    }
    return this.#request(this.#pendingOpaqueGets, requestId, {
      type: 'opaque.get',
      requestId,
      fileId,
      haveObjects: existingPayload?.manifest.chunks.map((chunk) => chunk.hashB64),
      ...(options.metadataOnly === true ? { metadataOnly: true } : {}),
    })
  }

  async listTree(): Promise<DaemonTreeState> {
    const requestId = this.#nextRequestId()
    return this.#request(this.#pendingTrees, requestId, {
      type: 'tree.list',
      requestId,
    })
  }

  async submitBatch(ops: WorkspaceBatchWireOp[]): Promise<BatchSubmitResult> {
    const requestId = this.#nextRequestId()
    return this.#request(this.#pendingBatches, requestId, {
      type: 'batch.submit',
      requestId,
      ops,
    })
  }

  // --- WorkspaceSyncTransport extra ----------------------------------------

  subscribeEvents(handler: (event: WireWorkspaceEvent) => void): () => void {
    this.#eventHandlers.add(handler)
    return () => this.#eventHandlers.delete(handler)
  }

  // --- lifecycle -------------------------------------------------------------

  /** True after a terminal close (4403/4410) or an explicit `stop()`. */
  get stopped(): boolean {
    return this.#stopped !== null
  }

  /** Eagerly establish the connection (requests do this lazily anyway). */
  async connect(): Promise<void> {
    await this.#ensureConnected()
  }

  stop(): void {
    if (this.#stopped === null) {
      this.#stopped = 'manual'
    }
    if (this.#reconnectTimer !== null) {
      this.#clearTimer(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    const socket = this.#socket
    this.#socket = null
    if (socket) {
      try {
        socket.close(1000, 'client stop')
      } catch {
        // Already closing/closed.
      }
    }
    this.#rejectAllPending(new Error('transport stopped'))
  }

  // --- internals -------------------------------------------------------------

  #nextRequestId(): string {
    return `rq-${++this.#requestCounter}`
  }

  async #request<T>(
    pending: Map<string, PendingRequest<T>>,
    key: string,
    message: Record<string, unknown>,
  ): Promise<T> {
    const socket = await this.#ensureConnected()
    return new Promise<T>((resolve, reject) => {
      pending.set(key, { resolve, reject })
      try {
        socket.send(JSON.stringify(message))
      } catch (error) {
        pending.delete(key)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Resolve the current socket, or park on the single in-flight connection
   * attempt. A failed attempt rejects every parked request (outcome-unknown
   * for the caller) while the reconnect schedule keeps running in the
   * background.
   */
  #ensureConnected(): Promise<WebSocket> {
    if (this.#stopped !== null) {
      return Promise.reject(new Error('transport stopped'))
    }
    if (this.#socket && this.#socket.readyState === this.#WebSocketImpl.OPEN) {
      return Promise.resolve(this.#socket)
    }
    this.#connectAttempt ??= this.#connectOnce().finally(() => {
      this.#connectAttempt = null
    })
    return this.#connectAttempt
  }

  async #connectOnce(): Promise<WebSocket> {
    // url() failures (e.g. "no credentials right now") take the SAME path
    // as handshake failures: count, schedule backoff, reject the attempt.
    const socket = await Promise.resolve()
      .then(async () => {
        const url = await this.#options.url()
        return new Promise<WebSocket>((resolve, reject) => {
          let settled = false
          const ws = new this.#WebSocketImpl(url)
          ws.onopen = () => {
            settled = true
            resolve(ws)
          }
          ws.onerror = () => {
            if (!settled) {
              settled = true
              reject(new Error(`WebSocket connection failed: ${url}`))
            }
          }
          ws.onclose = (event) => {
            if (!settled) {
              settled = true
              reject(new Error(`WebSocket closed during connect (${event.code})`))
            }
          }
        })
      })
      .catch((error: unknown) => {
        this.#consecutiveFailures += 1
        this.#scheduleReconnect()
        throw error instanceof Error ? error : new Error(String(error))
      })

    // stop() may have landed while the handshake was in flight.
    if (this.#stopped !== null) {
      try {
        socket.close(1000, 'client stop')
      } catch {
        // Already closing.
      }
      throw new Error('transport stopped')
    }

    // A superseded socket (e.g. stuck in CLOSING while we reconnected) can
    // still hold registered flights and will emit a lagging close. Sweep
    // its pendings NOW and detach it — its close must not touch the new
    // socket's state (#handleClose ignores non-current sockets).
    const superseded = this.#socket
    if (superseded && superseded !== socket) {
      this.#rejectAllPending(new Error('socket superseded by reconnect'))
      try {
        superseded.close(1000, 'superseded')
      } catch {
        // Already closing.
      }
    }

    this.#consecutiveFailures = 0
    this.#socket = socket
    socket.onmessage = (event) => {
      const data: unknown = event.data
      if (typeof data === 'string') {
        this.#handleMessage(data)
      }
    }
    socket.onclose = (event) => this.#handleClose(socket, event.code, event.reason)
    socket.onerror = () => {
      // The paired close event carries the policy; nothing to do here.
    }
    this.#options.onConnect?.()
    return socket
  }

  #handleClose(socket: WebSocket, code: number, reason: string): void {
    if (this.#socket !== socket) {
      // A superseded socket's lagging close: its flights were already
      // swept at replacement time; its policy codes are void — any 4403
      // that matters will also close the CURRENT socket.
      return
    }
    this.#socket = null
    if (this.#stopped !== null) {
      return
    }
    this.#rejectAllPending(new Error(`socket closed (${code}${reason ? `: ${reason}` : ''})`))

    if (code === WS_CLOSE_ACCESS_REVOKED || code === WS_CLOSE_WORKSPACE_DELETED) {
      const stopReason: WsTransportStopReason =
        code === WS_CLOSE_ACCESS_REVOKED ? 'access-revoked' : 'workspace-deleted'
      this.#stopped = { reason: stopReason, code }
      this.#options.onStopped?.(stopReason, code)
      return
    }
    if (code === WS_CLOSE_UNAUTHENTICATED) {
      // Not terminal: url() re-resolves per attempt, so a re-minted token
      // heals the connection. Surface it so the CLI can tell the user.
      this.#options.onAuthRequired?.(reason || 'unauthenticated')
    }
    this.#consecutiveFailures += 1
    this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#stopped !== null || this.#reconnectTimer !== null) {
      return
    }
    const exponent = Math.max(0, this.#consecutiveFailures - 1)
    const base = Math.min(this.#backoffMaxMs, this.#backoffInitialMs * 2 ** exponent)
    // Full jitter: anywhere in [base/2, base].
    const delay = Math.round(base / 2 + (base / 2) * this.#random())
    this.#reconnectTimer = this.#setTimer(() => {
      this.#reconnectTimer = null
      // Background attempt; parked requests share it via #ensureConnected.
      this.#ensureConnected().catch(() => {
        // #connectOnce already scheduled the next attempt.
      })
    }, delay)
  }

  #rejectAllPending(error: Error): void {
    for (const map of [
      this.#pendingSnapshots,
      this.#pendingEvents,
      this.#pendingBatches,
      this.#pendingSubmits,
      this.#pendingOpaqueSubmits,
      this.#pendingOpaqueGets,
      this.#pendingTrees,
    ] as Map<string, PendingRequest<never>>[]) {
      const waiters = [...map.values()]
      map.clear()
      for (const waiter of waiters) {
        waiter.reject(error)
      }
    }
  }

  #handleMessage(data: string): void {
    let message: WorkspaceServerMessage
    try {
      message = JSON.parse(data) as WorkspaceServerMessage
    } catch {
      return
    }
    switch (message.type) {
      case 'snapshot.response': {
        const pending = this.#pendingSnapshots.get(message.requestId)
        this.#pendingSnapshots.delete(message.requestId)
        pending?.resolve(base64ToBytes(message.snapshotB64))
        return
      }
      case 'events.batch': {
        const pending = this.#pendingEvents.get(message.requestId)
        this.#pendingEvents.delete(message.requestId)
        pending?.resolve({
          ok: true,
          currentSeq: message.currentSeq,
          events: message.events as WireWorkspaceEvent[],
        })
        return
      }
      case 'events.snapshot-required': {
        const pending = this.#pendingEvents.get(message.requestId)
        this.#pendingEvents.delete(message.requestId)
        pending?.resolve({ ok: false, reason: 'snapshot-required', currentSeq: message.currentSeq })
        return
      }
      case 'ack': {
        const pending = this.#pendingSubmits.get(message.opId)
        this.#pendingSubmits.delete(message.opId)
        pending?.resolve({
          type: 'ack',
          applied: message.applied,
          contentVersionB64: message.contentVersionB64,
        })
        return
      }
      case 'submit.deferred': {
        const pending = this.#pendingSubmits.get(message.opId)
        this.#pendingSubmits.delete(message.opId)
        pending?.resolve({
          type: 'deferred',
          reason: message.reason,
          snapshotB64: message.snapshotB64,
          contentVersionB64: message.contentVersionB64,
        })
        return
      }
      case 'submit.rejected': {
        // Shared rejection surface: content.submit and opaque.submit are
        // both opId-keyed and refused with the same message shape.
        const pending = this.#pendingSubmits.get(message.opId)
        if (pending) {
          this.#pendingSubmits.delete(message.opId)
          pending.resolve({
            type: 'rejected',
            reason: message.reason,
            retryAfterSec: message.retryAfterSec,
          })
          return
        }
        const pendingOpaque = this.#pendingOpaqueSubmits.get(message.opId)
        this.#pendingOpaqueSubmits.delete(message.opId)
        pendingOpaque?.resolve({
          type: 'rejected',
          reason: message.reason,
          retryAfterSec: message.retryAfterSec,
        })
        return
      }
      case 'opaque.ack': {
        const pending = this.#pendingOpaqueSubmits.get(message.opId)
        this.#pendingOpaqueSubmits.delete(message.opId)
        pending?.resolve({
          type: 'ack',
          hashHex: message.hashHex,
          sizeBytes: message.sizeBytes,
          manifest: message.manifest,
          conflict: message.conflict,
          path: message.path,
        })
        return
      }
      case 'opaque.response': {
        const pending = this.#pendingOpaqueGets.get(message.requestId)
        this.#pendingOpaqueGets.delete(message.requestId)
        const localObjects = this.#pendingOpaqueGetObjects.get(message.requestId) ?? []
        this.#pendingOpaqueGetObjects.delete(message.requestId)
        let bytes: Uint8Array | undefined
        if (
          message.found &&
          message.contentKind === 'opaque' &&
          message.hashHex !== undefined &&
          message.sizeBytes !== undefined &&
          message.manifest !== undefined &&
          message.objects !== undefined
        ) {
          try {
            bytes = assembleOpaqueWirePayload({
              hashHex: message.hashHex,
              sizeBytes: message.sizeBytes,
              manifest: message.manifest,
              objects: [...localObjects, ...message.objects],
            })
          } catch (error) {
            pending?.reject(error instanceof Error ? error : new Error(String(error)))
            return
          }
        }
        pending?.resolve({
          found: message.found,
          contentKind: message.contentKind,
          path: message.path,
          bytes,
          hashHex: message.hashHex,
          sizeBytes: message.sizeBytes,
          manifest: message.manifest,
        })
        return
      }
      case 'tree.state': {
        const pending = this.#pendingTrees.get(message.requestId)
        this.#pendingTrees.delete(message.requestId)
        pending?.resolve({
          currentSeq: message.currentSeq,
          entries: message.entries,
        })
        return
      }
      case 'batch.ack': {
        const pending = this.#pendingBatches.get(message.requestId)
        this.#pendingBatches.delete(message.requestId)
        pending?.resolve({
          type: 'ack',
          currentSeq: message.currentSeq,
          acceptedOps: message.acceptedOps,
          deferredOps: message.deferredOps,
        })
        return
      }
      case 'batch.rejected': {
        const pending = this.#pendingBatches.get(message.requestId)
        this.#pendingBatches.delete(message.requestId)
        pending?.resolve({
          type: 'rejected',
          reason: message.reason,
          retryAfterSec: message.retryAfterSec,
        })
        return
      }
      case 'error': {
        const error = new Error(`server error: ${message.message}`)
        if (message.requestId) {
          for (const map of [
            this.#pendingSnapshots,
            this.#pendingEvents,
            this.#pendingBatches,
            this.#pendingOpaqueGets,
            this.#pendingTrees,
          ]) {
            const pending = map.get(message.requestId)
            if (pending) {
              map.delete(message.requestId)
              pending.reject(error)
              return
            }
          }
        }
        // Uncorrelatable (the server's parse/validation catch carries no
        // requestId, and submits are opId-keyed): SOME flight just failed
        // on a healthy socket. Reject everything — outcome-unknown is the
        // safe state (idempotent retransmission); a silently hung flight
        // wedges the runner's serialized cycle queue forever.
        this.#rejectAllPending(error)
        return
      }
      case 'content.loroUpdate':
      case 'content.opaqueUpdate':
      case 'create':
      case 'rename':
      case 'delete': {
        const event = message as WireWorkspaceEvent
        this.#options.onHint?.(event)
        for (const handler of this.#eventHandlers) {
          handler(event)
        }
        return
      }
      default:
        return
    }
  }
}
