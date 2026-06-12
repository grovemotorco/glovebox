import { DurableObject } from 'cloudflare:workers'
import { WorkspaceServer, type WorkspaceConnectionClaims } from '@glovebox/sync/server'

const CLAIMS_HEADER = 'x-glovebox-claims'
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000

interface Env {
  WS_AUTH_SECRET?: string
}

/**
 * Thin Cloudflare shell over the transport-agnostic `WorkspaceServer` core.
 * Connection state lives in socket attachments and counters in durable
 * storage, so hibernation/eviction never resets peer IDs or `seq` (INV-7).
 * The worker verifies connection tokens and forwards trusted claims; this
 * shell routes them through the core's epoch/deletion gate.
 */
export class WorkspaceDO extends DurableObject<Env> {
  readonly #server = new WorkspaceServer({
    storage: this.ctx.storage,
    sql: this.ctx.storage.sql,
    getSockets: () => this.ctx.getWebSockets(),
    transactionSync: (closure) => this.ctx.storage.transactionSync(closure),
    requireAuth: Boolean(this.env.WS_AUTH_SECRET),
  })

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return this.#handleAdmin(request)
    }
    await this.#ensureMaintenanceAlarm()

    const gate = await this.#server.gateConnection(parseClaims(request.headers.get(CLAIMS_HEADER)))
    if (!gate.ok) {
      return new Response(gate.reason, { status: gate.status })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    await this.#server.handleConnect(server, gate.claims)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#server.handleMessage(ws, message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.#server.handleDisconnect(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#server.handleDisconnect(ws)
  }

  /**
   * Hourly maintenance: recovery-record pruning and the spec-§3.4 shallow
   * trim pass. The alarm arms on the first connection and reschedules
   * itself; hibernation wakes the DO for it.
   */
  override async alarm(): Promise<void> {
    await this.#server.runMaintenance()
    await this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_INTERVAL_MS)
  }

  async #ensureMaintenanceAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_INTERVAL_MS)
    }
  }

  async #handleAdmin(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === 'POST' && path.endsWith('/text/tree')) {
      const tree = await this.#server.listTree()
      return Response.json({ ok: true, ...tree })
    }
    if (request.method === 'POST' && path.endsWith('/text/read')) {
      const payload = (await request.json().catch(() => null)) as { fileId?: unknown } | null
      if (typeof payload?.fileId !== 'string') {
        return Response.json({ ok: false, error: 'fileId required' }, { status: 400 })
      }
      const file = await this.#server.readTextFile(payload.fileId)
      return Response.json({ ok: true, file })
    }
    if (request.method === 'POST' && path.endsWith('/text/push')) {
      const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (
        !payload ||
        typeof payload.fileId !== 'string' ||
        typeof payload.newText !== 'string' ||
        typeof payload.baseHashHex !== 'string'
      ) {
        return Response.json({ ok: false, error: 'invalid text/push body' }, { status: 400 })
      }
      const result = await this.#server.pushText({
        fileId: payload.fileId,
        newText: payload.newText,
        baseHashHex: payload.baseHashHex,
        baseText: typeof payload.baseText === 'string' ? payload.baseText : undefined,
        force: payload.force === true,
        idempotencyKey:
          typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined,
        modifiedBy: typeof payload.modifiedBy === 'string' ? payload.modifiedBy : undefined,
      })
      return Response.json({ ok: true, result })
    }
    if (request.method === 'POST' && path.endsWith('/recovery/list')) {
      const payload = (await request.json().catch(() => null)) as {
        pendingOnly?: unknown
      } | null
      const records = this.#server.listRecoveryRecords({
        pendingOnly: payload?.pendingOnly === true,
      })
      return Response.json({ ok: true, records })
    }
    if (request.method === 'POST' && path.endsWith('/recovery/acknowledge')) {
      const payload = (await request.json().catch(() => null)) as {
        recordId?: unknown
      } | null
      if (typeof payload?.recordId !== 'string') {
        return Response.json({ ok: false, error: 'recordId required' }, { status: 400 })
      }
      const acknowledged = this.#server.acknowledgeRecoveryRecord(payload.recordId)
      return Response.json({ ok: true, acknowledged })
    }
    if (request.method === 'POST' && path.endsWith('/recheck')) {
      const payload = (await request.json().catch(() => null)) as {
        principalIds?: unknown
      } | null
      const ids = Array.isArray(payload?.principalIds)
        ? payload.principalIds.filter((id): id is string => typeof id === 'string')
        : []
      await this.#server.bumpAuthEpoch()
      const closed = this.#server.recheckPrincipals(ids)
      return Response.json({ ok: true, closed })
    }
    if (request.method === 'POST' && path.endsWith('/deleted')) {
      await this.#server.markWorkspaceDeleted()
      return Response.json({ ok: true })
    }
    return new Response('Expected WebSocket', { status: 426 })
  }
}

function parseClaims(header: string | null): WorkspaceConnectionClaims | null {
  if (!header) return null
  try {
    const value = JSON.parse(header) as Partial<WorkspaceConnectionClaims>
    if (
      typeof value.principalId === 'string' &&
      (value.principalType === 'human' || value.principalType === 'agent') &&
      (value.role === 'viewer' || value.role === 'commenter' || value.role === 'editor') &&
      typeof value.owner === 'boolean' &&
      typeof value.epoch === 'number'
    ) {
      return {
        principalId: value.principalId,
        principalType: value.principalType,
        role: value.role,
        owner: value.owner,
        epoch: value.epoch,
      }
    }
  } catch {
    // Malformed header — treat as unauthenticated.
  }
  return null
}
