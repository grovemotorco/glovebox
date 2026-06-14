import {
  LIMITS,
  type OpaqueManifest,
  type WorkspaceChangeEvent,
  type WorkspaceTreeEntry,
} from '@glovebox/core'
import { EphemeralStore } from 'loro-crdt'
import { LoroFileDoc, versionDominates } from '../loro/file-doc.ts'
import { LoroFileService, LoroFileTooLargeError } from '../loro/file-store.ts'
import type { LoroFileImportResult } from '../loro/types.ts'
import { base64ToBytes, bytesToBase64 } from '../loro/base64.ts'
import { parseClientMessage, type IngressLimits } from './validate.ts'
import { decideSubmitWindow, type SubmitWindowDecision } from './ratelimit.ts'
import { TrimCoordinator, type TrimPolicy } from './trim.ts'
import { computeMergedTarget, DEGENERATE_DELETE_RATIO, TextBaseCache } from './text-merge.ts'
import { normalizeEol } from '../fs/eol.ts'
import { WorkspaceEventLog } from './event-log.ts'
import { SqliteLoroFileStore } from './sqlite-loro-store.ts'
import { WorkspaceRecoveryStore } from './recovery-store.ts'
import { getSuffixedPath, WorkspaceStore, type WorkspaceSqlStorageLike } from './workspace-store.ts'
import {
  WorkspaceBatchApplier,
  type BatchApplierLoroStore,
  type BatchAcceptedOp,
  type BatchDeferredOp,
  type LocalSyncOp,
} from './workspace-batch-applier.ts'
import { WorkspaceIdempotencyStore } from './batch-idempotency-store.ts'
import { isMarkdownFile } from '../fs/file-kind.ts'
import { sha256Hex } from './hash.ts'
import {
  mkdir,
  Database as DofsDatabase,
  initializeSchema,
  readRangeSync,
  ROOT_INODE,
  rm as dofsRm,
  stat as dofsStat,
  WorkspaceFilesystem,
  writeFileSync,
  type SQLStorageLike,
} from '@glovebox/dofs'
import {
  assembleOpaqueWirePayload,
  buildOpaqueWirePayload,
  contentRefFromPayload,
  OPAQUE_CHUNK_SIZE,
  type OpaqueObjectPayload,
  type OpaqueWirePayload,
} from '../opaque-wire.ts'

/**
 * Structural (tree-level) ops on the wire. Content stays on `content.submit`
 * (its M0 hardening — ack replay, size caps, history-pruned defers — must not
 * regress); `batch.submit` carries only what the batch applier's policy
 * adjudicates: renames and delete intents with per-op `baseSeq` (INV-3
 * stale-baseSeq rejection happens server-side in the applier).
 */
export type WorkspaceBatchWireOp =
  | {
      type: 'file.rename'
      opId: string
      fileId: string
      baseSeq: number
      fromPath: string
      toPath: string
    }
  | { type: 'file.deleteIntent'; opId: string; fileId: string; baseSeq: number; path: string }

export type WorkspaceClientMessage =
  | { type: 'hello'; deviceId?: string }
  | {
      type: 'snapshot.get'
      requestId: string
      fileId: string
      initialContent?: string
      /** Tree path for first-create registration (defaults to `<fileId>.md`). */
      observedPath?: string
    }
  /** Replay workspace events after a seq cursor (the pull path). */
  | { type: 'events.since'; requestId: string; afterSeq: number }
  /**
   * Full live tree + current seq watermark in one response. The daemon's
   * adoption step (ISSUE-0044) binds disk files to existing fileIds by
   * path from this listing — `events.since(0)` cannot serve it once any
   * history is pruned (bounded replay window).
   */
  | { type: 'tree.list'; requestId: string }
  /**
   * Current opaque bytes for one file (the opaque analog of snapshot.get,
   * minus the create surface — an unknown fileId is simply not found).
   */
  | {
      type: 'opaque.get'
      requestId: string
      fileId: string
      haveObjects?: string[]
      metadataOnly?: boolean
    }
  | { type: 'batch.submit'; requestId: string; ops: WorkspaceBatchWireOp[] }
  /**
   * Opaque (non-markdown) file write through the dofs chunk store.
   * `baseHashHex` is the watermark of the version the writer based its
   * bytes on ('' = expecting to create). Last writer wins; on a stale
   * watermark the overwritten server content is preserved as a recovery
   * record (INV-2).
   */
  | {
      type: 'opaque.submit'
      fileId: string
      observedPath: string
      opId: string
      baseHashHex: string
      hashHex: string
      sizeBytes: number
      manifest: OpaqueManifest
      objects: OpaqueObjectPayload[]
    }
  | {
      type: 'content.submit'
      fileId: string
      observedPath: string
      opId: string
      baseContentVersionB64: string
      loroUpdateB64: string
    }
  /**
   * Publish this connection's presence state (cursor, display name, …).
   * `stateJson` is an opaque, size-capped JSON value — presence identity
   * (`principalId`, `principalType`) is stamped server-side from the
   * connection claims and can never be client-asserted. Read-only roles may
   * publish: presence is ephemeral, not a content mutation.
   */
  | { type: 'presence.set'; stateJson: string }
  /** Fetch the full current presence state (late-joiner seed). */
  | { type: 'presence.get'; requestId: string }

export type WorkspaceServerMessage =
  | { type: 'ready'; sessionPeerId: string }
  | {
      type: 'snapshot.response'
      requestId: string
      fileId: string
      snapshotB64: string
      contentVersionB64: string
    }
  | { type: 'ack'; opId: string; fileId: string; contentVersionB64: string; applied: boolean }
  /**
   * The op could not be applied because its `baseContentVersion` predates the
   * file's shallow-history floor (ISSUE-0039 `history-pruned`). Nothing was
   * applied; the client must reset its local doc from the included snapshot,
   * replay in-flight edits onto it, and resubmit under new opIds.
   */
  | {
      type: 'submit.deferred'
      opId: string
      fileId: string
      reason: 'history-pruned'
      snapshotB64: string
      contentVersionB64: string
    }
  /**
   * The op was refused by policy and applied nothing. `too-large` is
   * permanent for that payload; `rate-limited` is retryable after
   * `retryAfterSec`.
   */
  | {
      type: 'submit.rejected'
      opId: string
      fileId: string
      reason: 'too-large' | 'rate-limited' | 'invalid-path' | 'forbidden'
      retryAfterSec?: number
    }
  | {
      type: 'events.batch'
      requestId: string
      currentSeq: number
      events: WorkspaceChangeEvent[]
    }
  /**
   * The cursor predates the bounded replay window. The client must
   * re-snapshot; the server never serves a partial incremental stream.
   */
  | { type: 'events.snapshot-required'; requestId: string; currentSeq: number }
  /** Live (non-tombstoned) tree entries + the seq watermark they reflect. */
  | {
      type: 'tree.state'
      requestId: string
      currentSeq: number
      entries: WorkspaceTreeEntry[]
    }
  /**
   * Answer to `opaque.get`; `found: false` when no live row holds the
   * fileId. A live MARKDOWN row answers found with its kind and path but
   * no bytes — a replica that fell behind the replay window must be able
   * to tell "the row crossed the kind boundary" from "deleted".
   */
  | {
      type: 'opaque.response'
      requestId: string
      fileId: string
      found: boolean
      contentKind?: 'markdown' | 'opaque'
      path?: string
      hashHex?: string
      sizeBytes?: number
      manifest?: OpaqueManifest
      objects?: OpaqueObjectPayload[]
    }
  | {
      type: 'opaque.ack'
      opId: string
      fileId: string
      hashHex: string
      sizeBytes: number
      manifest: OpaqueManifest
      conflict: boolean
      /** Canonical row path (suffixed on create collision). */
      path?: string
    }
  /** Per-op results for a `batch.submit`; deferred ops were not applied. */
  | {
      type: 'batch.ack'
      requestId: string
      currentSeq: number
      acceptedOps: BatchAcceptedOp[]
      deferredOps: BatchDeferredOp[]
    }
  | {
      type: 'batch.rejected'
      requestId: string
      reason: 'rate-limited' | 'forbidden'
      retryAfterSec?: number
    }
  | { type: 'error'; requestId?: string; message: string }
  /**
   * Incremental presence broadcast: encoded `EphemeralStore` update bytes
   * from a `presence.set`. Clients `apply()` them into a local store;
   * entry expiry is per-replica by timestamp.
   */
  | { type: 'presence.update'; dataB64: string }
  /**
   * A connection left: clients delete `key` from their local store. An
   * explicit message rather than the store's delete tombstone because the
   * tombstone loses same-millisecond LWW ties against the entry it
   * removes (verified against loro-crdt 1.12); the key is a never-reused
   * session peer ID (INV-7), so a late leave cannot evict a reconnected
   * peer's new entry.
   */
  | { type: 'presence.leave'; key: string }
  /** Full presence state (`encodeAll`) answering a `presence.get`. */
  | { type: 'presence.state'; requestId: string; dataB64: string }
  /** A `presence.set` was dropped by the rate limiter; retry after the window. */
  | { type: 'presence.rejected'; reason: 'rate-limited'; retryAfterSec?: number }
  /** Broadcast right before every socket is closed with 4410. */
  | { type: 'workspace.deleted' }
  | Extract<WorkspaceChangeEvent, { type: 'content.loroUpdate' | 'content.opaqueUpdate' }>
  /**
   * Tree-event broadcasts (create / rename / delete), shaped exactly like
   * the `events.batch` reconstruction: the core event body plus a top-level
   * `fileId` and the assigned `seq`.
   */
  | (Extract<WorkspaceChangeEvent, { type: 'create' | 'rename' | 'delete' }> & {
      fileId: string
      seq: number
    })

/**
 * Hibernation-safe per-connection state. Lives in the socket attachment
 * (`serializeAttachment`), never in DO memory, so it survives eviction —
 * a hibernated socket keeps its server-minted peer ID (INV-7).
 */
export interface WorkspaceConnectionAttachment {
  deviceId: string
  sessionPeerId: string
  principalId: string
  principalType: 'human' | 'agent'
  role: 'viewer' | 'commenter' | 'editor'
  owner: boolean
}

/**
 * What a presence entry looks like inside the `EphemeralStore`, keyed by
 * the connection's `sessionPeerId` (server-minted, never reused — INV-7
 * gives presence keys collision-freedom across reconnects). The identity
 * fields come from the socket attachment, never from the client message.
 */
export interface WorkspacePresenceEntry {
  principalId: string
  principalType: 'human' | 'agent'
  /** Client-supplied display state (cursor, name, color, …) — opaque JSON. */
  state: unknown
}

/** Connect was refused before the upgrade completed. */
export const CLOSE_UNAUTHENTICATED = 4401
/** Access revoked for this principal (`/admin/recheck`). */
export const CLOSE_ACCESS_REVOKED = 4403
/** The whole workspace was deleted. */
export const CLOSE_WORKSPACE_DELETED = 4410

/**
 * The slice of the Cloudflare hibernatable-WebSocket API the server core
 * needs. `cloudflare:workers` WebSocket satisfies this structurally; tests
 * provide an in-memory fake.
 */
export interface WorkspaceSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

/**
 * KV slice of `DurableObjectStorage`. All durable workspace counters (seq,
 * peer-ID) go through this — the in-memory fake in tests simulates eviction
 * by re-instantiating the server over the same storage.
 */
export interface WorkspaceServerStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

export type WorkspaceSqlValue = ArrayBuffer | string | number | null

/**
 * Synchronous SQL slice of DO SQLite (`ctx.storage.sql`). Tests back it with
 * `node:sqlite`.
 */
export interface WorkspaceSqlStorage {
  exec(
    query: string,
    ...bindings: WorkspaceSqlValue[]
  ): { toArray(): Record<string, WorkspaceSqlValue>[] }
}

export interface WorkspaceServerLimits {
  /** Cap on decoded Loro update bytes per submit. */
  maxUpdateBytes: number
  /** Cap on decoded opaque bytes per submit/get materialization. */
  maxOpaqueBytes: number
  /** Cap on a file's materialized markdown text, in UTF-8 bytes. */
  maxTextBytes: number
  /** Max submit attempts per identity inside the sliding window. */
  submitRateLimit: number
  /** Sliding-window width for the submit rate limit, in milliseconds. */
  submitRateWindowMs: number
}

export interface WorkspaceServerOptions {
  storage: WorkspaceServerStorage
  sql: WorkspaceSqlStorage
  /**
   * Live sockets for broadcast. The DO shell passes
   * `() => ctx.getWebSockets()` so sockets restored from hibernation are
   * always included; an in-memory map would silently drop them.
   */
  getSockets: () => readonly WorkspaceSocket[]
  limits?: Partial<WorkspaceServerLimits>
  /** DO `ctx.storage.transactionSync`; dofs uses it for multi-row writes. */
  transactionSync?: <T>(closure: () => T) => T
  /** Event-log replay window override (tests); default 10k. */
  replayWindow?: number
  /**
   * When true, connections without verified claims are refused. The worker
   * verifies the token (signature/expiry/workspaceId) and forwards claims;
   * the DO core gates on its durable auth epoch and deletion flag.
   */
  requireAuth?: boolean
  /**
   * Presence entry expiry (Loro `EphemeralStore` timeout). Clients must
   * republish below this interval to stay visible. Default 30s.
   */
  presenceTimeoutMs?: number
  /** Shallow-trim policy (spec §3.4) — idle threshold and registration TTL. */
  trim?: Partial<TrimPolicy>
  newDeviceId?: () => string
  now?: () => number
}

export interface WorkspaceConnectionClaims {
  principalId: string
  principalType: 'human' | 'agent'
  role: 'viewer' | 'commenter' | 'editor'
  owner: boolean
  epoch: number
}

export type WorkspaceConnectionGate =
  | { ok: true; principalId: string; claims: WorkspaceConnectionClaims }
  | { ok: false; status: number; reason: string }

/** `readTextFile` — a pull in the D5 text-push tier (spec §5.3). */
export type WorkspaceTextReadResult =
  | { status: 'not-found' }
  | {
      status: 'ok'
      fileId: string
      path: string
      text: string
      hashHex: string
      contentVersionB64: string
      sizeBytes: number
      seq?: number
      modifiedBy?: string
      modifiedAt?: number
    }

export interface WorkspaceTextPushInput {
  fileId: string
  newText: string
  /** sha256 of the base text the edit was derived from. */
  baseHashHex: string
  /** Re-sent base on cache miss; verified against `baseHashHex`. */
  baseText?: string
  /** Apply even a degenerate rewrite (explicit only, never default). */
  force?: boolean
  /**
   * Replay key for lost-response retries. REQUIRED for safe retries: a
   * fuzzy patch re-applied over its own landed result can insert twice
   * (diff-match-patch is not naturally idempotent against a stale base).
   * Only applied results are recorded — refusals are always retryable.
   */
  idempotencyKey?: string
  /** Attribution for the materialized view / event log. */
  modifiedBy?: string
  originDeviceId?: string
}

export type WorkspaceTextPushResult =
  | {
      status: 'applied'
      /** False when the merge was a no-op (e.g. an idempotent retry). */
      changed: boolean
      /** Unplaceable hunks, verbatim — the caller's base must not advance. */
      failedHunks: string[]
      path: string
      text: string
      hashHex: string
      contentVersionB64: string
    }
  /** The named base is not cached; re-send it as `baseText`. */
  | { status: 'base-missing' }
  /** Drifted base and the diff deletes most of it; `force` to override. */
  | { status: 'degenerate-rewrite'; deletedRatio: number }
  | { status: 'not-found' }
  | { status: 'too-large' }

const DEFAULT_LIMITS: WorkspaceServerLimits = {
  maxUpdateBytes: LIMITS.maxUpdateBytes,
  maxOpaqueBytes: LIMITS.maxOpaqueBytes,
  maxTextBytes: LIMITS.maxMarkdownBytes,
  // Realtime editors submit serially (one flight per round trip), so even
  // fast typing stays well under 10/sec sustained; floods do not.
  submitRateLimit: 600,
  submitRateWindowMs: 60_000,
}

const KEY_NEXT_PEER_ID = 'meta:nextPeerId'
const KEY_AUTH_EPOCH = 'meta:authEpoch'
const KEY_DELETED = 'meta:workspaceDeleted'

const DEFAULT_INITIAL_MARKDOWN = '# Glovebox\n\nStart typing in another tab.'
const OPAQUE_DOFS_ROOT = '/.glovebox/opaque'
const OPAQUE_RECOVERY_DOFS_ROOT = '/.glovebox/recovery'
const ANONYMOUS_CONNECTION_CLAIMS: WorkspaceConnectionClaims = {
  principalId: 'anonymous',
  principalType: 'human',
  role: 'editor',
  owner: true,
  epoch: 0,
}

/**
 * Transport-agnostic WorkspaceDO core. The Cloudflare DO is a thin shell over
 * this class; the simulation harness drives the same class with in-memory
 * storage and sockets. All connection state is socket-attached and all
 * counters are durable, so a fresh instance over the same storage (eviction)
 * never reissues a peer ID (INV-7) and `seq` is strictly monotonic.
 */
export class WorkspaceServer {
  readonly #storage: WorkspaceServerStorage
  readonly #getSockets: () => readonly WorkspaceSocket[]
  readonly #newDeviceId: () => string
  readonly #requireAuth: boolean
  readonly #files: LoroFileService
  readonly #idempotency: IdempotencyStore
  readonly #rateLimiter: SubmitRateLimiter
  readonly #events: WorkspaceEventLog
  readonly #recovery: WorkspaceRecoveryStore
  readonly #trim: TrimCoordinator
  readonly #baseCache: TextBaseCache
  readonly #dofsDb: DofsDatabase
  readonly #dofs: WorkspaceFilesystem
  readonly #workspace: WorkspaceStore
  readonly #applier: WorkspaceBatchApplier
  readonly #transactionSync: <T>(closure: () => T) => T
  readonly #limits: WorkspaceServerLimits
  readonly #ingressLimits: IngressLimits
  readonly #now: () => number
  /**
   * Presence lives in DO memory only — it is ephemeral by definition.
   * Eviction wipes it; client heartbeats (below the store timeout)
   * repopulate within one period, and every replica expires stale entries
   * on its own clock from the timestamps the entries carry.
   */
  readonly #presence: EphemeralStore
  /** Retained so the local-updates subscription is never GC'd. */
  readonly #presenceSubscription: () => void
  /** Set while a disconnect delete runs — its tombstone is not relayed. */
  #presenceRelayMuted = false
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: WorkspaceServerOptions) {
    this.#storage = options.storage
    this.#getSockets = options.getSockets
    this.#newDeviceId = options.newDeviceId ?? (() => crypto.randomUUID())
    this.#requireAuth = options.requireAuth ?? false
    this.#files = new LoroFileService(new SqliteLoroFileStore(options.sql))
    const now = options.now ?? (() => Date.now())
    this.#now = now
    this.#idempotency = new IdempotencyStore(options.sql, now)
    this.#events = new WorkspaceEventLog(options.sql, now, options.replayWindow)
    this.#recovery = new WorkspaceRecoveryStore(options.sql, now)
    this.#trim = new TrimCoordinator(options.sql, now, options.trim)
    this.#baseCache = new TextBaseCache(options.sql, now)
    this.#transactionSync = options.transactionSync ?? (<T>(closure: () => T): T => closure())
    // Tree/identity authority (ported loro-2 WorkspaceStore) + the batch
    // applier as the policy engine for structural ops. It allocates seq
    // from the SAME `workspace_meta` row as the event log — one seq domain.
    const sqlLike: WorkspaceSqlStorageLike = {
      sql: options.sql as unknown as WorkspaceSqlStorageLike['sql'],
      transactionSync: this.#transactionSync,
    }
    this.#workspace = new WorkspaceStore(sqlLike)
    this.#workspace.ensureInitialized()
    // The applier's Loro surface points at the LIVE Loro tables
    // (SqliteLoroFileStore): a delete must clear the state content.submit
    // serves from, not the ported store's parallel tables. Only `delete`
    // is reachable — batch.submit validation admits structural ops only.
    const batchLoro: BatchApplierLoroStore = {
      importUpdate: () => unreachableBatchLoro('importUpdate'),
      initialize: () => unreachableBatchLoro('initialize'),
      replaceWithSnapshot: () => unreachableBatchLoro('replaceWithSnapshot'),
      readSnapshot: () => unreachableBatchLoro('readSnapshot'),
      delete: (fileId) => {
        options.sql.exec('DELETE FROM loro_snapshots WHERE file_id = ?', fileId)
        options.sql.exec('DELETE FROM loro_updates WHERE file_id = ?', fileId)
        // The raw SQL bypasses LoroFileService — drop its cached doc too.
        this.#files.evict(fileId)
        this.#trim.forgetFile(fileId)
      },
    }
    const batchIdempotency = new WorkspaceIdempotencyStore(sqlLike)
    batchIdempotency.ensureInitialized()
    this.#applier = new WorkspaceBatchApplier(this.#workspace, batchLoro, batchIdempotency, {
      transitionContentKind: (fileId, oldPath, newPath) => {
        this.#transitionContentKindForRename(fileId, oldPath, newPath)
      },
    })
    const dofsDb = new DofsDatabase({
      sql: options.sql as unknown as SQLStorageLike,
      transactionSync: this.#transactionSync,
    })
    initializeSchema(dofsDb, now)
    this.#dofsDb = dofsDb
    this.#dofs = new WorkspaceFilesystem(dofsDb, { now })
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.#rateLimiter = new SubmitRateLimiter(
      options.sql,
      now,
      this.#limits.submitRateLimit,
      this.#limits.submitRateWindowMs,
    )
    this.#presence = new EphemeralStore(options.presenceTimeoutMs ?? 30_000)
    // Every set on the presence store broadcasts its encoded update;
    // clients apply the bytes into their own stores. Disconnect deletes
    // are muted here and broadcast as explicit `presence.leave` instead
    // (see that message's doc for why the tombstone is not enough).
    this.#presenceSubscription = this.#presence.subscribeLocalUpdates((update) => {
      if (this.#presenceRelayMuted) return
      this.#broadcast({ type: 'presence.update', dataB64: bytesToBase64(update) })
    })
    // Field caps are transport DoS bounds; semantic decoded-byte limits
    // still live in the handlers. Keep markdown/Loro capped to the markdown
    // tier instead of inheriting the larger opaque envelope.
    const maxUpdateB64Chars = base64CharCap(this.#limits.maxUpdateBytes) * 2
    const maxOpaqueObjectB64Chars = base64CharCap(
      Math.min(this.#limits.maxOpaqueBytes, OPAQUE_CHUNK_SIZE),
    )
    const opaqueChunkCount = Math.ceil(this.#limits.maxOpaqueBytes / OPAQUE_CHUNK_SIZE)
    const maxOpaqueSubmitMessageChars =
      base64CharCap(this.#limits.maxOpaqueBytes) + opaqueChunkCount * 256 + 16_384
    const maxContentSubmitMessageChars = maxUpdateB64Chars + 262_144 + 8192
    const maxSnapshotMessageChars = this.#limits.maxTextBytes + 8192
    const maxControlMessageChars = Math.max(262_144, maxSnapshotMessageChars)
    this.#ingressLimits = {
      maxUpdateB64Chars,
      maxOpaqueObjectB64Chars,
      maxContentSubmitMessageChars,
      maxOpaqueSubmitMessageChars,
      maxSnapshotMessageChars,
      maxControlMessageChars,
      maxInitialContentChars: this.#limits.maxTextBytes,
      maxMessageChars: Math.max(
        maxOpaqueSubmitMessageChars,
        maxContentSubmitMessageChars,
        maxSnapshotMessageChars,
        maxControlMessageChars,
      ),
    }
  }

  /**
   * Decide whether an upgrade may proceed, BEFORE the socket is accepted.
   * The worker has already verified token signature/expiry/workspaceId;
   * this gate owns what only durable state can answer: the auth epoch
   * (bumping it strands every previously minted token) and deletion.
   */
  async gateConnection(claims: WorkspaceConnectionClaims | null): Promise<WorkspaceConnectionGate> {
    if (await this.#storage.get<boolean>(KEY_DELETED)) {
      return { ok: false, status: 410, reason: 'workspace-deleted' }
    }
    if (!this.#requireAuth) {
      const acceptedClaims = claims ?? ANONYMOUS_CONNECTION_CLAIMS
      return { ok: true, principalId: acceptedClaims.principalId, claims: acceptedClaims }
    }
    if (!claims) {
      return { ok: false, status: 401, reason: 'unauthenticated' }
    }
    const epoch = (await this.#storage.get<number>(KEY_AUTH_EPOCH)) ?? 0
    if (claims.epoch < epoch) {
      return { ok: false, status: 401, reason: 'stale-epoch' }
    }
    return { ok: true, principalId: claims.principalId, claims }
  }

  /**
   * Mint connection state for a newly accepted socket. Serialized on the
   * message queue so peer-ID allocation is a strict read-increment-write even
   * if the runtime interleaves connects with messages.
   */
  handleConnect(
    socket: WorkspaceSocket,
    principalOrClaims: string | WorkspaceConnectionClaims = ANONYMOUS_CONNECTION_CLAIMS,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const claims =
        typeof principalOrClaims === 'string'
          ? { ...ANONYMOUS_CONNECTION_CLAIMS, principalId: principalOrClaims }
          : principalOrClaims
      const peerId = await this.#allocatePeerId()
      writeAttachment(socket, {
        deviceId: this.#newDeviceId(),
        sessionPeerId: peerId.toString(),
        principalId: claims.principalId,
        principalType: claims.principalType,
        role: claims.role,
        owner: claims.owner,
      })
    })
  }

  /**
   * Invalidate every token minted before now. Live connections are not
   * touched — pair with `recheckPrincipals` to drop them; reconnects then
   * re-validate through the worker with a fresh token.
   */
  async bumpAuthEpoch(): Promise<number> {
    const next = ((await this.#storage.get<number>(KEY_AUTH_EPOCH)) ?? 0) + 1
    await this.#storage.put(KEY_AUTH_EPOCH, next)
    return next
  }

  /**
   * Access revoked for specific principals (glyphdown `handleRecheck`): the
   * DO cannot consult the auth store, so the worker passes the affected ids
   * and exactly those sockets are closed. Principals that retain access via
   * another grant simply reconnect.
   */
  recheckPrincipals(principalIds: readonly string[]): number {
    const ids = new Set(principalIds)
    let closed = 0
    for (const socket of this.#getSockets()) {
      const attachment = readAttachment(socket)
      if (attachment && ids.has(attachment.principalId)) {
        this.#close(socket, CLOSE_ACCESS_REVOKED, 'access-revoked')
        closed += 1
      }
    }
    return closed
  }

  /** Workspace deleted: tell every client, drop all connections, refuse new ones. */
  async markWorkspaceDeleted(): Promise<void> {
    await this.#storage.put(KEY_DELETED, true)
    this.#broadcast({ type: 'workspace.deleted' })
    for (const socket of this.#getSockets()) {
      this.#close(socket, CLOSE_WORKSPACE_DELETED, 'workspace-deleted')
    }
  }

  handleMessage(socket: WorkspaceSocket, message: string | ArrayBuffer): Promise<void> {
    return this.#enqueue(() => this.#handleMessage(socket, message)).catch((error: unknown) => {
      // Best-effort correlation: a validation throw never produced a parsed
      // message, but the raw frame may still carry a usable requestId —
      // without one the client can only treat ALL its flights as failed.
      this.#send(socket, {
        type: 'error',
        requestId: extractRequestId(message),
        message: getErrorMessage(error),
      })
    })
  }

  async #handleMessage(socket: WorkspaceSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      this.#send(socket, { type: 'error', message: 'Expected JSON text message' })
      return
    }

    const parsed = parseClientMessage(message, this.#ingressLimits)
    switch (parsed.type) {
      case 'hello':
        this.#handleHello(socket, parsed)
        return
      case 'snapshot.get':
        await this.#handleSnapshotGet(socket, parsed)
        return
      case 'events.since':
        this.#handleEventsSince(socket, parsed)
        return
      case 'tree.list':
        this.#handleTreeList(socket, parsed)
        return
      case 'opaque.get':
        await this.#handleOpaqueGet(socket, parsed)
        return
      case 'content.submit':
        await this.#handleContentSubmit(socket, parsed)
        return
      case 'opaque.submit':
        await this.#handleOpaqueSubmit(socket, parsed)
        return
      case 'batch.submit':
        this.#handleBatchSubmit(socket, parsed)
        return
      case 'presence.set':
        this.#handlePresenceSet(socket, parsed)
        return
      case 'presence.get':
        this.#handlePresenceGet(socket, parsed)
        return
    }
  }

  /**
   * A socket closed (or errored). Presence cleanup only — sync state is
   * durable and survives disconnects by design. After an eviction the
   * fresh instance's store no longer has the entry; the delete is a no-op
   * and the entry expires on every replica by timeout instead.
   */
  handleDisconnect(socket: WorkspaceSocket): Promise<void> {
    return this.#enqueue(() => {
      const attachment = readAttachment(socket)
      if (!attachment) return
      this.#presenceRelayMuted = true
      try {
        this.#presence.delete(attachment.sessionPeerId)
      } finally {
        this.#presenceRelayMuted = false
      }
      this.#broadcast({ type: 'presence.leave', key: attachment.sessionPeerId })
    })
  }

  #handlePresenceSet(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'presence.set' }>,
  ): void {
    const attachment = readAttachment(socket)
    if (!attachment) {
      this.#send(socket, { type: 'error', message: 'Connection has no session state' })
      return
    }
    // Same sliding window as submits (denied attempts keep it full), under
    // a presence-scoped identity so a cursor flood cannot starve the
    // principal's content submits.
    const decision = this.#rateLimiter.record(`presence:${attachment.principalId}`)
    if (!decision.allowed) {
      this.#send(socket, {
        type: 'presence.rejected',
        reason: 'rate-limited',
        retryAfterSec: decision.retryAfterSec,
      })
      return
    }
    // No canMutate gate: read-only roles may publish presence (it is
    // ephemeral, never a content mutation). Identity is stamped from the
    // attachment claims here — a principalId inside stateJson is just
    // display data and never trusted.
    const entry: WorkspacePresenceEntry = {
      principalId: attachment.principalId,
      principalType: attachment.principalType,
      state: JSON.parse(message.stateJson) as unknown,
    }
    // The entry is JSON-safe by construction; loro's Value type just can't
    // see through the `unknown` state field.
    this.#presence.set(
      attachment.sessionPeerId,
      entry as unknown as Parameters<EphemeralStore['set']>[1],
    )
  }

  #handlePresenceGet(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'presence.get' }>,
  ): void {
    this.#send(socket, {
      type: 'presence.state',
      requestId: message.requestId,
      dataB64: bytesToBase64(this.#presence.encodeAll()),
    })
  }

  #handleHello(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'hello' }>,
  ): void {
    const attachment = readAttachment(socket)
    if (!attachment) {
      this.#send(socket, { type: 'error', message: 'Connection has no session state' })
      return
    }
    if (message.deviceId) {
      writeAttachment(socket, { ...attachment, deviceId: message.deviceId })
    }
    this.#send(socket, { type: 'ready', sessionPeerId: attachment.sessionPeerId })
  }

  async #handleSnapshotGet(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'snapshot.get' }>,
  ): Promise<void> {
    let snapshot = await this.#files.exportSnapshot(message.fileId)
    if (!snapshot) {
      if (!canMutate(readAttachment(socket))) {
        this.#send(socket, {
          type: 'error',
          requestId: message.requestId,
          message: 'forbidden',
        })
        return
      }
      // A markdown row with no Loro state (a row that crossed the
      // opaque→md boundary, ISSUE-0043) must seed from the row's
      // materialized text — falling through to DEFAULT would fabricate
      // placeholder markdown over real content. An OPAQUE row with no
      // seed is refused outright: minting placeholder Loro state for a
      // binary poisons the kind gates and every later read/transition
      // (a browser clicking a binary in the tree lands here). The
      // daemon's boundary transition legitimately seeds an opaque row,
      // but always WITH initialContent.
      const existingRow = this.#workspace.getByFileId(message.fileId)
      if (
        existingRow &&
        existingRow.contentKind === 'opaque' &&
        message.initialContent === undefined
      ) {
        this.#send(socket, {
          type: 'error',
          requestId: message.requestId,
          message: 'opaque-file',
        })
        return
      }
      const rowText =
        existingRow && existingRow.contentKind !== 'opaque'
          ? this.#workspace.readFileById(message.fileId)
          : null
      const materialized = await this.#files.initialize(
        message.fileId,
        // INV-13: client-supplied initial content is a text boundary.
        normalizeEol(message.initialContent ?? rowText ?? DEFAULT_INITIAL_MARKDOWN),
      )
      // snapshot.get is the create surface on this wire: the file enters
      // the tree authority here (path policy, per-file seq) and the
      // 'create' event makes it discoverable by pulling replicas.
      const registered = this.#registerFile(
        message.fileId,
        message.observedPath,
        materialized.textContent,
        readAttachment(socket)?.principalId ?? 'anonymous',
        {
          opId: `snapshot:${message.requestId}`,
          deviceId: readAttachment(socket)?.deviceId ?? 'unknown',
        },
      )
      if (!registered) {
        this.#send(socket, {
          type: 'error',
          requestId: message.requestId,
          message: 'materialized view refused file registration',
        })
        return
      }
      snapshot = (await this.#files.exportSnapshot(message.fileId))!
      this.#noteSnapshotServed(socket, message.fileId, materialized.contentVersion)
      this.#trim.noteActivity(message.fileId)
      this.#send(socket, {
        type: 'snapshot.response',
        requestId: message.requestId,
        fileId: message.fileId,
        snapshotB64: bytesToBase64(snapshot),
        contentVersionB64: bytesToBase64(materialized.contentVersion),
      })
      return
    }

    const materialized = await this.#files.materialize(message.fileId)
    const attachment = readAttachment(socket)
    if (!this.#workspace.getByFileId(message.fileId) && canMutate(attachment)) {
      const registered = this.#registerFile(
        message.fileId,
        message.observedPath,
        materialized!.textContent,
        attachment?.principalId ?? 'anonymous',
        {
          opId: `snapshot:${message.requestId}`,
          deviceId: attachment?.deviceId ?? 'unknown',
        },
      )
      if (!registered) {
        this.#send(socket, {
          type: 'error',
          requestId: message.requestId,
          message: 'materialized view refused file registration',
        })
        return
      }
    }
    this.#noteSnapshotServed(socket, message.fileId, materialized!.contentVersion)
    this.#send(socket, {
      type: 'snapshot.response',
      requestId: message.requestId,
      fileId: message.fileId,
      snapshotB64: bytesToBase64(snapshot),
      contentVersionB64: bytesToBase64(materialized!.contentVersion),
    })
  }

  /** A full snapshot transfer proves the device's knowledge (trim gate). */
  #noteSnapshotServed(socket: WorkspaceSocket, fileId: string, version: Uint8Array): void {
    const attachment = readAttachment(socket)
    if (attachment) this.#trim.noteSnapshotServed(attachment.deviceId, fileId, version)
  }

  async #handleContentSubmit(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'content.submit' }>,
  ): Promise<void> {
    const attachment = readAttachment(socket)
    if (!canMutate(attachment)) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'forbidden',
      })
      return
    }

    // Rate limit first — before any decode or storage read — and record the
    // attempt either way: denied attempts keep consuming the window, so
    // staying over the limit never drains it.
    const decision = this.#rateLimiter.record(
      attachment?.principalId ?? attachment?.deviceId ?? 'anonymous',
    )
    if (!decision.allowed) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'rate-limited',
        retryAfterSec: decision.retryAfterSec,
      })
      return
    }

    // Kind routing: the ROW is the authority once one exists (its kind is
    // re-derived on boundary renames, ISSUE-0043) — observedPath is only
    // trusted for first contact. Path-based alone, a daemon that hasn't
    // seen a md→opaque rename yet could keep landing text over bytes.
    if (!this.#isMarkdownTarget(message.fileId, message.observedPath)) {
      // A room that raced the boundary rename loses its unacked tail to
      // this rejection (the client suspends) — preserve the refused ops
      // as a recovery record (INV-2 at the rejection level).
      if (this.#workspace.getByFileId(message.fileId)) {
        this.#recovery.record({
          fileId: message.fileId,
          opId: message.opId,
          reason: 'kind-mismatch-rejected',
          deviceId: attachment?.deviceId ?? 'unknown',
          observedPath: message.observedPath,
          payload: JSON.stringify({
            loroUpdateB64: message.loroUpdateB64,
            baseContentVersionB64: message.baseContentVersionB64,
          }),
        })
      }
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'invalid-path',
      })
      return
    }

    const update = base64ToBytes(message.loroUpdateB64)
    if (update.byteLength > this.#limits.maxUpdateBytes) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'too-large',
      })
      return
    }

    const originalAck = this.#idempotency.get(message.opId)
    if (originalAck) {
      this.#send(socket, originalAck)
      return
    }

    const floor = await this.#files.shallowSinceVersion(message.fileId)
    if (floor) {
      const base = base64ToBytes(message.baseContentVersionB64)
      if (!versionDominates(base, floor)) {
        // Rare repair path — loading a private doc copy here is fine.
        const existing = await this.#files.load(message.fileId)
        if (existing) {
          this.#sendHistoryPrunedDefer(socket, message, existing)
          return
        }
      }
    }

    let result: LoroFileImportResult
    try {
      result = await this.#files.importUpdates(message.fileId, [update], {
        maxTextBytes: this.#limits.maxTextBytes,
      })
    } catch (error) {
      if (error instanceof LoroFileTooLargeError) {
        this.#send(socket, {
          type: 'submit.rejected',
          opId: message.opId,
          fileId: message.fileId,
          reason: 'too-large',
        })
        return
      }
      // The claimed base passed the floor check but the update's actual
      // dependencies were below the shallow root — same repair path.
      const doc = await this.#files.load(message.fileId)
      if (!doc) throw new Error(`File ${message.fileId} has no state`)
      this.#sendHistoryPrunedDefer(socket, message, doc)
      return
    }

    const row = this.#workspace.getByFileId(message.fileId)
    const projectedText =
      row && row.contentKind !== 'opaque' ? this.#workspace.readFileById(message.fileId) : null
    const needsMaterializedCommit =
      result.appliedUpdates > 0 || !row || projectedText !== result.textContent
    if (needsMaterializedCommit) {
      const committed = this.#commitContentUpdate({
        fileId: message.fileId,
        observedPath: message.observedPath,
        text: result.textContent,
        updateB64: message.loroUpdateB64,
        contentVersionB64: bytesToBase64(result.contentVersion),
        modifiedBy: attachment?.principalId ?? 'anonymous',
        originDeviceId: attachment?.deviceId,
        recovery: {
          opId: message.opId,
          deviceId: attachment?.deviceId ?? 'unknown',
        },
      })
      if (!committed) {
        this.#send(socket, {
          type: 'submit.rejected',
          opId: message.opId,
          fileId: message.fileId,
          reason: 'too-large',
        })
        return
      }
    }

    const ack: WorkspaceServerMessage = {
      type: 'ack',
      opId: message.opId,
      fileId: message.fileId,
      contentVersionB64: bytesToBase64(result.contentVersion),
      applied: result.appliedUpdates > 0,
    }
    this.#idempotency.put(message.opId, ack)
    this.#send(socket, ack)

    // The accepted submit proves the device holds base ⊔ update (trim gate).
    if (attachment) {
      this.#trim.noteSubmit(
        attachment.deviceId,
        message.fileId,
        base64ToBytes(message.baseContentVersionB64),
        update,
      )
    }

    // INV-13 at the WS ingress: updates are opaque ops, so EOL policy is
    // enforced POST-application — a CRLF that materialized lands a
    // corrective server-owned edit (the §3.2 server-enforce pattern);
    // every replica converges to `\n` through the ordinary broadcast.
    if (result.textContent.includes('\r')) {
      await this.#normalizeFileEol(message.fileId)
    }
  }

  async #normalizeFileEol(fileId: string): Promise<void> {
    const doc = await this.#files.load(fileId)
    if (!doc) return
    const text = doc.getTextContent()
    const target = normalizeEol(text)
    if (target === text) return
    try {
      await this.#landServerEdit({ fileId, doc, target, modifiedBy: 'server-eol' })
    } catch {
      // Best-effort: the submit was already acked; the next CR sighting
      // (or any later submit) retries the normalization.
    }
  }

  /**
   * Land `target` as a minimal server-minted edit: ops under a durable,
   * never-reused server peer (INV-7), persisted and committed through the
   * same pipeline as a WS submit so live clients converge by broadcast.
   */
  async #landServerEdit(input: {
    fileId: string
    doc: LoroFileDoc
    target: string
    modifiedBy: string
    originDeviceId?: string
  }): Promise<LoroFileImportResult> {
    const before = input.doc.contentVersion()
    input.doc.setPeerId(await this.#allocatePeerId())
    input.doc.setTextContent(input.target)
    const update = input.doc.exportUpdateSince(before)
    const result = await this.#files.importUpdates(input.fileId, [update], {
      maxTextBytes: this.#limits.maxTextBytes,
    })
    if (
      !this.#commitContentUpdate({
        fileId: input.fileId,
        text: result.textContent,
        updateB64: bytesToBase64(update),
        contentVersionB64: bytesToBase64(result.contentVersion),
        modifiedBy: input.modifiedBy,
        originDeviceId: input.originDeviceId ?? input.modifiedBy,
      })
    ) {
      throw new Error('materialized view refused server edit')
    }
    return result
  }

  /**
   * Shared tail of every accepted content change (WS submit or REST text
   * push): roll the tree authority's materialized view + per-file seq —
   * the seq advancing on EVERY content change is what arms the applier's
   * delete-vs-edit policy (INV-3) — then log, broadcast, and mark the
   * file active for the trim policy.
   */
  #commitContentUpdate(input: {
    fileId: string
    observedPath?: string
    text: string
    updateB64: string
    contentVersionB64: string
    modifiedBy: string
    originDeviceId?: string
    recovery?: { opId: string; deviceId: string }
  }): boolean {
    const rolledSeq = this.#rollMaterializedFile(
      input.fileId,
      input.observedPath,
      input.text,
      input.modifiedBy,
      input.recovery,
    )
    if (rolledSeq === false) return false
    const body = {
      loroUpdateB64: input.updateB64,
      contentVersionB64: input.contentVersionB64,
      originDeviceId: input.originDeviceId,
    }
    let seq: number
    if (rolledSeq === null) {
      seq = this.#events.append('content.loroUpdate', input.fileId, JSON.stringify(body))
    } else {
      seq = rolledSeq
      this.#events.appendAt(seq, 'content.loroUpdate', input.fileId, JSON.stringify(body))
    }
    this.#broadcast({ type: 'content.loroUpdate', fileId: input.fileId, seq, ...body })
    this.#trim.noteActivity(input.fileId)
    return true
  }

  /**
   * Write the post-import text through the WorkspaceStore (per-file seq +
   * materialized view) and return the allocated seq for the wire event, null
   * when first-contact registration already emitted the create event, or
   * false when the materialized tree row refused the write.
   */
  #rollMaterializedFile(
    fileId: string,
    observedPath: string | undefined,
    text: string,
    modifiedBy: string,
    recovery?: { opId: string; deviceId: string },
  ): number | null | false {
    try {
      const row = this.#workspace.getByFileId(fileId)
      if (!row) {
        return this.#registerFile(fileId, observedPath, text, modifiedBy, recovery) ? null : false
      }
      // Belt-and-braces kind routing: text must never land in an opaque
      // row (writeFileById would store raw text the byte readers then
      // base64-misdecode). The submit gates make this unreachable; keep
      // the invariant local anyway.
      if (row.contentKind === 'opaque') return false
      this.#workspace.writeFileById(fileId, text, { modifiedBy })
      return this.#workspace.getTreeEntryByFileId(fileId)?.seq ?? null
    } catch {
      return false
    }
  }

  /**
   * Enter a file into the tree authority under a free path (path collisions
   * suffix server-side, spec §3.3 createOrSuffix) and emit the 'create'
   * event at the store-stamped seq. Idempotent per fileId.
   */
  #registerFile(
    fileId: string,
    observedPath: string | undefined,
    text: string,
    modifiedBy: string,
    recovery?: { opId: string; deviceId: string },
  ): boolean {
    const fallbackPath = `${fileId}.md`
    const requestedPath = observedPath ?? fallbackPath
    const candidatePaths =
      requestedPath === fallbackPath ? [requestedPath] : [requestedPath, fallbackPath]
    let lastError: unknown = null

    for (const candidatePath of candidatePaths) {
      try {
        const existing = this.#workspace.getByFileId(fileId)
        if (existing) return true
        const path = this.#freePath(candidatePath)
        this.#workspace.createFile(path, text, { modifiedBy }, fileId)
      } catch (error) {
        lastError = error
        continue
      }

      const entry = this.#workspace.getTreeEntryByFileId(fileId)
      if (!entry || entry.seq === undefined) {
        lastError = new Error('Registered file has no tree seq')
        continue
      }
      const body = { path: entry.path, entry }
      this.#events.appendAt(entry.seq, 'create', fileId, JSON.stringify(body))
      this.#broadcast({ type: 'create', fileId, seq: entry.seq, ...body })
      return true
    }

    // Tree policy or quota rejected both the observed path and the stable
    // fileId fallback. Keep the orphaned Loro state observable and retryable.
    if (recovery) {
      this.#recovery.record({
        fileId,
        opId: recovery.opId,
        reason: 'registration-failed',
        deviceId: recovery.deviceId,
        observedPath,
        payload: JSON.stringify({
          requestedPath,
          fallbackPath,
          error: getErrorMessage(lastError),
        }),
      })
    }
    return false
  }

  #freePath(path: string): string {
    let candidate = path
    for (let suffix = 2; this.#workspace.getFileByPath(candidate); suffix += 1) {
      candidate = getSuffixedPath(path, suffix)
    }
    return candidate
  }

  #handleBatchSubmit(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'batch.submit' }>,
  ): void {
    const attachment = readAttachment(socket)
    if (!canMutate(attachment)) {
      this.#send(socket, {
        type: 'batch.rejected',
        requestId: message.requestId,
        reason: 'forbidden',
      })
      return
    }
    const decision = this.#rateLimiter.record(
      attachment?.principalId ?? attachment?.deviceId ?? 'anonymous',
    )
    if (!decision.allowed) {
      this.#send(socket, {
        type: 'batch.rejected',
        requestId: message.requestId,
        reason: 'rate-limited',
        retryAfterSec: decision.retryAfterSec,
      })
      return
    }

    const observedAt = this.#now()
    const ops: LocalSyncOp[] = message.ops.map((op) =>
      op.type === 'file.rename'
        ? {
            type: 'file.rename',
            opId: op.opId,
            fileId: op.fileId,
            baseSeq: op.baseSeq,
            fromPath: op.fromPath,
            toPath: op.toPath,
            observedAt,
          }
        : {
            type: 'file.deleteIntent',
            opId: op.opId,
            fileId: op.fileId,
            baseSeq: op.baseSeq,
            path: op.path,
            observedAt,
          },
    )

    const broadcasts: WorkspaceServerMessage[] = []
    const ack = this.#transactionSync<WorkspaceServerMessage>(() => {
      const result = this.#applier.apply(
        {
          workspaceId: 'workspace',
          mountId: 'wire',
          deviceId: attachment?.deviceId ?? 'unknown',
          baseSeq: 0,
          ops,
        },
        {
          userId: attachment?.principalId ?? 'anonymous',
          deviceId: attachment?.deviceId ?? 'unknown',
        },
      )

      // Every deferred intent lands in the recovery store before the ack is
      // sent (ISSUE-0041: a refused intent must never just vanish; INV-2 at
      // the intent level). Idempotent on opId, so a replayed batch returns
      // the same deferrals without double-writing.
      const opsById = new Map(message.ops.map((op) => [op.opId, op]))
      for (const deferred of result.deferredOps) {
        const op = opsById.get(deferred.opId)
        if (!op) continue
        this.#recovery.record({
          fileId: op.fileId,
          opId: op.opId,
          reason: deferred.reason,
          deviceId: attachment?.deviceId ?? 'unknown',
          observedPath: op.type === 'file.rename' ? op.toPath : op.path,
          payload: JSON.stringify({ op }),
        })
      }

      // Every applier event carries the seq the store stamped on the change;
      // record it in the wire log at that exact seq (shared counter — no
      // gaps) and broadcast in the same shape events.batch reconstructs.
      for (const event of result.events) {
        if (event.type !== 'rename' && event.type !== 'delete') continue
        if (event.seq === undefined) continue
        const fileId = event.type === 'rename' ? event.entry.fileId : event.fileId
        const { type, seq, ...body } = event
        this.#events.appendAt(seq, type, fileId, JSON.stringify(body))
        broadcasts.push({ ...event, fileId, seq } as WorkspaceServerMessage)
      }

      return {
        type: 'batch.ack',
        requestId: message.requestId,
        currentSeq: this.#events.currentSeq(),
        acceptedOps: result.acceptedOps,
        deferredOps: result.deferredOps,
      }
    })

    for (const broadcast of broadcasts) {
      this.#broadcast(broadcast)
    }
    this.#send(socket, ack)
  }

  async #handleOpaqueSubmit(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'opaque.submit' }>,
  ): Promise<void> {
    const attachment = readAttachment(socket)
    if (!canMutate(attachment)) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'forbidden',
      })
      return
    }
    const decision = this.#rateLimiter.record(
      attachment?.principalId ?? attachment?.deviceId ?? 'anonymous',
    )
    if (!decision.allowed) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'rate-limited',
        retryAfterSec: decision.retryAfterSec,
      })
      return
    }

    const originalAck = this.#idempotency.get(message.opId)
    if (originalAck) {
      this.#send(socket, originalAck)
      return
    }

    const payload: OpaqueWirePayload = {
      hashHex: message.hashHex,
      sizeBytes: message.sizeBytes,
      manifest: message.manifest,
      objects: message.objects,
    }
    let bytes: Uint8Array
    try {
      bytes = assembleOpaqueWirePayload(payload)
    } catch {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'invalid-path',
      })
      return
    }
    if (bytes.byteLength > this.#limits.maxOpaqueBytes) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'too-large',
      })
      return
    }

    // Markdown content merges through Loro; it must never reach the dofs
    // LWW write path (contentKind routing, spec §3.1). The ROW kind is the
    // authority once a row exists (re-derived on boundary renames,
    // ISSUE-0043); observedPath is only trusted for first contact.
    if (this.#isMarkdownTarget(message.fileId, message.observedPath)) {
      if (this.#workspace.getByFileId(message.fileId)) {
        this.#recordOpaqueRecoveryObject({
          fileId: message.fileId,
          opId: message.opId,
          reason: 'kind-mismatch-rejected',
          deviceId: attachment?.deviceId ?? 'unknown',
          observedPath: message.observedPath,
          bytes,
          content: contentRefFromPayload(payload),
        })
      }
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'invalid-path',
      })
      return
    }

    // LWW base check against the canonical current DOFS bytes. With a
    // clean-db wire break there is no path-keyed legacy mirror fallback.
    const currentEntry = this.#workspace.getTreeEntryByFileId(message.fileId)
    const conflict =
      currentEntry?.contentKind === 'opaque' && currentEntry.contentHash !== message.baseHashHex
    const current = conflict ? await this.#readOpaqueByFileId(message.fileId) : null

    const recovery =
      conflict && current !== null
        ? {
            path: opaqueRecoveryDofsPath(message.fileId, message.opId),
            bytes: current,
            payload: contentRefFromPayload(buildOpaqueWirePayload(current)),
            opId: message.opId,
            reason: 'opaque-conflict-loser',
            deviceId: attachment?.deviceId ?? 'unknown',
            observedPath: message.observedPath,
          }
        : undefined

    // Roll DOFS bytes and tree metadata in one SQL transaction before
    // acking. A refused metadata write must never acknowledge bytes that
    // the canonical tree row cannot name.
    const rolled = this.#rollOpaqueFile(
      message.fileId,
      message.observedPath,
      contentRefFromPayload(payload),
      bytes,
      attachment?.principalId ?? 'anonymous',
      recovery,
    )
    if (!rolled.ok) {
      this.#send(socket, {
        type: 'submit.rejected',
        opId: message.opId,
        fileId: message.fileId,
        reason: 'too-large',
      })
      return
    }

    const ack: WorkspaceServerMessage = {
      type: 'opaque.ack',
      opId: message.opId,
      fileId: message.fileId,
      hashHex: payload.hashHex,
      sizeBytes: payload.sizeBytes,
      manifest: payload.manifest,
      conflict,
      // Canonical row path — differs from observedPath when the create
      // collided and was suffixed; the daemon adopts it.
      path: rolled.path,
    }
    this.#idempotency.put(message.opId, ack)
    this.#send(socket, ack)

    const body = {
      hashHex: payload.hashHex,
      sizeBytes: payload.sizeBytes,
      manifest: payload.manifest,
      originDeviceId: attachment?.deviceId,
    }
    let seq: number
    if (rolled.seq === null) {
      seq = this.#events.append('content.opaqueUpdate', message.fileId, JSON.stringify(body))
    } else {
      seq = rolled.seq
      this.#events.appendAt(seq, 'content.opaqueUpdate', message.fileId, JSON.stringify(body))
    }
    this.#broadcast({ type: 'content.opaqueUpdate', fileId: message.fileId, seq, ...body })
  }

  /**
   * Kind routing authority: the tree row when one exists (kind is
   * re-derived on boundary renames), the path extension for first contact.
   */
  #isMarkdownTarget(fileId: string, observedPath: string): boolean {
    try {
      const row = this.#workspace.getByFileId(fileId)
      if (row) return row.contentKind !== 'opaque'
    } catch {
      // Tree authority unavailable — fall back to the path.
    }
    return isMarkdownFile(observedPath)
  }

  /**
   * Opaque twin of #rollMaterializedFile: write through the tree authority.
   * `seq: null` means the create event allocated its own. UNLIKE the
   * markdown roll, failure is surfaced (`ok: false` → the submit is
   * rejected): the row is the canonical opaque byte store, so a refused
   * write must never be acked.
   */
  #rollOpaqueFile(
    fileId: string,
    observedPath: string,
    content: { hashHex: string; sizeBytes: number; manifest: OpaqueManifest },
    bytes: Uint8Array,
    modifiedBy: string,
    recovery?: {
      path: string
      bytes: Uint8Array
      payload: { hashHex: string; sizeBytes: number; manifest: OpaqueManifest }
      opId: string
      reason: string
      deviceId: string
      observedPath: string
    },
  ): { ok: true; seq: number | null; path: string } | { ok: false } {
    try {
      return this.#transactionSync(() => {
        this.#ensureOpaqueDofsDirs(recovery !== undefined)
        if (recovery) {
          writeFileSync(this.#dofsDb, recovery.path, recovery.bytes, {}, this.#now)
        }
        writeFileSync(this.#dofsDb, opaqueDofsPath(fileId), bytes, {}, this.#now)
        if (!this.#workspace.getByFileId(fileId)) {
          const path = this.#registerOpaqueFile(fileId, observedPath, content, modifiedBy)
          return { ok: true, seq: null, path }
        }
        this.#workspace.writeOpaqueMetadataById(
          fileId,
          { contentHash: content.hashHex, sizeBytes: content.sizeBytes },
          { modifiedBy },
        )
        const entry = this.#workspace.getTreeEntryByFileId(fileId)
        if (recovery) {
          // Last writer wins; the overwritten bytes survive as a recovery
          // object reference instead of an event-log or recovery base64 blob.
          this.#recovery.record({
            fileId,
            opId: recovery.opId,
            reason: recovery.reason,
            deviceId: recovery.deviceId,
            observedPath: recovery.observedPath,
            payload: JSON.stringify({
              ...recovery.payload,
              dofsPath: recovery.path,
            }),
          })
        }
        return { ok: true, seq: entry?.seq ?? null, path: entry?.path ?? observedPath }
      })
    } catch {
      return { ok: false }
    }
  }

  #recordOpaqueRecoveryObject(input: {
    fileId: string
    opId: string
    reason: string
    deviceId: string
    observedPath: string
    bytes: Uint8Array
    content: { hashHex: string; sizeBytes: number; manifest: OpaqueManifest }
  }): void {
    const path = opaqueRecoveryDofsPath(input.fileId, input.opId)
    this.#transactionSync(() => {
      this.#ensureOpaqueDofsDirs(true)
      writeFileSync(this.#dofsDb, path, input.bytes, {}, this.#now)
      this.#recovery.record({
        fileId: input.fileId,
        opId: input.opId,
        reason: input.reason,
        deviceId: input.deviceId,
        observedPath: input.observedPath,
        payload: JSON.stringify({
          ...input.content,
          dofsPath: path,
        }),
      })
    })
  }

  /**
   * Opaque twin of #registerFile — same suffix policy, same 'create'
   * event. Throws on store refusal (quota, path policy); the caller maps
   * it to a rejection.
   */
  #registerOpaqueFile(
    fileId: string,
    observedPath: string,
    content: { hashHex: string; sizeBytes: number },
    modifiedBy: string,
  ): string {
    const path = this.#freePath(observedPath)
    this.#workspace.createOpaqueFile(
      path,
      { contentHash: content.hashHex, sizeBytes: content.sizeBytes },
      { modifiedBy },
      fileId,
    )
    const entry = this.#workspace.getTreeEntryByFileId(fileId)
    if (!entry || entry.seq === undefined) return path
    const body = { path: entry.path, entry }
    this.#events.appendAt(entry.seq, 'create', fileId, JSON.stringify(body))
    this.#broadcast({ type: 'create', fileId, seq: entry.seq, ...body })
    return entry.path
  }

  #handleTreeList(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'tree.list' }>,
  ): void {
    this.#send(socket, {
      type: 'tree.state',
      requestId: message.requestId,
      currentSeq: this.#events.currentSeq(),
      entries: this.#workspace.listAll().filter((entry) => !entry.tombstone),
    })
  }

  async #handleOpaqueGet(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'opaque.get' }>,
  ): Promise<void> {
    const entry = this.#workspace.getTreeEntryByFileId(message.fileId)
    if (entry && entry.contentKind === 'opaque') {
      const payload = this.#readOpaqueWirePayload(entry, {
        includeObjects: message.metadataOnly !== true,
        haveObjects: message.haveObjects,
      })
      if (payload) {
        this.#send(socket, {
          type: 'opaque.response',
          requestId: message.requestId,
          fileId: message.fileId,
          found: true,
          contentKind: 'opaque',
          path: entry.path,
          hashHex: payload.hashHex,
          sizeBytes: payload.sizeBytes,
          manifest: payload.manifest,
          ...(message.metadataOnly === true ? {} : { objects: payload.objects }),
        })
        return
      }
      this.#send(socket, {
        type: 'opaque.response',
        requestId: message.requestId,
        fileId: message.fileId,
        found: false,
      })
      return
    }
    if (entry) {
      // The row is alive but MARKDOWN (it crossed the kind boundary) —
      // never report it as missing, or a behind-the-window replica would
      // treat the crossing as a deletion and remove its local file.
      this.#send(socket, {
        type: 'opaque.response',
        requestId: message.requestId,
        fileId: message.fileId,
        found: true,
        contentKind: 'markdown',
        path: entry.path,
      })
      return
    }
    // No live row (deleted, or a pre-row legacy binary — those have no
    // fileId→path index to read dofs by).
    this.#send(socket, {
      type: 'opaque.response',
      requestId: message.requestId,
      fileId: message.fileId,
      found: false,
    })
  }

  async #readOpaqueByFileId(fileId: string): Promise<Uint8Array | null> {
    return this.#readOpaque(opaqueDofsPath(fileId))
  }

  async #readOpaque(path: string): Promise<Uint8Array | null> {
    let stream: ReadableStream<Uint8Array>
    try {
      stream = await this.#dofs.readFile(path)
    } catch {
      return null
    }
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  #readOpaqueWirePayload(
    entry: WorkspaceTreeEntry,
    options: { includeObjects: boolean; haveObjects?: string[] },
  ): OpaqueWirePayload | null {
    const inode = this.#resolveDofsFileInode(opaqueDofsPath(entry.fileId))
    if (inode === null) return null
    const chunkRows = this.#dofsDb.all<{ hash: Uint8Array; size: number }>(
      'SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx',
      inode,
    )
    const totalSize = chunkRows.reduce((sum, row) => sum + row.size, 0)
    if (totalSize !== entry.sizeBytes) return null
    const manifest: OpaqueManifest = {
      chunks: chunkRows.map((row) => ({ hashB64: bytesToBase64(row.hash), size: row.size })),
    }
    const objects: OpaqueObjectPayload[] = []
    if (options.includeObjects) {
      const have = new Set(options.haveObjects ?? [])
      for (const row of chunkRows) {
        const hashB64 = bytesToBase64(row.hash)
        if (have.has(hashB64)) continue
        const blob = this.#dofsDb.one<{ bytes: Uint8Array }>(
          'SELECT bytes FROM vfs_blob_bytes WHERE hash = ?',
          row.hash,
        )
        if (!blob) return null
        objects.push({ hashB64, bytesB64: bytesToBase64(blob.bytes) })
      }
    }
    return {
      hashHex: entry.contentHash,
      sizeBytes: entry.sizeBytes,
      manifest,
      objects,
    }
  }

  #resolveDofsFileInode(path: string): number | null {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return null
    let parentInode = ROOT_INODE
    for (let idx = 0; idx < parts.length; idx += 1) {
      const row = this.#dofsDb.one<{ inode: number; type: 'file' | 'dir' | 'symlink' }>(
        `SELECT n.inode AS inode, n.type AS type
           FROM vfs_dirents d
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE d.parent_inode = ? AND d.name = ?`,
        parentInode,
        parts[idx],
      )
      if (!row) return null
      const final = idx === parts.length - 1
      if (final) return row.type === 'file' ? row.inode : null
      if (row.type !== 'dir') return null
      parentInode = row.inode
    }
    return null
  }

  #ensureOpaqueDofsDirs(includeRecovery: boolean): void {
    mkdir(this.#dofsDb, '/.glovebox', { recursive: true }, this.#now)
    mkdir(this.#dofsDb, '/.glovebox/opaque', { recursive: true }, this.#now)
    if (includeRecovery) {
      mkdir(this.#dofsDb, '/.glovebox/recovery', { recursive: true }, this.#now)
    }
  }

  #transitionContentKindForRename(fileId: string, oldPath: string, newPath: string): void {
    const oldIsMarkdown = isMarkdownFile(oldPath)
    const newIsMarkdown = isMarkdownFile(newPath)
    if (oldIsMarkdown === newIsMarkdown) return

    if (!newIsMarkdown) {
      const text = this.#workspace.readFileById(fileId) ?? ''
      const bytes = new TextEncoder().encode(text)
      const payload = buildOpaqueWirePayload(bytes)
      this.#ensureOpaqueDofsDirs(false)
      writeFileSync(this.#dofsDb, opaqueDofsPath(fileId), bytes, {}, this.#now)
      const transitioned = this.#workspace.transitionMarkdownToOpaque(fileId, {
        contentHash: payload.hashHex,
        sizeBytes: payload.sizeBytes,
      })
      if (!transitioned) {
        throw new Error('Failed to transition markdown file to opaque')
      }
      return
    }

    const path = opaqueDofsPath(fileId)
    const size = dofsStat(this.#dofsDb, path).size
    const bytes = readRangeSync(this.#dofsDb, path, 0, size)
    const text = new TextDecoder().decode(bytes)
    const transitioned = this.#workspace.transitionOpaqueToMarkdown(fileId, text)
    if (!transitioned) {
      throw new Error('Failed to transition opaque file to markdown')
    }
    dofsRm(this.#dofsDb, path, { force: true })
  }

  /**
   * Release non-durable resources (the presence store's expiry timer and
   * its relay subscription). The DO runtime never calls this — eviction
   * just drops the isolate — but in-process hosts (tests, the harness)
   * should when a server instance is replaced.
   */
  dispose(): void {
    this.#presenceSubscription()
    this.#presence.destroy()
  }

  /** Live workspace tree (non-tombstoned entries) + the current seq head. */
  listTree(): Promise<{ entries: ReturnType<WorkspaceStore['listAll']>; currentSeq: number }> {
    return this.#enqueue(() => ({
      entries: this.#workspace.listAll().filter((entry) => !entry.tombstone),
      currentSeq: this.#events.currentSeq(),
    }))
  }

  /**
   * D5 pull: the live working text + its content hash. Serving a read
   * caches the text content-addressed so a later push can name this base
   * by hash alone (spec §5.3).
   */
  readTextFile(fileId: string): Promise<WorkspaceTextReadResult> {
    return this.#enqueue(async () => {
      // The text tier never serves opaque rows — a stray Loro doc for a
      // binary fileId (legacy fabrication) must not masquerade as text.
      if (this.#workspace.getByFileId(fileId)?.contentKind === 'opaque') {
        return { status: 'not-found' as const }
      }
      const doc = await this.#files.load(fileId)
      if (!doc) return { status: 'not-found' as const }
      const entry = this.#workspace.getTreeEntryByFileId(fileId)
      const text = doc.getTextContent()
      const hashHex = sha256Hex(text)
      this.#baseCache.put(hashHex, text)
      return {
        status: 'ok' as const,
        fileId,
        path: entry?.path ?? `${fileId}.md`,
        text,
        hashHex,
        contentVersionB64: bytesToBase64(doc.contentVersion()),
        sizeBytes: doc.getTextContentSizeBytes(),
        seq: entry?.seq,
        modifiedBy: entry?.modifiedBy,
        modifiedAt: entry?.modifiedAt,
      }
    })
  }

  /**
   * D5 push: three-way merge of `{base → newText}` onto the live doc,
   * landed as minimal Loro ops under a server-owned peer ID in one
   * transaction (glyphdown `handlePush` is the reference). Exact when the
   * doc hasn't drifted from the base; fuzzy patch application when it
   * has, with unplaceable hunks returned verbatim. EOL is normalized at
   * this boundary (INV-13).
   */
  pushText(input: WorkspaceTextPushInput): Promise<WorkspaceTextPushResult> {
    return this.#enqueue(async () => {
      const idempotencyKey = input.idempotencyKey ? `textpush:${input.idempotencyKey}` : null
      if (idempotencyKey) {
        const replay = this.#idempotency.get(idempotencyKey)
        if (replay) return replay as unknown as WorkspaceTextPushResult
      }

      // The text tier never writes opaque rows — kind routing applies to
      // every mutation surface, not just the WS gates (a text write into
      // an opaque row corrupts its base64 byte encoding).
      if (this.#workspace.getByFileId(input.fileId)?.contentKind === 'opaque') {
        return { status: 'not-found' as const }
      }

      const doc = await this.#files.load(input.fileId)
      if (!doc) return { status: 'not-found' as const }

      const newText = normalizeEol(input.newText)
      if (utf8Bytes(newText) > this.#limits.maxTextBytes) {
        return { status: 'too-large' as const }
      }

      const current = doc.getTextContent()
      const baseText = this.#resolveBaseText(current, input)
      if (baseText === null) return { status: 'base-missing' as const }

      const merge = computeMergedTarget(current, baseText, newText)
      if (merge.drifted && !input.force && merge.deletedRatio > DEGENERATE_DELETE_RATIO) {
        return { status: 'degenerate-rewrite' as const, deletedRatio: merge.deletedRatio }
      }

      let contentVersion = doc.contentVersion()
      let text = current
      if (merge.target !== current) {
        let result: LoroFileImportResult
        try {
          result = await this.#landServerEdit({
            fileId: input.fileId,
            doc,
            target: merge.target,
            modifiedBy: input.modifiedBy ?? 'text-push',
            originDeviceId: input.originDeviceId ?? 'text-push',
          })
        } catch (error) {
          if (error instanceof LoroFileTooLargeError) return { status: 'too-large' as const }
          throw error
        }
        contentVersion = result.contentVersion
        text = result.textContent
      }

      const hashHex = sha256Hex(text)
      // The post-merge text is the caller's next base.
      this.#baseCache.put(hashHex, text)
      const applied: WorkspaceTextPushResult = {
        status: 'applied' as const,
        changed: merge.target !== current,
        failedHunks: merge.failedHunks,
        path: this.#workspace.getTreeEntryByFileId(input.fileId)?.path ?? `${input.fileId}.md`,
        text,
        hashHex,
        contentVersionB64: bytesToBase64(contentVersion),
      }
      if (idempotencyKey) {
        this.#idempotency.put(idempotencyKey, applied as unknown as WorkspaceServerMessage)
      }
      return applied
    })
  }

  /**
   * Resolve the push's base text: the live text when the hash matches
   * (no drift), else the re-sent base (hash-verified), else the
   * content-addressed cache. Null = the client must re-send its base.
   */
  #resolveBaseText(current: string, input: WorkspaceTextPushInput): string | null {
    if (sha256Hex(current) === input.baseHashHex) return current
    if (input.baseText !== undefined) {
      const normalized = normalizeEol(input.baseText)
      if (sha256Hex(normalized) === input.baseHashHex) {
        this.#baseCache.put(input.baseHashHex, normalized)
        return normalized
      }
      return null
    }
    return this.#baseCache.get(input.baseHashHex)
  }

  /**
   * Periodic maintenance (the DO alarm drives this in production):
   * recovery-record TTL pruning (ISSUE-0041), trim-registration TTL
   * pruning, and the §3.4 shallow trim pass — idle files only, and only
   * when every live registration's tracked version dominates the file's
   * current version. Serialized on the message queue: trims must never
   * interleave with imports.
   */
  runMaintenance(): Promise<{
    prunedRecoveryRecords: number
    prunedTrimRegistrations: number
    prunedTextBases: number
    trimmedFiles: string[]
  }> {
    return this.#enqueue(async () => {
      const prunedRecoveryRecords = this.#recovery.prune()
      const prunedTrimRegistrations = this.#trim.pruneRegistrations()
      const prunedTextBases = this.#baseCache.prune()
      const trimmedFiles: string[] = []
      for (const fileId of this.#trim.idleFiles()) {
        const doc = await this.#files.load(fileId)
        if (!doc) {
          this.#trim.forgetFile(fileId)
          continue
        }
        const current = doc.contentVersion()
        if (current.byteLength === 0) continue
        if (!this.#trim.allRegistrantsDominate(fileId, current)) continue
        await this.#files.trimToShallow(fileId)
        this.#trim.noteTrimmed(fileId)
        trimmedFiles.push(fileId)
      }
      return { prunedRecoveryRecords, prunedTrimRegistrations, prunedTextBases, trimmedFiles }
    })
  }

  /** Recovery records surface (ISSUE-0041); UX lands in M6. */
  listRecoveryRecords(options: { pendingOnly?: boolean } = {}) {
    return this.#recovery.list(options)
  }

  acknowledgeRecoveryRecord(recordId: string): boolean {
    return this.#transactionSync(() => {
      const record = this.#recovery.get(recordId)
      const acknowledged = this.#recovery.acknowledge(recordId)
      if (acknowledged && record) {
        this.#deleteRecoveryDofsPayload(record.payload)
      }
      return acknowledged
    })
  }

  #deleteRecoveryDofsPayload(payload: string): void {
    let dofsPath: unknown
    try {
      dofsPath = (JSON.parse(payload) as { dofsPath?: unknown }).dofsPath
    } catch {
      return
    }
    if (typeof dofsPath !== 'string' || !dofsPath.startsWith(`${OPAQUE_RECOVERY_DOFS_ROOT}/`)) {
      return
    }
    dofsRm(this.#dofsDb, dofsPath, { force: true })
  }

  #handleEventsSince(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'events.since' }>,
  ): void {
    const read = this.#events.since(message.afterSeq)
    if (!read.ok) {
      this.#send(socket, {
        type: 'events.snapshot-required',
        requestId: message.requestId,
        currentSeq: read.currentSeq,
      })
      return
    }
    const events = read.events.map(
      (row) =>
        ({
          type: row.type,
          fileId: row.fileId,
          seq: row.seq,
          ...(JSON.parse(row.payload) as Record<string, unknown>),
        }) as unknown as WorkspaceChangeEvent,
    )
    this.#send(socket, {
      type: 'events.batch',
      requestId: message.requestId,
      currentSeq: read.currentSeq,
      events,
    })
  }

  #sendHistoryPrunedDefer(
    socket: WorkspaceSocket,
    message: Extract<WorkspaceClientMessage, { type: 'content.submit' }>,
    doc: LoroFileDoc,
  ): void {
    // Full-mode export preserves an existing shallow root, so this never
    // mints a new trim point (trim stays server-coordinated, spec §3.4).
    this.#send(socket, {
      type: 'submit.deferred',
      opId: message.opId,
      fileId: message.fileId,
      reason: 'history-pruned',
      snapshotB64: bytesToBase64(doc.exportSnapshot()),
      contentVersionB64: bytesToBase64(doc.contentVersion()),
    })
  }

  async #allocatePeerId(): Promise<bigint> {
    const stored = await this.#storage.get<string>(KEY_NEXT_PEER_ID)
    const peerId = stored === undefined ? 1n : BigInt(stored)
    await this.#storage.put(KEY_NEXT_PEER_ID, (peerId + 1n).toString())
    return peerId
  }

  #broadcast(message: WorkspaceServerMessage): void {
    for (const socket of this.#getSockets()) {
      this.#send(socket, message)
    }
  }

  #send(socket: WorkspaceSocket, message: WorkspaceServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // Socket already closed; the runtime reaps it from getSockets().
    }
  }

  #close(socket: WorkspaceSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  #enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.#queue.then(task, task)
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Durable `opId → original ack` store in DO SQLite. A duplicate
 * `content.submit` (client retry after a lost ack) replays the original ack
 * verbatim and must not touch the Loro store or the event log.
 */
class IdempotencyStore {
  readonly #sql: WorkspaceSqlStorage
  readonly #now: () => number

  constructor(sql: WorkspaceSqlStorage, now: () => number) {
    this.#sql = sql
    this.#now = now
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS idempotency (op_id TEXT PRIMARY KEY, ack TEXT NOT NULL, created_at INTEGER NOT NULL)',
    )
  }

  get(opId: string): WorkspaceServerMessage | null {
    const rows = this.#sql
      .exec('SELECT ack, created_at FROM idempotency WHERE op_id = ?', opId)
      .toArray()
    const row = rows[0]
    if (!row || typeof row.ack !== 'string') return null
    if (Number(row.created_at) + IDEMPOTENCY_TTL_MS <= this.#now()) return null
    return JSON.parse(row.ack) as WorkspaceServerMessage
  }

  put(opId: string, ack: WorkspaceServerMessage): void {
    const now = this.#now()
    this.#sql.exec('DELETE FROM idempotency WHERE created_at + ? <= ?', IDEMPOTENCY_TTL_MS, now)
    this.#sql.exec(
      'INSERT OR REPLACE INTO idempotency (op_id, ack, created_at) VALUES (?, ?, ?)',
      opId,
      JSON.stringify(ack),
      now,
    )
  }
}

/**
 * Sliding-window submit rate limit in DO SQLite (glyphdown `recordPush`):
 * insert the attempt, count the identity's window, prune expired rows.
 * Inserting before deciding is what records denied attempts.
 */
class SubmitRateLimiter {
  readonly #sql: WorkspaceSqlStorage
  readonly #now: () => number
  readonly #limit: number
  readonly #windowMs: number

  constructor(sql: WorkspaceSqlStorage, now: () => number, limit: number, windowMs: number) {
    this.#sql = sql
    this.#now = now
    this.#limit = limit
    this.#windowMs = windowMs
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS submit_attempts (identity TEXT NOT NULL, ts INTEGER NOT NULL)',
    )
    this.#sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_submit_attempts_identity ON submit_attempts (identity)',
    )
  }

  record(identity: string): SubmitWindowDecision {
    const now = this.#now()
    this.#sql.exec('INSERT INTO submit_attempts (identity, ts) VALUES (?, ?)', identity, now)
    const timestamps = this.#sql
      .exec('SELECT ts FROM submit_attempts WHERE identity = ?', identity)
      .toArray()
      .map((row) => Number(row.ts))
    const decision = decideSubmitWindow(timestamps, now, this.#limit, this.#windowMs)
    this.#sql.exec('DELETE FROM submit_attempts WHERE ts <= ?', decision.pruneBefore)
    return decision
  }
}

function readAttachment(socket: WorkspaceSocket): WorkspaceConnectionAttachment | null {
  const value = socket.deserializeAttachment()
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as WorkspaceConnectionAttachment).deviceId === 'string' &&
    typeof (value as WorkspaceConnectionAttachment).sessionPeerId === 'string' &&
    typeof (value as WorkspaceConnectionAttachment).principalId === 'string' &&
    ((value as WorkspaceConnectionAttachment).principalType === 'human' ||
      (value as WorkspaceConnectionAttachment).principalType === 'agent') &&
    ((value as WorkspaceConnectionAttachment).role === 'viewer' ||
      (value as WorkspaceConnectionAttachment).role === 'commenter' ||
      (value as WorkspaceConnectionAttachment).role === 'editor') &&
    typeof (value as WorkspaceConnectionAttachment).owner === 'boolean'
  ) {
    return value as WorkspaceConnectionAttachment
  }
  return null
}

function writeAttachment(socket: WorkspaceSocket, attachment: WorkspaceConnectionAttachment): void {
  socket.serializeAttachment(attachment)
}

function canMutate(attachment: WorkspaceConnectionAttachment | null): boolean {
  return Boolean(attachment && (attachment.owner || attachment.role === 'editor'))
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

const utf8Encoder = new TextEncoder()

function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

/**
 * Pull a plausible requestId out of a raw (possibly invalid) frame for
 * error correlation. Never trusts the value beyond shape: bounded length,
 * string only, and the frame itself is length-capped before parsing.
 */
function extractRequestId(message: string | ArrayBuffer): string | undefined {
  if (typeof message !== 'string' || message.length > 8 * 1024 * 1024) {
    return undefined
  }
  try {
    const parsed = JSON.parse(message) as { requestId?: unknown }
    if (typeof parsed.requestId === 'string' && parsed.requestId.length <= 256) {
      return parsed.requestId
    }
  } catch {
    // Unparseable frame — no correlation possible.
  }
  return undefined
}

function unreachableBatchLoro(method: string): never {
  throw new Error(`BatchApplierLoroStore.${method} is unreachable for structural batch ops`)
}

function base64CharCap(decodedBytes: number): number {
  return Math.ceil(decodedBytes / 3) * 4 + 4
}

function opaqueDofsPath(fileId: string): string {
  return `${OPAQUE_DOFS_ROOT}/${sha256Hex(fileId)}`
}

function opaqueRecoveryDofsPath(fileId: string, opId: string): string {
  return `${OPAQUE_RECOVERY_DOFS_ROOT}/${sha256Hex(`${fileId}:${opId}`)}`
}
