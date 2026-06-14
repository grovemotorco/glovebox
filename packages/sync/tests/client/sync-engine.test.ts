import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '../../src/loro/base64.ts'
import { MemoryClientStorage } from '../../src/client/workspace-state.ts'
import {
  WorkspaceSyncEngine,
  type EventsSinceResult,
  type SyncEngineChange,
  type WireWorkspaceEvent,
  type WorkspaceSyncTransport,
} from '../../src/client/sync-engine.ts'
import type { SubmitUpdateInput, SubmitUpdateResult } from '../../src/loro/room-client.ts'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import {
  WorkspaceServer,
  type WorkspaceServerMessage,
  type WorkspaceServerStorage,
  type WorkspaceSocket,
  type WorkspaceSqlStorage,
  type WorkspaceSqlValue,
} from '../../src/server/workspace-server.ts'

// ---------------------------------------------------------------------------
// Server-side harness (in-memory DO), same shape as the server test suite.
// ---------------------------------------------------------------------------

class FakeSqlStorage implements WorkspaceSqlStorage {
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

class FakeStorage implements WorkspaceServerStorage {
  readonly #values = new Map<string, unknown>()
  readonly sql: WorkspaceSqlStorage = new FakeSqlStorage()

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

/** Socket whose server->client sends dispatch synchronously to a handler. */
class LiveSocket implements WorkspaceSocket {
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

class ServerHost {
  readonly sockets: LiveSocket[] = []
  readonly server: WorkspaceServer

  constructor(replayWindow?: number) {
    const storage = new FakeStorage()
    this.server = new WorkspaceServer({
      storage,
      sql: storage.sql,
      getSockets: () => this.sockets,
      replayWindow,
    })
  }

  async connect(): Promise<LiveSocket> {
    const socket = new LiveSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket)
    return socket
  }

  detach(socket: LiveSocket): void {
    const index = this.sockets.indexOf(socket)
    if (index >= 0) this.sockets.splice(index, 1)
  }
}

// ---------------------------------------------------------------------------
// Client-side transport over a LiveSocket (the App's WS transport, in-memory).
// ---------------------------------------------------------------------------

class SocketTransport implements WorkspaceSyncTransport {
  readonly #host: ServerHost
  readonly #socket: LiveSocket
  readonly #pendingSnapshots = new Map<string, (snapshot: Uint8Array) => void>()
  readonly #pendingEvents = new Map<string, (result: EventsSinceResult) => void>()
  readonly #pendingSubmits = new Map<
    string,
    { resolve: (result: SubmitUpdateResult) => void; reject: (error: Error) => void }
  >()
  readonly #eventHandlers = new Set<(event: WireWorkspaceEvent) => void>()
  /** When true, submits fail at the transport layer (offline simulation). */
  failSubmits = false
  #requestCounter = 0

  constructor(host: ServerHost, socket: LiveSocket) {
    this.#host = host
    this.#socket = socket
    socket.onMessage = (message) => this.#handle(message)
  }

  async fetchSnapshot(fileId: string, initialContent?: string): Promise<Uint8Array> {
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<Uint8Array>((resolve) => {
      this.#pendingSnapshots.set(requestId, resolve)
    })
    await this.#host.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'snapshot.get', requestId, fileId, initialContent }),
    )
    return promise
  }

  async eventsSince(afterSeq: number): Promise<EventsSinceResult> {
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<EventsSinceResult>((resolve) => {
      this.#pendingEvents.set(requestId, resolve)
    })
    await this.#host.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'events.since', requestId, afterSeq }),
    )
    return promise
  }

  async submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    if (this.failSubmits) {
      throw new Error('offline')
    }
    const promise = new Promise<SubmitUpdateResult>((resolve, reject) => {
      this.#pendingSubmits.set(input.opId, { resolve, reject })
    })
    await this.#host.server.handleMessage(
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

  subscribeEvents(handler: (event: WireWorkspaceEvent) => void): () => void {
    this.#eventHandlers.add(handler)
    return () => this.#eventHandlers.delete(handler)
  }

  #handle(message: WorkspaceServerMessage): void {
    switch (message.type) {
      case 'snapshot.response': {
        const resolve = this.#pendingSnapshots.get(message.requestId)
        this.#pendingSnapshots.delete(message.requestId)
        resolve?.(base64ToBytes(message.snapshotB64))
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
        this.#pendingSubmits.delete(message.opId)
        pending?.resolve({
          type: 'rejected',
          reason: message.reason,
          retryAfterSec: message.retryAfterSec,
        })
        return
      }
      case 'content.loroUpdate':
      case 'content.opaqueUpdate': {
        for (const handler of this.#eventHandlers) handler(message as WireWorkspaceEvent)
        return
      }
      default:
        return
    }
  }
}

async function makeEngine(
  host: ServerHost,
  deviceId: string,
  storage = new MemoryClientStorage(),
): Promise<{
  engine: WorkspaceSyncEngine
  storage: MemoryClientStorage
  transport: SocketTransport
  socket: LiveSocket
}> {
  const socket = await host.connect()
  const transport = new SocketTransport(host, socket)
  const engine = new WorkspaceSyncEngine({
    workspaceId: 'ws-1',
    deviceId,
    storage,
    transport,
  })
  await engine.start()
  return { engine, storage, transport, socket }
}

const FILE = 'doc-1'
const PATH = 'notes.md'

describe('WorkspaceSyncEngine against the real server core', () => {
  it('two engines converge through live broadcasts', async () => {
    const host = new ServerHost()
    const a = await makeEngine(host, 'device-a')
    const b = await makeEngine(host, 'device-b')

    await a.engine.openFile(FILE, PATH, 'base\n')
    await b.engine.openFile(FILE, PATH)
    expect(b.engine.getText(FILE)).toBe('base\n')

    await a.engine.client(FILE)!.setTextContent('base +A\n')
    await a.engine.flush()
    expect(b.engine.getText(FILE)).toBe('base +A\n')

    await b.engine.client(FILE)!.setTextContent('base +A +B\n')
    await b.engine.flush()
    expect(a.engine.getText(FILE)).toBe('base +A +B\n')
    expect(a.engine.lastAckedSeq()).toBe(b.engine.lastAckedSeq())
  })

  it('reload mid-session: hydrates from persistence and catches up via events.since', async () => {
    const host = new ServerHost()
    const a = await makeEngine(host, 'device-a')
    const b = await makeEngine(host, 'device-b')
    await a.engine.openFile(FILE, PATH, 'v0\n')
    await b.engine.openFile(FILE, PATH)

    await a.engine.client(FILE)!.setTextContent('v1\n')
    await a.engine.flush()
    expect(b.engine.getText(FILE)).toBe('v1\n')

    // Tab B "closes": engine stops, socket detaches from broadcast.
    b.engine.stop()
    host.detach(b.socket)

    await a.engine.client(FILE)!.setTextContent('v2 while B away\n')
    await a.engine.flush()

    // Tab B "reopens": same IndexedDB, fresh socket. start() must hydrate
    // locally (no full refetch) and pull the missed events.
    const b2 = await makeEngine(host, 'device-b', b.storage)
    expect(b2.engine.getText(FILE)).toBe('v2 while B away\n')
    expect(b2.engine.lastAckedSeq()).toBe(a.engine.lastAckedSeq())
  })

  it('an unacked edit survives reload and retransmits (INV-2)', async () => {
    const host = new ServerHost()
    const a = await makeEngine(host, 'device-a')
    await a.engine.openFile(FILE, PATH, 'base\n')
    await a.engine.flush()

    // Go offline, edit, "close the tab" before any ack.
    a.transport.failSubmits = true
    await a.engine.client(FILE)!.setTextContent('base + offline edit\n')
    await a.engine.flush()
    expect(a.engine.client(FILE)!.hasPendingChanges()).toBe(true)
    a.engine.stop()
    host.detach(a.socket)

    // Reopen with a working transport: hydration restores the pending ops
    // and start() flushes them to the server.
    const a2 = await makeEngine(host, 'device-a', a.storage)
    expect(a2.engine.getText(FILE)).toBe('base + offline edit\n')
    expect(a2.engine.client(FILE)!.hasPendingChanges()).toBe(false)

    const verifier = await makeEngine(host, 'device-v')
    await verifier.engine.openFile(FILE, PATH)
    expect(verifier.engine.getText(FILE)).toBe('base + offline edit\n')
  })

  it('fills broadcast gaps via events.since', async () => {
    const host = new ServerHost()
    const a = await makeEngine(host, 'device-a')
    const b = await makeEngine(host, 'device-b')
    await a.engine.openFile(FILE, PATH, 'g0\n')
    await b.engine.openFile(FILE, PATH)

    // B misses one broadcast entirely…
    host.detach(b.socket)
    await a.engine.client(FILE)!.setTextContent('g1\n')
    await a.engine.flush()

    // …then comes back and receives the NEXT one with a seq gap.
    host.sockets.push(b.socket)
    await a.engine.client(FILE)!.setTextContent('g2\n')
    await a.engine.flush()
    await b.engine.flush()

    expect(b.engine.getText(FILE)).toBe('g2\n')
    expect(b.engine.lastAckedSeq()).toBe(a.engine.lastAckedSeq())
  })

  it('M2 gate: two tabs converge through concurrent edits and a mid-session reload', async () => {
    const host = new ServerHost()
    const a = await makeEngine(host, 'device-a')
    const b = await makeEngine(host, 'device-b')
    await a.engine.openFile(FILE, PATH, 'doc v0\n')
    await b.engine.openFile(FILE, PATH)

    // Concurrent edits: both docs mutate synchronously against their
    // pre-merge base before either submit settles — real tab concurrency.
    await Promise.all([
      a.engine.client(FILE)!.setTextContent('A-lead doc v0\n'),
      b.engine.client(FILE)!.setTextContent('doc v0 B-tail\n'),
    ])
    await a.engine.flush()
    await b.engine.flush()
    await a.engine.flush()
    expect(a.engine.getText(FILE)).toBe(b.engine.getText(FILE))
    expect(a.engine.getText(FILE)).toContain('A-lead')
    expect(a.engine.getText(FILE)).toContain('B-tail')

    // Tab A keeps typing offline (no acks), then "the tab reloads".
    a.transport.failSubmits = true
    const beforeReload = a.engine.getText(FILE)!
    await a.engine.client(FILE)!.setTextContent(`${beforeReload}A-unacked\n`)
    await a.engine.flush()
    a.engine.stop()
    host.detach(a.socket)

    // Tab B edits while A is gone.
    await b.engine.client(FILE)!.setTextContent(`${b.engine.getText(FILE)!}B-while-away\n`)
    await b.engine.flush()

    // Tab A reopens: hydrates from IndexedDB, retransmits the unacked
    // edit, pulls B's edit — INV-1 convergence with INV-2 (nothing lost).
    const a2 = await makeEngine(host, 'device-a', a.storage)
    await a2.engine.flush()
    await b.engine.flush()

    const finalA = a2.engine.getText(FILE)!
    expect(finalA).toBe(b.engine.getText(FILE))
    expect(finalA).toContain('A-lead')
    expect(finalA).toContain('B-tail')
    expect(finalA).toContain('A-unacked')
    expect(finalA).toContain('B-while-away')
    expect(a2.engine.lastAckedSeq()).toBe(b.engine.lastAckedSeq())

    // The server agrees with both tabs.
    const verifier = await makeEngine(host, 'device-v')
    await verifier.engine.openFile(FILE, PATH)
    expect(verifier.engine.getText(FILE)).toBe(finalA)
  })

  it('repairs from a fresh snapshot when the cursor predates the replay window', async () => {
    const host = new ServerHost(2)
    const a = await makeEngine(host, 'device-a')
    const b = await makeEngine(host, 'device-b')
    await a.engine.openFile(FILE, PATH, 'w0\n')
    await b.engine.openFile(FILE, PATH)

    b.engine.stop()
    host.detach(b.socket)

    // Five edits while B is away — far past the window of 2.
    for (let i = 1; i <= 5; i += 1) {
      await a.engine.client(FILE)!.setTextContent(`w${i}\n`)
      await a.engine.flush()
    }

    const repairs: string[] = []
    const b2 = await makeEngine(host, 'device-b', b.storage)
    b2.engine.onChange((change) => {
      if (change.type === 'repair') repairs.push(change.reason)
    })
    expect(b2.engine.getText(FILE)).toBe('w5\n')
    expect(b2.engine.lastAckedSeq()).toBe(a.engine.lastAckedSeq())
  })
})

// ---------------------------------------------------------------------------
// ISSUE-0048 Phase B: the engine is the single-cursor authority for tree-event
// ORDERING. It forwards create/rename/delete as gap-free `tree-event` changes
// in cursor order (so a tree op after a content edit is no longer mistaken for
// a content gap), fills real gaps via events.since, and asks for the one
// legitimate full refetch as `tree-resync` when the replay window is gone.
// ---------------------------------------------------------------------------

/** Transport with a captured live handler + a programmable events.since, for
 *  deterministic control over ordering, gaps, and the lost-window path. */
class FakeTreeTransport implements WorkspaceSyncTransport {
  #handler: ((event: WireWorkspaceEvent) => void) | null = null
  readonly eventsSinceQueue: EventsSinceResult[] = []
  defaultEventsSince: EventsSinceResult = { ok: true, currentSeq: 0, events: [] }

  async fetchSnapshot(): Promise<Uint8Array> {
    return LoroFileDoc.empty('').exportSnapshot()
  }
  async eventsSince(): Promise<EventsSinceResult> {
    return this.eventsSinceQueue.shift() ?? this.defaultEventsSince
  }
  async submitUpdate(): Promise<SubmitUpdateResult> {
    return { type: 'ack', applied: true, contentVersionB64: '' }
  }
  subscribeEvents(handler: (event: WireWorkspaceEvent) => void): () => void {
    this.#handler = handler
    return () => {
      this.#handler = null
    }
  }
  /** Inject a live broadcast exactly as the socket would. */
  emit(event: WireWorkspaceEvent): void {
    this.#handler?.(event)
  }
}

function treeWire(
  type: 'create' | 'rename' | 'delete',
  fileId: string,
  seq: number,
  paths: { path?: string; newPath?: string } = {},
): WireWorkspaceEvent {
  return { type, fileId, seq, ...paths }
}

function contentWire(fileId: string, seq: number): WireWorkspaceEvent {
  return { type: 'content.loroUpdate', fileId, seq, loroUpdateB64: 'AA==' }
}

describe('WorkspaceSyncEngine tree-event ordering (ISSUE-0048 Phase B)', () => {
  async function bootTreeEngine(transport: FakeTreeTransport): Promise<{
    engine: WorkspaceSyncEngine
    changes: SyncEngineChange[]
  }> {
    const engine = new WorkspaceSyncEngine({
      workspaceId: 'ws-1',
      deviceId: 'device-tree',
      storage: new MemoryClientStorage(),
      transport,
    })
    const changes: SyncEngineChange[] = []
    engine.onChange((change) => changes.push(change))
    await engine.start() // initial pull -> empty, cursor 0
    return { engine, changes }
  }

  function treeSeqs(changes: SyncEngineChange[]): [string, number | undefined][] {
    return changes
      .filter((change) => change.type === 'tree-event')
      .map((change) => [change.event.type, change.event.seq])
  }

  it('forwards tree ops interleaved with content under one cursor, gap-free', async () => {
    const transport = new FakeTreeTransport()
    const { engine, changes } = await bootTreeEngine(transport)

    transport.emit(treeWire('create', 'f1', 1, { path: 'a.md' }))
    await engine.flush()
    transport.emit(contentWire('f1', 2)) // a content edit advances the cursor
    await engine.flush()
    transport.emit(treeWire('rename', 'f1', 3, { newPath: 'b.md' }))
    await engine.flush()
    transport.emit(treeWire('delete', 'f1', 4))
    await engine.flush()

    // The content edit at seq 2 did NOT read as a gap for the tree op at seq 3:
    // every structural event was forwarded once, in cursor order.
    expect(treeSeqs(changes)).toEqual([
      ['create', 1],
      ['rename', 3],
      ['delete', 4],
    ])
    expect(engine.lastAckedSeq()).toBe(4)
  })

  it('fills a real gap via events.since, replaying missed tree ops in seq order', async () => {
    const transport = new FakeTreeTransport()
    const { engine, changes } = await bootTreeEngine(transport)

    transport.emit(treeWire('create', 'f1', 1, { path: 'a.md' }))
    await engine.flush()

    // delete@3 with the cursor at 1 is a gap (3 > 1+1): the engine pulls, and
    // the replay carries the missed rename@2 + delete@3.
    transport.eventsSinceQueue.push({
      ok: true,
      currentSeq: 3,
      events: [treeWire('rename', 'f1', 2, { newPath: 'b.md' }), treeWire('delete', 'f1', 3)],
    })
    transport.emit(treeWire('delete', 'f1', 3))
    await engine.flush()

    // Replayed in order, and delete@3 is NOT double-emitted.
    expect(treeSeqs(changes)).toEqual([
      ['create', 1],
      ['rename', 2],
      ['delete', 3],
    ])
    expect(engine.lastAckedSeq()).toBe(3)
  })

  it('emits tree-resync (not tree-event) when the replay window is lost', async () => {
    const transport = new FakeTreeTransport()
    const { engine, changes } = await bootTreeEngine(transport)

    transport.eventsSinceQueue.push({ ok: false, reason: 'snapshot-required', currentSeq: 5 })
    transport.emit(treeWire('create', 'f9', 5, { path: 'z.md' })) // gap -> pull -> lost window
    await engine.flush()

    expect(changes.filter((change) => change.type === 'tree-resync')).toHaveLength(1)
    expect(treeSeqs(changes)).toEqual([]) // no per-event forward; the resync covers it
    expect(engine.lastAckedSeq()).toBe(5)
  })

  it('recovers a missed tail event through an explicit pull() (reconnect)', async () => {
    const transport = new FakeTreeTransport()
    const { engine, changes } = await bootTreeEngine(transport)

    // Nothing arrives live (the tail broadcast was dropped while disconnected);
    // a reconnect pull replays it.
    transport.eventsSinceQueue.push({
      ok: true,
      currentSeq: 2,
      events: [
        treeWire('create', 'f1', 1, { path: 'a.md' }),
        treeWire('create', 'f2', 2, { path: 'b.md' }),
      ],
    })
    await engine.pull()

    expect(treeSeqs(changes)).toEqual([
      ['create', 1],
      ['create', 2],
    ])
    expect(engine.lastAckedSeq()).toBe(2)
  })
})
