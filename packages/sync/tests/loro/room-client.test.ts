import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import {
  LoroRoomClient,
  bytesToBase64,
  type LoroRoomTransport,
  type LoroUpdateWireEvent,
  type SubmitUpdateInput,
  type SubmitUpdateResult,
} from '../../src/loro/room-client.ts'

const FILE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PATH = 'docs/note.md'

/**
 * In-memory server stub that mirrors WorkspaceDO's content-update handling:
 * accept update bytes, apply them to the canonical doc, emit a
 * `content.loroUpdate` event to all subscribers (including the originator —
 * importing an own echo is a version-vector no-op on the room client).
 */
class StubRealtimeServer {
  #doc: LoroFileDoc
  readonly #subscribers = new Map<string, Set<(event: LoroUpdateWireEvent) => void>>()
  #seq = 0
  readonly #ackByOpId = new Map<string, SubmitUpdateResult>()
  /** Submits received, including idempotent replays — for retry assertions. */
  readonly submitLog: string[] = []

  constructor(seed: LoroFileDoc) {
    this.#doc = seed
  }

  snapshot(): Uint8Array {
    return this.#doc.exportSnapshot()
  }

  fileText(): string {
    return this.#doc.getTextContent()
  }

  /** Direct mutation (simulating the daemon path). */
  applyDaemonUpdate(update: Uint8Array, originDeviceId: string): void {
    if (!this.#doc.importUpdate(update)) return
    this.#seq += 1
    this.#deferBroadcast({
      type: 'content.loroUpdate',
      fileId: FILE_ID,
      loroUpdateB64: bytesToBase64(update),
      contentVersionB64: bytesToBase64(this.#doc.contentVersion()),
      originDeviceId,
      seq: this.#seq,
    })
  }

  /** Resolves once all queued broadcasts have been delivered. */
  async drain(): Promise<void> {
    // Wait two microtask hops to let queueMicrotask deliveries flush.
    await Promise.resolve()
    await Promise.resolve()
  }

  transportFor(deviceId: string): LoroRoomTransport {
    return {
      assignSessionPeerId: async () => (deviceId === 'browser-A' ? 101n : 202n),
      submitUpdate: async (input: SubmitUpdateInput) => {
        this.submitLog.push(input.opId)
        const replay = this.#ackByOpId.get(input.opId)
        if (replay) return replay
        const applied = this.#doc.importUpdate(input.loroUpdate)
        const ack: SubmitUpdateResult = {
          type: 'ack',
          applied,
          contentVersionB64: bytesToBase64(this.#doc.contentVersion()),
        }
        this.#ackByOpId.set(input.opId, ack)
        if (!applied) return ack
        this.#seq += 1
        // Defer the broadcast so concurrent submits each compute their update
        // against the original baseline, mirroring the network-latency reality
        // of a real WebSocket workspace channel.
        this.#deferBroadcast({
          type: 'content.loroUpdate',
          fileId: input.fileId,
          loroUpdateB64: bytesToBase64(input.loroUpdate),
          contentVersionB64: bytesToBase64(this.#doc.contentVersion()),
          originDeviceId: deviceId,
          seq: this.#seq,
        })
        return ack
      },
      subscribe: (fileId, handler) => {
        let bucket = this.#subscribers.get(fileId)
        if (!bucket) {
          bucket = new Set()
          this.#subscribers.set(fileId, bucket)
        }
        bucket.add(handler)
        return () => bucket?.delete(handler)
      },
      fetchSnapshot: async () => this.#doc.exportSnapshot(),
    }
  }

  #broadcast(event: LoroUpdateWireEvent): void {
    const subs = this.#subscribers.get(event.fileId)
    if (!subs) return
    for (const handler of subs) handler(event)
  }

  #deferBroadcast(event: LoroUpdateWireEvent): void {
    queueMicrotask(() => this.#broadcast(event))
  }
}

function makeClient(server: StubRealtimeServer, deviceId: string): LoroRoomClient {
  return new LoroRoomClient({
    fileId: FILE_ID,
    observedPath: PATH,
    deviceId,
    transport: server.transportFor(deviceId),
    newOpId: () => `${deviceId}-${Math.random().toString(36).slice(2)}`,
  })
}

describe('LoroRoomClient', () => {
  it('hydrates from the server snapshot on connect', async () => {
    const seed = LoroFileDoc.empty('# initial')
    const server = new StubRealtimeServer(seed)
    const client = makeClient(server, 'browser-A')
    await client.connect()
    expect(client.getTextContent()).toBe('# initial')
  })

  it('requests a session peer ID before hydrating the local doc', async () => {
    const seed = LoroFileDoc.empty('# initial')
    const server = new StubRealtimeServer(seed)
    const calls: string[] = []
    const transport = server.transportFor('browser-A')
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: {
        assignSessionPeerId: async () => {
          calls.push('peer')
          return transport.assignSessionPeerId!()
        },
        fetchSnapshot: async (fileId) => {
          calls.push('snapshot')
          return transport.fetchSnapshot(fileId)
        },
        subscribe: (fileId, handler) => transport.subscribe(fileId, handler),
        submitUpdate: (input) => transport.submitUpdate(input),
      },
    })

    await client.connect()

    expect(calls).toEqual(['peer', 'snapshot'])
  })

  it('local edits are submitted and reflected in the server canonical state', async () => {
    const seed = LoroFileDoc.empty('one')
    const server = new StubRealtimeServer(seed)
    const client = makeClient(server, 'browser-A')
    await client.connect()
    await client.setTextContent('one two')
    await server.drain()
    expect(server.fileText()).toBe('one two')
  })

  it('two browser clients converge after concurrent edits', async () => {
    const seed = LoroFileDoc.empty('abc')
    const server = new StubRealtimeServer(seed)
    const a = makeClient(server, 'browser-A')
    const b = makeClient(server, 'browser-B')
    await a.connect()
    await b.connect()

    await Promise.all([a.setTextContent('abcA'), b.setTextContent('Babc')])
    await server.drain()

    expect(a.getTextContent()).toBe(b.getTextContent())
    expect(a.getTextContent()).toBe(server.fileText())
    // Both contributions survive concurrent merge.
    expect(a.getTextContent()).toContain('A')
    expect(a.getTextContent()).toContain('B')
  })

  it('exit criteria — two browsers + one daemon converge through the server store', async () => {
    const seed = LoroFileDoc.empty('# Hello\n\nbody')
    const server = new StubRealtimeServer(seed)

    const browserA = makeClient(server, 'browser-A')
    const browserB = makeClient(server, 'browser-B')
    await browserA.connect()
    await browserB.connect()

    // Daemon has its own LoroFileDoc started from the same baseline.
    const daemonDoc = LoroFileDoc.fromSnapshot(server.snapshot())
    const daemonBaseVersion = daemonDoc.contentVersion()
    daemonDoc.setTextContent('# Hello\n\nbody (daemon edit)')
    const daemonUpdate = daemonDoc.exportUpdateSince(daemonBaseVersion)

    // Browser A and Browser B both edit concurrently.
    await Promise.all([
      browserA.setTextContent('# Hello — A\n\nbody'),
      browserB.setTextContent('# Hello\n\nbody — B'),
    ])

    // Daemon submits via its own path (simulating workspace.applyLocalBatch).
    server.applyDaemonUpdate(daemonUpdate, 'daemon-1')
    await server.drain()

    // All three diverge sources should now see the same text.
    expect(browserA.getTextContent()).toBe(server.fileText())
    expect(browserB.getTextContent()).toBe(server.fileText())

    // Sanity: every client's text contains all three contributions.
    const text = server.fileText()
    expect(text).toContain('A')
    expect(text).toContain('B')
    expect(text).toContain('daemon edit')
  })

  it('does not emit remote-update for the client own echo (idempotent import)', async () => {
    const seed = LoroFileDoc.empty('seed')
    const server = new StubRealtimeServer(seed)
    const client = makeClient(server, 'browser-A')
    await client.connect()

    let remoteUpdates = 0
    client.onChange((reason) => {
      if (reason === 'remote-update') remoteUpdates += 1
    })

    await client.setTextContent('seed extra')
    await server.drain()
    expect(remoteUpdates).toBe(0)
    expect(client.getTextContent()).toBe('seed extra')
  })

  it('converges two tabs that share one deviceId (echoes must not be device-filtered)', async () => {
    // Two tabs of one browser profile share localStorage, hence one deviceId,
    // but each WS connection gets its own session peer. Filtering echoes by
    // deviceId silently dropped the OTHER tab's edits (only a snapshot
    // re-fetch ever showed them) — regression test for that.
    const seed = LoroFileDoc.empty('seed ')
    const server = new StubRealtimeServer(seed)
    const tab = (peerId: bigint): LoroRoomClient =>
      new LoroRoomClient({
        fileId: FILE_ID,
        observedPath: PATH,
        deviceId: 'shared-profile-device',
        transport: {
          ...server.transportFor('shared-profile-device'),
          assignSessionPeerId: async () => peerId,
        },
        newOpId: () => `tab${peerId}-${Math.random().toString(36).slice(2)}`,
      })
    const tab1 = tab(101n)
    const tab2 = tab(202n)
    await tab1.connect()
    await tab2.connect()

    let tab2RemoteUpdates = 0
    tab2.onChange((reason) => {
      if (reason === 'remote-update') tab2RemoteUpdates += 1
    })

    await tab1.setTextContent('seed from-tab-1')
    await server.drain()

    expect(tab2RemoteUpdates).toBe(1)
    expect(tab2.getTextContent()).toBe('seed from-tab-1')
  })

  it('throws when used before connect()', async () => {
    const seed = LoroFileDoc.empty('x')
    const server = new StubRealtimeServer(seed)
    const client = makeClient(server, 'browser-A')
    expect(() => client.getTextContent()).toThrow(/not connected/)
    await expect(client.setTextContent('y')).rejects.toThrow(/not connected/)
  })

  it('retransmits from syncedVV after a transport failure instead of swallowing', async () => {
    const seed = LoroFileDoc.empty('start')
    const server = new StubRealtimeServer(seed)
    const transport = server.transportFor('browser-A')
    let failNext = true
    const flaky: LoroRoomTransport = {
      ...transport,
      submitUpdate: async (input) => {
        if (failNext) {
          failNext = false
          throw new Error('network down')
        }
        return transport.submitUpdate(input)
      },
    }
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: flaky,
    })
    await client.connect()

    const reasons: string[] = []
    client.onChange((reason) => reasons.push(reason))

    await client.setTextContent('start edited')
    expect(reasons).toContain('submit-error')
    expect(client.hasPendingChanges()).toBe(true)
    expect(server.fileText()).toBe('start')

    await client.flush()
    await server.drain()
    expect(client.hasPendingChanges()).toBe(false)
    expect(server.fileText()).toBe('start edited')
  })

  it('reuses the same opId when retrying a flight whose ack was lost', async () => {
    const seed = LoroFileDoc.empty('idem')
    const server = new StubRealtimeServer(seed)
    const transport = server.transportFor('browser-A')
    let dropAck = true
    const lossy: LoroRoomTransport = {
      ...transport,
      submitUpdate: async (input) => {
        const result = await transport.submitUpdate(input)
        if (dropAck) {
          dropAck = false
          throw new Error('ack lost')
        }
        return result
      },
    }
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: lossy,
    })
    await client.connect()

    await client.setTextContent('idem edited')
    // Server applied it, but the ack was lost — still pending client-side.
    expect(client.hasPendingChanges()).toBe(true)
    expect(server.fileText()).toBe('idem edited')

    await client.flush()
    expect(client.hasPendingChanges()).toBe(false)
    expect(server.submitLog).toHaveLength(2)
    expect(server.submitLog[0]).toBe(server.submitLog[1])
    expect(server.fileText()).toBe('idem edited')
  })

  it('coalesces edits made while a submit retry is pending into the next flight', async () => {
    const seed = LoroFileDoc.empty('a')
    const server = new StubRealtimeServer(seed)
    const transport = server.transportFor('browser-A')
    let failures = 1
    const flaky: LoroRoomTransport = {
      ...transport,
      submitUpdate: async (input) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('offline')
        }
        return transport.submitUpdate(input)
      },
    }
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: flaky,
    })
    await client.connect()

    await client.setTextContent('a b')
    expect(server.fileText()).toBe('a')

    // Second edit triggers the retry of the first flight, then a second
    // flight carrying the remainder.
    await client.setTextContent('a b c')
    await server.drain()

    expect(client.hasPendingChanges()).toBe(false)
    expect(server.fileText()).toBe('a b c')
  })

  it('suspends auto-submit and surfaces history-pruned deferrals', async () => {
    const seed = LoroFileDoc.empty('pruned')
    const server = new StubRealtimeServer(seed)
    const transport = server.transportFor('browser-A')
    let submits = 0
    const deferring: LoroRoomTransport = {
      ...transport,
      submitUpdate: async () => {
        submits += 1
        const result: SubmitUpdateResult = {
          type: 'deferred',
          reason: 'history-pruned',
          snapshotB64: bytesToBase64(server.snapshot()),
          contentVersionB64: '',
        }
        return result
      },
    }
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: deferring,
    })
    await client.connect()

    const reasons: string[] = []
    client.onChange((reason) => reasons.push(reason))

    await client.setTextContent('pruned edit')
    expect(reasons).toContain('history-pruned')
    expect(client.hasPendingChanges()).toBe(true)

    await client.setTextContent('pruned edit again')
    await client.flush()
    expect(submits).toBe(1)
  })

  it('keeps the flight on rate-limited rejection and retries on flush', async () => {
    const seed = LoroFileDoc.empty('rl')
    const server = new StubRealtimeServer(seed)
    const transport = server.transportFor('browser-A')
    let limited = true
    const attemptedOpIds: string[] = []
    const limiting: LoroRoomTransport = {
      ...transport,
      submitUpdate: async (input) => {
        attemptedOpIds.push(input.opId)
        if (limited) {
          limited = false
          return { type: 'rejected', reason: 'rate-limited', retryAfterSec: 1 }
        }
        return transport.submitUpdate(input)
      },
    }
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: limiting,
    })
    await client.connect()

    await client.setTextContent('rl edited')
    expect(client.hasPendingChanges()).toBe(true)
    expect(server.fileText()).toBe('rl')

    await client.flush()
    expect(client.hasPendingChanges()).toBe(false)
    expect(server.fileText()).toBe('rl edited')
    // Same flight retried under the same opId.
    expect(attemptedOpIds).toHaveLength(2)
    expect(attemptedOpIds[0]).toBe(attemptedOpIds[1])
  })

  it('suspends auto-submit after a permanent too-large rejection', async () => {
    const seed = LoroFileDoc.empty('big')
    const server = new StubRealtimeServer(seed)
    const transport = server.transportFor('browser-A')
    let submits = 0
    const refusing: LoroRoomTransport = {
      ...transport,
      submitUpdate: async () => {
        submits += 1
        return { type: 'rejected', reason: 'too-large' }
      },
    }
    const client = new LoroRoomClient({
      fileId: FILE_ID,
      observedPath: PATH,
      deviceId: 'browser-A',
      transport: refusing,
    })
    await client.connect()

    const reasons: string[] = []
    client.onChange((reason) => reasons.push(reason))

    await client.setTextContent('big edit')
    expect(reasons).toContain('submit-error')
    expect(client.hasPendingChanges()).toBe(true)

    await client.setTextContent('big edit again')
    await client.flush()
    expect(submits).toBe(1)
  })

  it('disconnect releases the subscription', async () => {
    const seed = LoroFileDoc.empty('z')
    const server = new StubRealtimeServer(seed)
    const client = makeClient(server, 'browser-A')
    await client.connect()
    client.disconnect()

    // Daemon edit lands while client is disconnected.
    const doc = LoroFileDoc.fromSnapshot(server.snapshot())
    const v = doc.contentVersion()
    doc.setTextContent('z again')
    server.applyDaemonUpdate(doc.exportUpdateSince(v), 'daemon')

    // Client text should not have updated.
    await client.connect()
    expect(client.getTextContent()).toBe('z again') // freshly hydrated from server
  })
})
