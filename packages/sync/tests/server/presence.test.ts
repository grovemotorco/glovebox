import { DatabaseSync } from 'node:sqlite'
import { EphemeralStore } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { base64ToBytes } from '../../src/loro/base64.ts'
import { WorkspacePresence } from '../../src/client/presence.ts'
import {
  WorkspaceServer,
  type WorkspaceConnectionClaims,
  type WorkspaceClientMessage,
  type WorkspacePresenceEntry,
  type WorkspaceServerLimits,
  type WorkspaceServerMessage,
  type WorkspaceServerStorage,
  type WorkspaceSocket,
  type WorkspaceSqlStorage,
  type WorkspaceSqlValue,
} from '../../src/server/workspace-server.ts'

function roleClaims(
  principalId: string,
  role: WorkspaceConnectionClaims['role'],
  principalType: WorkspaceConnectionClaims['principalType'] = 'human',
): WorkspaceConnectionClaims {
  return { principalId, principalType, role, owner: false, epoch: 0 }
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
  readonly listeners = new Set<(message: WorkspaceServerMessage) => void>()
  closed: { code?: number; reason?: string } | null = null
  #attachment: unknown

  send(data: string): void {
    if (this.closed) throw new Error('Socket is closed')
    const message = JSON.parse(data) as WorkspaceServerMessage
    this.sent.push(message)
    for (const listener of this.listeners) listener(message)
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

interface FakeHostOptions {
  storage?: FakeStorage
  sockets?: FakeSocket[]
  limits?: Partial<WorkspaceServerLimits>
}

class FakeHost {
  readonly storage: FakeStorage
  readonly sockets: FakeSocket[]
  readonly server: WorkspaceServer
  readonly limits?: Partial<WorkspaceServerLimits>
  now: number

  constructor(options: FakeHostOptions = {}) {
    this.storage = options.storage ?? new FakeStorage()
    this.sockets = options.sockets ?? []
    this.now = 1_750_000_000_000
    this.limits = options.limits
    this.server = new WorkspaceServer({
      storage: this.storage,
      sql: this.storage.sql,
      getSockets: () => this.sockets,
      now: () => this.now,
      limits: this.limits,
    })
  }

  async connect(claims: WorkspaceConnectionClaims): Promise<FakeSocket> {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    await this.server.handleConnect(socket, claims)
    return socket
  }

  async send(socket: FakeSocket, message: WorkspaceClientMessage): Promise<void> {
    await this.server.handleMessage(socket, JSON.stringify(message))
  }

  async sendRaw(socket: FakeSocket, raw: string): Promise<void> {
    await this.server.handleMessage(socket, raw)
  }

  /** In-memory server state is lost; durable storage and sockets survive. */
  evict(): FakeHost {
    return new FakeHost({ storage: this.storage, sockets: this.sockets, limits: this.limits })
  }
}

async function peerIdOf(host: FakeHost, socket: FakeSocket): Promise<string> {
  await host.send(socket, { type: 'hello' })
  return socket.received('ready').at(-1)!.sessionPeerId
}

/** Decode a presence.state / presence.update stream into a fresh store. */
function decodePresence(messages: { dataB64: string }[]): Record<string, WorkspacePresenceEntry> {
  const store = new EphemeralStore(60_000)
  for (const message of messages) store.apply(base64ToBytes(message.dataB64))
  const states = store.getAllStates() as unknown as Record<string, WorkspacePresenceEntry>
  store.destroy()
  return states
}

async function fetchPresence(
  host: FakeHost,
  socket: FakeSocket,
): Promise<Record<string, WorkspacePresenceEntry>> {
  const requestId = crypto.randomUUID()
  await host.send(socket, { type: 'presence.get', requestId })
  const response = socket
    .received('presence.state')
    .find((message) => message.requestId === requestId)
  expect(response).toBeDefined()
  return decodePresence([response!])
}

describe('workspace presence', () => {
  it('stamps identity from connection claims, never from the message', async () => {
    const host = new FakeHost()
    const publisher = await host.connect(roleClaims('user-real', 'editor'))
    const peerId = await peerIdOf(host, publisher)

    await host.send(publisher, {
      type: 'presence.set',
      stateJson: JSON.stringify({ principalId: 'attacker', name: 'Mallory' }),
    })

    const observer = await host.connect(roleClaims('user-2', 'viewer'))
    const states = await fetchPresence(host, observer)
    expect(Object.keys(states)).toEqual([peerId])
    expect(states[peerId]!.principalId).toBe('user-real')
    expect(states[peerId]!.principalType).toBe('human')
    // The client-asserted id survives only inside the untrusted state blob.
    expect(states[peerId]!.state).toEqual({ principalId: 'attacker', name: 'Mallory' })
  })

  it('lets read-only roles publish presence', async () => {
    const host = new FakeHost()
    const viewer = await host.connect(roleClaims('viewer-1', 'viewer'))
    const peerId = await peerIdOf(host, viewer)

    await host.send(viewer, { type: 'presence.set', stateJson: '{"name":"V"}' })

    const states = await fetchPresence(host, viewer)
    expect(states[peerId]!.principalId).toBe('viewer-1')
  })

  it('broadcasts presence updates that other clients can apply incrementally', async () => {
    const host = new FakeHost()
    const a = await host.connect(roleClaims('user-a', 'editor'))
    const b = await host.connect(roleClaims('user-b', 'editor'))
    const peerA = await peerIdOf(host, a)

    await host.send(a, { type: 'presence.set', stateJson: '{"cursor":3}' })

    const updates = b.received('presence.update')
    expect(updates.length).toBeGreaterThan(0)
    const states = decodePresence(updates)
    expect(states[peerA]).toEqual({
      principalId: 'user-a',
      principalType: 'human',
      state: { cursor: 3 },
    })
  })

  it('removes the entry and broadcasts an explicit leave on disconnect', async () => {
    const host = new FakeHost()
    const leaver = await host.connect(roleClaims('user-a', 'editor'))
    const stayer = await host.connect(roleClaims('user-b', 'editor'))
    const leaverPeer = await peerIdOf(host, leaver)

    await host.send(leaver, { type: 'presence.set', stateJson: '{"here":true}' })
    await host.server.handleDisconnect(leaver)

    // The stayer gets an explicit leave (the delete tombstone would lose a
    // same-millisecond LWW tie against the set, so it is not relayed) …
    expect(stayer.received('presence.leave')).toEqual([{ type: 'presence.leave', key: leaverPeer }])
    // … and a late joiner sees nothing at all.
    const joiner = await host.connect(roleClaims('user-c', 'viewer'))
    expect(await fetchPresence(host, joiner)).toEqual({})
  })

  it('rejects malformed presence frames per INV-12 and stores nothing', async () => {
    const host = new FakeHost()
    const socket = await host.connect(roleClaims('user-a', 'editor'))

    // Unknown key.
    await host.sendRaw(
      socket,
      JSON.stringify({ type: 'presence.set', stateJson: '{}', extra: 'nope' }),
    )
    // Oversized state.
    await host.send(socket, {
      type: 'presence.set',
      stateJson: JSON.stringify({ pad: 'x'.repeat(5000) }),
    })
    // Not JSON.
    await host.sendRaw(socket, JSON.stringify({ type: 'presence.set', stateJson: 'not json {' }))
    // Wrong type.
    await host.sendRaw(socket, JSON.stringify({ type: 'presence.set', stateJson: 42 }))

    expect(socket.received('error')).toHaveLength(4)
    expect(await fetchPresence(host, socket)).toEqual({})
  })

  it('rate-limits presence floods without starving content submits', async () => {
    const host = new FakeHost({ limits: { submitRateLimit: 2 } })
    const socket = await host.connect(roleClaims('user-a', 'editor'))
    const peerId = await peerIdOf(host, socket)

    await host.send(socket, { type: 'presence.set', stateJson: '{"n":1}' })
    await host.send(socket, { type: 'presence.set', stateJson: '{"n":2}' })
    await host.send(socket, { type: 'presence.set', stateJson: '{"n":3}' })

    const rejected = socket.received('presence.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBe('rate-limited')
    const states = await fetchPresence(host, socket)
    expect(states[peerId]!.state).toEqual({ n: 2 })

    // The submit window is presence-scoped: content submits still pass.
    await host.send(socket, {
      type: 'snapshot.get',
      requestId: 'r1',
      fileId: 'file-1',
      initialContent: 'hello',
      observedPath: 'notes/a.md',
    })
    expect(socket.received('snapshot.response')).toHaveLength(1)
  })

  it('loses presence on eviction and heals when clients republish', async () => {
    const host = new FakeHost()
    const socket = await host.connect(roleClaims('user-a', 'editor'))
    const peerId = await peerIdOf(host, socket)
    await host.send(socket, { type: 'presence.set', stateJson: '{"v":1}' })

    const next = host.evict()
    expect(await fetchPresence(next, socket)).toEqual({})

    // The client heartbeat republishes the same state on the same socket.
    await next.send(socket, { type: 'presence.set', stateJson: '{"v":1}' })
    const states = await fetchPresence(next, socket)
    expect(states[peerId]).toEqual({
      principalId: 'user-a',
      principalType: 'human',
      state: { v: 1 },
    })
  })
})

/**
 * Bridge a FakeSocket into the client transport interface. `hostRef` is a
 * mutable ref so an eviction (new server over the same storage/sockets)
 * redirects traffic the way a real socket would.
 */
function presenceTransport(hostRef: { host: FakeHost }, socket: FakeSocket) {
  return {
    sendPresence(stateJson: string): void {
      void hostRef.host.send(socket, { type: 'presence.set', stateJson })
    },
    async fetchPresenceState(): Promise<Uint8Array> {
      const requestId = crypto.randomUUID()
      await hostRef.host.send(socket, { type: 'presence.get', requestId })
      const response = socket
        .received('presence.state')
        .find((message) => message.requestId === requestId)!
      return base64ToBytes(response.dataB64)
    },
    subscribePresence(
      handler: (
        event: { type: 'update'; data: Uint8Array } | { type: 'leave'; key: string },
      ) => void,
    ): () => void {
      const listener = (message: WorkspaceServerMessage): void => {
        if (message.type === 'presence.update') {
          handler({ type: 'update', data: base64ToBytes(message.dataB64) })
        } else if (message.type === 'presence.leave') {
          handler({ type: 'leave', key: message.key })
        }
      }
      socket.listeners.add(listener)
      return () => socket.listeners.delete(listener)
    },
  }
}

describe('WorkspacePresence client', () => {
  it('sees peers end-to-end, applies leaves, and heals after eviction', async () => {
    const hostRef = { host: new FakeHost() }
    const socketA = await hostRef.host.connect(roleClaims('user-a', 'editor'))
    const socketB = await hostRef.host.connect(roleClaims('user-b', 'viewer', 'agent'))
    const peerA = await peerIdOf(hostRef.host, socketA)
    const peerB = await peerIdOf(hostRef.host, socketB)

    const heartbeats: (() => void)[] = []
    const presenceA = new WorkspacePresence({
      transport: presenceTransport(hostRef, socketA),
      setInterval: (callback) => {
        heartbeats.push(callback)
        return heartbeats.length
      },
      clearInterval: () => {},
    })
    const presenceB = new WorkspacePresence({ transport: presenceTransport(hostRef, socketB) })

    let notified = 0
    presenceA.subscribe(() => {
      notified += 1
    })

    const drain = (socket: FakeSocket): Promise<void> =>
      hostRef.host.server.handleMessage(socket, JSON.stringify({ type: 'hello' }))

    // B publishes before A starts — A must see it via the seed fetch.
    await presenceB.start()
    presenceB.setLocalState({ name: 'Bee' })
    await drain(socketB)
    await presenceA.start()
    presenceA.setLocalState({ name: 'Aye' })
    await drain(socketA)

    const peersOfA = presenceA.peers()
    expect(peersOfA.map((peer) => peer.key).sort()).toEqual([peerA, peerB].sort())
    const b = peersOfA.find((peer) => peer.key === peerB)!
    expect(b.principalId).toBe('user-b')
    expect(b.principalType).toBe('agent')
    expect(b.state).toEqual({ name: 'Bee' })
    expect(notified).toBeGreaterThan(0)

    // B disconnects — A applies the explicit leave immediately.
    await hostRef.host.server.handleDisconnect(socketB)
    expect(presenceA.peers().map((peer) => peer.key)).toEqual([peerA])

    // Eviction wipes the server store; the heartbeat republish heals it.
    hostRef.host = hostRef.host.evict()
    expect(await fetchPresence(hostRef.host, socketA)).toEqual({})
    expect(heartbeats).toHaveLength(1)
    heartbeats[0]!()
    await drain(socketA)
    const healed = await fetchPresence(hostRef.host, socketA)
    expect(healed[peerA]!.state).toEqual({ name: 'Aye' })

    presenceA.stop()
    presenceB.stop()
  })
})
