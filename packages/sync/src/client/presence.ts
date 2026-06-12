import { EphemeralStore } from 'loro-crdt'
import type { WorkspacePresenceEntry } from '../server/workspace-server.ts'

/**
 * Client side of workspace presence (spec §5.1 "Presence via Loro
 * `EphemeralStore`"). The server owns the authoritative store: it stamps
 * identity (`principalId`, `principalType`) from the connection claims and
 * keys entries by the server-minted session peer ID, so nothing here can
 * impersonate another principal. This class mirrors that store locally:
 * it applies `presence.update` broadcast bytes, seeds itself from a
 * `presence.get`, and republishes the local state on a heartbeat below the
 * server's entry timeout so liveness self-heals across DO evictions.
 */

export interface WorkspacePresencePeer {
  /** Presence key — the publishing connection's server-minted peer ID. */
  key: string
  principalId: string
  principalType: 'human' | 'agent'
  /** Publisher-supplied display state (cursor, name, color, …). Untrusted. */
  state: unknown
}

/**
 * Live presence traffic: `presence.update` store bytes to apply, or a
 * `presence.leave` key to delete locally (an explicit signal because the
 * store's delete tombstone loses same-millisecond LWW ties).
 */
export type WorkspacePresenceWireEvent =
  | { type: 'update'; data: Uint8Array }
  | { type: 'leave'; key: string }

export interface WorkspacePresenceTransport {
  /** Fire-and-forget `presence.set`. */
  sendPresence(stateJson: string): void
  /** `presence.get` — resolves with the server's full `encodeAll` bytes. */
  fetchPresenceState(): Promise<Uint8Array>
  /** Live presence broadcasts, in socket order. */
  subscribePresence(handler: (event: WorkspacePresenceWireEvent) => void): () => void
}

export interface WorkspacePresenceOptions {
  transport: WorkspacePresenceTransport
  /**
   * Republish interval for the local state. Must stay below the server's
   * presence timeout (default 30s) or this client flickers out of every
   * peer's view between heartbeats. Default 20s.
   */
  heartbeatMs?: number
  /** Local entry expiry; mirrors the server store's timeout. Default 30s. */
  timeoutMs?: number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export class WorkspacePresence {
  readonly #transport: WorkspacePresenceTransport
  readonly #store: EphemeralStore
  readonly #heartbeatMs: number
  readonly #setInterval: (callback: () => void, ms: number) => unknown
  readonly #clearInterval: (handle: unknown) => void
  readonly #listeners = new Set<() => void>()
  /** Retained so the store subscription is never GC'd. */
  readonly #storeSubscription: () => void
  #unsubscribeTransport: (() => void) | null = null
  #heartbeat: unknown = null
  #localStateJson: string | null = null
  #stopped = false

  constructor(options: WorkspacePresenceOptions) {
    this.#transport = options.transport
    this.#store = new EphemeralStore(options.timeoutMs ?? 30_000)
    this.#heartbeatMs = options.heartbeatMs ?? 20_000
    this.#setInterval = options.setInterval ?? ((callback, ms) => setInterval(callback, ms))
    this.#clearInterval = options.clearInterval ?? ((handle) => clearInterval(handle as number))
    this.#storeSubscription = this.#store.subscribe(() => this.#notify())
  }

  /**
   * Subscribe to live updates, then seed from the server's full state.
   * Subscription comes first so an update racing the seed is never lost
   * (the store's timestamp LWW makes the overlap harmless).
   */
  async start(): Promise<void> {
    if (this.#stopped) throw new Error('WorkspacePresence is stopped')
    this.#unsubscribeTransport ??= this.#transport.subscribePresence((event) => {
      if (event.type === 'update') this.#store.apply(event.data)
      else this.#store.delete(event.key)
    })
    const seed = await this.#transport.fetchPresenceState()
    if (seed.byteLength > 0) this.#store.apply(seed)
  }

  /**
   * Publish this connection's display state. The value is rebroadcast on a
   * heartbeat so the entry survives both store timeouts and server-side
   * presence loss (DO eviction). Callers throttle rapid updates (cursor
   * moves) themselves — every call here is a wire message.
   */
  setLocalState(state: unknown): void {
    this.#localStateJson = JSON.stringify(state)
    this.#transport.sendPresence(this.#localStateJson)
    if (this.#heartbeat === null && !this.#stopped) {
      this.#heartbeat = this.#setInterval(() => {
        if (this.#localStateJson !== null) this.#transport.sendPresence(this.#localStateJson)
      }, this.#heartbeatMs)
    }
  }

  /** Current peers (including this connection once its echo arrives). */
  peers(): WorkspacePresencePeer[] {
    const states = this.#store.getAllStates() as Record<string, unknown>
    const peers: WorkspacePresencePeer[] = []
    for (const [key, value] of Object.entries(states)) {
      const entry = parsePresenceEntry(value)
      if (entry) peers.push({ key, ...entry })
    }
    return peers
  }

  /** Notified whenever the peer set or any peer's state changes. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#heartbeat !== null) {
      this.#clearInterval(this.#heartbeat)
      this.#heartbeat = null
    }
    this.#unsubscribeTransport?.()
    this.#unsubscribeTransport = null
    this.#storeSubscription()
    this.#store.destroy()
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
}

/** Server-stamped entries are trusted in shape, but never assume the wire. */
function parsePresenceEntry(value: unknown): WorkspacePresenceEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Partial<WorkspacePresenceEntry>
  if (typeof entry.principalId !== 'string') return null
  if (entry.principalType !== 'human' && entry.principalType !== 'agent') return null
  return { principalId: entry.principalId, principalType: entry.principalType, state: entry.state }
}
