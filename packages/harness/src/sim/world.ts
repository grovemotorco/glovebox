import { DatabaseSync } from 'node:sqlite'
import {
  WorkspaceServer,
  type WorkspaceServerMessage,
  type WorkspaceServerStorage,
  type WorkspaceSocket,
  type WorkspaceSqlStorage,
  type WorkspaceSqlValue,
} from '@glovebox/sync/server'
import {
  MemoryClientStorage,
  WorkspaceSyncEngine,
  type ClientStateStorage,
  type ClientStoreName,
  type EventsSinceResult,
  type WireWorkspaceEvent,
  type WorkspaceSyncTransport,
} from '@glovebox/sync/client'
import type { SubmitUpdateInput, SubmitUpdateResult } from '@glovebox/sync/loro'
import { LoroFileDoc, base64ToBytes, bytesToBase64 } from '@glovebox/sync/loro'
import {
  DaemonSyncEngine,
  MemoryDaemonStorage,
  type BatchSubmitResult,
  type DaemonStorage,
  type DaemonTreeState,
  type OpaqueFetchResult,
  type SubmitOpaqueInput,
  type SubmitOpaqueResult,
} from '@glovebox/sync/daemon'
import {
  assembleOpaqueWirePayload,
  buildOpaqueWirePayload,
  type OpaqueObjectPayload,
} from '@glovebox/sync'
import type { WorkspaceBatchWireOp } from '@glovebox/sync/server'
import { MemoryFS } from '../fs/memory-fs.ts'
import { CrashFuse, SimChannel, SimCrash, SimScheduler, type ChannelPolicy } from './scheduler.ts'

/**
 * The DO-shaped in-memory world: the REAL WorkspaceServer core and REAL
 * WorkspaceSyncEngine clients, with broadcast delivery routed through
 * seeded SimChannels (drop / duplicate / reorder under scheduler control)
 * and client persistence instrumented with crash fuses. Request/response
 * traffic resolves synchronously — interleaving is explored through client
 * action order and broadcast delivery order, which is where the historical
 * bugs lived.
 */

class SimSqlStorage implements WorkspaceSqlStorage {
  readonly #db = new DatabaseSync(':memory:')

  exec(
    query: string,
    ...bindings: WorkspaceSqlValue[]
  ): { toArray(): Record<string, WorkspaceSqlValue>[] } {
    const normalized = bindings.map((binding) =>
      binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
    )
    const rows = this.#db
      .prepare(query)
      .all(...(normalized as (string | number | null)[])) as Record<string, WorkspaceSqlValue>[]
    return { toArray: () => rows }
  }
}

class SimServerStorage implements WorkspaceServerStorage {
  readonly #values = new Map<string, unknown>()
  readonly sql: WorkspaceSqlStorage = new SimSqlStorage()

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key)
    return value === undefined ? undefined : (structuredClone(value) as T)
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#values.set(key, structuredClone(value))
  }

  async delete(key: string): Promise<boolean> {
    return this.#values.delete(key)
  }
}

class SimSocket implements WorkspaceSocket {
  onMessage: ((message: WorkspaceServerMessage) => void) | null = null
  #attachment: unknown

  send(data: string): void {
    this.onMessage?.(JSON.parse(data) as WorkspaceServerMessage)
  }

  close(): void {
    this.onMessage = null
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value)
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment)
  }
}

/** ClientStateStorage wrapper that consults a crash fuse before writes. */
class FusedClientStorage implements ClientStateStorage {
  constructor(
    readonly inner: ClientStateStorage,
    public fuse: CrashFuse,
  ) {}

  get(store: ClientStoreName, key: string): Promise<unknown> {
    return this.inner.get(store, key)
  }

  put(store: ClientStoreName, key: string, value: unknown): Promise<void> {
    this.fuse.checkpoint()
    return this.inner.put(store, key, value)
  }

  delete(store: ClientStoreName, key: string): Promise<void> {
    this.fuse.checkpoint()
    return this.inner.delete(store, key)
  }

  listKeys(store: ClientStoreName): Promise<string[]> {
    return this.inner.listKeys(store)
  }
}

class SimTransport implements WorkspaceSyncTransport {
  readonly #world: SimWorld
  readonly #socket: SimSocket
  readonly #pendingSnapshots = new Map<
    string,
    { resolve: (snapshot: Uint8Array) => void; reject: (error: Error) => void }
  >()
  readonly #pendingEvents = new Map<string, (result: EventsSinceResult) => void>()
  readonly #pendingSubmits = new Map<
    string,
    { resolve: (result: SubmitUpdateResult) => void; reject: (error: Error) => void }
  >()
  readonly #pendingBatches = new Map<string, (result: BatchSubmitResult) => void>()
  readonly #pendingOpaqueSubmits = new Map<string, (result: SubmitOpaqueResult) => void>()
  readonly #pendingOpaqueGets = new Map<string, (result: OpaqueFetchResult) => void>()
  readonly #pendingOpaqueGetObjects = new Map<string, OpaqueObjectPayload[]>()
  readonly #pendingTrees = new Map<string, (result: DaemonTreeState) => void>()
  readonly #eventHandlers = new Set<(event: WireWorkspaceEvent) => void>()
  offline = false
  #requestCounter = 0

  constructor(world: SimWorld, socket: SimSocket, channel: SimChannel<WireWorkspaceEvent>) {
    this.#world = world
    this.#socket = socket
    socket.onMessage = (message) => this.#handle(message)
    channel.onDeliver((event) => {
      for (const handler of this.#eventHandlers) handler(event)
    })
  }

  async fetchSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    this.#assertOnline()
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingSnapshots.set(requestId, { resolve, reject })
    })
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'snapshot.get', requestId, fileId, initialContent, observedPath }),
    )
    return promise
  }

  async submitBatch(ops: WorkspaceBatchWireOp[]): Promise<BatchSubmitResult> {
    this.#assertOnline()
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<BatchSubmitResult>((resolve) => {
      this.#pendingBatches.set(requestId, resolve)
    })
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'batch.submit', requestId, ops }),
    )
    return promise
  }

  async eventsSince(afterSeq: number): Promise<EventsSinceResult> {
    this.#assertOnline()
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<EventsSinceResult>((resolve) => {
      this.#pendingEvents.set(requestId, resolve)
    })
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'events.since', requestId, afterSeq }),
    )
    return promise
  }

  async submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    this.#assertOnline()
    const promise = new Promise<SubmitUpdateResult>((resolve, reject) => {
      this.#pendingSubmits.set(input.opId, { resolve, reject })
    })
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({
        type: 'content.submit',
        fileId: input.fileId,
        observedPath: input.observedPath,
        opId: input.opId,
        baseContentVersionB64: bytesToBase64(input.baseContentVersion),
        loroUpdateB64: bytesToBase64(input.loroUpdate),
      }),
    )
    return promise
  }

  async submitOpaque(input: SubmitOpaqueInput): Promise<SubmitOpaqueResult> {
    this.#assertOnline()
    const promise = new Promise<SubmitOpaqueResult>((resolve) => {
      this.#pendingOpaqueSubmits.set(input.opId, resolve)
    })
    const payload = buildOpaqueWirePayload(input.bytes)
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({
        type: 'opaque.submit',
        fileId: input.fileId,
        observedPath: input.observedPath,
        opId: input.opId,
        baseHashHex: input.baseHashHex,
        hashHex: payload.hashHex,
        sizeBytes: payload.sizeBytes,
        manifest: payload.manifest,
        objects: payload.objects,
      }),
    )
    return promise
  }

  async fetchOpaque(
    fileId: string,
    existingBytes?: Uint8Array,
    options: { metadataOnly?: boolean } = {},
  ): Promise<OpaqueFetchResult> {
    this.#assertOnline()
    const requestId = `rq-${++this.#requestCounter}`
    const existingPayload =
      existingBytes === undefined || options.metadataOnly === true
        ? undefined
        : buildOpaqueWirePayload(existingBytes)
    if (existingPayload) {
      this.#pendingOpaqueGetObjects.set(requestId, existingPayload.objects)
    }
    const promise = new Promise<OpaqueFetchResult>((resolve) => {
      this.#pendingOpaqueGets.set(requestId, resolve)
    })
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({
        type: 'opaque.get',
        requestId,
        fileId,
        haveObjects: existingPayload?.manifest.chunks.map((chunk) => chunk.hashB64),
        ...(options.metadataOnly === true ? { metadataOnly: true } : {}),
      }),
    )
    return promise
  }

  async listTree(): Promise<DaemonTreeState> {
    this.#assertOnline()
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<DaemonTreeState>((resolve) => {
      this.#pendingTrees.set(requestId, resolve)
    })
    await this.#world.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'tree.list', requestId }),
    )
    return promise
  }

  subscribeEvents(handler: (event: WireWorkspaceEvent) => void): () => void {
    this.#eventHandlers.add(handler)
    return () => this.#eventHandlers.delete(handler)
  }

  #assertOnline(): void {
    if (this.offline) throw new Error('offline')
  }

  #handle(message: WorkspaceServerMessage): void {
    switch (message.type) {
      case 'snapshot.response': {
        const pending = this.#pendingSnapshots.get(message.requestId)
        this.#pendingSnapshots.delete(message.requestId)
        pending?.resolve(base64ToBytes(message.snapshotB64))
        return
      }
      case 'events.batch': {
        const resolve = this.#pendingEvents.get(message.requestId)
        this.#pendingEvents.delete(message.requestId)
        resolve?.({
          ok: true,
          currentSeq: message.currentSeq,
          events: message.events as WireWorkspaceEvent[],
        })
        return
      }
      case 'events.snapshot-required': {
        const resolve = this.#pendingEvents.get(message.requestId)
        this.#pendingEvents.delete(message.requestId)
        resolve?.({ ok: false, reason: 'snapshot-required', currentSeq: message.currentSeq })
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
        pendingOpaque?.({
          type: 'rejected',
          reason: message.reason,
          retryAfterSec: message.retryAfterSec,
        })
        return
      }
      case 'opaque.ack': {
        const resolve = this.#pendingOpaqueSubmits.get(message.opId)
        this.#pendingOpaqueSubmits.delete(message.opId)
        resolve?.({
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
        const resolve = this.#pendingOpaqueGets.get(message.requestId)
        this.#pendingOpaqueGets.delete(message.requestId)
        const localObjects = this.#pendingOpaqueGetObjects.get(message.requestId) ?? []
        this.#pendingOpaqueGetObjects.delete(message.requestId)
        const bytes =
          message.found &&
          message.contentKind === 'opaque' &&
          message.hashHex !== undefined &&
          message.sizeBytes !== undefined &&
          message.manifest !== undefined &&
          message.objects !== undefined
            ? assembleOpaqueWirePayload({
                hashHex: message.hashHex,
                sizeBytes: message.sizeBytes,
                manifest: message.manifest,
                objects: [...localObjects, ...message.objects],
              })
            : undefined
        resolve?.({
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
      case 'error': {
        // Correlated refusal (e.g. snapshot.get on an opaque row) — reject
        // the matching flight so the engine's recovery path can classify
        // it; without this the sim daemon would hang on the promise.
        const requestId = (message as { requestId?: string }).requestId
        if (requestId) {
          const snapshot = this.#pendingSnapshots.get(requestId)
          if (snapshot) {
            this.#pendingSnapshots.delete(requestId)
            snapshot.reject(new Error(`server error: ${message.message}`))
          }
        }
        return
      }
      case 'tree.state': {
        const resolve = this.#pendingTrees.get(message.requestId)
        this.#pendingTrees.delete(message.requestId)
        resolve?.({ currentSeq: message.currentSeq, entries: message.entries })
        return
      }
      case 'batch.ack': {
        const resolve = this.#pendingBatches.get(message.requestId)
        this.#pendingBatches.delete(message.requestId)
        resolve?.({
          type: 'ack',
          currentSeq: message.currentSeq,
          acceptedOps: message.acceptedOps,
          deferredOps: message.deferredOps,
        })
        return
      }
      case 'batch.rejected': {
        const resolve = this.#pendingBatches.get(message.requestId)
        this.#pendingBatches.delete(message.requestId)
        resolve?.({
          type: 'rejected',
          reason: message.reason,
          retryAfterSec: message.retryAfterSec,
        })
        return
      }
      case 'content.loroUpdate':
      case 'content.opaqueUpdate':
      case 'create':
      case 'rename':
      case 'delete': {
        // Broadcasts go through the lossy seeded channel, not directly.
        this.#world.routeBroadcast(this, message as WireWorkspaceEvent)
        return
      }
      default:
        return
    }
  }

  deliverViaChannel(event: WireWorkspaceEvent): void {
    for (const handler of this.#eventHandlers) handler(event)
  }
}

export interface SimClient {
  readonly deviceId: string
  engine: WorkspaceSyncEngine
  transport: SimTransport
  storage: FusedClientStorage
  /** Simulated process death + restart over the same persisted storage. */
  reboot(): Promise<void>
}

/** DaemonStorage wrapper that consults a crash fuse before writes. */
class FusedDaemonStorage implements DaemonStorage {
  constructor(
    readonly inner: DaemonStorage,
    public fuse: CrashFuse,
  ) {}

  read(name: string): Promise<Uint8Array | null> {
    return this.inner.read(name)
  }

  writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    this.fuse.checkpoint()
    return this.inner.writeAtomic(name, bytes)
  }

  delete(name: string): Promise<void> {
    this.fuse.checkpoint()
    return this.inner.delete(name)
  }

  list(): Promise<string[]> {
    return this.inner.list()
  }
}

export interface SimDaemon {
  readonly deviceId: string
  /** The daemon's mount — the "real directory" it observes. */
  readonly fs: MemoryFS
  engine: DaemonSyncEngine
  transport: SimTransport
  /** True once the fuse tripped and the process is dead until reboot(). */
  crashed(): boolean
  /** Arm the fuse to die on the Nth persistence write from now. */
  armCrash(writeOrdinal: number): void
  /** Simulated process death + restart over the same storage and mount. */
  reboot(): Promise<void>
}

export interface SimWorldOptions {
  seed: number
  broadcastPolicy?: ChannelPolicy
}

export class SimWorld {
  readonly scheduler: SimScheduler
  readonly server: WorkspaceServer
  readonly #broadcastPolicy: ChannelPolicy
  readonly #clients: SimClient[] = []
  readonly #daemons: SimDaemon[] = []
  readonly #channels = new Map<SimTransport, SimChannel<WireWorkspaceEvent>>()
  #sockets: SimSocket[] = []
  #fileIdCounter = 0
  /** Virtual wall clock — drives the daemon's INV-3 timers (30s tombstone). */
  clockMs = 1_750_000_000_000

  constructor(options: SimWorldOptions) {
    this.scheduler = new SimScheduler(options.seed)
    this.#broadcastPolicy = options.broadcastPolicy ?? {}
    const storage = new SimServerStorage()
    this.server = new WorkspaceServer({
      storage,
      sql: storage.sql,
      getSockets: () => this.#sockets,
      now: () => this.clockMs,
    })
  }

  advanceClock(ms: number): void {
    this.clockMs += ms
  }

  async addClient(deviceId: string): Promise<SimClient> {
    const inner = new MemoryClientStorage()
    const storage = new FusedClientStorage(inner, new CrashFuse(deviceId))
    const client = await this.#bootClient(deviceId, storage)
    this.#clients.push(client)
    return client
  }

  async #bootClient(deviceId: string, storage: FusedClientStorage): Promise<SimClient> {
    const socket = new SimSocket()
    this.#sockets.push(socket)
    await this.server.handleConnect(socket)
    const channel = new SimChannel<WireWorkspaceEvent>(
      this.scheduler,
      `ws:${deviceId}`,
      this.#broadcastPolicy,
    )
    const transport = new SimTransport(this, socket, channel)
    this.#channels.set(transport, channel)
    const engine = new WorkspaceSyncEngine({
      workspaceId: 'sim-ws',
      deviceId,
      storage,
      transport,
    })
    await engine.start()

    const client: SimClient = {
      deviceId,
      engine,
      transport,
      storage,
      reboot: async (): Promise<void> => {
        client.engine.stop()
        client.transport.offline = true
        this.#detach(socket)
        this.#channels.delete(client.transport)
        storage.fuse = new CrashFuse(deviceId)
        const rebooted = await this.#bootClient(deviceId, storage)
        client.engine = rebooted.engine
        client.transport = rebooted.transport
      },
    }
    return client
  }

  /**
   * Boot a V2 daemon over its own MemoryFS mount. Daemons are cycle-driven
   * (no broadcast subscription): quiesce() runs their cycles, and a tripped
   * crash fuse inside a cycle kills the process until reboot().
   */
  async addDaemon(deviceId: string, files: Record<string, string> = {}): Promise<SimDaemon> {
    const fs = MemoryFS.from(files)
    const storage = new FusedDaemonStorage(new MemoryDaemonStorage(), new CrashFuse(deviceId))
    let currentSocket: SimSocket | null = null
    const boot = async (): Promise<{ engine: DaemonSyncEngine; transport: SimTransport }> => {
      const socket = new SimSocket()
      currentSocket = socket
      this.#sockets.push(socket)
      await this.server.handleConnect(socket)
      const channel = new SimChannel<WireWorkspaceEvent>(
        this.scheduler,
        `ws:${deviceId}`,
        this.#broadcastPolicy,
      )
      const transport = new SimTransport(this, socket, channel)
      this.#channels.set(transport, channel)
      const engine = new DaemonSyncEngine({
        workspaceId: 'sim-ws',
        mountId: `mount-${deviceId}`,
        deviceId,
        fs,
        storage,
        transport,
        now: () => this.clockMs,
        newFileId: () => `${deviceId}-file-${++this.#fileIdCounter}`,
      })
      await engine.start()
      return { engine, transport }
    }

    const first = await boot()
    const daemon: SimDaemon = {
      deviceId,
      fs,
      engine: first.engine,
      transport: first.transport,
      crashed: () => storage.fuse.tripped,
      armCrash: (writeOrdinal: number): void => {
        storage.fuse = new CrashFuse(deviceId, writeOrdinal)
      },
      reboot: async (): Promise<void> => {
        daemon.engine.stop()
        daemon.transport.offline = true
        if (currentSocket) this.#detach(currentSocket)
        this.#channels.delete(daemon.transport)
        storage.fuse = new CrashFuse(deviceId)
        const rebooted = await boot()
        daemon.engine = rebooted.engine
        daemon.transport = rebooted.transport
      },
    }
    this.#daemons.push(daemon)
    return daemon
  }

  routeBroadcast(target: SimTransport, event: WireWorkspaceEvent): void {
    this.#channels.get(target)?.send(event)
  }

  #detach(socket: SimSocket): void {
    socket.close()
    const index = this.#sockets.indexOf(socket)
    if (index >= 0) this.#sockets.splice(index, 1)
  }

  /**
   * Drain scheduler + pushes + daemon cycles until nothing is pending AND a
   * full round passes with every cursor frozen. The cursor check matters:
   * within one round clients pull BEFORE daemons push, and a push whose
   * broadcast copies are all dropped at send time leaves zero scheduler
   * tasks — exiting on `pending === 0` alone would strand the clients one
   * event behind forever.
   */
  async quiesce(): Promise<void> {
    let previousFingerprint = ''
    for (let round = 0; round < 50; round += 1) {
      await this.scheduler.run()
      for (const client of this.#clients) {
        // Pull first: a dropped tail broadcast is only repaired by an
        // explicit catch-up (the reconnect/idle pull in production).
        await client.engine.pull()
        await client.engine.flush()
      }
      let daemonsActive = false
      for (const daemon of this.#daemons) {
        try {
          await daemon.engine.runCycle()
        } catch (error) {
          if (!(error instanceof SimCrash)) throw error
          // A fuse armed earlier fired mid-cycle: the supervisor restarts
          // the process and the next round resumes from persisted state.
          await daemon.reboot()
          daemonsActive = true
        }
        if (daemon.engine.hasPendingChanges()) daemonsActive = true
      }
      const fingerprint = JSON.stringify([
        this.#clients.map((client) => client.engine.lastAckedSeq()),
        this.#daemons.map((daemon) => daemon.engine.lastAckedSeq()),
      ])
      if (this.scheduler.pending === 0 && !daemonsActive && fingerprint === previousFingerprint) {
        return
      }
      previousFingerprint = fingerprint
    }
    throw new Error(`SimWorld failed to quiesce (seed ${this.scheduler.seed})`)
  }

  /**
   * INV-1 after quiescence: every client, every daemon (doc AND mount
   * disk), and the server materialize the same text. Returns that text for
   * content assertions (INV-2 markers).
   */
  async assertConverged(fileId: string, maxBytes = 1_048_576): Promise<string> {
    const reference =
      this.#clients[0]?.engine.getText(fileId) ?? this.#daemons[0]?.engine.getText(fileId)
    if (reference === null || reference === undefined) {
      throw new Error('no client has the file open')
    }
    for (const client of this.#clients) {
      const text = client.engine.getText(fileId)
      if (text !== reference) {
        throw new Error(
          `INV-1 violated (seed ${this.scheduler.seed}): ${client.deviceId} diverged\n--- ${client.deviceId}\n${text}\n--- reference\n${reference}\n--- trace\n${this.scheduler.trace.join(' ')}`,
        )
      }
    }
    for (const daemon of this.#daemons) {
      const text = daemon.engine.getText(fileId)
      if (text === null) continue // Daemon never discovered the file (no tree wire).
      if (text !== reference) {
        throw new Error(
          `INV-1 violated (seed ${this.scheduler.seed}): daemon ${daemon.deviceId} doc diverged\n--- ${daemon.deviceId}\n${text}\n--- reference\n${reference}\n--- trace\n${this.scheduler.trace.join(' ')}`,
        )
      }
      const path = daemon.engine.files().find((file) => file.fileId === fileId)?.path
      const disk = path ? daemon.fs.getFile(path) : null
      if (disk !== reference) {
        throw new Error(
          `INV-1 violated (seed ${this.scheduler.seed}): daemon ${daemon.deviceId} mount diverged\n--- disk\n${disk}\n--- reference\n${reference}\n--- trace\n${this.scheduler.trace.join(' ')}`,
        )
      }
    }
    const anyTransport = (this.#clients[0] ?? this.#daemons[0])!.transport
    const snapshot = await anyTransport.fetchSnapshot(fileId)
    const serverText = LoroFileDoc.fromSnapshot(snapshot).getTextContent()
    if (serverText !== reference) {
      throw new Error(
        `INV-1 violated (seed ${this.scheduler.seed}): server diverged from clients\n--- server\n${serverText}\n--- clients\n${reference}`,
      )
    }
    if (new TextEncoder().encode(reference).byteLength > maxBytes) {
      throw new Error(`doc length unbounded (seed ${this.scheduler.seed})`)
    }
    return reference
  }
}
