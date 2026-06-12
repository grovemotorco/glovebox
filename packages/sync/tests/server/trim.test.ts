import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { base64ToBytes, bytesToBase64 } from '../../src/loro/base64.ts'
import type { TrimPolicy } from '../../src/server/trim.ts'
import {
  WorkspaceServer,
  type WorkspaceClientMessage,
  type WorkspaceServerMessage,
  type WorkspaceServerStorage,
  type WorkspaceSocket,
  type WorkspaceSqlStorage,
  type WorkspaceSqlValue,
} from '../../src/server/workspace-server.ts'

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

class FakeSocket implements WorkspaceSocket {
  readonly sent: WorkspaceServerMessage[] = []
  #attachment: unknown

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WorkspaceServerMessage)
  }

  close(): void {}

  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value)
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment)
  }

  received<T extends WorkspaceServerMessage['type']>(
    type: T,
  ): Extract<WorkspaceServerMessage, { type: T }>[] {
    return this.sent.filter((message) => message.type === type) as Extract<
      WorkspaceServerMessage,
      { type: T }
    >[]
  }
}

const START = 1_750_000_000_000
const TRIM: TrimPolicy = { idleMs: 60 * 60 * 1000, registrationTtlMs: 30 * 24 * 60 * 60 * 1000 }

class FakeHost {
  readonly storage: FakeStorage
  readonly sockets: FakeSocket[]
  readonly server: WorkspaceServer
  now: number

  constructor(options: { storage?: FakeStorage; sockets?: FakeSocket[]; now?: number } = {}) {
    this.storage = options.storage ?? new FakeStorage()
    this.sockets = options.sockets ?? []
    this.now = options.now ?? START
    this.server = new WorkspaceServer({
      storage: this.storage,
      sql: this.storage.sql,
      getSockets: () => this.sockets,
      now: () => this.now,
      trim: TRIM,
    })
  }

  async connect(deviceId: string): Promise<FakeSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket)
    // hello pins the device identity in the attachment before any tracking.
    await this.send(socket, { type: 'hello', deviceId })
    return socket
  }

  async send(socket: FakeSocket, message: WorkspaceClientMessage): Promise<void> {
    await this.server.handleMessage(socket, JSON.stringify(message))
  }

  evict(): FakeHost {
    return new FakeHost({ storage: this.storage, sockets: this.sockets, now: this.now })
  }
}

async function openFile(
  host: FakeHost,
  socket: FakeSocket,
  fileId: string,
  initialContent: string,
): Promise<LoroFileDoc> {
  await host.send(socket, {
    type: 'snapshot.get',
    requestId: crypto.randomUUID(),
    fileId,
    initialContent,
    observedPath: `${fileId}.md`,
  })
  const response = socket.received('snapshot.response').at(-1)!
  const peerId = socket.received('ready').at(-1)!.sessionPeerId
  return LoroFileDoc.fromSnapshot(base64ToBytes(response.snapshotB64), {
    peerId: BigInt(peerId),
  })
}

async function submitEdit(
  host: FakeHost,
  socket: FakeSocket,
  editor: LoroFileDoc,
  fileId: string,
  text: string,
  opId: string,
): Promise<void> {
  const base = editor.contentVersion()
  editor.setTextContent(text)
  await host.send(socket, {
    type: 'content.submit',
    fileId,
    observedPath: `${fileId}.md`,
    opId,
    baseContentVersionB64: bytesToBase64(base),
    loroUpdateB64: bytesToBase64(editor.exportUpdateSince(base)),
  })
}

async function serverDoc(host: FakeHost, socket: FakeSocket, fileId: string): Promise<LoroFileDoc> {
  await host.send(socket, { type: 'snapshot.get', requestId: crypto.randomUUID(), fileId })
  const response = socket.received('snapshot.response').at(-1)!
  return LoroFileDoc.fromSnapshot(base64ToBytes(response.snapshotB64))
}

describe('server-coordinated shallow trim (spec §3.4)', () => {
  it('trims an idle file once every registrant dominates, and edits continue', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    const editor = await openFile(host, socket, 'file-1', 'v1\n')
    await submitEdit(host, socket, editor, 'file-1', 'v1\nv2\n', 'op-1')
    await submitEdit(host, socket, editor, 'file-1', 'v1\nv2\nv3\n', 'op-2')

    // Still active: nothing trims.
    expect((await host.server.runMaintenance()).trimmedFiles).toEqual([])

    host.now += TRIM.idleMs + 1
    const result = await host.server.runMaintenance()
    expect(result.trimmedFiles).toEqual(['file-1'])

    // The stored doc is shallow now: the floor advanced to the trim point.
    const doc = await serverDoc(host, socket, 'file-1')
    expect(doc.unwrap().isShallow()).toBe(true)
    expect(doc.getTextContent()).toBe('v1\nv2\nv3\n')

    // A second pass with nothing new is a no-op.
    host.now += TRIM.idleMs + 1
    expect((await host.server.runMaintenance()).trimmedFiles).toEqual([])

    // The registrant keeps editing at its (dominating) base — accepted.
    await submitEdit(host, socket, editor, 'file-1', 'v1\nv2\nv3\nv4\n', 'op-3')
    const ack = socket.received('ack').at(-1)!
    expect(ack.opId).toBe('op-3')
    expect(socket.received('submit.deferred')).toEqual([])
  })

  it('never trims past a live registrant that has not provably caught up', async () => {
    const host = new FakeHost()
    const socketA = await host.connect('device-a')
    const socketB = await host.connect('device-b')
    const editorA = await openFile(host, socketA, 'file-1', 'v1\n')
    // B's knowledge is registered at the version it was served.
    await serverDoc(host, socketB, 'file-1')
    // A advances; B only ever "hears" via broadcasts, which are untracked.
    await submitEdit(host, socketA, editorA, 'file-1', 'v1\nv2\n', 'op-1')

    host.now += TRIM.idleMs + 1
    // Eviction must not launder the gate: bookkeeping is durable.
    const next = host.evict()
    expect((await next.server.runMaintenance()).trimmedFiles).toEqual([])
    const doc = await serverDoc(next, socketA, 'file-1')
    expect(doc.unwrap().isShallow()).toBe(false)
  })

  it('trims after the straggler registration expires; the straggler repairs via history-pruned', async () => {
    const host = new FakeHost()
    const socketA = await host.connect('device-a')
    const socketB = await host.connect('device-b')
    const editorA = await openFile(host, socketA, 'file-1', 'v1\n')
    const editorB = await serverDoc(host, socketB, 'file-1')
    await submitEdit(host, socketA, editorA, 'file-1', 'v1\nv2\n', 'op-1')

    // B goes dark past the registration TTL; A's last touch also ages out,
    // so refresh A's registration with a current-version snapshot fetch.
    host.now += TRIM.registrationTtlMs + 1
    await serverDoc(host, socketA, 'file-1')
    const result = await host.server.runMaintenance()
    expect(result.trimmedFiles).toEqual(['file-1'])
    expect(result.prunedTrimRegistrations).toBeGreaterThan(0)

    // The straggler returns with a base below the floor → history-pruned
    // defer with a fresh snapshot (M0.3), the spec'd repair path.
    const staleBase = editorB.contentVersion()
    editorB.setTextContent('v1\nstraggler\n')
    await host.send(socketB, {
      type: 'content.submit',
      fileId: 'file-1',
      observedPath: 'file-1.md',
      opId: 'op-stale',
      baseContentVersionB64: bytesToBase64(staleBase),
      loroUpdateB64: bytesToBase64(editorB.exportUpdateSince(staleBase)),
    })
    const deferred = socketB.received('submit.deferred').at(-1)!
    expect(deferred.reason).toBe('history-pruned')

    // Repair: reset from the served snapshot, re-apply the text, resubmit.
    const repaired = LoroFileDoc.fromSnapshot(base64ToBytes(deferred.snapshotB64), {
      peerId: 99n,
    })
    await submitEdit(host, socketB, repaired, 'file-1', 'v1\nv2\nstraggler\n', 'op-repaired')
    expect(socketB.received('ack').at(-1)!.opId).toBe('op-repaired')
    const converged = await serverDoc(host, socketA, 'file-1')
    expect(converged.getTextContent()).toBe('v1\nv2\nstraggler\n')
  })

  it('clears bookkeeping when a maintained file no longer has Loro state', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    const editor = await openFile(host, socket, 'file-gone', 'v1\n')
    await submitEdit(host, socket, editor, 'file-gone', 'v1\nv2\n', 'op-1')
    host.storage.sql.exec('DELETE FROM loro_snapshots')
    host.storage.sql.exec('DELETE FROM loro_updates')

    host.now += TRIM.idleMs + 1
    expect((await host.server.runMaintenance()).trimmedFiles).toEqual([])
    const activity = host.storage.sql.exec('SELECT * FROM file_activity').toArray()
    expect(activity).toEqual([])
  })
})
