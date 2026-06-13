/* @vitest-environment happy-dom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTreeEntry } from '@glovebox/api'
import { bytesToBase64, LoroFileDoc } from '@glovebox/sync/loro'
import { useRoom, useWorkspace, WorkspaceProvider, type RoomHandle } from '../src/state/workspace.tsx'

const apiMock = vi.hoisted(() => ({
  treeEntries: [] as WorkspaceTreeEntry[],
  treeSeq: 0,
  workspaces: {
    create: vi.fn(),
    list: vi.fn(),
    tree: vi.fn(),
  },
  members: { list: vi.fn() },
  invites: { list: vi.fn() },
  documents: { recoveryList: vi.fn() },
  auth: { mintWorkspaceSocketToken: vi.fn() },
}))

vi.mock('../src/lib/api.ts', () => ({
  getOrCreateDeviceId: () => 'device-test',
  api: {
    workspaces: apiMock.workspaces,
    members: apiMock.members,
    invites: apiMock.invites,
    documents: apiMock.documents,
    auth: apiMock.auth,
  },
}))

const originalWebSocket = globalThis.WebSocket
const originalLocalStorage = globalThis.localStorage

interface ProbeState {
  workspace: ReturnType<typeof useWorkspace>
  handle: RoomHandle | null
}

let latest: ProbeState | null = null

describe('WorkspaceProvider remote tree delete handling', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    latest = null
    FakeWebSocket.instances = []
    apiMock.treeEntries = [entry('file-1', 'docs/a.md', 1)]
    apiMock.treeSeq = 1
    apiMock.workspaces.create.mockReset()
    apiMock.workspaces.list.mockResolvedValue({
      workspaces: [
        {
          id: 'ws-1',
          name: 'Workspace',
          deleted: false,
          authEpoch: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    apiMock.workspaces.tree.mockImplementation(async () => ({
      entries: apiMock.treeEntries,
      seq: apiMock.treeSeq,
    }))
    apiMock.members.list.mockResolvedValue({ members: [] })
    apiMock.invites.list.mockResolvedValue({ invites: [] })
    apiMock.documents.recoveryList.mockResolvedValue({ records: [] })
    apiMock.auth.mintWorkspaceSocketToken.mockResolvedValue({ token: null })
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket as unknown as typeof WebSocket,
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: originalLocalStorage,
    })
  })

  it('resurrects an opened file with unacked local edits instead of dropping the room', async () => {
    const root = await renderWorkspace()
    try {
      const socket = await connectWorkspace()

      await act(async () => {
        latest?.workspace.openFile('file-1', 'docs/a.md')
      })
      const initialSnapshotRequest = await waitForSent(socket, 'snapshot.get')
      respondSnapshot(socket, initialSnapshotRequest, 'file-1', 'server text')
      await waitFor(() => latest?.handle?.status === 'ready')

      const originalRoom = latest!.handle!.room
      await act(async () => {
        void originalRoom.setTextContent('local edit')
      })
      await waitFor(() => latest?.handle?.room.hasPendingChanges() === true)
      await waitForSent(socket, 'content.submit')

      await act(async () => {
        socket.receive({
          type: 'delete',
          fileId: 'file-1',
          path: 'docs/a.md',
          seq: 2,
          tombstone: true,
        })
      })
      expect(latest?.workspace.tree.map((item) => item.fileId)).toEqual(['file-1'])

      const resurrectSnapshotRequest = await waitForSent(socket, 'snapshot.get', 1)
      expect(resurrectSnapshotRequest.initialContent).toBe('local edit')
      apiMock.treeEntries = [entry('file-1', 'docs/a.md', 3)]
      apiMock.treeSeq = 3
      respondSnapshot(socket, resurrectSnapshotRequest, 'file-1', 'local edit')

      await waitFor(() => latest?.handle?.status === 'ready' && latest.handle.room !== originalRoom)
      expect(latest?.handle?.room.getTextContent()).toBe('local edit')
      expect(latest?.workspace.tree.map((item) => item.fileId)).toEqual(['file-1'])
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('keeps newer event state when a stale tree refresh returns later', async () => {
    const root = await renderWorkspace()
    try {
      const socket = await connectWorkspace()

      await act(async () => {
        socket.receive({
          type: 'create',
          fileId: 'file-2',
          path: 'docs/b.md',
          entry: entry('file-2', 'docs/b.md', 2),
          seq: 2,
        })
      })
      expect(latest?.workspace.tree.map((item) => item.fileId).sort()).toEqual([
        'file-1',
        'file-2',
      ])

      apiMock.treeEntries = []
      apiMock.treeSeq = 1
      await act(async () => {
        await latest?.workspace.refreshTree()
      })

      expect(latest?.workspace.tree.map((item) => item.fileId).sort()).toEqual([
        'file-1',
        'file-2',
      ])
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('refreshes authoritative tree state after a gapped event', async () => {
    const root = await renderWorkspace()
    try {
      const socket = await connectWorkspace()
      apiMock.treeEntries = [
        entry('file-1', 'docs/a.md', 1),
        entry('file-2', 'docs/b.md', 3),
        entry('file-3', 'docs/c.md', 4),
      ]
      apiMock.treeSeq = 4

      await act(async () => {
        socket.receive({
          type: 'create',
          fileId: 'file-3',
          path: 'docs/c.md',
          entry: entry('file-3', 'docs/c.md', 4),
          seq: 4,
        })
      })

      await waitFor(() =>
        latest?.workspace.tree.some((item) => item.fileId === 'file-2') === true
      )
      expect(latest?.workspace.tree.map((item) => item.fileId).sort()).toEqual([
        'file-1',
        'file-2',
        'file-3',
      ])
    } finally {
      await act(async () => root.unmount())
    }
  })
})

function Probe() {
  const workspace = useWorkspace()
  const handle = useRoom('file-1')
  latest = { workspace, handle }
  return null
}

async function renderWorkspace(): Promise<Root> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <WorkspaceProvider
        user={{ id: 'user-1', name: 'Test User', email: 'test@example.com' }}
        autoSync
      >
        <Probe />
      </WorkspaceProvider>,
    )
  })
  return root
}

async function connectWorkspace(): Promise<FakeWebSocket> {
  await waitFor(() => latest?.workspace.workspaceId === 'ws-1')
  await waitFor(() => FakeWebSocket.instances.length === 1)
  const socket = FakeWebSocket.instances[0]!
  await act(async () => {
    socket.open()
    socket.receive({ type: 'ready', sessionPeerId: '1' })
  })
  await waitFor(() => latest?.workspace.treeLoaded === true)
  return socket
}

async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (assertion()) return
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function waitForSent(
  socket: FakeWebSocket,
  type: string,
  index = 0,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined
  await waitFor(() => {
    const messages = socket.sentJson().filter((message) => message.type === type)
    found = messages[index]
    return found !== undefined
  })
  return found!
}

function respondSnapshot(
  socket: FakeWebSocket,
  request: Record<string, unknown>,
  fileId: string,
  text: string,
): void {
  const doc = LoroFileDoc.empty(text)
  socket.receive({
    type: 'snapshot.response',
    requestId: request.requestId,
    fileId,
    snapshotB64: bytesToBase64(doc.exportSnapshot()),
    contentVersionB64: bytesToBase64(doc.contentVersion()),
  })
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  readonly url: string
  readonly #sent: string[] = []

  constructor(url: string) {
    super()
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.#sent.push(String(data))
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

  sentJson(): Record<string, unknown>[] {
    return this.#sent.map((message) => JSON.parse(message) as Record<string, unknown>)
  }
}

class MemoryStorage {
  readonly #values = new Map<string, string>()

  get length(): number {
    return this.#values.size
  }

  clear(): void {
    this.#values.clear()
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.#values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.#values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value)
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
