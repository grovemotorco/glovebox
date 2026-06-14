import { createServer, type Server } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws'
import {
  WorkspaceServer,
  verifyWorkspaceToken,
  type WorkspaceConnectionClaims,
  type WorkspaceServerLimits,
  type WorkspaceServerStorage,
  type WorkspaceSocket,
  type WorkspaceSqlStorage,
  type WorkspaceSqlValue,
} from '@glovebox/sync/server'

/**
 * The REAL `WorkspaceServer` core behind a REAL local WebSocket server —
 * the M8 live-socket fixture. Mirrors the production worker/DO split: the
 * HTTP upgrade handler owns token verification (signature, expiry,
 * workspaceId) exactly like `apps/worker`, and `gateConnection` owns the
 * durable checks (auth epoch, deletion). No protocol mocks anywhere — the
 * bytes on this socket are the bytes production would see.
 */

class LiveSqlStorage implements WorkspaceSqlStorage {
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

class LiveStorage implements WorkspaceServerStorage {
  readonly #values = new Map<string, unknown>()
  readonly sql: WorkspaceSqlStorage = new LiveSqlStorage()

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

class LiveSocketShim implements WorkspaceSocket {
  readonly ws: ServerWebSocket
  #attachment: unknown

  constructor(ws: ServerWebSocket) {
    this.ws = ws
  }

  send(data: string): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(data)
    }
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = structuredClone(value)
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.#attachment)
  }
}

export interface LiveWorkspaceHostOptions {
  workspaceId?: string
  /** Set to enable auth: upgrades must carry a valid signed token. */
  authSecret?: string
  now?: () => number
  limits?: Partial<WorkspaceServerLimits>
}

export class LiveWorkspaceHost {
  readonly workspaceId: string
  readonly server: WorkspaceServer
  readonly #authSecret: string | undefined
  readonly #now: () => number
  readonly #shims = new Set<LiveSocketShim>()
  #http: Server | null = null
  #wss: WebSocketServer | null = null
  #port: number | null = null
  /** Total accepted WS connections — tests assert reconnect behavior on it. */
  acceptedConnections = 0
  /** Message types to swallow (request left unanswered) — close-window tests. */
  readonly holdTypes = new Set<string>()
  /** Raw text of swallowed messages, in arrival order. */
  readonly heldMessages: string[] = []

  constructor(options: LiveWorkspaceHostOptions = {}) {
    this.workspaceId = options.workspaceId ?? 'ws-live'
    this.#authSecret = options.authSecret
    this.#now = options.now ?? (() => Date.now())
    const storage = new LiveStorage()
    this.server = new WorkspaceServer({
      storage,
      sql: storage.sql,
      getSockets: () => [...this.#shims],
      requireAuth: Boolean(this.#authSecret),
      now: this.#now,
      limits: options.limits,
    })
  }

  get port(): number {
    if (this.#port === null) {
      throw new Error('host not started')
    }
    return this.#port
  }

  /** ws:// URL for this host's workspace endpoint (append ?token=…). */
  wsUrl(token?: string): string {
    const base = `ws://127.0.0.1:${this.port}/ws/${this.workspaceId}`
    return token ? `${base}?token=${encodeURIComponent(token)}` : base
  }

  async start(): Promise<this> {
    const http = createServer((_, res) => {
      res.writeHead(426).end('Expected WebSocket')
    })
    const wss = new WebSocketServer({ noServer: true })
    this.#http = http
    this.#wss = wss

    http.on('upgrade', (request, socket, head) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname !== `/ws/${this.workspaceId}`) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }

        // Worker's share: signature, expiry, workspaceId (apps/worker model).
        let claims: WorkspaceConnectionClaims | null = null
        if (this.#authSecret) {
          const token = url.searchParams.get('token')
          const verified = token
            ? await verifyWorkspaceToken(token, this.#authSecret, this.#now())
            : null
          if (!verified || verified.workspaceId !== this.workspaceId) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
            socket.destroy()
            return
          }
          claims = {
            principalId: verified.principalId,
            principalType: verified.principalType,
            role: verified.role,
            owner: verified.owner,
            epoch: verified.epoch,
          }
        }

        // DO's share: durable auth epoch + deletion flag.
        const gate = await this.server.gateConnection(claims)
        if (!gate.ok) {
          socket.write(`HTTP/1.1 ${gate.status} ${gate.reason}\r\n\r\n`)
          socket.destroy()
          return
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          this.acceptedConnections += 1
          const shim = new LiveSocketShim(ws)
          this.#shims.add(shim)
          const ready = this.server.handleConnect(shim, gate.claims)
          ws.on('message', (data) => {
            const text = typeof data === 'string' ? data : (data as Buffer).toString('utf-8')
            if (this.#shouldHold(text)) {
              return
            }
            void ready.then(() => this.server.handleMessage(shim, text))
          })
          ws.on('close', () => {
            this.#shims.delete(shim)
          })
        })
      })()
    })

    await new Promise<void>((resolve) => {
      http.listen(0, '127.0.0.1', resolve)
    })
    const address = http.address()
    if (!address || typeof address === 'string') {
      throw new Error('failed to bind live host')
    }
    this.#port = address.port
    return this
  }

  /** Close every live connection from the server side with a given code. */
  closeAll(code: number, reason: string): void {
    for (const shim of this.#shims) {
      shim.close(code, reason)
    }
  }

  /** Bump the durable auth epoch and close the named principals (4403). */
  async revoke(principalIds: readonly string[]): Promise<void> {
    await this.server.bumpAuthEpoch()
    this.server.recheckPrincipals(principalIds)
  }

  async stop(): Promise<void> {
    for (const shim of this.#shims) {
      shim.ws.terminate()
    }
    this.#shims.clear()
    await new Promise<void>((resolve) => {
      this.#wss?.close(() => resolve())
    })
    await new Promise<void>((resolve, reject) => {
      if (!this.#http) {
        resolve()
        return
      }
      this.#http.close((error) => (error ? reject(error) : resolve()))
    })
    this.#http = null
    this.#wss = null
  }

  #shouldHold(text: string): boolean {
    if (this.holdTypes.size === 0) {
      return false
    }
    try {
      const parsed = JSON.parse(text) as { type?: unknown }
      const held = typeof parsed.type === 'string' && this.holdTypes.has(parsed.type)
      if (held) {
        this.heldMessages.push(text)
      }
      return held
    } catch {
      return false
    }
  }
}
