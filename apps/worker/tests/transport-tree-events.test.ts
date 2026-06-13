import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceTreeEntry } from '@glovebox/api'
import { WorkspaceSocketTransport } from '../src/lib/transport.ts'
import type { TreeWireEvent } from '../src/lib/tree-events.ts'

const originalWebSocket = globalThis.WebSocket

describe('WorkspaceSocketTransport tree events', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket as unknown as typeof WebSocket,
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    })
  })

  it('dispatches create, rename, and delete broadcasts to tree subscribers', async () => {
    const events: TreeWireEvent[] = []
    const statuses: string[] = []
    const transport = new WorkspaceSocketTransport({
      deviceId: 'device-1',
      getUrl: () => 'wss://workspace.example/ws',
      onStatus: (status) => statuses.push(status),
    })
    await Promise.resolve()

    const socket = FakeWebSocket.instances[0]
    expect(socket).toBeDefined()
    socket?.open()
    socket?.receive({ type: 'ready', sessionPeerId: '1' })

    const unsubscribe = transport.subscribeTreeEvents((event) => events.push(event))
    socket?.receive({
      type: 'create',
      fileId: 'file-1',
      path: 'docs/a.md',
      entry: entry('file-1', 'docs/a.md', 1),
      seq: 1,
    })
    socket?.receive({
      type: 'rename',
      fileId: 'file-1',
      oldPath: 'docs/a.md',
      newPath: 'docs/b.md',
      entry: entry('file-1', 'docs/b.md', 2),
      seq: 2,
    })
    socket?.receive({
      type: 'delete',
      fileId: 'file-1',
      path: 'docs/b.md',
      seq: 3,
      tombstone: true,
    })

    expect(events.map((event) => event.type)).toEqual(['create', 'rename', 'delete'])
    expect(statuses).toEqual(['connecting', 'open'])

    unsubscribe()
    socket?.receive({
      type: 'delete',
      fileId: 'file-2',
      path: 'docs/c.md',
      seq: 4,
      tombstone: true,
    })

    expect(events).toHaveLength(3)
    transport.close()
  })
})

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []

  constructor(url: string) {
    super()
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(String(data))
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(message: unknown): void {
    const event = new Event('message') as MessageEvent<string>
    Object.defineProperty(event, 'data', { value: JSON.stringify(message) })
    this.dispatchEvent(event)
  }
}

function entry(fileId: string, path: string, seq: number): WorkspaceTreeEntry {
  return {
    fileId,
    path,
    contentHash: `hash-${fileId}-${seq}`,
    sizeBytes: 1,
    version: seq,
    seq,
    modifiedBy: 'tester',
    modifiedAt: seq,
  }
}
