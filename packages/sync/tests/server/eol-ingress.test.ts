import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { base64ToBytes, bytesToBase64 } from '../../src/loro/base64.ts'
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

class FakeHost {
  readonly storage = new FakeStorage()
  readonly sockets: FakeSocket[] = []
  readonly server: WorkspaceServer

  constructor() {
    this.server = new WorkspaceServer({
      storage: this.storage,
      sql: this.storage.sql,
      getSockets: () => this.sockets,
    })
  }

  async connect(): Promise<FakeSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket)
    await this.send(socket, { type: 'hello' })
    return socket
  }

  async send(socket: FakeSocket, message: WorkspaceClientMessage): Promise<void> {
    await this.server.handleMessage(socket, JSON.stringify(message))
  }
}

describe('INV-13 at the WS ingress', () => {
  it('normalizes CRLF that materializes from a content.submit via a server edit', async () => {
    const host = new FakeHost()
    const socket = await host.connect()
    await host.send(socket, {
      type: 'snapshot.get',
      requestId: 'rq-1',
      fileId: 'file-1',
      initialContent: 'v1\n',
      observedPath: 'note.md',
    })
    const response = socket.received('snapshot.response').at(-1)!
    const peerId = socket.received('ready').at(-1)!.sessionPeerId
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(response.snapshotB64), {
      peerId: BigInt(peerId),
    })

    // A Windows-side editor writes CRLF straight into the doc.
    const base = editor.contentVersion()
    editor.setTextContent('v1\r\nwindows line\r\n')
    await host.send(socket, {
      type: 'content.submit',
      fileId: 'file-1',
      observedPath: 'note.md',
      opId: 'op-crlf',
      baseContentVersionB64: bytesToBase64(base),
      loroUpdateB64: bytesToBase64(editor.exportUpdateSince(base)),
    })

    // The submit is acked as-is, then a corrective server-owned edit
    // lands and broadcasts; the live server text carries no CR.
    expect(socket.received('ack').at(-1)!.opId).toBe('op-crlf')
    const read = await host.server.readTextFile('file-1')
    if (read.status !== 'ok') throw new Error('unreachable')
    expect(read.text).toBe('v1\nwindows line\n')

    const updates = socket.received('content.loroUpdate')
    const corrective = updates.filter((update) => update.originDeviceId === 'server-eol')
    expect(corrective).toHaveLength(1)

    // The submitting editor converges by applying its broadcasts.
    for (const update of updates) {
      editor.importUpdate(base64ToBytes(update.loroUpdateB64))
    }
    expect(editor.getTextContent()).toBe('v1\nwindows line\n')
  })

  it('normalizes client-supplied initial content on create', async () => {
    const host = new FakeHost()
    const socket = await host.connect()
    await host.send(socket, {
      type: 'snapshot.get',
      requestId: 'rq-1',
      fileId: 'file-crlf',
      initialContent: 'top\r\nbottom\r\n',
      observedPath: 'crlf.md',
    })
    const response = socket.received('snapshot.response').at(-1)!
    const doc = LoroFileDoc.fromSnapshot(base64ToBytes(response.snapshotB64))
    expect(doc.getTextContent()).toBe('top\nbottom\n')
  })

  it('leaves clean submits untouched — no corrective edit, no extra seq', async () => {
    const host = new FakeHost()
    const socket = await host.connect()
    await host.send(socket, {
      type: 'snapshot.get',
      requestId: 'rq-1',
      fileId: 'file-1',
      initialContent: 'v1\n',
      observedPath: 'note.md',
    })
    const response = socket.received('snapshot.response').at(-1)!
    const peerId = socket.received('ready').at(-1)!.sessionPeerId
    const editor = LoroFileDoc.fromSnapshot(base64ToBytes(response.snapshotB64), {
      peerId: BigInt(peerId),
    })
    const base = editor.contentVersion()
    editor.setTextContent('v1\nclean\n')
    await host.send(socket, {
      type: 'content.submit',
      fileId: 'file-1',
      observedPath: 'note.md',
      opId: 'op-clean',
      baseContentVersionB64: bytesToBase64(base),
      loroUpdateB64: bytesToBase64(editor.exportUpdateSince(base)),
    })

    expect(socket.received('content.loroUpdate')).toHaveLength(1)
  })
})
