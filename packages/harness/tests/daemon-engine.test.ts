import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  assembleOpaqueWirePayload,
  buildOpaqueWirePayload,
  sha256Hex,
  type OpaqueObjectPayload,
} from '@glovebox/sync'
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
  type EventsSinceResult,
  type WireWorkspaceEvent,
  type WorkspaceSyncTransport,
} from '@glovebox/sync/client'
import {
  DaemonSyncEngine,
  MemoryDaemonStorage,
  type BatchSubmitResult,
  type DaemonStorage,
} from '@glovebox/sync/daemon'
import type { WorkspaceBatchWireOp } from '@glovebox/sync/server'
import type {
  DaemonTreeState,
  DaemonWorkspaceState,
  OpaqueFetchResult,
  SubmitOpaqueInput,
  SubmitOpaqueResult,
} from '@glovebox/sync/daemon'
import type { SubmitUpdateInput, SubmitUpdateResult } from '@glovebox/sync/loro'
import { LoroFileDoc, base64ToBytes, bytesToBase64 } from '@glovebox/sync/loro'
import { EDITOR_SAVE_PATTERNS } from '../src/corpus/editor-saves.ts'
import { MemoryFS } from '../src/fs/memory-fs.ts'

/**
 * M4 daemon content cycle, end-to-end against the REAL WorkspaceServer:
 * pull → guarded checkout → scan → push → final checkout over a MemoryFS
 * mount, with a real browser-engine client as the concurrent editor.
 */

// --- server harness (same shape as the sync-engine test suite) -------------

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

  constructor() {
    const storage = new FakeStorage()
    this.server = new WorkspaceServer({
      storage,
      sql: storage.sql,
      getSockets: () => this.sockets,
    })
  }

  async connect(): Promise<LiveSocket> {
    const socket = new LiveSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket)
    return socket
  }

  /** Canonical server text, via a throwaway snapshot fetch. */
  async serverText(fileId: string): Promise<string> {
    const socket = await this.connect()
    const transport = new SocketTransport(this, socket)
    const snapshot = await transport.fetchSnapshot(fileId)
    return LoroFileDoc.fromSnapshot(snapshot).getTextContent()
  }
}

/** Serves both the daemon transport and the browser-engine transport. */
class SocketTransport implements WorkspaceSyncTransport {
  readonly #host: ServerHost
  readonly #socket: LiveSocket
  readonly #pendingSnapshots = new Map<
    string,
    { resolve: (snapshot: Uint8Array) => void; reject: (error: Error) => void }
  >()
  readonly #pendingEvents = new Map<string, (result: EventsSinceResult) => void>()
  readonly #pendingSubmits = new Map<
    string,
    { resolve: (result: SubmitUpdateResult) => void; reject: (error: Error) => void }
  >()
  readonly #pendingBatches = new Map<
    string,
    { resolve: (result: BatchSubmitResult) => void; reject: (error: Error) => void }
  >()
  readonly #pendingOpaqueSubmits = new Map<string, (result: SubmitOpaqueResult) => void>()
  readonly #pendingOpaqueGets = new Map<string, (result: OpaqueFetchResult) => void>()
  readonly #pendingOpaqueGetObjects = new Map<string, OpaqueObjectPayload[]>()
  readonly #pendingTrees = new Map<string, (result: DaemonTreeState) => void>()
  readonly #eventHandlers = new Set<(event: WireWorkspaceEvent) => void>()
  /** When true, submits fail at the transport layer (offline simulation). */
  failSubmits = false
  #requestCounter = 0

  constructor(host: ServerHost, socket: LiveSocket) {
    this.#host = host
    this.#socket = socket
    socket.onMessage = (message) => this.#handle(message)
  }

  async fetchSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pendingSnapshots.set(requestId, { resolve, reject })
    })
    await this.#host.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'snapshot.get', requestId, fileId, initialContent, observedPath }),
    )
    return promise
  }

  async submitBatch(ops: WorkspaceBatchWireOp[]): Promise<BatchSubmitResult> {
    if (this.failSubmits) {
      throw new Error('offline')
    }
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<BatchSubmitResult>((resolve, reject) => {
      this.#pendingBatches.set(requestId, { resolve, reject })
    })
    await this.#host.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'batch.submit', requestId, ops }),
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

  async submitOpaque(input: SubmitOpaqueInput): Promise<SubmitOpaqueResult> {
    if (this.failSubmits) {
      throw new Error('offline')
    }
    const promise = new Promise<SubmitOpaqueResult>((resolve) => {
      this.#pendingOpaqueSubmits.set(input.opId, resolve)
    })
    const payload = buildOpaqueWirePayload(input.bytes)
    await this.#host.server.handleMessage(
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
    await this.#host.server.handleMessage(
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
    const requestId = `rq-${++this.#requestCounter}`
    const promise = new Promise<DaemonTreeState>((resolve) => {
      this.#pendingTrees.set(requestId, resolve)
    })
    await this.#host.server.handleMessage(
      this.#socket,
      JSON.stringify({ type: 'tree.list', requestId }),
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
      case 'tree.state': {
        const resolve = this.#pendingTrees.get(message.requestId)
        this.#pendingTrees.delete(message.requestId)
        resolve?.({ currentSeq: message.currentSeq, entries: message.entries })
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
        // A server-side throw correlated to a request: settle the flight so
        // the cycle observes a failed call instead of hanging forever (real
        // transports reject the in-flight request the same way).
        if (message.requestId === undefined) return
        const pending = this.#pendingBatches.get(message.requestId)
        if (pending) {
          this.#pendingBatches.delete(message.requestId)
          pending.reject(new Error(message.message))
        }
        const snapshot = this.#pendingSnapshots.get(message.requestId)
        if (snapshot) {
          this.#pendingSnapshots.delete(message.requestId)
          snapshot.reject(new Error(`server error: ${message.message}`))
        }
        return
      }
      case 'content.loroUpdate':
      case 'content.opaqueUpdate':
      case 'create':
      case 'rename':
      case 'delete': {
        for (const handler of this.#eventHandlers) handler(message as WireWorkspaceEvent)
        return
      }
      default:
        return
    }
  }
}

// --- fixtures ---------------------------------------------------------------

interface DaemonFixture {
  fs: MemoryFS
  storage: DaemonStorage
  engine: DaemonSyncEngine
  transport: SocketTransport
  /** Process death + restart over the same storage and mount. */
  restart(): Promise<void>
}

let fileIdCounter = 0

interface BootDaemonOptions {
  storage?: DaemonStorage
  deviceId?: string
  now?: () => number
}

async function bootDaemon(
  host: ServerHost,
  fs: MemoryFS,
  options: BootDaemonOptions = {},
): Promise<DaemonFixture> {
  const storage = options.storage ?? new MemoryDaemonStorage()
  const deviceId = options.deviceId ?? 'daemon-1'
  const makeEngine = async (): Promise<{
    engine: DaemonSyncEngine
    transport: SocketTransport
  }> => {
    const transport = new SocketTransport(host, await host.connect())
    const engine = new DaemonSyncEngine({
      workspaceId: 'ws-1',
      mountId: `mount-${deviceId}`,
      deviceId,
      fs,
      storage,
      transport,
      now: options.now,
      newFileId: () => `file-${++fileIdCounter}`,
    })
    await engine.start()
    return { engine, transport }
  }

  const first = await makeEngine()
  const fixture: DaemonFixture = {
    fs,
    storage,
    engine: first.engine,
    transport: first.transport,
    restart: async () => {
      fixture.engine.stop()
      const next = await makeEngine()
      fixture.engine = next.engine
      fixture.transport = next.transport
    },
  }
  return fixture
}

async function bootBrowserClient(host: ServerHost, deviceId: string): Promise<WorkspaceSyncEngine> {
  const transport = new SocketTransport(host, await host.connect())
  const engine = new WorkspaceSyncEngine({
    workspaceId: 'ws-1',
    deviceId,
    storage: new MemoryClientStorage(),
    transport,
  })
  await engine.start()
  return engine
}

function onlyFileId(daemon: DaemonFixture): string {
  const files = daemon.engine.files()
  expect(files).toHaveLength(1)
  return files[0]!.fileId
}

// --- scenarios --------------------------------------------------------------

describe('DaemonSyncEngine content cycle', () => {
  it('pushes a disk create to the server and stays quiet afterwards', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'notes/hello.md': 'hello from disk\n' })
    const daemon = await bootDaemon(host, fs)

    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    expect(await host.serverText(fileId)).toBe('hello from disk\n')

    await daemon.engine.runCycle()
    expect(daemon.engine.hasPendingChanges()).toBe(false)
    expect(fs.getFile('notes/hello.md')).toBe('hello from disk\n')
  })

  it('checks out a remote edit and rolls the watermark', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'base\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    const browser = await bootBrowserClient(host, 'browser-1')
    const client = await browser.openFile(fileId, 'doc.md')
    await client.setTextContent('base\nremote line\n')
    await browser.flush()

    await daemon.engine.runCycle()
    expect(fs.getFile('doc.md')).toBe('base\nremote line\n')

    // Watermark rolled with the write: the next cycle sees a clean disk.
    await daemon.engine.runCycle()
    expect(daemon.engine.hasPendingChanges()).toBe(false)
    expect(fs.getFile('doc.md')).toBe('base\nremote line\n')
  })

  it('merges concurrent remote and local edits without losing either (INV-5 anchor)', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'alpha\nomega\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    const browser = await bootBrowserClient(host, 'browser-1')
    const client = await browser.openFile(fileId, 'doc.md')

    // Remote inserts at the top while disk gets a local edit at the bottom —
    // neither has seen the other.
    await client.setTextContent('REMOTE\nalpha\nomega\n')
    await browser.flush()
    fs.putFile('doc.md', 'alpha\nomega\nLOCAL\n')

    await daemon.engine.runCycle()
    await browser.flush()

    const merged = fs.getFile('doc.md')!
    expect(merged).toContain('REMOTE')
    expect(merged).toContain('LOCAL')
    expect(merged).toContain('alpha')
    expect(await host.serverText(fileId)).toBe(merged)
    expect(browser.getText(fileId)).toBe(merged)
  })

  it('absorbs every editor-save pattern as a content change on the same file', async () => {
    for (const pattern of EDITOR_SAVE_PATTERNS) {
      const host = new ServerHost()
      const fs = MemoryFS.from({ 'notes/doc.md': 'original\n' })
      const daemon = await bootDaemon(host, fs)
      await daemon.engine.runCycle()
      const fileId = onlyFileId(daemon)

      const content = `saved by ${pattern.name}\n`
      await pattern.run(fs, 'notes/doc.md', content)
      await daemon.engine.runCycle()

      expect(daemon.engine.files(), pattern.name).toHaveLength(1)
      expect(daemon.engine.pendingDeletes(), pattern.name).toEqual([])
      expect(await host.serverText(fileId), pattern.name).toBe(content)
      expect(fs.getFile('notes/doc.md'), pattern.name).toBe(content)
    }
  })

  it('normalizes CRLF at the scan boundary without a resubmit loop (INV-13)', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'one\r\ntwo\r\n' })
    const daemon = await bootDaemon(host, fs)

    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    expect(await host.serverText(fileId)).toBe('one\ntwo\n')

    // Second cycle absorbs the file's own 'create' event into the cursor;
    // after that, a quiet cycle must not advance it (a CRLF resubmit loop
    // would keep minting content events).
    await daemon.engine.runCycle()
    const settled = daemon.engine.lastAckedSeq()
    await daemon.engine.runCycle()
    expect(daemon.engine.hasPendingChanges()).toBe(false)
    expect(daemon.engine.lastAckedSeq()).toBe(settled)
  })

  it('records a delete intent without propagating, then remote-edit-wins resurrects', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'keep me\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    await fs.deletePath('doc.md')
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes().map((intent) => intent.fileId)).toEqual([fileId])
    // No propagation and no resurrection while the intent is open.
    expect(await host.serverText(fileId)).toBe('keep me\n')
    expect(fs.getFile('doc.md')).toBeNull()
    await daemon.engine.runCycle()
    expect(fs.getFile('doc.md')).toBeNull()
    expect(daemon.engine.pendingDeletes()).toHaveLength(1)

    const browser = await bootBrowserClient(host, 'browser-1')
    const client = await browser.openFile(fileId, 'doc.md')
    await client.setTextContent('keep me\nedited remotely\n')
    await browser.flush()

    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toEqual([])
    expect(fs.getFile('doc.md')).toBe('keep me\nedited remotely\n')
  })

  it('tracks a rename as the same file and keeps pushing under its fileId', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'old.md': 'content\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    await fs.rename('old.md', 'new.md')
    await daemon.engine.runCycle()
    expect(daemon.engine.files()).toEqual([{ fileId, path: 'new.md', contentKind: 'markdown' }])
    expect(daemon.engine.pendingDeletes()).toEqual([])

    fs.putFile('new.md', 'content\nmore\n')
    await daemon.engine.runCycle()
    expect(await host.serverText(fileId)).toBe('content\nmore\n')
  })

  it('retransmits an offline edit after restart over the same storage (INV-2)', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'base\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    daemon.transport.failSubmits = true
    fs.putFile('doc.md', 'base\nunacked edit\n')
    await daemon.engine.runCycle()
    expect(await host.serverText(fileId)).toBe('base\n')
    expect(daemon.engine.hasPendingChanges()).toBe(true)

    await daemon.restart()
    expect(daemon.engine.hasPendingChanges()).toBe(true)
    await daemon.engine.runCycle()
    expect(await host.serverText(fileId)).toBe('base\nunacked edit\n')
    expect(daemon.engine.files()).toEqual([{ fileId, path: 'doc.md', contentKind: 'markdown' }])
  })

  it('restart with no changes makes no new submissions', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'stable\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    await daemon.engine.runCycle() // settle the cursor over the 'create' event
    const seq = daemon.engine.lastAckedSeq()

    await daemon.restart()
    await daemon.engine.runCycle()
    expect(daemon.engine.lastAckedSeq()).toBe(seq)
    expect(daemon.engine.hasPendingChanges()).toBe(false)
    expect(fs.getFile('doc.md')).toBe('stable\n')
  })
})

// --- INV-3 deletion stack ----------------------------------------------------

describe('DaemonSyncEngine INV-3 deletion stack', () => {
  it('propagates a single delete only after the tombstone delay', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fs = MemoryFS.from({ 'a.md': 'alpha\n', 'b.md': 'beta\n' })
    const daemon = await bootDaemon(host, fs, { now: () => clock.nowMs })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileA = daemon.engine.files().find((file) => file.path === 'a.md')!.fileId

    await fs.deletePath('a.md')
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes().map((intent) => intent.fileId)).toEqual([fileA])

    // 29s later: still held by the tombstone delay; nothing propagated.
    clock.nowMs += 29_000
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toHaveLength(1)
    expect(await host.serverText(fileA)).toBe('alpha\n')

    // Past 30s: the delete lands; local tracking drops the file.
    clock.nowMs += 2_000
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toEqual([])
    expect(daemon.engine.files().map((file) => file.path)).toEqual(['b.md'])
    // Server tombstoned it: fresh snapshot.get re-creates empty-of-old-text.
    expect(await host.serverText(fileA)).not.toContain('alpha')
  })

  it('cancels and resurrects when the server defers the delete as remote-edit-wins', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fs = MemoryFS.from({ 'doc.md': 'precious\n' })
    const daemon = await bootDaemon(host, fs, { now: () => clock.nowMs })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    await fs.deletePath('doc.md')
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toHaveLength(1)

    // A browser edit lands BETWEEN the daemon's pull and its propagation —
    // staged by injecting the edit right before the batch goes out.
    const browser = await bootBrowserClient(host, 'browser-race')
    const realSubmitBatch = daemon.transport.submitBatch.bind(daemon.transport)
    let injected = false
    daemon.transport.submitBatch = async (ops) => {
      if (!injected) {
        injected = true
        const client = await browser.openFile(fileId, 'doc.md')
        await client.setTextContent('precious\nedited concurrently\n')
        await browser.flush()
      }
      return realSubmitBatch(ops)
    }

    clock.nowMs += 31_000
    await daemon.engine.runCycle()
    expect(injected).toBe(true)
    // The intent died; the file resurrected locally (doc text first, the
    // concurrent edit merges on the next pull).
    expect(daemon.engine.pendingDeletes()).toEqual([])
    expect(fs.getFile('doc.md')).not.toBeNull()

    await daemon.engine.runCycle()
    expect(fs.getFile('doc.md')).toBe('precious\nedited concurrently\n')
    expect(await host.serverText(fileId)).toBe('precious\nedited concurrently\n')
  })

  it('holds a bulk disappearance behind the sliding-window guard, releasing on reappearance', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const files = {
      'n/1.md': 'one\n',
      'n/2.md': 'two\n',
      'n/3.md': 'three\n',
      'n/4.md': 'four\n',
    }
    const fs = MemoryFS.from(files)
    const daemon = await bootDaemon(host, fs, { now: () => clock.nowMs })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileIds = daemon.engine.files().map((file) => file.fileId)

    // The wipe: every file vanishes at once (git checkout / unmounted volume).
    for (const path of Object.keys(files)) {
      await fs.deletePath(path)
    }
    await daemon.engine.runCycle()
    const intents = daemon.engine.pendingDeletes()
    expect(intents).toHaveLength(4)
    expect(intents.every((intent) => intent.held === 'bulk-window')).toBe(true)

    // No amount of waiting releases a held wipe.
    clock.nowMs += 120_000
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toHaveLength(4)
    for (const fileId of fileIds) {
      expect(await host.serverText(fileId)).toMatch(/one|two|three|four/)
    }

    // The volume comes back: intents cancel, nothing was lost anywhere.
    for (const [path, content] of Object.entries(files)) {
      fs.putFile(path, content)
    }
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toEqual([])
    expect(daemon.engine.files()).toHaveLength(4)
  })

  it('holds a 100% wipe seen by the first scan after a restart (startup guard)', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const storage = new MemoryDaemonStorage()
    const fs = MemoryFS.from({ 'x.md': 'ex\n', 'y.md': 'why\n' })
    const daemon = await bootDaemon(host, fs, { now: () => clock.nowMs, storage })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileIds = daemon.engine.files().map((file) => file.fileId)

    // Two files is BELOW the window guard's ratio floor — only the startup
    // guard can catch this wipe.
    daemon.engine.stop()
    await fs.deletePath('x.md')
    await fs.deletePath('y.md')
    await daemon.restart()
    await daemon.engine.runCycle()

    const intents = daemon.engine.pendingDeletes()
    expect(intents).toHaveLength(2)
    expect(intents.every((intent) => intent.held === 'bulk-startup')).toBe(true)

    clock.nowMs += 60_000
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toHaveLength(2)
    expect(await host.serverText(fileIds[0]!)).toBe('ex\n')
    expect(await host.serverText(fileIds[1]!)).toBe('why\n')
  })

  it('freezes all delete processing while the sentinel is missing (suspect mount)', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fs = MemoryFS.from({ 'doc.md': 'guarded\n' })
    const daemon = await bootDaemon(host, fs, { now: () => clock.nowMs })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    expect(fs.getFile('.glovebox.json')).not.toBeNull() // adopted on first cycle

    await fs.deletePath('.glovebox.json')
    await fs.deletePath('doc.md')
    clock.nowMs += 60_000
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    // Suspect: the absence was never even recorded, nothing propagated,
    // and nothing was written into the possibly-foreign directory.
    expect(daemon.engine.mountSuspect()).toBe(true)
    expect(daemon.engine.pendingDeletes()).toEqual([])
    expect(await host.serverText(fileId)).toBe('guarded\n')
    expect(fs.getFile('doc.md')).toBeNull()

    // Sentinel restored: trust resumes, and the (real) deletion propagates
    // through the normal tombstone path.
    fs.putFile('.glovebox.json', '{}')
    await daemon.engine.runCycle()
    expect(daemon.engine.mountSuspect()).toBe(false)
    expect(daemon.engine.pendingDeletes()).toHaveLength(1)
    clock.nowMs += 31_000
    await daemon.engine.runCycle()
    expect(daemon.engine.pendingDeletes()).toEqual([])
    expect(daemon.engine.files()).toEqual([])
  })

  it('discovers files created by another replica and applies its renames', async () => {
    const host = new ServerHost()
    const fsA = MemoryFS.from({ 'shared.md': 'from A\n' })
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A' })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B' })

    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    expect(fsB.getFile('shared.md')).toBe('from A\n')
    const fileId = onlyFileId(daemonB)

    // A renames; B applies it as a rename of the SAME fileId, moving the
    // disk file — never delete+create.
    await fsA.rename('shared.md', 'moved.md')
    await daemonA.engine.runCycle()
    expect(daemonA.engine.pendingRenames()).toEqual([])

    await daemonB.engine.runCycle()
    expect(fsB.getFile('shared.md')).toBeNull()
    expect(fsB.getFile('moved.md')).toBe('from A\n')
    expect(onlyFileId(daemonB)).toBe(fileId)
  })

  it('applies a propagated delete on the other replica with a guarded disk removal', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fsA = MemoryFS.from({ 'doomed.md': 'bye\n', 'keep.md': 'stay\n' })
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A', now: () => clock.nowMs })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B', now: () => clock.nowMs })
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    expect(fsB.getFile('doomed.md')).toBe('bye\n')

    await fsA.deletePath('doomed.md')
    await daemonA.engine.runCycle()
    clock.nowMs += 31_000
    await daemonA.engine.runCycle()
    expect(daemonA.engine.files().map((file) => file.path)).toEqual(['keep.md'])

    await daemonB.engine.runCycle()
    expect(fsB.getFile('doomed.md')).toBeNull()
    expect(fsB.getFile('keep.md')).toBe('stay\n')
    expect(daemonB.engine.files().map((file) => file.path)).toEqual(['keep.md'])
  })

  it('local unacked edit survives a remote delete: the file resurrects everywhere (INV-2)', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fsA = MemoryFS.from({ 'contest.md': 'original\n' })
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A', now: () => clock.nowMs })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B', now: () => clock.nowMs })
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    const fileId = onlyFileId(daemonB)

    // A deletes and propagates; meanwhile B edits the same file on disk
    // WITHOUT cycling (its edit is unseen when the delete event arrives).
    await fsA.deletePath('contest.md')
    await daemonA.engine.runCycle()
    clock.nowMs += 31_000
    await daemonA.engine.runCycle()

    fsB.putFile('contest.md', 'original\nedited on B\n')
    await daemonB.engine.runCycle()
    // B's bytes won: the file re-created server-side under the same fileId.
    expect(fsB.getFile('contest.md')).toBe('original\nedited on B\n')
    expect(await host.serverText(fileId)).toBe('original\nedited on B\n')

    // A discovers the resurrected file and re-materializes it.
    await daemonA.engine.runCycle()
    expect(fsA.getFile('contest.md')).toBe('original\nedited on B\n')
  })
})

// --- ISSUE-0045: full daemon opaque content cycle -----------------------------

/** Distinct binary payloads: PNG magic (not valid UTF-8) plus a tail. */
function pngBytes(...tail: number[]): Uint8Array {
  return Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail)
}

function patternedBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bytes[i] = (i * 31 + Math.floor(i / 257)) % 251
  }
  return bytes
}

describe('opaque cycle (ISSUE-0045)', () => {
  it('pushes a disk binary create: opaque tree row, right hash, tracked locally', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({})
    const bytes = pngBytes(1, 2, 3)
    await fs.writeFileBytes('assets/logo.png', bytes)
    const daemon = await bootDaemon(host, fs)

    await daemon.engine.runCycle()
    await daemon.engine.runCycle()

    const tree = await daemon.transport.listTree()
    expect(tree.entries).toHaveLength(1)
    const entry = tree.entries[0]!
    expect(entry.path).toBe('assets/logo.png')
    expect(entry.contentKind).toBe('opaque')
    expect(entry.contentHash).toBe(sha256Hex(bytes))
    expect(daemon.engine.files()).toEqual([
      { fileId: entry.fileId, path: 'assets/logo.png', contentKind: 'opaque' },
    ])
    expect(await fs.readFileBytes('assets/logo.png')).toEqual(bytes)
  })

  it('propagates a binary overwrite and materializes it on a second daemon via pull', async () => {
    const host = new ServerHost()
    const fsA = MemoryFS.from({})
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A' })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B' })
    // Both adopt the still-empty workspace first, so B discovers the binary
    // through its own pull (create + content.opaqueUpdate events), never
    // through adoption or a live broadcast.
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()

    const v1 = pngBytes(1)
    await fsA.writeFileBytes('img.png', v1)
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    expect(await fsB.readFileBytes('img.png')).toEqual(v1)
    expect(daemonB.engine.files().map((file) => file.path)).toEqual(['img.png'])

    const v2 = pngBytes(2, 2)
    await fsA.writeFileBytes('img.png', v2)
    await daemonA.engine.runCycle()
    const entry = (await daemonA.transport.listTree()).entries.find(
      (candidate) => candidate.path === 'img.png',
    )
    expect(entry?.contentHash).toBe(sha256Hex(v2))

    await daemonB.engine.runCycle()
    expect(await fsB.readFileBytes('img.png')).toEqual(v2)
  })

  it('round-trips a 4 MiB opaque file disk -> server -> second daemon disk', async () => {
    const host = new ServerHost()
    const fsA = MemoryFS.from({})
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A' })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B' })
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()

    const bytes = patternedBytes(4 * 1024 * 1024)
    await fsA.writeFileBytes('large.bin', bytes)
    await daemonA.engine.runCycle()

    const entry = (await daemonA.transport.listTree()).entries.find(
      (candidate) => candidate.path === 'large.bin',
    )
    expect(entry).toMatchObject({
      contentKind: 'opaque',
      contentHash: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
    })

    await daemonB.engine.runCycle()
    expect(await fsB.readFileBytes('large.bin')).toEqual(bytes)
  }, 15_000)

  it('behind-window opaque refresh uses metadata-only probes before object fetches', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({})
    const daemon = await bootDaemon(host, fs, { deviceId: 'daemon-A' })
    await daemon.engine.runCycle()

    const bytes = pngBytes(4, 5, 6)
    await fs.writeFileBytes('clean.bin', bytes)
    await daemon.engine.runCycle()
    expect(await fs.readFileBytes('clean.bin')).toEqual(bytes)

    const tree = await daemon.transport.listTree()
    const currentSeq = tree.currentSeq
    const realEventsSince = daemon.transport.eventsSince.bind(daemon.transport)
    const realFetchOpaque = daemon.transport.fetchOpaque.bind(daemon.transport)
    const fetches: Array<{ existingBytes?: Uint8Array; metadataOnly?: boolean }> = []
    daemon.transport.eventsSince = async () => ({
      ok: false,
      reason: 'snapshot-required',
      currentSeq,
    })
    daemon.transport.fetchOpaque = async (fileId, existingBytes, options) => {
      fetches.push({ existingBytes, metadataOnly: options?.metadataOnly })
      return realFetchOpaque(fileId, existingBytes, options)
    }

    await daemon.engine.runCycle()
    expect(fetches).toEqual([{ existingBytes: undefined, metadataOnly: true }])

    fetches.length = 0
    const dirty = pngBytes(8, 9, 10)
    await fs.writeFileBytes('clean.bin', dirty)
    await daemon.engine.runCycle()
    daemon.transport.eventsSince = realEventsSince

    expect(fetches).toEqual([{ existingBytes: undefined, metadataOnly: true }])
    const dirtyEntry = (await daemon.transport.listTree()).entries.find(
      (candidate) => candidate.path === 'clean.bin',
    )
    expect(dirtyEntry?.contentHash).toBe(sha256Hex(dirty))
  })

  it('opaque conflict: the later submitter wins LWW and the loser lands in recovery', async () => {
    const host = new ServerHost()
    const fsA = MemoryFS.from({})
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A' })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B' })
    const base = pngBytes(0)
    await fsA.writeFileBytes('shared.png', base)
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    expect(await fsB.readFileBytes('shared.png')).toEqual(base)

    // Both diverge from the same confirmed base without seeing each other.
    const fromA = pngBytes(0xaa)
    const fromB = pngBytes(0xbb, 0xbb)
    await fsA.writeFileBytes('shared.png', fromA)
    await fsB.writeFileBytes('shared.png', fromB)

    await daemonA.engine.runCycle() // base matched — lands cleanly
    await daemonB.engine.runCycle() // stale base — conflicts; B is later and wins

    const records = host.server.listRecoveryRecords({ pendingOnly: true })
    expect(records).toHaveLength(1)
    expect(records[0]!.reason).toBe('opaque-conflict-loser')
    const payload = JSON.parse(records[0]!.payload) as { hashHex: string; sizeBytes: number }
    expect(payload.hashHex).toBe(sha256Hex(fromA))
    expect(payload.sizeBytes).toBe(fromA.byteLength)

    // Neither disk was zeroed; further cycles converge both to the winner.
    expect(await fsB.readFileBytes('shared.png')).toEqual(fromB)
    expect(await fsA.readFileBytes('shared.png')).toEqual(fromA)
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    expect(await fsA.readFileBytes('shared.png')).toEqual(fromB)
    expect(await fsB.readFileBytes('shared.png')).toEqual(fromB)
  })

  it('propagates a binary delete after the tombstone delay and clears the second replica', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fsA = MemoryFS.from({ 'keep.md': 'stay\n' })
    const bin = pngBytes(9)
    await fsA.writeFileBytes('gone.png', bin)
    const fsB = MemoryFS.from({})
    const daemonA = await bootDaemon(host, fsA, { deviceId: 'daemon-A', now: () => clock.nowMs })
    const daemonB = await bootDaemon(host, fsB, { deviceId: 'daemon-B', now: () => clock.nowMs })
    await daemonA.engine.runCycle()
    await daemonB.engine.runCycle()
    expect(await fsB.readFileBytes('gone.png')).toEqual(bin)

    await fsA.deletePath('gone.png')
    await daemonA.engine.runCycle()
    expect(daemonA.engine.pendingDeletes().map((intent) => intent.path)).toEqual(['gone.png'])
    // Held by the tombstone delay: the row is still live.
    expect((await daemonA.transport.listTree()).entries.map((entry) => entry.path).sort()).toEqual([
      'gone.png',
      'keep.md',
    ])

    clock.nowMs += 31_000
    await daemonA.engine.runCycle()
    expect(daemonA.engine.pendingDeletes()).toEqual([])
    expect((await daemonA.transport.listTree()).entries.map((entry) => entry.path)).toEqual([
      'keep.md',
    ])

    await daemonB.engine.runCycle()
    expect(fsB.getFile('gone.png')).toBeNull()
    expect(daemonB.engine.files().map((file) => file.path)).toEqual(['keep.md'])
  })

  it('binary create lands exactly once across a crash between scan and push', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({})
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle() // adopt the empty workspace

    const bytes = pngBytes(4, 2)
    await fs.writeFileBytes('pic.png', bytes)
    daemon.transport.failSubmits = true
    await daemon.engine.runCycle() // create tracked locally; the push never lands
    expect((await daemon.transport.listTree()).entries).toEqual([])

    await daemon.restart() // process death + reboot over the same storage and mount
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()

    const entries = (await daemon.transport.listTree()).entries
    expect(entries.map((entry) => entry.path)).toEqual(['pic.png']) // one row, no -2 suffix
    expect(entries[0]!.contentHash).toBe(sha256Hex(bytes))
    expect(daemon.engine.files().map((file) => file.path)).toEqual(['pic.png'])
    expect(await fs.readFileBytes('pic.png')).toEqual(bytes)
  })
})

// --- ISSUE-0043: renames across the md↔opaque kind boundary -------------------

describe('kind-boundary rename (ISSUE-0043)', () => {
  it('md→opaque rename keeps the fileId and later byte edits survive every cycle (DEFECT-1)', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'note.md': 'was markdown\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    await fs.rename('note.md', 'note.png')
    await daemon.engine.runCycle()
    expect(daemon.engine.files()).toEqual([{ fileId, path: 'note.png', contentKind: 'opaque' }])
    expect(daemon.engine.pendingRenames()).toEqual([])
    const tree = await daemon.transport.listTree()
    expect(tree.entries).toHaveLength(1) // ONE rename — never delete+create
    expect(tree.entries[0]).toMatchObject({ fileId, path: 'note.png', contentKind: 'opaque' })

    // DEFECT-1 regression: a byte overwrite after the boundary rename must
    // survive every subsequent cycle (a stale markdown view absorbed the
    // bytes as text and the checkout stomped the user's file).
    const bytes = pngBytes(7)
    await fs.writeFileBytes('note.png', bytes)
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await daemon.engine.runCycle()
      expect(await fs.readFileBytes('note.png'), `after cycle ${cycle}`).toEqual(bytes)
    }
    const entry = (await daemon.transport.listTree()).entries[0]!
    expect(entry.contentHash).toBe(sha256Hex(bytes))
  })

  it('opaque→md rename adopts the bytes as markdown and later edits merge, not LWW', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({})
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    const text = 'plain text wearing a .bin extension\n'
    await fs.writeFileBytes('img.bin', new TextEncoder().encode(text))
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    expect(daemon.engine.files()[0]!.contentKind).toBe('opaque')

    await fs.rename('img.bin', 'img.md')
    await daemon.engine.runCycle()
    expect(daemon.engine.files()).toEqual([{ fileId, path: 'img.md', contentKind: 'markdown' }])
    const entry = (await daemon.transport.listTree()).entries.find(
      (candidate) => candidate.fileId === fileId,
    )
    expect(entry?.path).toBe('img.md')
    expect(entry?.contentKind).not.toBe('opaque') // the row kind re-derived to markdown
    expect(await host.server.readTextFile(fileId)).toMatchObject({ status: 'ok', text })

    // Subsequent edits sync as markdown: a concurrent browser edit and a
    // disk edit merge as a union instead of LWW-overwriting each other.
    const browser = await bootBrowserClient(host, 'browser-1')
    const client = await browser.openFile(fileId, 'img.md')
    await client.setTextContent(`REMOTE\n${text}`)
    await browser.flush()
    fs.putFile('img.md', `${text}LOCAL\n`)
    await daemon.engine.runCycle()
    const merged = fs.getFile('img.md')!
    expect(merged).toContain('REMOTE')
    expect(merged).toContain('LOCAL')
    expect(await host.serverText(fileId)).toBe(merged)
  })

  it('applies a remote md→opaque rename and keeps syncing the bytes by LWW', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'note.md': 'body text\n' })
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)

    // Another client renames across the boundary with a fresh baseSeq.
    const remote = new SocketTransport(host, await host.connect())
    const { currentSeq } = await remote.listTree()
    const result = await remote.submitBatch([
      {
        type: 'file.rename',
        opId: 'op-remote-boundary-rename',
        fileId,
        baseSeq: currentSeq,
        fromPath: 'note.md',
        toPath: 'note.png',
      },
    ])
    expect(result.type).toBe('ack')
    expect(result.type === 'ack' && result.acceptedOps.map((op) => op.opId)).toEqual([
      'op-remote-boundary-rename',
    ])

    await daemon.engine.runCycle()
    expect(fs.getFile('note.md')).toBeNull()
    expect(fs.getFile('note.png')).toBe('body text\n')
    expect(daemon.engine.files()).toEqual([{ fileId, path: 'note.png', contentKind: 'opaque' }])

    // A later disk edit flows through the opaque LWW path and is never
    // truncated by a stale markdown view.
    const bytes = pngBytes(0x42)
    await fs.writeFileBytes('note.png', bytes)
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await daemon.engine.runCycle()
      expect(await fs.readFileBytes('note.png'), `after cycle ${cycle}`).toEqual(bytes)
    }
    const entry = (await daemon.transport.listTree()).entries.find(
      (candidate) => candidate.fileId === fileId,
    )
    expect(entry?.contentHash).toBe(sha256Hex(bytes))
  })
})

// --- ISSUE-0044: tree adoption on remount --------------------------------------

describe('kind self-heal (ISSUE-0043 hardening)', () => {
  it('heals a persisted markdown view stranded at an opaque path (crash window / legacy state)', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'note.md': '# stranded\n' })
    const daemon = await bootDaemon(host, fs, { deviceId: 'daemon-A' })
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    daemon.engine.stop()

    // Fabricate the DEFECT-1-era drift: the persisted view's path moved
    // across the boundary but its kind never transitioned (a crash between
    // the two writes, or pre-fix legacy state). Disk + server row follow
    // the rename; the state artifact keeps contentKind 'markdown'.
    await fs.rename('note.md', 'note.png')
    const head = (await daemon.transport.listTree()).currentSeq
    const ack = await daemon.transport.submitBatch([
      {
        type: 'file.rename',
        opId: 'heal-ren',
        fileId,
        baseSeq: head,
        fromPath: 'note.md',
        toPath: 'note.png',
      },
    ])
    expect(ack.type).toBe('ack')
    const stateRaw = (await daemon.storage.read('workspace-state.json'))!
    const state = JSON.parse(new TextDecoder().decode(stateRaw)) as DaemonWorkspaceState
    state.files[fileId]!.path = 'note.png'
    // Cursor stays where it is; kind deliberately stays 'markdown'.
    await daemon.storage.writeAtomic(
      'workspace-state.json',
      new TextEncoder().encode(JSON.stringify(state)),
    )

    await daemon.restart()
    await daemon.engine.runCycle()
    expect(daemon.engine.files()).toEqual([{ fileId, path: 'note.png', contentKind: 'opaque' }])

    // The original data-loss trigger: a disk edit after the drift. The
    // bytes must survive and flow as opaque content.
    const edited = pngBytes(1, 2, 3)
    await fs.writeFileBytes('note.png', edited)
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    expect(await fs.readFileBytes('note.png')).toEqual(edited)
    const entry = (await daemon.transport.listTree()).entries.find(
      (candidate) => candidate.fileId === fileId,
    )
    expect(entry?.path).toBe('note.png')
    expect(entry?.contentKind).toBe('opaque')
    expect(entry?.contentHash).toBe(sha256Hex(edited))
  })
})

describe('remount adoption (ISSUE-0044)', () => {
  it('remount over fresh state binds every disk file to its existing fileId', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'a.md': 'alpha\n', 'docs/b.md': 'beta\n' })
    const bin = pngBytes(3, 1, 4)
    await fs.writeFileBytes('assets/pi.png', bin)
    const daemon = await bootDaemon(host, fs, { deviceId: 'daemon-A' })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const before = await daemon.transport.listTree()
    expect(before.entries).toHaveLength(3)
    const fileIdByPath = new Map(before.entries.map((entry) => [entry.path, entry.fileId]))
    const diskBefore = fs.snapshot()
    daemon.engine.stop()

    // Unmount→remount: fresh state dir, same disk, new device/mount identity.
    const remounted = await bootDaemon(host, fs, {
      storage: new MemoryDaemonStorage(),
      deviceId: 'daemon-remount',
    })
    await remounted.engine.runCycle()

    const after = await remounted.transport.listTree()
    expect(after.entries).toHaveLength(3) // no -2 suffix duplicates
    for (const entry of after.entries) {
      expect(entry.fileId, entry.path).toBe(fileIdByPath.get(entry.path))
    }
    expect(fs.snapshot()).toEqual(diskBefore)
    expect(
      remounted.engine
        .files()
        .map((file) => file.path)
        .sort(),
    ).toEqual(['a.md', 'assets/pi.png', 'docs/b.md'])
  })

  it('adoption with divergence merges the disk text and the remote edit as a union', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'doc.md': 'alpha\nomega\n' })
    const daemon = await bootDaemon(host, fs, { deviceId: 'daemon-A' })
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const fileId = onlyFileId(daemon)
    daemon.engine.stop()

    // While unmounted: a browser edit lands server-side AND the disk copy
    // diverges — neither has seen the other when the remount adopts.
    const browser = await bootBrowserClient(host, 'browser-1')
    const client = await browser.openFile(fileId, 'doc.md')
    await client.setTextContent('REMOTE\nalpha\nomega\n')
    await browser.flush()
    fs.putFile('doc.md', 'alpha\nomega\nLOCAL\n')

    const remounted = await bootDaemon(host, fs, {
      storage: new MemoryDaemonStorage(),
      deviceId: 'daemon-remount',
    })
    await remounted.engine.runCycle()
    await remounted.engine.runCycle()

    const merged = fs.getFile('doc.md')!
    expect(merged).toContain('REMOTE')
    expect(merged).toContain('LOCAL')
    expect(merged).toContain('alpha')
    expect(await host.serverText(fileId)).toBe(merged)
  })

  it('adoption materializes server-only files to disk on the first cycle (md and opaque)', async () => {
    const host = new ServerHost()
    // Files created while NO daemon state exists anywhere.
    const browser = await bootBrowserClient(host, 'browser-1')
    await browser.openFile('srv-md-1', 'notes/remote.md', 'authored in the browser\n')
    await browser.flush()
    const wire = new SocketTransport(host, await host.connect())
    const blob = pngBytes(9, 9)
    const ack = await wire.submitOpaque({
      fileId: 'srv-bin-1',
      observedPath: 'assets/remote.png',
      opId: 'op-srv-bin-create',
      baseHashHex: '',
      bytes: blob,
    })
    expect(ack.type).toBe('ack')

    const fs = MemoryFS.from({})
    const daemon = await bootDaemon(host, fs)
    await daemon.engine.runCycle()

    expect(fs.getFile('notes/remote.md')).toBe('authored in the browser\n')
    expect(await fs.readFileBytes('assets/remote.png')).toEqual(blob)
    expect(
      daemon.engine
        .files()
        .map((file) => ({ fileId: file.fileId, path: file.path, contentKind: file.contentKind }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    ).toEqual([
      { fileId: 'srv-bin-1', path: 'assets/remote.png', contentKind: 'opaque' },
      { fileId: 'srv-md-1', path: 'notes/remote.md', contentKind: 'markdown' },
    ])
  })

  it('a crash that loses the resurrect flag never converts a server-only file into a delete', async () => {
    const host = new ServerHost()
    const browser = await bootBrowserClient(host, 'browser-1')
    await browser.openFile('srv-keep', 'remote.md', 'remote text\n')
    await browser.flush()
    const wire = new SocketTransport(host, await host.connect())
    const blob = pngBytes(7, 7)
    await wire.submitOpaque({
      fileId: 'srv-keep-bin',
      observedPath: 'remote.bin',
      opId: 'op-keep-bin',
      baseHashHex: '',
      bytes: blob,
    })

    // First cycle: adoption binds (persisted, watermark '') then the pull
    // fails — the cycle aborts AFTER the binds landed, exactly the crash
    // window where the in-memory resurrect authority would be lost.
    const fs = MemoryFS.from({ 'local.md': 'local\n' })
    const daemon = await bootDaemon(host, fs)
    const realEventsSince = daemon.transport.eventsSince.bind(daemon.transport)
    let failPull = true
    daemon.transport.eventsSince = async (afterSeq) => {
      if (failPull) {
        failPull = false
        throw new Error('network down')
      }
      return realEventsSince(afterSeq)
    }
    await expect(daemon.engine.runCycle()).rejects.toThrow('network down')
    await daemon.restart() // in-memory flags gone; binds persisted

    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    // Materialized — never recorded as delete intents, never tombstoned.
    expect(fs.getFile('remote.md')).toBe('remote text\n')
    expect(await fs.readFileBytes('remote.bin')).toEqual(blob)
    expect(daemon.engine.pendingDeletes()).toEqual([])
    const tree = await daemon.transport.listTree()
    expect(tree.entries.map((entry) => entry.path).sort()).toEqual([
      'local.md',
      'remote.bin',
      'remote.md',
    ])
  })

  it('replayed create over identical disk bytes binds instead of suffix-duplicating (kill -9 window)', async () => {
    const host = new ServerHost()
    const fs = MemoryFS.from({ 'seed.md': 'seed\n' })
    const daemon = await bootDaemon(host, fs, { deviceId: 'daemon-A' })
    await daemon.engine.runCycle()

    // Crash window: scan created the file server-side (snapshot.get with
    // initialContent) but the process died before the view persisted.
    // Emulate with a throwaway create + a restart over the same storage.
    fs.putFile('crash.md', 'crash content\n')
    const wire = new SocketTransport(host, await host.connect())
    await wire.fetchSnapshot('file-crash', 'crash content\n', 'crash.md')
    await daemon.restart()
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()

    const tree = await daemon.transport.listTree()
    const crashRows = tree.entries.filter((entry) => entry.path.startsWith('crash'))
    expect(crashRows).toHaveLength(1) // bound by path, never re-created
    expect(crashRows[0]!.fileId).toBe('file-crash')
    expect(fs.getFile('crash.md')).toBe('crash content\n')
    expect(await host.serverText('file-crash')).toBe('crash content\n')

    // Genuinely DIFFERENT content at the path keeps the suffix policy:
    // both files survive, nothing is silently merged away.
    fs.putFile('clash.md', 'local version\n')
    const wire2 = new SocketTransport(host, await host.connect())
    await wire2.fetchSnapshot('file-clash-remote', 'remote version\n', 'clash.md')
    await daemon.restart()
    await daemon.engine.runCycle()
    await daemon.engine.runCycle()
    const clashRows = (await daemon.transport.listTree()).entries.filter((entry) =>
      entry.path.startsWith('clash'),
    )
    expect(clashRows).toHaveLength(2)
    expect(fs.getFile('clash.md')).toBe('remote version\n')
    expect(fs.getFile('clash-2.md')).toBe('local version\n')
    expect(await host.serverText('file-clash-remote')).toBe('remote version\n')
    const localSurvivor = clashRows.find((entry) => entry.fileId !== 'file-clash-remote')
    expect(localSurvivor?.path).toBe('clash-2.md')
    expect(await host.serverText(localSurvivor!.fileId)).toBe('local version\n')
  })

  it('empty adoption is a no-op, persists adoptedAt, and a second boot never re-adopts', async () => {
    const host = new ServerHost()
    const clock = { nowMs: 1_750_000_000_000 }
    const fs = MemoryFS.from({})
    const daemon = await bootDaemon(host, fs, { now: () => clock.nowMs })
    await daemon.engine.runCycle()
    expect((await daemon.transport.listTree()).entries).toEqual([])
    expect(daemon.engine.files()).toEqual([])
    expect(fs.allPaths()).toEqual(['.glovebox.json']) // only the mount sentinel

    const readState = async (): Promise<DaemonWorkspaceState> =>
      JSON.parse(
        new TextDecoder().decode((await daemon.storage.read('workspace-state.json'))!),
      ) as DaemonWorkspaceState
    const adoptedAt = (await readState()).adoptedAt
    expect(adoptedAt).toBe(clock.nowMs)

    clock.nowMs += 60_000
    await daemon.restart()
    let treeCalls = 0
    const realListTree = daemon.transport.listTree.bind(daemon.transport)
    daemon.transport.listTree = async () => {
      treeCalls += 1
      return realListTree()
    }
    await daemon.engine.runCycle()
    expect(treeCalls).toBe(0) // adoptedAt persisted — no second adoption pass
    expect((await readState()).adoptedAt).toBe(adoptedAt)
  })
})
