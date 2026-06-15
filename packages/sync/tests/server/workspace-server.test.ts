import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Database as DofsDatabase, readRangeSync, stat as dofsStat } from '@glovebox/dofs'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { sha256Hex } from '../../src/server/hash.ts'
import { base64ToBytes, bytesToBase64 } from '../../src/loro/base64.ts'
import { SqliteLoroFileStore } from '../../src/server/sqlite-loro-store.ts'
import { assembleOpaqueWirePayload, buildOpaqueWirePayload } from '../../src/opaque-wire.ts'
import {
  WorkspaceServer,
  type WorkspaceConnectionClaims,
  type WorkspaceClientMessage,
  type WorkspaceServerMessage,
  type WorkspaceServerLimits,
  type WorkspaceServerStorage,
  type WorkspaceSocket,
  type WorkspaceSqlStorage,
  type WorkspaceSqlValue,
} from '../../src/server/workspace-server.ts'

function claims(principalId: string, epoch = 0): WorkspaceConnectionClaims {
  return {
    principalId,
    principalType: 'human',
    role: 'editor',
    owner: false,
    epoch,
  }
}

function roleClaims(
  principalId: string,
  role: WorkspaceConnectionClaims['role'],
  owner = false,
): WorkspaceConnectionClaims {
  return {
    principalId,
    principalType: 'human',
    role,
    owner,
    epoch: 0,
  }
}

class FakeStorage implements WorkspaceServerStorage {
  readonly #values = new Map<string, unknown>()
  readonly sql = new FakeSqlStorage()

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
  readonly #faults: Array<{
    match: (query: string, bindings: readonly unknown[]) => boolean
    error: Error
  }> = []
  #transactionDepth = 0
  #savepointId = 0

  failNext(
    match: (query: string, bindings: readonly unknown[]) => boolean,
    error = new Error('injected SQL failure'),
  ): void {
    this.#faults.push({ match, error })
  }

  transactionSync<T>(closure: () => T): T {
    if (this.#transactionDepth === 0) {
      this.#db.exec('BEGIN')
      this.#transactionDepth += 1
      try {
        const value = closure()
        this.#transactionDepth -= 1
        this.#db.exec('COMMIT')
        return value
      } catch (error) {
        this.#transactionDepth -= 1
        this.#db.exec('ROLLBACK')
        throw error
      }
    }

    const savepoint = `sp_${++this.#savepointId}`
    this.#db.exec(`SAVEPOINT ${savepoint}`)
    this.#transactionDepth += 1
    try {
      const value = closure()
      this.#transactionDepth -= 1
      this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      return value
    } catch (error) {
      this.#transactionDepth -= 1
      this.#db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      this.#db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      throw error
    }
  }

  exec(
    query: string,
    ...bindings: WorkspaceSqlValue[]
  ): { toArray(): Record<string, WorkspaceSqlValue>[] } {
    const normalized = bindings.map((binding) =>
      binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
    )
    const compactQuery = query.replace(/\s+/g, ' ').trim()
    const faultIndex = this.#faults.findIndex((fault) => fault.match(compactQuery, normalized))
    if (faultIndex >= 0) {
      const [fault] = this.#faults.splice(faultIndex, 1)
      throw fault!.error
    }
    const rows = this.#db
      .prepare(query)
      .all(...(normalized as (string | number | null)[])) as Record<string, WorkspaceSqlValue>[]
    return { toArray: () => rows }
  }
}

class FakeSocket implements WorkspaceSocket {
  readonly sent: WorkspaceServerMessage[] = []
  closed: { code?: number; reason?: string } | null = null
  #attachment: unknown

  send(data: string): void {
    if (this.closed) throw new Error('Socket is closed')
    this.sent.push(JSON.parse(data) as WorkspaceServerMessage)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }

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

/**
 * One lifetime of the DO process. `evict()` models hibernation/eviction the
 * way Cloudflare does: in-memory server state is lost, durable storage and
 * accepted sockets (with their attachments) survive into the next instance.
 */
interface FakeHostOptions {
  storage?: FakeStorage
  sockets?: FakeSocket[]
  now?: number
  limits?: Partial<WorkspaceServerLimits>
  requireAuth?: boolean
}

class FakeHost {
  readonly storage: FakeStorage
  readonly sockets: FakeSocket[]
  readonly server: WorkspaceServer
  readonly limits?: Partial<WorkspaceServerLimits>
  readonly requireAuth?: boolean
  now: number

  constructor(options: FakeHostOptions = {}) {
    this.storage = options.storage ?? new FakeStorage()
    this.sockets = options.sockets ?? []
    this.now = options.now ?? 1_750_000_000_000
    this.limits = options.limits
    this.requireAuth = options.requireAuth
    this.server = new WorkspaceServer({
      storage: this.storage,
      sql: this.storage.sql,
      getSockets: () => this.sockets,
      now: () => this.now,
      limits: this.limits,
      requireAuth: this.requireAuth,
      transactionSync: (closure) => this.storage.sql.transactionSync(closure),
    })
  }

  async connect(principalId?: string): Promise<FakeSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket, principalId)
    return socket
  }

  async connectWithClaims(claims: WorkspaceConnectionClaims): Promise<FakeSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket, claims)
    return socket
  }

  async send(socket: FakeSocket, message: WorkspaceClientMessage): Promise<void> {
    await this.server.handleMessage(socket, JSON.stringify(message))
  }

  evict(): FakeHost {
    return new FakeHost({
      storage: this.storage,
      sockets: this.sockets,
      now: this.now,
      limits: this.limits,
      requireAuth: this.requireAuth,
    })
  }
}

async function helloPeerId(host: FakeHost, socket: FakeSocket, deviceId?: string): Promise<string> {
  await host.send(socket, { type: 'hello', deviceId })
  const ready = socket.received('ready').at(-1)
  expect(ready).toBeDefined()
  return ready!.sessionPeerId
}

async function fetchSnapshot(
  host: FakeHost,
  socket: FakeSocket,
  fileId: string,
  initialContent?: string,
  observedPath?: string,
): Promise<{ snapshotB64: string; contentVersionB64: string }> {
  await host.send(socket, {
    type: 'snapshot.get',
    requestId: crypto.randomUUID(),
    fileId,
    initialContent,
    observedPath,
  })
  const response = socket.received('snapshot.response').at(-1)
  expect(response).toBeDefined()
  return response!
}

async function submitEdit(
  host: FakeHost,
  socket: FakeSocket,
  editor: LoroFileDoc,
  fileId: string,
  text: string,
  opId: string,
): Promise<WorkspaceClientMessage> {
  const base = editor.contentVersion()
  editor.setTextContent(text)
  const message: WorkspaceClientMessage = {
    type: 'content.submit',
    fileId,
    observedPath: 'notes.md',
    opId,
    baseContentVersionB64: bytesToBase64(base),
    loroUpdateB64: bytesToBase64(editor.exportUpdateSince(base)),
  }
  await host.send(socket, message)
  return message
}

function opaqueSubmitMessage(input: {
  fileId: string
  observedPath: string
  opId: string
  baseHashHex: string
  bytes: Uint8Array
}): WorkspaceClientMessage {
  return {
    type: 'opaque.submit',
    fileId: input.fileId,
    observedPath: input.observedPath,
    opId: input.opId,
    baseHashHex: input.baseHashHex,
    ...buildOpaqueWirePayload(input.bytes),
  }
}

function opaqueResponseBytes(
  response: Extract<WorkspaceServerMessage, { type: 'opaque.response' }>,
): Uint8Array | undefined {
  if (
    response.hashHex === undefined ||
    response.sizeBytes === undefined ||
    response.manifest === undefined ||
    response.objects === undefined
  ) {
    return undefined
  }
  return assembleOpaqueWirePayload({
    hashHex: response.hashHex,
    sizeBytes: response.sizeBytes,
    manifest: response.manifest,
    objects: response.objects,
  })
}

function patternedOpaqueBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bytes[i] = (i * 31 + Math.floor(i / 257)) % 251
  }
  return bytes
}

function tableRowCount(host: FakeHost, table: string): number {
  const exists = host.storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table)
    .toArray()
  if (exists.length === 0) return 0
  const row = host.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]
  return Number(row?.count ?? 0)
}

function readDofsFile(host: FakeHost, path: string): Uint8Array {
  const db = new DofsDatabase({
    sql: host.storage.sql,
    transactionSync: (closure) => host.storage.sql.transactionSync(closure),
  } as ConstructorParameters<typeof DofsDatabase>[0])
  const size = dofsStat(db, path).size
  return readRangeSync(db, path, 0, size)
}

describe('WorkspaceServer test transaction harness', () => {
  it('supports nested transactionSync rollback via savepoints', () => {
    const sql = new FakeSqlStorage()

    sql.transactionSync(() => {
      sql.exec('CREATE TABLE tx_probe (id TEXT PRIMARY KEY)')
      sql.exec('INSERT INTO tx_probe (id) VALUES (?)', 'outer-before')
      expect(() =>
        sql.transactionSync(() => {
          sql.exec('INSERT INTO tx_probe (id) VALUES (?)', 'inner')
          throw new Error('rollback inner')
        }),
      ).toThrow(/rollback inner/)
      sql.exec('INSERT INTO tx_probe (id) VALUES (?)', 'outer-after')
    })

    const rows = sql.exec('SELECT id FROM tx_probe ORDER BY id ASC').toArray()
    expect(rows.map((row) => row.id)).toEqual(['outer-after', 'outer-before'])
  })
})

describe('WorkspaceServer hibernation safety', () => {
  it('mints strictly increasing peer IDs and never reissues one after eviction', async () => {
    const hostA = new FakeHost()
    const ids: string[] = []
    ids.push(await helloPeerId(hostA, await hostA.connect()))
    ids.push(await helloPeerId(hostA, await hostA.connect()))

    const hostB = hostA.evict()
    ids.push(await helloPeerId(hostB, await hostB.connect()))

    const hostC = hostB.evict()
    ids.push(await helloPeerId(hostC, await hostC.connect()))

    expect(ids).toEqual(['1', '2', '3', '4'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps seq strictly monotonic across eviction', async () => {
    const fileId = 'file-1'
    const hostA = new FakeHost()
    const editorSocket = await hostA.connect()
    const observerSocket = await hostA.connect()
    const peerId = await helloPeerId(hostA, editorSocket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(hostA, editorSocket, fileId, 'hello\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    await submitEdit(hostA, editorSocket, editor, fileId, 'hello world\n', 'op-1')

    const hostB = hostA.evict()
    await submitEdit(hostB, editorSocket, editor, fileId, 'hello world!\n', 'op-2')

    // seq 1 went to the file's 'create' event at snapshot.get; the two
    // content events continue the same (single) counter across eviction.
    const seqs = observerSocket.received('content.loroUpdate').map((event) => event.seq)
    expect(seqs).toEqual([2, 3])

    const acks = editorSocket.received('ack')
    expect(acks.map((ack) => ack.applied)).toEqual([true, true])
  })

  it('restores connection identity from the socket attachment, not memory', async () => {
    const fileId = 'file-2'
    const hostA = new FakeHost()
    const editorSocket = await hostA.connect()
    const observerSocket = await hostA.connect()
    const peerId = await helloPeerId(hostA, editorSocket, 'device-A')

    const { snapshotB64 } = await fetchSnapshot(hostA, editorSocket, fileId, 'draft\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    const hostB = hostA.evict()
    await submitEdit(hostB, editorSocket, editor, fileId, 'draft v2\n', 'op-1')

    const updates = observerSocket.received('content.loroUpdate')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.originDeviceId).toBe('device-A')

    const serverDoc = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64))
    serverDoc.importUpdate(base64ToBytes(updates[0]!.loroUpdateB64))
    expect(serverDoc.getTextContent()).toBe('draft v2\n')
  })

  it('replays the original ack for a duplicate opId and applies nothing', async () => {
    const fileId = 'file-idem'
    const host = new FakeHost()
    const editorSocket = await host.connect()
    const observerSocket = await host.connect()
    const peerId = await helloPeerId(host, editorSocket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(host, editorSocket, fileId, 'base\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    const submit = await submitEdit(host, editorSocket, editor, fileId, 'base edited\n', 'op-dup')
    await host.send(editorSocket, submit)

    const acks = editorSocket.received('ack')
    expect(acks).toHaveLength(2)
    expect(acks[1]).toEqual(acks[0])
    expect(acks[1]!.applied).toBe(true)
    expect(observerSocket.received('content.loroUpdate')).toHaveLength(1)
  })

  it('keeps idempotency across eviction and never advances seq on a duplicate', async () => {
    const fileId = 'file-idem-evict'
    const hostA = new FakeHost()
    const editorSocket = await hostA.connect()
    const observerSocket = await hostA.connect()
    const peerId = await helloPeerId(hostA, editorSocket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(hostA, editorSocket, fileId, 'one\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    const submit = await submitEdit(hostA, editorSocket, editor, fileId, 'two\n', 'op-1')

    const hostB = hostA.evict()
    await hostB.send(editorSocket, submit)
    await submitEdit(hostB, editorSocket, editor, fileId, 'three\n', 'op-2')

    const acks = editorSocket.received('ack')
    expect(acks).toHaveLength(3)
    expect(acks[1]).toEqual(acks[0])

    // 'create' took seq 1; the duplicate consumed nothing between 2 and 3.
    const seqs = observerSocket.received('content.loroUpdate').map((event) => event.seq)
    expect(seqs).toEqual([2, 3])
  })

  it('expires idempotency records after the 7-day TTL', async () => {
    const fileId = 'file-idem-ttl'
    const host = new FakeHost()
    const editorSocket = await host.connect()
    const peerId = await helloPeerId(host, editorSocket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(host, editorSocket, fileId, 'ttl\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    const submit = await submitEdit(host, editorSocket, editor, fileId, 'ttl edited\n', 'op-ttl')

    host.now += 7 * 24 * 60 * 60 * 1000 + 1
    await host.send(editorSocket, submit)

    const acks = editorSocket.received('ack')
    expect(acks).toHaveLength(2)
    expect(acks[0]!.applied).toBe(true)
    // Record expired, so the submit went through the real import path again;
    // the Loro doc already knows these ops, hence applied: false.
    expect(acks[1]!.applied).toBe(false)
  })

  it('defers a submit whose base predates the shallow floor with history-pruned + snapshot', async () => {
    const fileId = 'file-pruned'
    const host = new FakeHost()
    const staleSocket = await host.connect()
    const freshSocket = await host.connect()
    const observerSocket = await host.connect()
    const stalePeer = await helloPeerId(host, staleSocket, 'device-stale')
    const freshPeer = await helloPeerId(host, freshSocket, 'device-fresh')

    const { snapshotB64 } = await fetchSnapshot(host, staleSocket, fileId, 'v1\n')
    const staleEditor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(stalePeer),
    })

    const { snapshotB64: freshSnapshotB64 } = await fetchSnapshot(host, freshSocket, fileId)
    const freshEditor = LoroFileDoc.fromSnapshot(base64ToBytes(freshSnapshotB64), {
      peerId: BigInt(freshPeer),
    })
    await submitEdit(host, freshSocket, freshEditor, fileId, 'v2\n', 'op-fresh-1')
    await submitEdit(host, freshSocket, freshEditor, fileId, 'v3\n', 'op-fresh-2')

    // Server-coordinated trim to the current frontier. Storage is shaped
    // directly, so replace the server instance over the same storage —
    // exactly the hibernation shape: sockets survive with attachments, the
    // next instance reads the trimmed state cold.
    const store = new SqliteLoroFileStore(host.storage.sql)
    const trimmed = LoroFileDoc.fromState((await store.loadState(fileId))!)
    await store.replaceSnapshot(fileId, trimmed.exportShallowSnapshot())
    host.server.dispose()
    const reborn = new FakeHost({ storage: host.storage, sockets: host.sockets })

    const updatesBefore = observerSocket.received('content.loroUpdate').length
    await submitEdit(reborn, staleSocket, staleEditor, fileId, 'v1 stale edit\n', 'op-stale')

    expect(staleSocket.received('ack')).toHaveLength(0)
    const deferred = staleSocket.received('submit.deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.reason).toBe('history-pruned')
    expect(deferred[0]!.opId).toBe('op-stale')
    expect(observerSocket.received('content.loroUpdate')).toHaveLength(updatesBefore)

    // Repair: reset local doc from the returned snapshot, replay the edit,
    // resubmit under a new opId (ISSUE-0039 client contract).
    const repaired = LoroFileDoc.fromSnapshot(base64ToBytes(deferred[0]!.snapshotB64), {
      peerId: BigInt(stalePeer),
    })
    expect(repaired.getTextContent()).toBe('v3\n')
    await submitEdit(reborn, staleSocket, repaired, fileId, 'v3 replayed\n', 'op-stale-replay')

    const acks = staleSocket.received('ack')
    expect(acks).toHaveLength(1)
    expect(acks[0]!.applied).toBe(true)
    const freshDoc = LoroFileDoc.fromSnapshot(base64ToBytes(deferred[0]!.snapshotB64))
    const echoed = observerSocket.received('content.loroUpdate').at(-1)!
    freshDoc.importUpdate(base64ToBytes(echoed.loroUpdateB64))
    expect(freshDoc.getTextContent()).toBe('v3 replayed\n')
  })

  it('defers via the import guard when the claimed base lies about stale update bytes', async () => {
    const fileId = 'file-pruned-liar'
    const host = new FakeHost()
    const staleSocket = await host.connect()
    const freshSocket = await host.connect()
    const stalePeer = await helloPeerId(host, staleSocket, 'device-stale')
    const freshPeer = await helloPeerId(host, freshSocket, 'device-fresh')

    const { snapshotB64 } = await fetchSnapshot(host, staleSocket, fileId, 'v1\n')
    const staleEditor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(stalePeer),
    })

    const { snapshotB64: freshSnapshotB64 } = await fetchSnapshot(host, freshSocket, fileId)
    const freshEditor = LoroFileDoc.fromSnapshot(base64ToBytes(freshSnapshotB64), {
      peerId: BigInt(freshPeer),
    })
    await submitEdit(host, freshSocket, freshEditor, fileId, 'v2\n', 'op-fresh')

    const store = new SqliteLoroFileStore(host.storage.sql)
    const trimmed = LoroFileDoc.fromState((await store.loadState(fileId))!)
    await store.replaceSnapshot(fileId, trimmed.exportShallowSnapshot())
    // Same hibernation shape as above: trimmed storage is read cold by a
    // replacement server instance.
    host.server.dispose()
    const reborn = new FakeHost({ storage: host.storage, sockets: host.sockets })

    // Update bytes are built on the stale base, but the message claims the
    // server's current version — the floor pre-check passes, the import
    // itself must catch it.
    const base = staleEditor.contentVersion()
    staleEditor.setTextContent('stale lie\n')
    await reborn.send(staleSocket, {
      type: 'content.submit',
      fileId,
      observedPath: 'notes.md',
      opId: 'op-liar',
      baseContentVersionB64: bytesToBase64(trimmed.contentVersion()),
      loroUpdateB64: bytesToBase64(staleEditor.exportUpdateSince(base)),
    })

    expect(staleSocket.received('ack')).toHaveLength(0)
    const deferred = staleSocket.received('submit.deferred')
    expect(deferred).toHaveLength(1)
    expect(deferred[0]!.reason).toBe('history-pruned')
  })

  it('rejects messages with unknown keys and applies nothing (INV-12)', async () => {
    const host = new FakeHost()
    const socket = await host.connect()
    const observerSocket = await host.connect()

    await host.server.handleMessage(
      socket,
      JSON.stringify({
        type: 'content.submit',
        fileId: 'f',
        observedPath: 'a.md',
        opId: 'op-x',
        baseContentVersionB64: '',
        loroUpdateB64: '',
        sneaky: 'extra',
      }),
    )

    const errors = socket.received('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/Unexpected key: sneaky/)
    expect(socket.received('ack')).toHaveLength(0)
    expect(observerSocket.received('content.loroUpdate')).toHaveLength(0)
  })

  it('rejects raw messages over the pre-decode length cap without parsing', async () => {
    const host = new FakeHost({
      limits: { maxUpdateBytes: 1024, maxOpaqueBytes: 1024 },
    })
    const socket = await host.connect()

    // Over the absolute envelope cap and deliberately not valid JSON — the
    // length gate must fire before any decode.
    const oversized = '{'.repeat(2 * 1024 * 1024)
    await host.server.handleMessage(socket, oversized)

    const errors = socket.received('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/size limit/)
  })

  it('rejects field-level garbage: wrong types and oversized fields', async () => {
    const host = new FakeHost()
    const socket = await host.connect()

    await host.server.handleMessage(
      socket,
      JSON.stringify({ type: 'snapshot.get', requestId: 7, fileId: 'f' }),
    )
    expect(socket.received('error').at(-1)!.message).toMatch(/Expected string field: requestId/)

    await host.server.handleMessage(
      socket,
      JSON.stringify({ type: 'snapshot.get', requestId: 'r', fileId: 'x'.repeat(300) }),
    )
    expect(socket.received('error').at(-1)!.message).toMatch(/exceeds size limit: fileId/)

    await host.server.handleMessage(socket, JSON.stringify({ type: 'unknown.kind' }))
    expect(socket.received('error').at(-1)!.message).toMatch(/Unknown message type/)
  })

  it('rejects an update whose decoded bytes exceed maxUpdateBytes', async () => {
    const host = new FakeHost({
      limits: { maxUpdateBytes: 64 },
    })
    const editorSocket = await host.connect()
    const observerSocket = await host.connect()
    await helloPeerId(host, editorSocket, 'device-editor')

    // 100 decoded bytes: over the 64-byte semantic cap, under the 2x
    // pre-decode field cap — must come back as an opId-correlated rejection,
    // and must never reach the Loro import.
    await host.send(editorSocket, {
      type: 'content.submit',
      fileId: 'file-big',
      observedPath: 'notes.md',
      opId: 'op-big',
      baseContentVersionB64: '',
      loroUpdateB64: bytesToBase64(new Uint8Array(100)),
    })

    const rejected = editorSocket.received('submit.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBe('too-large')
    expect(rejected[0]!.opId).toBe('op-big')
    expect(editorSocket.received('ack')).toHaveLength(0)
    expect(editorSocket.received('error')).toHaveLength(0)
    expect(observerSocket.received('content.loroUpdate')).toHaveLength(0)
  })

  it('rejects an update that would grow the file past maxTextBytes, persisting nothing', async () => {
    const host = new FakeHost({
      limits: { maxTextBytes: 32 },
    })
    const editorSocket = await host.connect()
    const peerId = await helloPeerId(host, editorSocket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(host, editorSocket, 'file-cap', 'short\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    await submitEdit(host, editorSocket, editor, 'file-cap', `${'z'.repeat(64)}\n`, 'op-grow')

    const rejected = editorSocket.received('submit.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBe('too-large')

    // Server state is unchanged — a fresh snapshot still materializes the
    // original text.
    const { snapshotB64: after } = await fetchSnapshot(host, editorSocket, 'file-cap')
    expect(LoroFileDoc.fromSnapshot(base64ToBytes(after)).getTextContent()).toBe('short\n')

    // And a small follow-up edit from a repaired doc still applies.
    const repaired = LoroFileDoc.fromSnapshot(base64ToBytes(after), { peerId: BigInt(peerId) })
    await submitEdit(host, editorSocket, repaired, 'file-cap', 'short ok\n', 'op-ok')
    expect(editorSocket.received('ack').at(-1)!.applied).toBe(true)
  })

  it('rate-limits submits per identity, recording denied attempts so the window never drains', async () => {
    const host = new FakeHost({
      limits: { submitRateLimit: 3, submitRateWindowMs: 60_000 },
    })
    const editorSocket = await host.connect()
    const observerSocket = await host.connect()
    const peerId = await helloPeerId(host, editorSocket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(host, editorSocket, 'file-rate', 'r0\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    // helloPeerId + fetchSnapshot don't count; 3 submits fill the window.
    await submitEdit(host, editorSocket, editor, 'file-rate', 'r1\n', 'op-1')
    await submitEdit(host, editorSocket, editor, 'file-rate', 'r2\n', 'op-2')
    await submitEdit(host, editorSocket, editor, 'file-rate', 'r3\n', 'op-3')
    expect(editorSocket.received('ack')).toHaveLength(3)

    const fourth = await submitEdit(host, editorSocket, editor, 'file-rate', 'r4\n', 'op-4')
    let rejected = editorSocket.received('submit.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBe('rate-limited')
    expect(rejected[0]!.retryAfterSec).toBeGreaterThanOrEqual(1)

    // Hammering while denied keeps the window full: the three denied
    // attempts at t+30s still block the retry at t+61s, after the original
    // window has fully expired.
    host.now += 30_000
    await host.send(editorSocket, fourth)
    await host.send(editorSocket, fourth)
    await host.send(editorSocket, fourth)
    host.now += 31_000
    await host.send(editorSocket, fourth)
    rejected = editorSocket.received('submit.rejected')
    expect(rejected).toHaveLength(5)
    expect(rejected.every((r) => r.reason === 'rate-limited')).toBe(true)

    // Going quiet for a full window drains it; the retry then applies.
    host.now += 61_000
    await host.send(editorSocket, fourth)
    expect(editorSocket.received('ack')).toHaveLength(4)
    const doc = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64))
    for (const event of observerSocket.received('content.loroUpdate')) {
      doc.importUpdate(base64ToBytes(event.loroUpdateB64))
    }
    expect(doc.getTextContent()).toBe('r4\n')
  })

  it('rate-limits identities independently', async () => {
    const host = new FakeHost({
      limits: { submitRateLimit: 1, submitRateWindowMs: 60_000 },
    })
    const aSocket = await host.connect('user-a')
    const bSocket = await host.connect('user-b')
    const aPeer = await helloPeerId(host, aSocket, 'device-a')
    const bPeer = await helloPeerId(host, bSocket, 'device-b')

    const { snapshotB64 } = await fetchSnapshot(host, aSocket, 'file-multi', 'm\n')
    const aDoc = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), { peerId: BigInt(aPeer) })
    const bDoc = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), { peerId: BigInt(bPeer) })

    await submitEdit(host, aSocket, aDoc, 'file-multi', 'm a\n', 'op-a1')
    await submitEdit(host, aSocket, aDoc, 'file-multi', 'm a2\n', 'op-a2')
    expect(aSocket.received('submit.rejected')).toHaveLength(1)

    // Device B is unaffected by A's exhausted window.
    await submitEdit(host, bSocket, bDoc, 'file-multi', 'm b\n', 'op-b1')
    expect(bSocket.received('submit.rejected')).toHaveLength(0)
    expect(bSocket.received('ack')).toHaveLength(1)
  })

  it('gates connections on the durable auth epoch', async () => {
    const hostA = new FakeHost({ requireAuth: true })

    expect(await hostA.server.gateConnection(null)).toMatchObject({ ok: false, status: 401 })
    expect(await hostA.server.gateConnection(claims('u1'))).toMatchObject({
      ok: true,
      principalId: 'u1',
    })

    await hostA.server.bumpAuthEpoch()
    expect(await hostA.server.gateConnection(claims('u1'))).toMatchObject({
      ok: false,
      status: 401,
      reason: 'stale-epoch',
    })
    expect(await hostA.server.gateConnection(claims('u1', 1))).toMatchObject({
      ok: true,
    })

    // The epoch is durable: eviction does not resurrect stale tokens.
    const hostB = hostA.evict()
    expect(await hostB.server.gateConnection(claims('u1'))).toMatchObject({
      ok: false,
      reason: 'stale-epoch',
    })
  })

  it('stores expanded connection claims in hibernation-safe socket attachments', async () => {
    const host = new FakeHost()
    const socket = new FakeSocket()
    const connectionClaims: WorkspaceConnectionClaims = {
      principalId: 'agent-claims',
      principalType: 'agent',
      role: 'commenter',
      owner: true,
      epoch: 3,
    }

    await host.server.handleConnect(socket, connectionClaims)

    expect(socket.deserializeAttachment()).toMatchObject({
      principalId: 'agent-claims',
      principalType: 'agent',
      role: 'commenter',
      owner: true,
    })
  })

  it('allows viewers and commenters to read existing snapshots but rejects write surfaces', async () => {
    const host = new FakeHost()
    const editorSocket = await host.connectWithClaims(roleClaims('editor-user', 'editor'))
    await helloPeerId(host, editorSocket, 'device-editor')
    const seed = await fetchSnapshot(host, editorSocket, 'role-file', 'seed\n', 'role-file.md')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(seed.snapshotB64), {
      peerId: BigInt(editorSocket.received('ready').at(-1)!.sessionPeerId),
    })

    for (const role of ['viewer', 'commenter'] as const) {
      const socket = await host.connectWithClaims(roleClaims(`${role}-user`, role))
      await helloPeerId(host, socket, `device-${role}`)

      await fetchSnapshot(host, socket, 'role-file')
      expect(socket.received('snapshot.response').at(-1)).toMatchObject({ fileId: 'role-file' })

      await host.send(socket, {
        type: 'snapshot.get',
        requestId: `create-${role}`,
        fileId: `new-${role}`,
        initialContent: 'nope\n',
        observedPath: `new-${role}.md`,
      })
      expect(socket.received('error').at(-1)).toMatchObject({
        requestId: `create-${role}`,
        message: 'forbidden',
      })

      const submit = await submitEdit(
        host,
        socket,
        editor,
        'role-file',
        `seed ${role}\n`,
        `op-${role}`,
      )
      expect(submit.type).toBe('content.submit')
      expect(socket.received('submit.rejected').at(-1)).toMatchObject({
        opId: `op-${role}`,
        reason: 'forbidden',
      })

      await host.send(
        socket,
        opaqueSubmitMessage({
          fileId: 'opaque-role',
          observedPath: 'asset.bin',
          opId: `opaque-${role}`,
          baseHashHex: '',
          bytes: new TextEncoder().encode('asset'),
        }),
      )
      expect(socket.received('submit.rejected').at(-1)).toMatchObject({
        opId: `opaque-${role}`,
        reason: 'forbidden',
      })

      await host.send(socket, {
        type: 'batch.submit',
        requestId: `batch-${role}`,
        ops: [
          {
            type: 'file.rename',
            opId: `rename-${role}`,
            fileId: 'role-file',
            baseSeq: 0,
            fromPath: 'role-file.md',
            toPath: `role-file-${role}.md`,
          },
        ],
      })
      expect(socket.received('batch.rejected').at(-1)).toMatchObject({
        requestId: `batch-${role}`,
        reason: 'forbidden',
      })
    }
  })

  it('allows owners to mutate even when their document role is viewer', async () => {
    const host = new FakeHost()
    const ownerSocket = await host.connectWithClaims(roleClaims('owner-user', 'viewer', true))
    const peerId = await helloPeerId(host, ownerSocket, 'device-owner')
    const { snapshotB64 } = await fetchSnapshot(host, ownerSocket, 'owner-file', 'owner\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    await submitEdit(host, ownerSocket, editor, 'owner-file', 'owner edit\n', 'owner-op')

    expect(ownerSocket.received('ack').at(-1)).toMatchObject({
      opId: 'owner-op',
      applied: true,
    })
  })

  it('recheck closes exactly the revoked principals with 4403', async () => {
    const host = new FakeHost()
    const aliceSocket = await host.connect('alice')
    const bobSocket = await host.connect('bob')
    const aliceSocket2 = await host.connect('alice')
    await helloPeerId(host, bobSocket, 'device-bob')

    const closed = host.server.recheckPrincipals(['alice'])
    expect(closed).toBe(2)
    expect(aliceSocket.closed).toEqual({ code: 4403, reason: 'access-revoked' })
    expect(aliceSocket2.closed).toEqual({ code: 4403, reason: 'access-revoked' })
    expect(bobSocket.closed).toBeNull()

    // Bob's connection keeps working after the sweep.
    const peerId = await helloPeerId(host, bobSocket, 'device-bob')
    const { snapshotB64 } = await fetchSnapshot(host, bobSocket, 'file-rc', 'rc\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })
    await submitEdit(host, bobSocket, editor, 'file-rc', 'rc ok\n', 'op-rc')
    expect(bobSocket.received('ack').at(-1)!.applied).toBe(true)
  })

  it('workspace deletion broadcasts, closes all with 4410, and refuses new connections', async () => {
    const hostA = new FakeHost()
    const s1 = await hostA.connect('alice')
    const s2 = await hostA.connect('bob')

    await hostA.server.markWorkspaceDeleted()

    expect(s1.received('workspace.deleted')).toHaveLength(1)
    expect(s2.received('workspace.deleted')).toHaveLength(1)
    expect(s1.closed).toEqual({ code: 4410, reason: 'workspace-deleted' })
    expect(s2.closed).toEqual({ code: 4410, reason: 'workspace-deleted' })

    expect(await hostA.server.gateConnection(claims('alice'))).toMatchObject({
      ok: false,
      status: 410,
    })

    // The deletion flag is durable.
    const hostB = hostA.evict()
    expect(await hostB.server.gateConnection(null)).toMatchObject({ ok: false, status: 410 })
  })

  it('M0 gate: submit → evict → reconnect → duplicate resubmit → concurrent edit converges with no duplicate application', async () => {
    const fileId = 'gate-file'
    const hostA = new FakeHost()
    const aliceSocket = await hostA.connect('alice')
    const alicePeer = await helloPeerId(hostA, aliceSocket, 'device-alice')
    const { snapshotB64 } = await fetchSnapshot(hostA, aliceSocket, fileId, 'base\n')
    const alice = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(alicePeer),
    })

    // 1. Submit on the first DO lifetime.
    const submit1 = await submitEdit(hostA, aliceSocket, alice, fileId, 'base +alice\n', 'op-g1')
    expect(aliceSocket.received('ack')).toHaveLength(1)
    expect(aliceSocket.received('ack')[0]!.applied).toBe(true)

    // 2. Evict. 3. Reconnect: a second client joins the new lifetime and
    // hydrates the durable post-edit state; its peer ID is freshly minted.
    const hostB = hostA.evict()
    const bobSocket = await hostB.connect('bob')
    const bobPeer = await helloPeerId(hostB, bobSocket, 'device-bob')
    expect(bobPeer).not.toBe(alicePeer)
    const { snapshotB64: bobSnapshotB64 } = await fetchSnapshot(hostB, bobSocket, fileId)
    const bob = LoroFileDoc.fromSnapshot(base64ToBytes(bobSnapshotB64), {
      peerId: BigInt(bobPeer),
    })
    expect(bob.getTextContent()).toBe('base +alice\n')

    // 4. Duplicate resubmit (lost-ack retry) against the new lifetime:
    // original ack replayed verbatim, nothing applied, no seq consumed.
    await hostB.send(aliceSocket, submit1)
    const ackReplay = aliceSocket.received('ack')
    expect(ackReplay).toHaveLength(2)
    expect(ackReplay[1]).toEqual(ackReplay[0])

    // 5. Concurrent edits: both export against the same base before either
    // sees the other's update.
    const aliceBase = alice.contentVersion()
    alice.setTextContent('base +alice +A\n')
    const bobBase = bob.contentVersion()
    bob.setTextContent('B+ base +alice\n')
    await hostB.send(aliceSocket, {
      type: 'content.submit',
      fileId,
      observedPath: 'notes.md',
      opId: 'op-g2',
      baseContentVersionB64: bytesToBase64(aliceBase),
      loroUpdateB64: bytesToBase64(alice.exportUpdateSince(aliceBase)),
    })
    await hostB.send(bobSocket, {
      type: 'content.submit',
      fileId,
      observedPath: 'notes.md',
      opId: 'op-g3',
      baseContentVersionB64: bytesToBase64(bobBase),
      loroUpdateB64: bytesToBase64(bob.exportUpdateSince(bobBase)),
    })

    // Both clients apply every broadcast (importing your own echo is a no-op).
    for (const socket of [aliceSocket, bobSocket]) {
      for (const event of socket.received('content.loroUpdate')) {
        alice.importUpdate(base64ToBytes(event.loroUpdateB64))
        bob.importUpdate(base64ToBytes(event.loroUpdateB64))
      }
    }

    // Convergence (INV-1): both editors and the server materialize the same
    // text, with each contribution applied exactly once.
    const { snapshotB64: finalB64 } = await fetchSnapshot(hostB, bobSocket, fileId)
    const serverText = LoroFileDoc.fromSnapshot(base64ToBytes(finalB64)).getTextContent()
    expect(alice.getTextContent()).toBe(serverText)
    expect(bob.getTextContent()).toBe(serverText)
    expect(serverText.match(/\+alice/g)).toHaveLength(1)
    expect(serverText.match(/\+A/g)).toHaveLength(1)
    expect(serverText.match(/B\+/g)).toHaveLength(1)

    // Seq consumed exactly once per applied update — the duplicate got none.
    const seqs = [
      ...aliceSocket.received('content.loroUpdate'),
      ...bobSocket.received('content.loroUpdate'),
    ]
      .map((event) => event.seq)
      .sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(new Set(seqs).size).toBeGreaterThanOrEqual(3)
    // 3 applied updates after the 'create' event at seq 1.
    expect(seqs.at(-1)).toBe(4)

    // A late duplicate after all of this still replays the original ack.
    await hostB.send(aliceSocket, submit1)
    expect(aliceSocket.received('ack').at(-1)).toEqual(ackReplay[0])
  })

  it('replays persisted events via events.since across eviction', async () => {
    const fileId = 'file-replay'
    const hostA = new FakeHost()
    const editorSocket = await hostA.connect('alice')
    const peerId = await helloPeerId(hostA, editorSocket, 'device-editor')
    const { snapshotB64 } = await fetchSnapshot(hostA, editorSocket, fileId, 'r0\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    await submitEdit(hostA, editorSocket, editor, fileId, 'r1\n', 'op-r1')
    await submitEdit(hostA, editorSocket, editor, fileId, 'r2\n', 'op-r2')

    // A client that was offline catches up on the next lifetime purely from
    // the durable log.
    const hostB = hostA.evict()
    const lateSocket = await hostB.connect('bob')
    await hostB.send(lateSocket, { type: 'events.since', requestId: 'rq-1', afterSeq: 0 })

    const batches = lateSocket.received('events.batch')
    expect(batches).toHaveLength(1)
    expect(batches[0]!.currentSeq).toBe(3)
    const events = batches[0]!.events
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3])

    // The file's registration replays first (cross-replica discovery), then
    // the content history.
    expect(events[0]!.type).toBe('create')
    expect(events[0]).toMatchObject({ path: `${fileId}.md` })

    const replayDoc = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64))
    for (const event of events.slice(1)) {
      expect(event.type).toBe('content.loroUpdate')
      if (event.type === 'content.loroUpdate') {
        replayDoc.importUpdate(base64ToBytes(event.loroUpdateB64))
      }
    }
    expect(replayDoc.getTextContent()).toBe('r2\n')

    // Cursor at head → empty batch, same currentSeq.
    await hostB.send(lateSocket, { type: 'events.since', requestId: 'rq-2', afterSeq: 3 })
    expect(lateSocket.received('events.batch').at(-1)).toMatchObject({
      requestId: 'rq-2',
      currentSeq: 3,
      events: [],
    })

    // Strict ingress applies to the new message type too.
    await hostB.send(lateSocket, {
      type: 'events.since',
      requestId: 'rq-3',
      afterSeq: 0,
      extra: true,
    } as unknown as WorkspaceClientMessage)
    expect(lateSocket.received('error').at(-1)!.message).toMatch(/Unexpected key: extra/)
    await hostB.send(lateSocket, {
      type: 'events.since',
      requestId: 'rq-4',
      afterSeq: -1,
    })
    expect(lateSocket.received('error').at(-1)!.message).toMatch(/afterSeq/)
  })

  it('routes contentKind strictly: markdown through Loro, opaque through dofs', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    // Loro submit on a non-markdown path is refused.
    await host.send(socket, {
      type: 'content.submit',
      fileId: 'f-png',
      observedPath: 'assets/img.png',
      opId: 'op-md-guard',
      baseContentVersionB64: '',
      loroUpdateB64: '',
    })
    expect(socket.received('submit.rejected').at(-1)).toMatchObject({
      opId: 'op-md-guard',
      reason: 'invalid-path',
    })

    // Opaque submit on a markdown path is refused — markdown can never
    // reach the dofs LWW write path.
    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-md',
        observedPath: 'docs/note.md',
        opId: 'op-opaque-guard',
        baseHashHex: '',
        bytes: new TextEncoder().encode('hi'),
      }),
    )
    expect(socket.received('submit.rejected').at(-1)).toMatchObject({
      opId: 'op-opaque-guard',
      reason: 'invalid-path',
    })
  })

  it('preserves refused opaque bytes by DOFS reference when the row is markdown', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    await fetchSnapshot(host, socket, 'f-md-row', '# markdown\n', 'docs/note.md')

    const refused = new TextEncoder().encode('refused binary bytes')
    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-md-row',
        observedPath: 'assets/note.bin',
        opId: 'op-kind-refused',
        baseHashHex: '',
        bytes: refused,
      }),
    )

    expect(socket.received('submit.rejected').at(-1)).toMatchObject({
      opId: 'op-kind-refused',
      reason: 'invalid-path',
    })
    const records = host.server.listRecoveryRecords({ pendingOnly: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      fileId: 'f-md-row',
      opId: 'op-kind-refused',
      reason: 'kind-mismatch-rejected',
      observedPath: 'assets/note.bin',
    })
    const payload = JSON.parse(records[0]!.payload) as {
      hashHex: string
      sizeBytes: number
      dofsPath: string
    }
    expect(payload.hashHex).toBe(sha256Hex(refused))
    expect(payload.sizeBytes).toBe(refused.byteLength)
    expect(readDofsFile(host, payload.dofsPath)).toEqual(refused)

    const tree = await host.server.listTree()
    const row = tree.entries.find((entry) => entry.fileId === 'f-md-row')!
    expect(row.contentKind).toBeUndefined()
    expect(row.path).toBe('docs/note.md')
  })

  it('stores opaque files through dofs with LWW + recovery record for the loser (INV-2)', async () => {
    const host = new FakeHost()
    const writerA = await host.connect('alice')
    const writerB = await host.connect('bob')
    const observer = await host.connect('carol')
    await helloPeerId(host, writerA, 'device-a')
    await helloPeerId(host, writerB, 'device-b')

    const v1 = new TextEncoder().encode('binary v1')
    await host.send(
      writerA,
      opaqueSubmitMessage({
        fileId: 'f-bin',
        observedPath: 'assets/data.bin',
        opId: 'op-bin-1',
        baseHashHex: '',
        bytes: v1,
      }),
    )
    const ack1 = writerA.received('opaque.ack').at(-1)!
    expect(ack1.conflict).toBe(false)

    // Duplicate replays the original ack.
    await host.send(
      writerA,
      opaqueSubmitMessage({
        fileId: 'f-bin',
        observedPath: 'assets/data.bin',
        opId: 'op-bin-1',
        baseHashHex: '',
        bytes: v1,
      }),
    )
    expect(writerA.received('opaque.ack')).toHaveLength(2)
    expect(writerA.received('opaque.ack').at(-1)).toEqual(ack1)
    expect(observer.received('content.opaqueUpdate')).toHaveLength(1)

    // Writer B saw v1 and writes v2 — clean LWW, no conflict.
    const v2 = new TextEncoder().encode('binary v2')
    await host.send(
      writerB,
      opaqueSubmitMessage({
        fileId: 'f-bin',
        observedPath: 'assets/data.bin',
        opId: 'op-bin-2',
        baseHashHex: ack1.hashHex,
        bytes: v2,
      }),
    )
    const ack2 = writerB.received('opaque.ack').at(-1)!
    expect(ack2.conflict).toBe(false)

    // Writer A writes again from the stale v1 watermark: it wins (last
    // writer), but v2 must survive as a recovery record, not vanish.
    const v3 = new TextEncoder().encode('binary v3 from stale base')
    await host.send(
      writerA,
      opaqueSubmitMessage({
        fileId: 'f-bin',
        observedPath: 'assets/data.bin',
        opId: 'op-bin-3',
        baseHashHex: ack1.hashHex,
        bytes: v3,
      }),
    )
    const ack3 = writerA.received('opaque.ack').at(-1)!
    expect(ack3.conflict).toBe(true)

    const records = host.server.listRecoveryRecords({ pendingOnly: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      fileId: 'f-bin',
      opId: 'op-bin-3',
      reason: 'opaque-conflict-loser',
      observedPath: 'assets/data.bin',
    })
    const payload = JSON.parse(records[0]!.payload) as {
      hashHex: string
      sizeBytes: number
      dofsPath: string
    }
    expect(payload.sizeBytes).toBe(v2.byteLength)
    expect(payload.hashHex).toBe(ack2.hashHex)
    expect(readDofsFile(host, payload.dofsPath)).toEqual(v2)

    // The first write registered a tree row (its 'create' event took seq 1)
    // so the binary is visible to the tree authority and pulling replicas;
    // every accepted write got a seq'd broadcast and the duplicate got none.
    const creates = observer.received('create')
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ fileId: 'f-bin', seq: 1 })
    expect((creates[0] as { entry: { contentKind?: string } }).entry.contentKind).toBe('opaque')
    const seqs = observer.received('content.opaqueUpdate').map((event) => event.seq)
    expect(seqs).toEqual([2, 3, 4])
    const tree = await host.server.listTree()
    expect(tree.entries.map((entry) => entry.path)).toContain('assets/data.bin')
    const row = tree.entries.find((entry) => entry.path === 'assets/data.bin')!
    expect(row.contentKind).toBe('opaque')
    expect(row.contentHash).toBe(ack3.hashHex)
    expect(host.server.acknowledgeRecoveryRecord(records[0]!.recordId)).toBe(true)
    expect(() => readDofsFile(host, payload.dofsPath)).toThrow()
  })

  it('records conflict-loser recovery atomically with the loser blob and winning write', async () => {
    const host = new FakeHost()
    const writerA = await host.connect('alice')
    const writerB = await host.connect('bob')
    await helloPeerId(host, writerA, 'device-a')
    await helloPeerId(host, writerB, 'device-b')

    const v1 = new TextEncoder().encode('base binary')
    await host.send(
      writerA,
      opaqueSubmitMessage({
        fileId: 'f-atomic',
        observedPath: 'atomic.bin',
        opId: 'op-atomic-1',
        baseHashHex: '',
        bytes: v1,
      }),
    )
    const ack1 = writerA.received('opaque.ack').at(-1)!

    const v2 = new TextEncoder().encode('server loser candidate')
    await host.send(
      writerB,
      opaqueSubmitMessage({
        fileId: 'f-atomic',
        observedPath: 'atomic.bin',
        opId: 'op-atomic-2',
        baseHashHex: ack1.hashHex,
        bytes: v2,
      }),
    )
    const ack2 = writerB.received('opaque.ack').at(-1)!

    host.storage.sql.failNext((query) => query.startsWith('INSERT INTO workspace_recovery_records'))
    const v3 = new TextEncoder().encode('would-be winning bytes')
    await host.send(
      writerA,
      opaqueSubmitMessage({
        fileId: 'f-atomic',
        observedPath: 'atomic.bin',
        opId: 'op-atomic-3',
        baseHashHex: ack1.hashHex,
        bytes: v3,
      }),
    )

    expect(writerA.received('submit.rejected').at(-1)).toMatchObject({
      opId: 'op-atomic-3',
    })
    expect(writerA.received('opaque.ack').filter((ack) => ack.opId === 'op-atomic-3')).toEqual([])
    expect(host.server.listRecoveryRecords({ pendingOnly: true })).toEqual([])
    expect(() =>
      readDofsFile(host, `/.glovebox/recovery/${sha256Hex('f-atomic:op-atomic-3')}`),
    ).toThrow()

    await host.send(writerA, { type: 'opaque.get', requestId: 'rq-atomic', fileId: 'f-atomic' })
    const current = writerA.received('opaque.response').at(-1)!
    expect(current.hashHex).toBe(ack2.hashHex)
    expect(opaqueResponseBytes(current)).toEqual(v2)
  })

  it('stores opaque bytes only in DOFS chunks and filters known objects on get', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')
    const bytes = new Uint8Array(700_000)
    bytes.fill(7)

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-a',
        observedPath: 'a.bin',
        opId: 'op-a',
        baseHashHex: '',
        bytes,
      }),
    )
    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-b',
        observedPath: 'b.bin',
        opId: 'op-b',
        baseHashHex: '',
        bytes,
      }),
    )

    const rows = host.storage.sql
      .exec(
        "SELECT file_id, content, content_hash, size_bytes FROM workspace_files WHERE file_id IN ('f-a', 'f-b') ORDER BY file_id",
      )
      .toArray()
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.content === null)).toBe(true)
    expect(rows.map((row) => row.content_hash)).toEqual([sha256Hex(bytes), sha256Hex(bytes)])
    expect(rows.map((row) => row.size_bytes)).toEqual([bytes.byteLength, bytes.byteLength])

    // Two identical files share the same two fixed-size chunks.
    const blobCount = host.storage.sql.exec('SELECT COUNT(*) AS count FROM vfs_blobs').toArray()[0]!
    expect(Number(blobCount.count)).toBe(2)

    const payloads = host.storage.sql
      .exec("SELECT payload FROM workspace_changes WHERE type = 'content.opaqueUpdate'")
      .toArray()
      .map((row) => JSON.parse(row.payload as string) as Record<string, unknown>)
    expect(payloads).toHaveLength(2)
    expect(payloads.every((payload) => payload.bytesB64 === undefined)).toBe(true)
    expect(payloads.every((payload) => typeof payload.hashHex === 'string')).toBe(true)

    await host.send(socket, { type: 'opaque.get', requestId: 'rq-full', fileId: 'f-a' })
    const full = socket.received('opaque.response').at(-1)!
    expect(full.objects).toHaveLength(2)
    expect(opaqueResponseBytes(full)).toEqual(bytes)

    await host.send(socket, {
      type: 'opaque.get',
      requestId: 'rq-meta',
      fileId: 'f-a',
      metadataOnly: true,
    })
    const metadataOnly = socket.received('opaque.response').at(-1)!
    expect(metadataOnly).toMatchObject({
      requestId: 'rq-meta',
      found: true,
      contentKind: 'opaque',
      hashHex: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
    })
    expect(metadataOnly.manifest?.chunks).toHaveLength(2)
    expect(metadataOnly.objects).toBeUndefined()

    await host.send(socket, {
      type: 'opaque.get',
      requestId: 'rq-missing',
      fileId: 'f-a',
      haveObjects: [full.manifest!.chunks[0]!.hashB64],
    })
    const missing = socket.received('opaque.response').at(-1)!
    expect(missing.objects).toHaveLength(1)
    expect(missing.objects![0]!.hashB64).toBe(full.manifest!.chunks[1]!.hashB64)
  })

  it('round-trips a 4 MiB opaque submit through DOFS chunks and opaque.get', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')
    const bytes = patternedOpaqueBytes(4 * 1024 * 1024)

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-large',
        observedPath: 'large.bin',
        opId: 'op-large',
        baseHashHex: '',
        bytes,
      }),
    )
    const ack = socket.received('opaque.ack').at(-1)!
    expect(ack).toMatchObject({
      fileId: 'f-large',
      hashHex: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      conflict: false,
    })

    await host.send(socket, { type: 'opaque.get', requestId: 'rq-large', fileId: 'f-large' })
    const response = socket.received('opaque.response').at(-1)!
    expect(response).toMatchObject({
      requestId: 'rq-large',
      found: true,
      contentKind: 'opaque',
      hashHex: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
    })
    expect(response.manifest?.chunks).toHaveLength(8)
    expect(response.objects).toHaveLength(8)
    expect(opaqueResponseBytes(response)).toEqual(bytes)
  })

  it('broadcasts to sockets restored from hibernation without a reconnect', async () => {
    const fileId = 'file-3'
    const hostA = new FakeHost()
    const observerSocket = await hostA.connect()
    await helloPeerId(hostA, observerSocket, 'device-observer')

    const hostB = hostA.evict()
    const editorSocket = await hostB.connect()
    const peerId = await helloPeerId(hostB, editorSocket, 'device-editor')
    const { snapshotB64 } = await fetchSnapshot(hostB, editorSocket, fileId, 'shared\n')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })

    await submitEdit(hostB, editorSocket, editor, fileId, 'shared edit\n', 'op-1')

    const updates = observerSocket.received('content.loroUpdate')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.originDeviceId).toBe('device-editor')
  })
})

describe('WorkspaceServer batch.submit (tree ops)', () => {
  it('applies a deleteIntent at head: tombstone event, cleared Loro state, fresh re-create', async () => {
    const host = new FakeHost()
    const editorSocket = await host.connect('alice')
    const observerSocket = await host.connect('bob')
    await helloPeerId(host, editorSocket, 'device-editor')
    await fetchSnapshot(host, editorSocket, 'file-del', 'doomed\n', 'notes/doomed.md')

    // The observer is fully caught up (cursor at the create event).
    await host.send(observerSocket, { type: 'events.since', requestId: 'rq-0', afterSeq: 0 })
    const head = observerSocket.received('events.batch').at(-1)!.currentSeq

    await host.send(editorSocket, {
      type: 'batch.submit',
      requestId: 'rq-del',
      ops: [
        {
          type: 'file.deleteIntent',
          opId: 'op-del-1',
          fileId: 'file-del',
          baseSeq: head,
          path: 'notes/doomed.md',
        },
      ],
    })

    const ack = editorSocket.received('batch.ack').at(-1)!
    expect(ack.acceptedOps.map((op) => op.opId)).toEqual(['op-del-1'])
    expect(ack.deferredOps).toEqual([])

    // Tombstone event broadcast and replayable from the durable log.
    const broadcastDeletes = observerSocket.received('delete')
    expect(broadcastDeletes).toHaveLength(1)
    expect(broadcastDeletes[0]).toMatchObject({
      fileId: 'file-del',
      path: 'notes/doomed.md',
      tombstone: true,
    })
    await host.send(observerSocket, { type: 'events.since', requestId: 'rq-1', afterSeq: head })
    const replay = observerSocket.received('events.batch').at(-1)!
    expect(replay.events.map((event) => event.type)).toEqual(['delete'])

    // The live Loro state is gone with the file: a snapshot.get re-creates
    // fresh (resurrection under the same fileId is a deliberate new create).
    const { snapshotB64 } = await fetchSnapshot(host, editorSocket, 'file-del')
    expect(LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64)).getTextContent()).not.toContain(
      'doomed',
    )
  })

  it('defers a deleteIntent whose baseSeq predates a content edit (remote-edit-wins, INV-3)', async () => {
    const host = new FakeHost()
    const editorSocket = await host.connect('alice')
    const peerId = await helloPeerId(host, editorSocket, 'device-editor')
    const { snapshotB64 } = await fetchSnapshot(
      host,
      editorSocket,
      'file-keep',
      'precious\n',
      'keep.md',
    )
    const staleBase = editorSocket.received('events.batch').length // placeholder, real cursor below
    void staleBase
    await host.send(editorSocket, { type: 'events.since', requestId: 'rq-0', afterSeq: 0 })
    const cursorBeforeEdit = editorSocket.received('events.batch').at(-1)!.currentSeq

    // A content edit lands AFTER the deleter's observed cursor.
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })
    await submitEdit(host, editorSocket, editor, 'file-keep', 'precious\nedited\n', 'op-edit')

    await host.send(editorSocket, {
      type: 'batch.submit',
      requestId: 'rq-del',
      ops: [
        {
          type: 'file.deleteIntent',
          opId: 'op-del-stale',
          fileId: 'file-keep',
          baseSeq: cursorBeforeEdit,
          path: 'keep.md',
        },
      ],
    })

    const ack = editorSocket.received('batch.ack').at(-1)!
    expect(ack.acceptedOps).toEqual([])
    expect(ack.deferredOps).toEqual([{ opId: 'op-del-stale', reason: 'remote-edit-wins' }])
    expect(editorSocket.received('delete')).toEqual([])

    // The file and its content survive.
    const { snapshotB64: after } = await fetchSnapshot(host, editorSocket, 'file-keep')
    expect(LoroFileDoc.fromSnapshot(base64ToBytes(after)).getTextContent()).toBe(
      'precious\nedited\n',
    )

    // The refused intent is durable (ISSUE-0041): one recovery record,
    // carrying the original op; a replayed batch never double-writes.
    const records = host.server.listRecoveryRecords({ pendingOnly: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      fileId: 'file-keep',
      opId: 'op-del-stale',
      reason: 'remote-edit-wins',
      deviceId: 'device-editor',
      observedPath: 'keep.md',
      acknowledgedAt: null,
    })
    expect(JSON.parse(records[0]!.payload)).toMatchObject({
      op: { type: 'file.deleteIntent', fileId: 'file-keep', path: 'keep.md' },
    })

    await host.send(editorSocket, {
      type: 'batch.submit',
      requestId: 'rq-del-replay',
      ops: [
        {
          type: 'file.deleteIntent',
          opId: 'op-del-stale',
          fileId: 'file-keep',
          baseSeq: cursorBeforeEdit,
          path: 'keep.md',
        },
      ],
    })
    expect(host.server.listRecoveryRecords()).toHaveLength(1)

    // Acknowledge drops it from the pending view (trash dismiss).
    expect(host.server.acknowledgeRecoveryRecord(records[0]!.recordId)).toBe(true)
    expect(host.server.listRecoveryRecords({ pendingOnly: true })).toHaveLength(0)
  })

  it('applies renames with target-occupied deferral and replays both in seq order', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-editor')
    await fetchSnapshot(host, socket, 'file-a', 'a\n', 'a.md')
    await fetchSnapshot(host, socket, 'file-b', 'b\n', 'b.md')
    await host.send(socket, { type: 'events.since', requestId: 'rq-0', afterSeq: 0 })
    const head = socket.received('events.batch').at(-1)!.currentSeq

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-mv',
      ops: [
        {
          type: 'file.rename',
          opId: 'op-mv-1',
          fileId: 'file-a',
          baseSeq: head,
          fromPath: 'a.md',
          toPath: 'renamed.md',
        },
        // Target occupied by file-a's new path → deferred, nothing applied.
        {
          type: 'file.rename',
          opId: 'op-mv-2',
          fileId: 'file-b',
          baseSeq: head,
          fromPath: 'b.md',
          toPath: 'renamed.md',
        },
      ],
    })

    const ack = socket.received('batch.ack').at(-1)!
    expect(ack.acceptedOps.map((op) => op.opId)).toEqual(['op-mv-1'])
    expect(ack.acceptedOps[0]!.binding).toMatchObject({ fileId: 'file-a', path: 'renamed.md' })
    expect(ack.deferredOps).toEqual([{ opId: 'op-mv-2', reason: 'rename-target-occupied' }])

    const renames = socket.received('rename')
    expect(renames).toHaveLength(1)
    expect(renames[0]).toMatchObject({ oldPath: 'a.md', newPath: 'renamed.md', fileId: 'file-a' })

    // The wire log replays the rename contiguously after the creates.
    await host.send(socket, { type: 'events.since', requestId: 'rq-1', afterSeq: 0 })
    const replay = socket.received('events.batch').at(-1)!
    const seqs = replay.events.map((event) => event.seq)
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1))
    expect(replay.events.at(-1)).toMatchObject({ type: 'rename', newPath: 'renamed.md' })
  })

  it('rolls back a mid-batch event-log failure without burned seqs or cached opIds', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-editor')
    await fetchSnapshot(host, socket, 'file-a', 'a\n', 'a.md')
    await fetchSnapshot(host, socket, 'file-b', 'b\n', 'b.md')
    await host.send(socket, { type: 'events.since', requestId: 'rq-0', afterSeq: 0 })
    const head = socket.received('events.batch').at(-1)!.currentSeq

    let eventLogInserts = 0
    host.storage.sql.failNext((query) => {
      if (!query.startsWith('INSERT INTO workspace_changes ')) return false
      eventLogInserts += 1
      return eventLogInserts === 2
    })

    const batchOps: Extract<WorkspaceClientMessage, { type: 'batch.submit' }>['ops'] = [
      {
        type: 'file.rename',
        opId: 'op-rename-a',
        fileId: 'file-a',
        baseSeq: head,
        fromPath: 'a.md',
        toPath: 'a-renamed.md',
      },
      {
        type: 'file.rename',
        opId: 'op-rename-b',
        fileId: 'file-b',
        baseSeq: head,
        fromPath: 'b.md',
        toPath: 'b-renamed.md',
      },
    ]

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-fault',
      ops: batchOps,
    })

    expect(socket.received('error').at(-1)).toMatchObject({
      requestId: 'rq-fault',
      message: 'injected SQL failure',
    })
    expect(socket.received('batch.ack')).toHaveLength(0)
    expect(socket.received('rename')).toHaveLength(0)
    expect(tableRowCount(host, 'workspace_idempotency')).toBe(0)
    expect(tableRowCount(host, 'workspace_recovery_records')).toBe(0)

    let tree = await host.server.listTree()
    expect(tree.currentSeq).toBe(head)
    expect(tree.entries.map((entry) => entry.path).sort()).toEqual(['a.md', 'b.md'])

    await host.send(socket, { type: 'events.since', requestId: 'rq-after-fault', afterSeq: head })
    expect(socket.received('events.batch').at(-1)).toMatchObject({
      requestId: 'rq-after-fault',
      currentSeq: head,
      events: [],
    })

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-retry',
      ops: batchOps,
    })

    const ack = socket.received('batch.ack').at(-1)!
    expect(ack.requestId).toBe('rq-retry')
    expect(ack.acceptedOps.map((op) => op.opId)).toEqual(['op-rename-a', 'op-rename-b'])
    expect(ack.deferredOps).toEqual([])
    expect(socket.received('rename')).toHaveLength(2)

    tree = await host.server.listTree()
    expect(tree.currentSeq).toBe(head + 2)
    expect(tree.entries.map((entry) => entry.path).sort()).toEqual(['a-renamed.md', 'b-renamed.md'])
    expect(tableRowCount(host, 'workspace_idempotency')).toBe(2)

    await host.send(socket, { type: 'events.since', requestId: 'rq-after-retry', afterSeq: head })
    const replay = socket.received('events.batch').at(-1)!
    expect(replay.requestId).toBe('rq-after-retry')
    expect(replay.currentSeq).toBe(head + 2)
    expect(replay.events.map((event) => [event.seq, event.type])).toEqual([
      [head + 1, 'rename'],
      [head + 2, 'rename'],
    ])
  })

  it('replays a duplicate batch idempotently — same acceptance, no second event', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-editor')
    await fetchSnapshot(host, socket, 'file-dup', 'x\n', 'x.md')
    await host.send(socket, { type: 'events.since', requestId: 'rq-0', afterSeq: 0 })
    const head = socket.received('events.batch').at(-1)!.currentSeq

    const batch: WorkspaceClientMessage = {
      type: 'batch.submit',
      requestId: 'rq-dup',
      ops: [
        {
          type: 'file.deleteIntent',
          opId: 'op-dup-del',
          fileId: 'file-dup',
          baseSeq: head,
          path: 'x.md',
        },
      ],
    }
    await host.send(socket, batch)
    await host.send(socket, batch)

    const acks = socket.received('batch.ack')
    expect(acks).toHaveLength(2)
    expect(acks[1]!.acceptedOps).toEqual(acks[0]!.acceptedOps)
    expect(acks[1]!.currentSeq).toBe(acks[0]!.currentSeq)
    expect(socket.received('delete')).toHaveLength(1)
  })

  it('rejects malformed batches before any decode (INV-12)', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-editor')

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-bad',
      ops: [{ type: 'file.everythingIntent', opId: 'x' }],
    } as unknown as WorkspaceClientMessage)
    expect(socket.received('error').at(-1)!.message).toMatch(/Unknown batch op type/)

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-bad-2',
      ops: [
        {
          type: 'file.deleteIntent',
          opId: 'op',
          fileId: 'f',
          baseSeq: 0,
          path: 'p.md',
          extra: 1,
        },
      ],
    } as unknown as WorkspaceClientMessage)
    expect(socket.received('error').at(-1)!.message).toMatch(/Unexpected key: extra/)

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-bad-3',
      ops: [],
    } as unknown as WorkspaceClientMessage)
    expect(socket.received('error').at(-1)!.message).toMatch(/out of bounds/)
  })

  it('keeps one gapless seq domain across content, create, and tree events', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    const peerId = await helloPeerId(host, socket, 'device-editor')

    const { snapshotB64 } = await fetchSnapshot(host, socket, 'file-seq', 'one\n', 'one.md')
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })
    await submitEdit(host, socket, editor, 'file-seq', 'one two\n', 'op-1')
    await fetchSnapshot(host, socket, 'file-seq-2', 'other\n', 'two.md')
    await host.send(socket, { type: 'events.since', requestId: 'rq-head', afterSeq: 0 })
    const head = socket.received('events.batch').at(-1)!.currentSeq
    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-mv',
      ops: [
        {
          type: 'file.rename',
          opId: 'op-mv',
          fileId: 'file-seq-2',
          baseSeq: head,
          fromPath: 'two.md',
          toPath: 'three.md',
        },
      ],
    })
    await submitEdit(host, socket, editor, 'file-seq', 'one two three\n', 'op-2')

    await host.send(socket, { type: 'events.since', requestId: 'rq-all', afterSeq: 0 })
    const replay = socket.received('events.batch').at(-1)!
    expect(replay.events.map((event) => [event.seq, event.type])).toEqual([
      [1, 'create'],
      [2, 'content.loroUpdate'],
      [3, 'create'],
      [4, 'rename'],
      [5, 'content.loroUpdate'],
    ])
    expect(replay.currentSeq).toBe(5)
  })

  it('suffixes a concurrent create whose path is already taken (createOrSuffix)', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-editor')
    await fetchSnapshot(host, socket, 'file-one', 'first\n', 'shared.md')
    await fetchSnapshot(host, socket, 'file-two', 'second\n', 'shared.md')

    await host.send(socket, { type: 'events.since', requestId: 'rq', afterSeq: 0 })
    const creates = socket
      .received('events.batch')
      .at(-1)!
      .events.filter((event) => event.type === 'create')
    expect(creates.map((event) => (event.type === 'create' ? event.path : ''))).toEqual([
      'shared.md',
      'shared-2.md',
    ])
  })
})

describe('WorkspaceServer kind-boundary routing and adoption surfaces (ISSUE-0043/0044/0045)', () => {
  it('tree.list returns live entries + currentSeq', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    await fetchSnapshot(host, socket, 'f-md', '# hello\n', 'docs/note.md')
    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-bin',
        observedPath: 'assets/img.png',
        opId: 'op-bin-create',
        baseHashHex: '',
        bytes: new TextEncoder().encode('pixels'),
      }),
    )
    expect(socket.received('opaque.ack').at(-1)).toMatchObject({
      opId: 'op-bin-create',
      conflict: false,
    })

    await host.send(socket, { type: 'tree.list', requestId: 'rq-tree' })
    const tree = socket.received('tree.state').at(-1)!
    expect(tree.requestId).toBe('rq-tree')

    // The watermark reflects every event so far (md create, opaque create,
    // opaque update) and agrees with the event log's head.
    await host.send(socket, { type: 'events.since', requestId: 'rq-head', afterSeq: 0 })
    expect(tree.currentSeq).toBe(socket.received('events.batch').at(-1)!.currentSeq)
    expect(tree.currentSeq).toBe(3)

    expect(tree.entries).toHaveLength(2)
    const mdRow = tree.entries.find((entry) => entry.path === 'docs/note.md')!
    expect(mdRow).toMatchObject({ fileId: 'f-md', tombstone: false, seq: 1 })
    // Markdown is the implicit kind — entries only carry contentKind when opaque.
    expect(mdRow.contentKind).toBeUndefined()
    const binRow = tree.entries.find((entry) => entry.path === 'assets/img.png')!
    expect(binRow).toMatchObject({ fileId: 'f-bin', tombstone: false })
    expect(binRow.contentKind).toBe('opaque')
  })

  it('opaque.get round-trips current bytes', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-raw',
        observedPath: 'assets/raw.bin',
        opId: 'op-raw-1',
        baseHashHex: '',
        bytes: new TextEncoder().encode('pixels'),
      }),
    )
    const ack = socket.received('opaque.ack').at(-1)!
    expect(ack.conflict).toBe(false)

    await host.send(socket, { type: 'opaque.get', requestId: 'rq-raw', fileId: 'f-raw' })
    const response = socket.received('opaque.response').at(-1)!
    expect(response).toMatchObject({
      requestId: 'rq-raw',
      fileId: 'f-raw',
      found: true,
      path: 'assets/raw.bin',
      hashHex: ack.hashHex,
    })
    expect(new TextDecoder().decode(opaqueResponseBytes(response)!)).toBe('pixels')

    // Unknown fileId is simply not found — opaque.get has no create surface.
    await host.send(socket, { type: 'opaque.get', requestId: 'rq-ghost', fileId: 'f-ghost' })
    const missing = socket.received('opaque.response').at(-1)!
    expect(missing).toMatchObject({ requestId: 'rq-ghost', fileId: 'f-ghost', found: false })
    expect(missing.objects).toBeUndefined()

    // A markdown row answers found WITH its kind but never serves bytes —
    // a behind-the-window replica must distinguish "the row crossed the
    // kind boundary" from "deleted" (treating it as deleted would remove
    // the local file).
    await fetchSnapshot(host, socket, 'f-doc', 'text\n', 'doc.md')
    await host.send(socket, { type: 'opaque.get', requestId: 'rq-md', fileId: 'f-doc' })
    const mdResponse = socket.received('opaque.response').at(-1)!
    expect(mdResponse).toMatchObject({
      requestId: 'rq-md',
      fileId: 'f-doc',
      found: true,
      contentKind: 'markdown',
      path: 'doc.md',
    })
    expect(mdResponse.objects).toBeUndefined()
  })

  it('submit gates validate against the ROW kind after a boundary rename', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')
    await fetchSnapshot(host, socket, 'f-row', 'seed\n', 'note.md')

    await host.send(socket, { type: 'tree.list', requestId: 'rq-head' })
    const head = socket.received('tree.state').at(-1)!.currentSeq

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-mv',
      ops: [
        {
          type: 'file.rename',
          opId: 'op-mv',
          fileId: 'f-row',
          baseSeq: head,
          fromPath: 'note.md',
          toPath: 'note.png',
        },
      ],
    })
    expect(
      socket
        .received('batch.ack')
        .at(-1)!
        .acceptedOps.map((op) => op.opId),
    ).toEqual(['op-mv'])

    // The row is opaque now: a Loro submit still claiming the old markdown
    // path bounces off the ROW kind, not the path extension.
    await host.send(socket, {
      type: 'content.submit',
      fileId: 'f-row',
      observedPath: 'note.md',
      opId: 'op-md-stale',
      baseContentVersionB64: '',
      loroUpdateB64: '',
    })
    expect(socket.received('submit.rejected').at(-1)).toMatchObject({
      opId: 'op-md-stale',
      reason: 'invalid-path',
    })

    // The opaque path is open: a write based on the renamed row's
    // contentHash is a clean LWW advance, not a conflict.
    await host.send(socket, { type: 'tree.list', requestId: 'rq-row' })
    const row = socket
      .received('tree.state')
      .at(-1)!
      .entries.find((entry) => entry.path === 'note.png')!
    expect(row.contentKind).toBe('opaque')

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-row',
        observedPath: 'note.png',
        opId: 'op-opaque-clean',
        baseHashHex: row.contentHash,
        bytes: new TextEncoder().encode('seed v2'),
      }),
    )
    expect(socket.received('opaque.ack').at(-1)).toMatchObject({
      opId: 'op-opaque-clean',
      conflict: false,
    })
  })

  it('snapshot.get seeds from row text after opaque→md rename, never DEFAULT', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-real',
        observedPath: 'data.bin',
        opId: 'op-bin-seed',
        baseHashHex: '',
        bytes: new TextEncoder().encode('real content'),
      }),
    )
    expect(socket.received('opaque.ack').at(-1)!.conflict).toBe(false)

    await host.send(socket, { type: 'tree.list', requestId: 'rq-head' })
    const head = socket.received('tree.state').at(-1)!.currentSeq
    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-mv',
      ops: [
        {
          type: 'file.rename',
          opId: 'op-mv',
          fileId: 'f-real',
          baseSeq: head,
          fromPath: 'data.bin',
          toPath: 'data.md',
        },
      ],
    })
    const ack = socket.received('batch.ack').at(-1)!
    expect(ack.acceptedOps.map((op) => op.opId)).toEqual(['op-mv'])
    expect(ack.deferredOps).toEqual([])

    // The doc-less markdown row seeds its Loro doc from the row text —
    // falling through to DEFAULT would fabricate placeholder markdown over
    // real content.
    const { snapshotB64 } = await fetchSnapshot(host, socket, 'f-real')
    const text = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64)).getTextContent()
    expect(text).toBe('real content')
    expect(text).not.toContain('# Glovebox')
  })

  it('snapshot.get on an opaque row is refused instead of fabricating placeholder Loro state', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-pic',
        observedPath: 'pic.png',
        opId: 'op-pic',
        baseHashHex: '',
        bytes: new TextEncoder().encode('pixels'),
      }),
    )
    expect(socket.received('opaque.ack').at(-1)!.conflict).toBe(false)

    // A seed-less snapshot.get (a browser clicking the binary in the tree)
    // must NOT mint a DEFAULT markdown doc for the opaque fileId — that
    // doc would poison the kind gates, text reads, and a later opaque→md
    // transition's row-text seeding.
    await host.send(socket, { type: 'snapshot.get', requestId: 'rq-pic', fileId: 'f-pic' })
    const refusal = socket.received('error').at(-1)!
    expect(refusal).toMatchObject({ requestId: 'rq-pic', message: 'opaque-file' })
    expect(socket.received('snapshot.response')).toHaveLength(0)
    // The text tier stays closed too.
    expect(await host.server.readTextFile('f-pic')).toEqual({ status: 'not-found' })
    expect(
      await host.server.pushText({
        fileId: 'f-pic',
        newText: 'overwrite attempt',
        baseHashHex: sha256Hex('whatever'),
      }),
    ).toEqual({ status: 'not-found' })

    // The daemon's boundary transition seeds WITH initialContent — allowed.
    const { snapshotB64 } = await fetchSnapshot(host, socket, 'f-pic', 'now text\n', 'pic.md')
    expect(LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64)).getTextContent()).toBe('now text\n')
  })

  it('opaque.submit is rejected, not acked, when the tree-row write is refused', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    // Occupy a path of exactly the maximum length, then collide a second
    // fileId onto it: the suffix pushes the path over the limit and the
    // row create throws — the canonical store refused the bytes, so the
    // submit must be REJECTED (an ack would advance the daemon watermark
    // and a later refresh would silently revert its disk).
    const longPath = `${'a'.repeat(1024 - 4)}.bin`
    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-long-1',
        observedPath: longPath,
        opId: 'op-long-1',
        baseHashHex: '',
        bytes: new TextEncoder().encode('first'),
      }),
    )
    expect(socket.received('opaque.ack').at(-1)!.fileId).toBe('f-long-1')

    await host.send(
      socket,
      opaqueSubmitMessage({
        fileId: 'f-long-2',
        observedPath: longPath,
        opId: 'op-long-2',
        baseHashHex: '',
        bytes: new TextEncoder().encode('second'),
      }),
    )
    const rejection = socket
      .received('submit.rejected')
      .find((message) => message.opId === 'op-long-2')
    expect(rejection).toMatchObject({ fileId: 'f-long-2', reason: 'too-large' })
    expect(socket.received('opaque.ack').filter((ack) => ack.fileId === 'f-long-2')).toHaveLength(0)
    // No row, no create event, no opaqueUpdate broadcast for the refusal.
    const tree = await host.server.listTree()
    expect(tree.entries.filter((entry) => entry.fileId === 'f-long-2')).toHaveLength(0)
  })

  it('rejects invalid opaque observed paths as invalid-path before row registration', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    const invalidPaths = [
      { fileId: 'f-bad-rel', observedPath: '../evil.bin', opId: 'op-bad-rel' },
      { fileId: 'f-bad-abs', observedPath: '/tmp/evil.bin', opId: 'op-bad-abs' },
    ]

    for (const invalid of invalidPaths) {
      await host.send(
        socket,
        opaqueSubmitMessage({
          ...invalid,
          baseHashHex: '',
          bytes: new TextEncoder().encode('evil'),
        }),
      )

      expect(
        socket.received('submit.rejected').find((message) => message.opId === invalid.opId),
      ).toMatchObject({
        fileId: invalid.fileId,
        reason: 'invalid-path',
      })
      expect(
        socket.received('opaque.ack').filter((ack) => ack.fileId === invalid.fileId),
      ).toHaveLength(0)
      expect(() => readDofsFile(host, `/.glovebox/opaque/${sha256Hex(invalid.fileId)}`)).toThrow()
    }

    const tree = await host.server.listTree()
    expect(tree.entries.filter((entry) => entry.fileId.startsWith('f-bad-'))).toHaveLength(0)
  })

  it('first-contact markdown registration falls back from a refused observedPath', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    const peerId = await helloPeerId(host, socket, 'device-a')

    // Occupy a max-length markdown path. The colliding create must suffix;
    // the suffixed observedPath is over the path cap, so first contact falls
    // back to the stable fileId path instead of minting a Loro-only orphan.
    const longPath = `${'a'.repeat(1024 - 3)}.md`
    await fetchSnapshot(host, socket, 'f-long-md-1', 'first\n', longPath)

    const doc = LoroFileDoc.empty('', { peerId: BigInt(peerId) })
    const base = doc.contentVersion()
    doc.setTextContent('second\n')
    const updateB64 = bytesToBase64(doc.exportUpdateSince(base))

    await host.send(socket, {
      type: 'content.submit',
      fileId: 'f-long-md-2',
      observedPath: longPath,
      opId: 'op-long-md-2',
      baseContentVersionB64: bytesToBase64(base),
      loroUpdateB64: updateB64,
    })

    expect(
      socket.received('submit.rejected').filter((message) => message.fileId === 'f-long-md-2'),
    ).toHaveLength(0)
    expect(socket.received('ack').at(-1)).toMatchObject({
      fileId: 'f-long-md-2',
      opId: 'op-long-md-2',
      applied: true,
    })
    const fallbackEntry = (await host.server.listTree()).entries.find(
      (entry) => entry.fileId === 'f-long-md-2',
    )
    expect(fallbackEntry).toMatchObject({ path: 'f-long-md-2.md' })
    expect(socket.received('create').at(-1)).toMatchObject({
      fileId: 'f-long-md-2',
      path: 'f-long-md-2.md',
    })
    expect(host.server.listRecoveryRecords({ pendingOnly: true })).toHaveLength(0)
  })

  it('records registration-failed recovery when observedPath and fallback both fail', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    await helloPeerId(host, socket, 'device-a')

    const failRegistrationInsert = (query: string) =>
      query.startsWith('INSERT INTO workspace_files ')
    host.storage.sql.failNext(failRegistrationInsert, new Error('quota create failed'))
    host.storage.sql.failNext(failRegistrationInsert, new Error('fallback create failed'))

    await host.send(socket, {
      type: 'snapshot.get',
      requestId: 'rq-registration-fault',
      fileId: 'f-registration-fault',
      initialContent: 'orphan until retry\n',
      observedPath: 'bad/registration.md',
    })

    expect(socket.received('snapshot.response')).toHaveLength(0)
    expect(socket.received('error').at(-1)).toMatchObject({
      requestId: 'rq-registration-fault',
      message: 'materialized view refused file registration',
    })
    expect((await host.server.listTree()).entries).not.toContainEqual(
      expect.objectContaining({ fileId: 'f-registration-fault' }),
    )
    const records = host.server.listRecoveryRecords({ pendingOnly: true })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      fileId: 'f-registration-fault',
      opId: 'snapshot:rq-registration-fault',
      reason: 'registration-failed',
      observedPath: 'bad/registration.md',
    })

    await host.send(socket, {
      type: 'snapshot.get',
      requestId: 'rq-registration-retry',
      fileId: 'f-registration-fault',
      observedPath: 'good/registration.md',
    })
    expect(socket.received('snapshot.response').at(-1)).toMatchObject({
      requestId: 'rq-registration-retry',
      fileId: 'f-registration-fault',
    })
    expect((await host.server.listTree()).entries).toContainEqual(
      expect.objectContaining({ fileId: 'f-registration-fault', path: 'good/registration.md' }),
    )
  })

  it('retries a faulted markdown row write before stale-baseSeq delete can win', async () => {
    const host = new FakeHost()
    const socket = await host.connect('alice')
    const peerId = await helloPeerId(host, socket, 'device-a')
    const { snapshotB64 } = await fetchSnapshot(host, socket, 'f-roll-fault', 'base\n', 'roll.md')
    await host.send(socket, { type: 'events.since', requestId: 'rq-head', afterSeq: 0 })
    const head = socket.received('events.batch').at(-1)!.currentSeq

    host.storage.sql.failNext(
      (query) => query.startsWith('UPDATE workspace_files SET content ='),
      new Error('row write failed'),
    )

    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64), {
      peerId: BigInt(peerId),
    })
    const rejectedSubmit = await submitEdit(
      host,
      socket,
      editor,
      'f-roll-fault',
      'base\nedited\n',
      'op-roll-fault',
    )

    expect(socket.received('ack').filter((ack) => ack.fileId === 'f-roll-fault')).toHaveLength(0)
    expect(socket.received('submit.rejected').at(-1)).toMatchObject({
      fileId: 'f-roll-fault',
      opId: 'op-roll-fault',
      reason: 'too-large',
    })
    let entry = (await host.server.listTree()).entries.find(
      (treeEntry) => treeEntry.fileId === 'f-roll-fault',
    )!
    expect(entry.seq).toBe(head)
    expect(entry.contentHash).toBe(sha256Hex('base\n'))

    // The first attempt imported into the Loro store before the row write
    // faulted. Retrying the same op must still roll the stale projection and
    // advance the per-file seq before a stale deleteIntent can be accepted.
    await host.send(socket, rejectedSubmit)

    expect(socket.received('ack').at(-1)).toMatchObject({
      fileId: 'f-roll-fault',
      opId: 'op-roll-fault',
      applied: false,
    })
    entry = (await host.server.listTree()).entries.find(
      (treeEntry) => treeEntry.fileId === 'f-roll-fault',
    )!
    expect(entry.seq).toBeGreaterThan(head)
    expect(entry.contentHash).toBe(sha256Hex('base\nedited\n'))

    await host.send(socket, {
      type: 'batch.submit',
      requestId: 'rq-stale-delete',
      ops: [
        {
          type: 'file.deleteIntent',
          opId: 'op-stale-delete-after-roll-fault',
          fileId: 'f-roll-fault',
          baseSeq: head,
          path: 'roll.md',
        },
      ],
    })

    expect(socket.received('batch.ack').at(-1)).toMatchObject({
      requestId: 'rq-stale-delete',
      acceptedOps: [],
      deferredOps: [{ opId: 'op-stale-delete-after-roll-fault', reason: 'remote-edit-wins' }],
    })
    expect(socket.received('delete')).toHaveLength(0)
    const { snapshotB64: afterDelete } = await fetchSnapshot(host, socket, 'f-roll-fault')
    expect(LoroFileDoc.fromSnapshot(base64ToBytes(afterDelete)).getTextContent()).toBe(
      'base\nedited\n',
    )
  })
})
