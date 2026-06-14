import { afterEach, describe, expect, it } from 'vitest'
import { LoroFileDoc } from '@glovebox/sync/loro'
import { signWorkspaceToken } from '@glovebox/sync/server'
import { WsDaemonTransport, type WsTransportStopReason } from '@glovebox/sync/daemon'
import type { SubmitUpdateInput } from '@glovebox/sync/loro'
import { LiveWorkspaceHost, type LiveWorkspaceHostOptions } from '../src/live/live-server.ts'

/**
 * M8 WsDaemonTransport against the REAL WorkspaceServer core behind a REAL
 * local WebSocket server — no protocol mocks. Covers the full mapping
 * (requestId/opId correlation), in-flight rejection + idempotent
 * retransmission, the close-code policy (4401 re-auth, 4403/4410 terminal),
 * broadcast hints, and backoff scheduling.
 */

const hosts: LiveWorkspaceHost[] = []
const transports: WsDaemonTransport[] = []

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    transport.stop()
  }
  for (const host of hosts.splice(0)) {
    await host.stop()
  }
})

async function startHost(options?: LiveWorkspaceHostOptions): Promise<LiveWorkspaceHost> {
  const host = await new LiveWorkspaceHost(options).start()
  hosts.push(host)
  return host
}

function makeTransport(
  options: ConstructorParameters<typeof WsDaemonTransport>[0],
): WsDaemonTransport {
  const transport = new WsDaemonTransport({
    backoffInitialMs: 10,
    backoffMaxMs: 50,
    ...options,
  })
  transports.push(transport)
  return transport
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** A valid one-edit submit for fileId, derived from a fresh server snapshot. */
async function buildSubmit(
  transport: WsDaemonTransport,
  fileId: string,
  path: string,
  text: string,
  opId: string,
): Promise<SubmitUpdateInput> {
  const snapshot = await transport.fetchSnapshot(fileId, undefined, path)
  const doc = LoroFileDoc.fromSnapshot(snapshot)
  const base = doc.contentVersion()
  doc.setTextContent(text)
  return {
    fileId,
    opId,
    observedPath: path,
    baseContentVersion: base,
    loroUpdate: doc.exportUpdateSince(base),
  }
}

describe('WsDaemonTransport over a live socket', () => {
  it('round-trips snapshot.get, content.submit, events.since, batch.submit', async () => {
    const host = await startHost()
    const transport = makeTransport({ url: () => host.wsUrl() })

    const snapshot = await transport.fetchSnapshot('f1', 'hello\n', 'notes/a.md')
    const doc = LoroFileDoc.fromSnapshot(snapshot)
    expect(doc.getTextContent()).toBe('hello\n')

    const base = doc.contentVersion()
    doc.setTextContent('hello\nworld\n')
    const ack = await transport.submitUpdate({
      fileId: 'f1',
      opId: 'op-1',
      observedPath: 'notes/a.md',
      baseContentVersion: base,
      loroUpdate: doc.exportUpdateSince(base),
    })
    expect(ack.type).toBe('ack')

    const events = await transport.eventsSince(0)
    if (!events.ok) {
      throw new Error('expected events.batch')
    }
    expect(events.events.map((event) => event.type)).toEqual(['create', 'content.loroUpdate'])

    const batch = await transport.submitBatch([
      {
        type: 'file.rename',
        opId: 'op-2',
        fileId: 'f1',
        baseSeq: events.currentSeq,
        fromPath: 'notes/a.md',
        toPath: 'notes/b.md',
      },
    ])
    if (batch.type !== 'ack') {
      throw new Error('expected batch.ack')
    }
    expect(batch.acceptedOps).toHaveLength(1)
    expect(batch.deferredOps).toHaveLength(0)

    const verify = LoroFileDoc.fromSnapshot(await transport.fetchSnapshot('f1'))
    expect(verify.getTextContent()).toBe('hello\nworld\n')
  })

  it('correlates interleaved concurrent requests by requestId', async () => {
    const host = await startHost()
    const transport = makeTransport({ url: () => host.wsUrl() })

    await transport.fetchSnapshot('a', 'AAA\n', 'a.md')
    await transport.fetchSnapshot('b', 'BBB\n', 'b.md')

    const [snapA, snapB, eventsAll, eventsTail] = await Promise.all([
      transport.fetchSnapshot('a'),
      transport.fetchSnapshot('b'),
      transport.eventsSince(0),
      transport.eventsSince(1),
    ])
    expect(LoroFileDoc.fromSnapshot(snapA).getTextContent()).toBe('AAA\n')
    expect(LoroFileDoc.fromSnapshot(snapB).getTextContent()).toBe('BBB\n')
    if (!eventsAll.ok || !eventsTail.ok) {
      throw new Error('expected events batches')
    }
    expect(eventsAll.events).toHaveLength(2)
    expect(eventsTail.events).toHaveLength(1)
  })

  it('replays the original ack for a duplicate opId without re-applying', async () => {
    const host = await startHost()
    const transport = makeTransport({ url: () => host.wsUrl() })

    const input = await buildSubmit(transport, 'f1', 'notes/a.md', 'one edit\n', 'op-dup')
    const first = await transport.submitUpdate(input)
    const second = await transport.submitUpdate(input)
    expect(first).toEqual(second)

    const events = await transport.eventsSince(0)
    if (!events.ok) {
      throw new Error('expected events.batch')
    }
    expect(events.events.filter((event) => event.type === 'content.loroUpdate')).toHaveLength(1)
  })

  it('rejects in-flight requests on close; same-opId retransmit converges', async () => {
    const host = await startHost()
    const transport = makeTransport({ url: () => host.wsUrl() })

    const input = await buildSubmit(transport, 'f1', 'notes/a.md', 'edited\n', 'op-flight')

    // Swallow the submit server-side, then drop the connection: the flight
    // is now outcome-unknown and must reject.
    host.holdTypes.add('content.submit')
    const flight = transport.submitUpdate(input)
    await until(() => host.heldMessages.length === 1)
    host.closeAll(1012, 'service restart')
    await expect(flight).rejects.toThrow(/socket closed \(1012/)

    // Engine behavior: retransmit the byte-identical flight under the same
    // opId. The transport reconnects on demand; the server applies once.
    host.holdTypes.clear()
    const retry = await transport.submitUpdate(input)
    expect(retry.type).toBe('ack')

    const events = await transport.eventsSince(0)
    if (!events.ok) {
      throw new Error('expected events.batch')
    }
    expect(events.events.filter((event) => event.type === 'content.loroUpdate')).toHaveLength(1)
    const verify = LoroFileDoc.fromSnapshot(await transport.fetchSnapshot('f1'))
    expect(verify.getTextContent()).toBe('edited\n')
  })

  it('surfaces broadcasts as hints and subscribeEvents deliveries', async () => {
    const host = await startHost()
    const hintTypes: string[] = []
    const subscribed: string[] = []
    const listener = makeTransport({
      url: () => host.wsUrl(),
      onHint: (event) => hintTypes.push(event.type),
    })
    listener.subscribeEvents((event) => subscribed.push(event.type))
    await listener.connect()

    const writer = makeTransport({ url: () => host.wsUrl() })
    await writer.submitUpdate(
      await buildSubmit(writer, 'f1', 'notes/a.md', 'broadcast me\n', 'op-b'),
    )

    await until(() => hintTypes.includes('content.loroUpdate'))
    expect(hintTypes).toContain('create')
    expect(subscribed).toEqual(hintTypes)
  })

  it('4403 access-revoked is terminal: stops, reports, never reconnects', async () => {
    const secret = 's3cret'
    const host = await startHost({ authSecret: secret })
    const token = await signWorkspaceToken(
      {
        workspaceId: host.workspaceId,
        principalId: 'device-a',
        principalType: 'agent',
        role: 'editor',
        owner: false,
        epoch: 0,
        exp: Date.now() + 60_000,
      },
      secret,
    )
    const stops: [WsTransportStopReason, number][] = []
    const transport = makeTransport({
      url: () => host.wsUrl(token),
      onStopped: (reason, code) => stops.push([reason, code]),
    })
    await transport.connect()
    expect(host.acceptedConnections).toBe(1)

    await host.revoke(['device-a'])
    await until(() => stops.length === 1)
    expect(stops[0]).toEqual(['access-revoked', 4403])
    expect(transport.stopped).toBe(true)
    await expect(transport.fetchSnapshot('f1')).rejects.toThrow('transport stopped')

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.acceptedConnections).toBe(1)
  })

  it('4410 workspace-deleted is terminal', async () => {
    const host = await startHost()
    const stops: [WsTransportStopReason, number][] = []
    const transport = makeTransport({
      url: () => host.wsUrl(),
      onStopped: (reason, code) => stops.push([reason, code]),
    })
    await transport.connect()

    await host.server.markWorkspaceDeleted()
    await until(() => stops.length === 1)
    expect(stops[0]).toEqual(['workspace-deleted', 4410])
    expect(transport.stopped).toBe(true)
  })

  it('4401 fires onAuthRequired and recovers through a fresh url()', async () => {
    const host = await startHost()
    const authEvents: string[] = []
    let urlCalls = 0
    const transport = makeTransport({
      url: () => {
        urlCalls += 1
        return host.wsUrl()
      },
      onAuthRequired: (reason) => authEvents.push(reason),
    })
    await transport.connect()

    host.closeAll(4401, 'unauthenticated')
    await until(() => authEvents.length === 1)
    expect(transport.stopped).toBe(false)

    const snapshot = await transport.fetchSnapshot('f1', 'recovered\n', 'r.md')
    expect(LoroFileDoc.fromSnapshot(snapshot).getTextContent()).toBe('recovered\n')
    expect(urlCalls).toBeGreaterThanOrEqual(2)
  })

  it('recovers from an HTTP-refused upgrade once the token is re-minted', async () => {
    const secret = 's3cret'
    const host = await startHost({ authSecret: secret })
    let token = 'garbage-token'
    const transport = makeTransport({ url: () => host.wsUrl(token) })

    await expect(transport.fetchSnapshot('f1')).rejects.toThrow()

    token = await signWorkspaceToken(
      {
        workspaceId: host.workspaceId,
        principalId: 'device-a',
        principalType: 'agent',
        role: 'editor',
        owner: false,
        epoch: 0,
        exp: Date.now() + 60_000,
      },
      secret,
    )
    const snapshot = await transport.fetchSnapshot('f1', 'minted\n', 'm.md')
    expect(LoroFileDoc.fromSnapshot(snapshot).getTextContent()).toBe('minted\n')
  })

  it('schedules exponential backoff with jitter inside [base/2, base]', async () => {
    const delays: number[] = []
    const timerCallbacks: (() => void)[] = []
    const transport = makeTransport({
      url: () => 'ws://127.0.0.1:1/ws/nowhere',
      random: () => 1,
      backoffInitialMs: 100,
      backoffMaxMs: 400,
      setTimer: (callback, delayMs) => {
        delays.push(delayMs)
        timerCallbacks.push(callback)
        return delays.length
      },
      clearTimer: () => {},
    })

    await expect(transport.fetchSnapshot('f1')).rejects.toThrow()
    await until(() => delays.length === 1)

    for (const expected of [2, 3, 4]) {
      timerCallbacks.shift()!()
      await until(() => delays.length === expected)
    }
    // random()=1 pins each delay at its base: 100, 200, 400, then capped.
    expect(delays).toEqual([100, 200, 400, 400])
  })
})

describe('WsDaemonTransport failure-model hardening (review findings)', () => {
  it('a validation error reply rejects the flight instead of hanging it', async () => {
    const host = await startHost()
    const transport = makeTransport({ url: () => host.wsUrl() })

    // initialContent over the server's 1 MiB cap: parseClientMessage throws,
    // the server answers {type:'error'} — correlated by best-effort
    // requestId extraction. Without rejection this flight would hang on a
    // healthy socket and wedge the runner's serialized cycle queue forever.
    const oversized = 'x'.repeat(1_048_577)
    await expect(transport.fetchSnapshot('big', oversized, 'big.md')).rejects.toThrow(
      /server error/,
    )

    // The socket stayed healthy and later requests work.
    const snapshot = await transport.fetchSnapshot('ok', 'fine\n', 'ok.md')
    expect(LoroFileDoc.fromSnapshot(snapshot).getTextContent()).toBe('fine\n')
  })

  it('an uncorrelatable error reply rejects opId-keyed submits too', async () => {
    const host = await startHost({ limits: { maxUpdateBytes: 1024, maxOpaqueBytes: 1024 } })
    const transport = makeTransport({ url: () => host.wsUrl() })
    await transport.fetchSnapshot('f1', 'seed\n', 'notes/a.md')

    // content.submit carries an opId, never a requestId — a validation
    // throw for it is uncorrelatable, so the transport must fail ALL
    // flights (outcome-unknown; retransmission is idempotent).
    const oversizedUpdate = new Uint8Array(3 * 1024 * 1024)
    await expect(
      transport.submitUpdate({
        fileId: 'f1',
        opId: 'op-too-big',
        observedPath: 'notes/a.md',
        baseContentVersion: new Uint8Array(),
        loroUpdate: oversizedUpdate,
      }),
    ).rejects.toThrow(/server error/)

    const snapshot = await transport.fetchSnapshot('f1')
    expect(LoroFileDoc.fromSnapshot(snapshot).getTextContent()).toBe('seed\n')
  })

  it('4403 close on an open server never reconnects (falsifiable)', async () => {
    // No-auth host: the server would happily ACCEPT a reconnect, so a
    // transport that lost its terminal-stop guard would show up in
    // acceptedConnections — unlike the revoke() test, where the bumped
    // epoch refuses upgrades regardless of client behavior.
    const host = await startHost()
    const stops: [WsTransportStopReason, number][] = []
    const transport = makeTransport({
      url: () => host.wsUrl(),
      onStopped: (reason, code) => stops.push([reason, code]),
    })
    await transport.connect()
    expect(host.acceptedConnections).toBe(1)

    host.closeAll(4403, 'access-revoked')
    await until(() => stops.length === 1)
    await expect(transport.fetchSnapshot('f1')).rejects.toThrow('transport stopped')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(host.acceptedConnections).toBe(1)
  })

  it('stop() during an in-flight handshake closes the socket and rejects', async () => {
    class FakeSocket {
      static readonly OPEN = 1
      static instances: FakeSocket[] = []
      readyState = 0
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      onmessage: unknown = null
      closedWith: number | null = null
      constructor() {
        FakeSocket.instances.push(this)
      }
      send(): void {}
      close(code?: number): void {
        this.closedWith = code ?? 1000
      }
      open(): void {
        this.readyState = 1
        this.onopen?.()
      }
    }

    const transport = makeTransport({
      url: () => 'ws://fake/',
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    })
    const connecting = transport.connect()
    transport.stop() // Lands while the handshake is in flight (socket not even constructed yet).
    await until(() => FakeSocket.instances.length === 1)
    FakeSocket.instances[0]!.open() // Handshake completes AFTER stop().

    await expect(connecting).rejects.toThrow('transport stopped')
    expect(FakeSocket.instances[0]!.closedWith).toBe(1000)
  })

  it('a url() failure keeps the background reconnect chain alive', async () => {
    const host = await startHost()
    const delays: number[] = []
    const timerCallbacks: (() => void)[] = []
    let failUrl = false
    let urlCalls = 0
    const transport = makeTransport({
      url: () => {
        urlCalls += 1
        if (failUrl) {
          throw new Error('no credentials right now')
        }
        return host.wsUrl()
      },
      random: () => 1,
      backoffInitialMs: 50,
      setTimer: (callback, delayMs) => {
        delays.push(delayMs)
        timerCallbacks.push(callback)
        return delays.length
      },
      clearTimer: () => {},
    })
    await transport.connect()

    // Server drops the connection → a reconnect timer is scheduled.
    failUrl = true
    host.closeAll(1012, 'restart')
    await until(() => delays.length === 1)

    // The timer fires into a url() failure — the chain must re-arm
    // (before the fix, the rejection escaped the failure path and all
    // reconnect state ended up null).
    timerCallbacks.shift()!()
    await until(() => delays.length === 2)
    expect(urlCalls).toBeGreaterThanOrEqual(2)

    // Credentials come back; the next firing reconnects for real.
    failUrl = false
    timerCallbacks.shift()!()
    await until(() => host.acceptedConnections === 2)
  })
})
