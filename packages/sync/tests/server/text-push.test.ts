import { DatabaseSync } from 'node:sqlite'
import { decodeImportBlobMeta } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { base64ToBytes, bytesToBase64 } from '../../src/loro/base64.ts'
import { sha256Hex } from '../../src/fs/hash.ts'
import {
  WorkspaceServer,
  type WorkspaceClientMessage,
  type WorkspaceServerLimits,
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
  readonly storage: FakeStorage
  readonly sockets: FakeSocket[] = []
  readonly server: WorkspaceServer
  now = 1_750_000_000_000

  constructor(limits?: Partial<WorkspaceServerLimits>) {
    this.storage = new FakeStorage()
    this.server = new WorkspaceServer({
      storage: this.storage,
      sql: this.storage.sql,
      getSockets: () => this.sockets,
      now: () => this.now,
      limits,
    })
  }

  async connect(deviceId: string): Promise<FakeSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket)
    await this.send(socket, { type: 'hello', deviceId })
    return socket
  }

  async send(socket: FakeSocket, message: WorkspaceClientMessage): Promise<void> {
    await this.server.handleMessage(socket, JSON.stringify(message))
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

describe('text-push tier (D5, spec §5.3)', () => {
  it('pull → clean push lands through the same pipeline as a WS submit', async () => {
    const host = new FakeHost()
    const observer = await host.connect('device-observer')
    await openFile(host, observer, 'file-1', '# Doc\n\nv1\n')

    const pulled = await host.server.readTextFile('file-1')
    expect(pulled.status).toBe('ok')
    if (pulled.status !== 'ok') throw new Error('unreachable')
    expect(pulled.text).toBe('# Doc\n\nv1\n')
    expect(pulled.hashHex).toBe(sha256Hex('# Doc\n\nv1\n'))

    const result = await host.server.pushText({
      fileId: 'file-1',
      newText: '# Doc\n\nv1\nv2 from agent\n',
      baseHashHex: pulled.hashHex,
      modifiedBy: 'agent-1',
    })
    expect(result).toMatchObject({ status: 'applied', changed: true, failedHunks: [] })
    if (result.status !== 'applied') throw new Error('unreachable')
    expect(result.text).toBe('# Doc\n\nv1\nv2 from agent\n')
    expect(result.hashHex).toBe(sha256Hex(result.text))

    // Live clients heard the change as an ordinary content.loroUpdate…
    const broadcast = observer.received('content.loroUpdate').at(-1)!
    expect(broadcast.contentVersionB64).toBe(result.contentVersionB64)
    // …and the event log + tree authority rolled (event at the file's seq).
    await host.send(observer, { type: 'events.since', requestId: 'rq-1', afterSeq: 0 })
    const batch = observer.received('events.batch').at(-1)!
    expect(batch.events.filter((event) => event.type === 'content.loroUpdate')).toHaveLength(1)
    const tree = await host.server.listTree()
    expect(tree.entries).toHaveLength(1)
    expect(tree.entries[0]!.modifiedBy).toBe('agent-1')

    // The pulled base resolves from cache for a follow-up reader's doc.
    const after = await host.server.readTextFile('file-1')
    if (after.status !== 'ok') throw new Error('unreachable')
    expect(after.text).toBe('# Doc\n\nv1\nv2 from agent\n')
  })

  it('lands push ops under a freshly allocated server-owned peer (INV-7)', async () => {
    const host = new FakeHost()
    const observer = await host.connect('device-observer')
    await openFile(host, observer, 'file-1', 'v1\n')
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    const counterBefore = BigInt((await host.storage.get<string>('meta:nextPeerId')) ?? '1')
    await host.server.pushText({
      fileId: 'file-1',
      newText: 'v1\npushed\n',
      baseHashHex: pulled.hashHex,
    })

    // The durable counter advanced and the broadcast update's ops belong
    // to exactly that peer — not to any client session peer.
    const counterAfter = BigInt((await host.storage.get<string>('meta:nextPeerId'))!)
    expect(counterAfter).toBe(counterBefore + 1n)
    const update = base64ToBytes(observer.received('content.loroUpdate').at(-1)!.loroUpdateB64)
    const peers = [...decodeImportBlobMeta(update, false).partialEndVersionVector.toJSON().keys()]
    expect(peers).toEqual([counterBefore.toString()])
  })

  it('merges a drifted push, preserving concurrent edits', async () => {
    const host = new FakeHost()
    const editorSocket = await host.connect('device-editor')
    const editor = await openFile(host, editorSocket, 'file-1', 'intro\n\nbody\n')
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    // A live editor changes the intro AFTER the agent pulled.
    await submitEdit(host, editorSocket, editor, 'file-1', 'intro edited\n\nbody\n', 'op-1')

    // The agent edits the body, based on the old pull.
    const result = await host.server.pushText({
      fileId: 'file-1',
      newText: 'intro\n\nbody improved by agent\n',
      baseHashHex: pulled.hashHex,
    })
    expect(result).toMatchObject({ status: 'applied', changed: true, failedHunks: [] })
    if (result.status !== 'applied') throw new Error('unreachable')
    expect(result.text).toBe('intro edited\n\nbody improved by agent\n')
  })

  it('returns unplaceable hunks verbatim and applies nothing for them', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    const editor = await openFile(
      host,
      socket,
      'file-1',
      'alpha bravo charlie\ndelta echo foxtrot\n',
    )
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    // The doc is completely rewritten — no context survives for the patch.
    await submitEdit(
      host,
      socket,
      editor,
      'file-1',
      'zz yy xx ww vv uu\n11 22 33 44 55 66\n',
      'op-rewrite',
    )

    const result = await host.server.pushText({
      fileId: 'file-1',
      newText: 'alpha bravo charlie AMENDED\ndelta echo foxtrot\n',
      baseHashHex: pulled.hashHex,
    })
    if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`)
    expect(result.failedHunks.length).toBeGreaterThan(0)
    // Nothing landed: the current text is untouched by the failed hunk.
    expect(result.changed).toBe(false)
    expect(result.text).toBe('zz yy xx ww vv uu\n11 22 33 44 55 66\n')
  })

  it('refuses a degenerate rewrite of a drifted base unless forced', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    const editor = await openFile(
      host,
      socket,
      'file-1',
      'one two three four five six seven eight nine ten\n',
    )
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    // Drift…
    await submitEdit(
      host,
      socket,
      editor,
      'file-1',
      'one two three four five six seven eight nine ten eleven\n',
      'op-drift',
    )

    // …then a push that deletes nearly everything.
    const refused = await host.server.pushText({
      fileId: 'file-1',
      newText: 'one\n',
      baseHashHex: pulled.hashHex,
    })
    expect(refused.status).toBe('degenerate-rewrite')
    if (refused.status !== 'degenerate-rewrite') throw new Error('unreachable')
    expect(refused.deletedRatio).toBeGreaterThan(0.6)

    // Explicit force applies it.
    const forced = await host.server.pushText({
      fileId: 'file-1',
      newText: 'one\n',
      baseHashHex: pulled.hashHex,
      force: true,
    })
    expect(forced.status).toBe('applied')

    // A non-drifted full rewrite is NOT degenerate — no refusal.
    const freshPull = await host.server.readTextFile('file-1')
    if (freshPull.status !== 'ok') throw new Error('unreachable')
    const cleanRewrite = await host.server.pushText({
      fileId: 'file-1',
      newText: 'totally new\n',
      baseHashHex: freshPull.hashHex,
    })
    expect(cleanRewrite.status).toBe('applied')
  })

  it('asks for the base on a cache miss and resumes when it is re-sent', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    await openFile(host, socket, 'file-1', 'v1\ncommon middle\nend\n')

    // A base the server never served (an old offline copy) — unknown hash.
    const offlineBase = 'v1\ncommon middle\n'
    const newText = 'v1\ncommon middle\nplus\n'
    const miss = await host.server.pushText({
      fileId: 'file-1',
      newText,
      baseHashHex: sha256Hex(offlineBase),
    })
    expect(miss.status).toBe('base-missing')

    // A re-sent base that does not match its claimed hash is refused too.
    const lying = await host.server.pushText({
      fileId: 'file-1',
      newText,
      baseHashHex: sha256Hex(offlineBase),
      baseText: 'something else entirely\n',
    })
    expect(lying.status).toBe('base-missing')

    // Honest re-send resumes: merged against the drifted current text.
    const resumed = await host.server.pushText({
      fileId: 'file-1',
      newText,
      baseHashHex: sha256Hex(offlineBase),
      baseText: offlineBase,
    })
    expect(resumed.status).toBe('applied')
    if (resumed.status !== 'applied') throw new Error('unreachable')
    expect(resumed.failedHunks).toEqual([])
    expect(resumed.text).toContain('plus\n')
    expect(resumed.text).toContain('end\n')
  })

  it('serves a drifted push from the pull-time base cache', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    const editor = await openFile(host, socket, 'file-1', 'line a\nline b\n')
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    await submitEdit(host, socket, editor, 'file-1', 'line a CHANGED\nline b\n', 'op-1')

    // No baseText supplied — the cache from the pull carries it.
    const result = await host.server.pushText({
      fileId: 'file-1',
      newText: 'line a\nline b extended\n',
      baseHashHex: pulled.hashHex,
    })
    expect(result).toMatchObject({ status: 'applied', failedHunks: [] })
    if (result.status !== 'applied') throw new Error('unreachable')
    expect(result.text).toBe('line a CHANGED\nline b extended\n')
  })

  it('normalizes EOL at the push boundary (INV-13) and replays retries by key', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    await openFile(host, socket, 'file-1', 'v1\n')
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    const push = {
      fileId: 'file-1',
      newText: 'v1\r\nwindows line\r\n',
      baseHashHex: pulled.hashHex,
      idempotencyKey: 'push-attempt-1',
    }
    const first = await host.server.pushText(push)
    if (first.status !== 'applied') throw new Error('unreachable')
    expect(first.text).toBe('v1\nwindows line\n')
    expect(first.changed).toBe(true)

    // A lost-response retry replays the recorded result — the fuzzy patch
    // must never run twice (it would insert the line again).
    const retry = await host.server.pushText(push)
    expect(retry).toEqual(first)
    const after = await host.server.readTextFile('file-1')
    if (after.status !== 'ok') throw new Error('unreachable')
    expect(after.text).toBe('v1\nwindows line\n')
  })

  it('rejects pushes to unknown files and over-sized texts', async () => {
    const host = new FakeHost({ maxTextBytes: 64 })
    const socket = await host.connect('device-a')
    await openFile(host, socket, 'file-1', 'v1\n')
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    expect(
      (
        await host.server.pushText({
          fileId: 'file-unknown',
          newText: 'x\n',
          baseHashHex: pulled.hashHex,
        })
      ).status,
    ).toBe('not-found')

    expect(
      (
        await host.server.pushText({
          fileId: 'file-1',
          newText: 'x'.repeat(100),
          baseHashHex: pulled.hashHex,
        })
      ).status,
    ).toBe('too-large')
  })

  it('expires cached bases through maintenance; pushes then ask for a re-send', async () => {
    const host = new FakeHost()
    const socket = await host.connect('device-a')
    const editor = await openFile(host, socket, 'file-1', 'v1\n')
    const pulled = await host.server.readTextFile('file-1')
    if (pulled.status !== 'ok') throw new Error('unreachable')

    // Drift so the stale-base push cannot take the current-text fast path.
    await submitEdit(host, socket, editor, 'file-1', 'v1\ndrift\n', 'op-1')

    host.now += 8 * 24 * 60 * 60 * 1000
    const maintenance = await host.server.runMaintenance()
    expect(maintenance.prunedTextBases).toBeGreaterThan(0)

    const result = await host.server.pushText({
      fileId: 'file-1',
      newText: 'v1\nagent\n',
      baseHashHex: pulled.hashHex,
    })
    expect(result.status).toBe('base-missing')
  })
})
