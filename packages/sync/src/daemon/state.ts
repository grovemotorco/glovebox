import { LoroFileDoc } from '../loro/file-doc.ts'
import { base64ToBytes, bytesToBase64 } from '../loro/base64.ts'

/**
 * V2 daemon persistence (spec-loro-sync-refactor.md data model): exactly two
 * artifacts — one `workspace-state.json` and one snapshot envelope per
 * markdown file. Each artifact write is atomic (tmp+rename in the node
 * storage); the crash window that matters is BETWEEN artifact writes, and
 * the reconcile in `load()` resolves every ordering (INV-6).
 *
 * The envelope carries its own server-confirmed VV so bytes+VV are always a
 * consistent pair — the spec's "re-derive syncedVV from the snapshot" is
 * implemented as "read the VV recorded WITH the snapshot", never derived
 * from the oplog bytes: a snapshot can contain unacked local ops, and
 * deriving would mark them confirmed and kill retransmission (INV-2; same
 * lesson as the browser WorkspaceStateStore).
 */

export interface DaemonStorage {
  read(name: string): Promise<Uint8Array | null>
  /**
   * Whole-artifact atomic write: after a crash the artifact holds either
   * the complete old bytes or the complete new bytes, never a prefix.
   */
  writeAtomic(name: string, bytes: Uint8Array): Promise<void>
  delete(name: string): Promise<void>
  /** Artifact names, optionally restricted to those under `prefix` (a
   *  directory-style prefix ending in `/`). */
  list(prefix?: string): Promise<string[]>
}

/** Tree-level intent not yet acked — re-driven on each push (bounded). */
export interface PendingRename {
  opId: string
  fileId: string
  fromPath: string
  toPath: string
  baseSeq: number
}

/**
 * Delete INTENT (INV-3): records when absence was first observed so the
 * tombstone delay and rename-correction window can be enforced by the cycle.
 */
export interface PendingDelete {
  opId: string
  fileId: string
  path: string
  baseSeq: number
  observedMissingAtMs: number
  /**
   * Set when a bulk-delete guard adjudicated this absence as part of a
   * suspected wipe: the intent never propagates (reappearance still cancels
   * it). Persisted so a restart cannot launder a held wipe into deletes.
   */
  held?: 'bulk-startup' | 'bulk-window'
  /** Set only by explicit local user confirmation; prevents later bulk guards
   *  from re-freezing the same reviewed absence after a restart. */
  confirmedAtMs?: number
}

export interface DeleteResolutionCommand {
  id: string
  action: 'confirm' | 'restore'
  fileIds: string[]
  createdAt: number
}

export interface DaemonFileState {
  path: string
  contentKind: 'markdown' | 'opaque'
  /** Inode identity from the last checkout/scan, for rename detection. */
  nodeId: string | null
  /** Cache of the snapshot envelope's VV — never reconciled FROM (INV-6). */
  syncedVVB64: string
  /** sha256 of the last bytes the daemon wrote/confirmed on disk (INV-4). */
  lastWrittenHash: string
  /** Doc version that materializes the lastWrittenHash bytes — the anchor
   *  for absorbing later disk edits (markdown only; rolls with the hash). */
  lastWrittenVVB64?: string
  sizeBytes: number
  /** Opaque-only content watermark; matches lastWrittenHash. */
  opaqueHash?: string
  /** When the snapshot pair was persisted — pairing witness, NOT a generic
   *  modified-time. Meta-only updates must not bump it (a bump without a
   *  new envelope would fabricate a lost-snapshot reconcile case). */
  savedAt: number
}

export interface DaemonWorkspaceState {
  workspaceId: string
  mountId: string
  deviceId: string
  /** Advanced by pull only, never by push. */
  lastAckedSeq: number
  /**
   * Set once the tree adoption pass (ISSUE-0044: bind disk files to
   * existing fileIds by path) has completed. Absent on fresh state AND on
   * pre-adoption legacy state — both re-run adoption, which is idempotent
   * over already-bound views.
   */
  adoptedAt?: number
  files: Record<string, DaemonFileState>
  pendingRenames: PendingRename[]
  pendingDeletes: PendingDelete[]
}

interface SnapshotEnvelope {
  fileId: string
  snapshotB64: string
  /** Captured from the same doc state as the snapshot — the authoritative pair. */
  syncedVVB64: string
  savedAt: number
}

export interface DaemonReadyFile {
  fileId: string
  fileState: DaemonFileState
  snapshot: Uint8Array
  syncedVVB64: string
}

export interface DaemonReconcileResult {
  state: DaemonWorkspaceState
  /** Markdown files whose snapshot pair is intact — hydrate locally. */
  ready: DaemonReadyFile[]
  /** Markdown files needing a fresh server snapshot (lost/corrupt envelope). */
  refetch: { fileId: string; fileState: DaemonFileState }[]
  /** True when the state artifact itself was missing/corrupt — full reset. */
  fresh: boolean
}

export const STATE_ARTIFACT = 'workspace-state.json'
/** Spool directory for delete-resolution commands. One file per command
 *  (named by its unique id) so enqueue (CLI) and drain (daemon) are
 *  independent atomic file operations — no shared read-modify-write, no lock,
 *  no lost commands under concurrent `glovebox sync deletes`. */
export const DELETE_RESOLUTION_DIR = 'delete-resolutions/'

export function deleteResolutionName(id: string): string {
  return `${DELETE_RESOLUTION_DIR}${encodeURIComponent(id)}.json`
}

const ENVELOPE_PREFIX = 'loro/'
const ENVELOPE_SUFFIX = '.snapshot.json'

/** Storage artifact name of a file's snapshot envelope (read-only tools —
 *  `glovebox status` — inspect envelopes without running a reconcile). */
export function envelopeName(fileId: string): string {
  return `${ENVELOPE_PREFIX}${encodeURIComponent(fileId)}${ENVELOPE_SUFFIX}`
}

function envelopeFileId(name: string): string | null {
  if (!name.startsWith(ENVELOPE_PREFIX) || !name.endsWith(ENVELOPE_SUFFIX)) return null
  const middle = name.slice(ENVELOPE_PREFIX.length, name.length - ENVELOPE_SUFFIX.length)
  try {
    return decodeURIComponent(middle)
  } catch {
    return null
  }
}

export interface DaemonStateStoreOptions {
  workspaceId: string
  mountId: string
  deviceId: string
  now?: () => number
}

export class DaemonStateStore {
  readonly #storage: DaemonStorage
  readonly #workspaceId: string
  readonly #mountId: string
  readonly #deviceId: string
  readonly #now: () => number

  constructor(storage: DaemonStorage, options: DaemonStateStoreOptions) {
    this.#storage = storage
    this.#workspaceId = options.workspaceId
    this.#mountId = options.mountId
    this.#deviceId = options.deviceId
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Persist a markdown file: snapshot envelope FIRST, then the state entry.
   * A crash between the writes leaves a newer envelope than state —
   * reconcile case 1, harmless (the envelope carries its own VV). The
   * reverse order would fabricate a lost-snapshot case on every crash.
   */
  async persistMarkdownFile(
    fileId: string,
    pair: { snapshot: Uint8Array; syncedVVB64: string },
    meta: {
      path: string
      nodeId: string | null
      lastWrittenHash: string
      lastWrittenVVB64: string
      sizeBytes: number
    },
  ): Promise<void> {
    const savedAt = this.#now()
    const envelope: SnapshotEnvelope = {
      fileId,
      snapshotB64: bytesToBase64(pair.snapshot),
      syncedVVB64: pair.syncedVVB64,
      savedAt,
    }
    await this.#storage.writeAtomic(envelopeName(fileId), encodeJson(envelope))

    const state = await this.#loadStateOrFresh()
    state.files[fileId] = {
      path: meta.path,
      contentKind: 'markdown',
      nodeId: meta.nodeId,
      syncedVVB64: pair.syncedVVB64,
      lastWrittenHash: meta.lastWrittenHash,
      lastWrittenVVB64: meta.lastWrittenVVB64,
      sizeBytes: meta.sizeBytes,
      savedAt,
    }
    await this.#saveState(state)
  }

  /**
   * Drop a file's snapshot envelope without touching its state entry — the
   * md→opaque view transition (kind-boundary rename, ISSUE-0043) persists
   * the entry as opaque and must not leave an orphan envelope for the next
   * reconcile to clean up.
   */
  async dropEnvelope(fileId: string): Promise<void> {
    await this.#storage.delete(envelopeName(fileId))
  }

  /** Opaque files are watermark-only — state entry, no Loro envelope. */
  async persistOpaqueFile(
    fileId: string,
    meta: {
      path: string
      nodeId: string | null
      opaqueHash: string
      sizeBytes: number
    },
  ): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.files[fileId] = {
      path: meta.path,
      contentKind: 'opaque',
      nodeId: meta.nodeId,
      syncedVVB64: '',
      lastWrittenHash: meta.opaqueHash,
      sizeBytes: meta.sizeBytes,
      opaqueHash: meta.opaqueHash,
      savedAt: this.#now(),
    }
    await this.#saveState(state)
  }

  /**
   * Roll forward disk-facing fields (checkout watermark, observed inode,
   * rename) without touching the snapshot pair. Deliberately does NOT bump
   * `savedAt` — see DaemonFileState.savedAt.
   */
  async updateFileMeta(
    fileId: string,
    meta: Partial<
      Pick<
        DaemonFileState,
        'path' | 'nodeId' | 'lastWrittenHash' | 'lastWrittenVVB64' | 'sizeBytes' | 'opaqueHash'
      >
    >,
  ): Promise<void> {
    const state = await this.#loadStateOrFresh()
    const file = state.files[fileId]
    if (!file) return
    Object.assign(file, meta)
    await this.#saveState(state)
  }

  async setLastAckedSeq(seq: number): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.lastAckedSeq = seq
    await this.#saveState(state)
  }

  /** Adoption completed — written LAST so a crash mid-adoption re-runs it. */
  async markAdopted(): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.adoptedAt = this.#now()
    await this.#saveState(state)
  }

  async setPendingRenames(renames: PendingRename[]): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.pendingRenames = renames
    await this.#saveState(state)
  }

  async setPendingDeletes(deletes: PendingDelete[]): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.pendingDeletes = deletes
    await this.#saveState(state)
  }

  /**
   * Commit a delete-resolution pass atomically: the surviving pending deletes
   * AND the watermark clears for restored files land in ONE state write. Two
   * separate writes (setPendingDeletes + updateFileMeta) leave a crash window
   * where a restored file has an emptied watermark while its delete intent is
   * still persisted — a restart re-holds it and a later confirm would delete
   * the very file the user asked to restore.
   */
  async commitDeleteResolutions(
    deletes: PendingDelete[],
    restoredFileIds: Iterable<string>,
  ): Promise<void> {
    const state = await this.#loadStateOrFresh()
    state.pendingDeletes = deletes
    for (const fileId of restoredFileIds) {
      const file = state.files[fileId]
      if (!file) continue
      file.lastWrittenHash = ''
      if (file.contentKind === 'opaque') file.opaqueHash = ''
    }
    await this.#saveState(state)
  }

  /**
   * Envelope first, then state: a crash between leaves a state entry whose
   * envelope is gone — reconcile refetches that file, and pull discovers
   * the deletion. The reverse order would leave an orphan envelope, which
   * reconcile also drops; both windows are recoverable.
   */
  async removeFile(fileId: string): Promise<void> {
    await this.#storage.delete(envelopeName(fileId))
    const state = await this.#loadStateOrFresh()
    if (fileId in state.files) {
      delete state.files[fileId]
      await this.#saveState(state)
    }
  }

  /** Startup reconcile across the two artifacts (INV-6). */
  async load(): Promise<DaemonReconcileResult> {
    const state = await this.#readState()

    if (state === null) {
      // Full reset: drop any orphan envelopes so a later save can't pair
      // stale bytes with a fresh state artifact.
      await this.#dropAllEnvelopes()
      return { state: this.#freshState(), ready: [], refetch: [], fresh: true }
    }

    const ready: DaemonReadyFile[] = []
    const refetch: { fileId: string; fileState: DaemonFileState }[] = []

    for (const [fileId, fileState] of Object.entries(state.files)) {
      if (fileState.contentKind === 'opaque') continue
      const envelope = await this.#readEnvelope(fileId)
      if (envelope === null || envelope.savedAt < fileState.savedAt) {
        // Lost/corrupt envelope or one older than the state entry: the
        // local doc cannot be proven to match lastAckedSeq — hydrate this
        // file fresh from the server; the cursor stays (the fresh server
        // snapshot is at-or-past it).
        refetch.push({ fileId, fileState })
        await this.#storage.delete(envelopeName(fileId))
        continue
      }
      ready.push({
        fileId,
        fileState,
        snapshot: base64ToBytes(envelope.snapshotB64),
        // Envelope is the authority; the FileState copy is a cache.
        syncedVVB64: envelope.syncedVVB64,
      })
    }

    // Orphan envelopes (no state entry, or the entry went opaque) come from
    // a crash between the two writes of a first save — dropped, never
    // guessed at.
    for (const name of await this.#storage.list()) {
      const fileId = envelopeFileId(name)
      if (fileId === null) continue
      if (!(fileId in state.files) || state.files[fileId]!.contentKind === 'opaque') {
        await this.#storage.delete(name)
      }
    }

    return { state, ready, refetch, fresh: false }
  }

  async #readState(): Promise<DaemonWorkspaceState | null> {
    return readWorkspaceState(this.#storage)
  }

  async #readEnvelope(fileId: string): Promise<SnapshotEnvelope | null> {
    const bytes = await this.#storage.read(envelopeName(fileId))
    if (bytes === null) return null
    const value = decodeJson(bytes)
    if (!isSnapshotEnvelope(value)) return null
    if (!importable(value.snapshotB64)) return null
    return value
  }

  async #dropAllEnvelopes(): Promise<void> {
    for (const name of await this.#storage.list()) {
      if (envelopeFileId(name) !== null) {
        await this.#storage.delete(name)
      }
    }
  }

  async #loadStateOrFresh(): Promise<DaemonWorkspaceState> {
    return (await this.#readState()) ?? this.#freshState()
  }

  async #saveState(state: DaemonWorkspaceState): Promise<void> {
    await this.#storage.writeAtomic(STATE_ARTIFACT, encodeJson(state))
  }

  #freshState(): DaemonWorkspaceState {
    return {
      workspaceId: this.#workspaceId,
      mountId: this.#mountId,
      deviceId: this.#deviceId,
      lastAckedSeq: 0,
      files: {},
      pendingRenames: [],
      pendingDeletes: [],
    }
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

function importable(snapshotB64: string): boolean {
  try {
    LoroFileDoc.fromSnapshot(base64ToBytes(snapshotB64))
    return true
  } catch {
    return false
  }
}

/**
 * Read and VALIDATE the workspace-state artifact, returning null when it is
 * absent, unparseable, or fails the schema gate — it never throws on a
 * truncated/corrupt file. This is the single reader the daemon's own load()
 * uses; the CLI (`status`, `sync deletes`) MUST go through it too, so a
 * half-written state can't crash those commands or be cast-trusted into a
 * confident-but-wrong listing.
 */
export async function readWorkspaceState(
  storage: DaemonStorage,
): Promise<DaemonWorkspaceState | null> {
  const bytes = await storage.read(STATE_ARTIFACT)
  if (bytes === null) return null
  const value = decodeJson(bytes)
  return isWorkspaceState(value) ? value : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// A plain-object record, NOT an array. `files` must be keyed by fileId; an
// array like `[fileState]` is a non-null object whose Object.entries keys are
// numeric indexes ("0", "1") — it would otherwise pass and the daemon would
// adopt array indexes as file IDs.
function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

// Element guards validate EVERY required field of each nested entry (and the
// type of each optional field when present) — not just that the entry is a
// non-null object. A shallow check lets a record with a missing/garbage opId,
// baseSeq, or watermark pass readWorkspaceState; the daemon would then build
// submitBatch ops with undefined identifiers (#propagateTreeOps) or hydrate
// views with invalid watermarks (start()) — the same "trust invalid persisted
// state" hazard this gate exists to stop. A failing entry makes the WHOLE
// state read as null (CLI: not-initialized; daemon: fresh + re-sync), the same
// safe path as truncated JSON. The daemon always writes complete records, so
// only genuinely-corrupt state is rejected.
function isFileState(value: unknown): value is DaemonFileState {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    (value.contentKind === 'markdown' || value.contentKind === 'opaque') &&
    (value.nodeId === null || typeof value.nodeId === 'string') &&
    typeof value.syncedVVB64 === 'string' &&
    typeof value.lastWrittenHash === 'string' &&
    typeof value.sizeBytes === 'number' &&
    typeof value.savedAt === 'number' &&
    isOptionalString(value.lastWrittenVVB64) &&
    isOptionalString(value.opaqueHash)
  )
}

function isPendingDelete(value: unknown): value is PendingDelete {
  return (
    isRecord(value) &&
    typeof value.opId === 'string' &&
    typeof value.fileId === 'string' &&
    typeof value.path === 'string' &&
    typeof value.baseSeq === 'number' &&
    typeof value.observedMissingAtMs === 'number' &&
    (value.held === undefined || value.held === 'bulk-startup' || value.held === 'bulk-window') &&
    isOptionalNumber(value.confirmedAtMs)
  )
}

function isPendingRename(value: unknown): value is PendingRename {
  return (
    isRecord(value) &&
    typeof value.opId === 'string' &&
    typeof value.fileId === 'string' &&
    typeof value.fromPath === 'string' &&
    typeof value.toPath === 'string' &&
    typeof value.baseSeq === 'number'
  )
}

function isWorkspaceState(value: unknown): value is DaemonWorkspaceState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as DaemonWorkspaceState
  return (
    typeof state.workspaceId === 'string' &&
    typeof state.mountId === 'string' &&
    typeof state.deviceId === 'string' &&
    typeof state.lastAckedSeq === 'number' &&
    isRecord(state.files) &&
    Object.values(state.files).every(isFileState) &&
    Array.isArray(state.pendingRenames) &&
    state.pendingRenames.every(isPendingRename) &&
    Array.isArray(state.pendingDeletes) &&
    state.pendingDeletes.every(isPendingDelete)
  )
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as SnapshotEnvelope
  return (
    typeof envelope.fileId === 'string' &&
    typeof envelope.snapshotB64 === 'string' &&
    typeof envelope.syncedVVB64 === 'string' &&
    typeof envelope.savedAt === 'number'
  )
}

/** In-memory implementation for tests and the M3/M4 harness. */
export class MemoryDaemonStorage implements DaemonStorage {
  readonly #artifacts = new Map<string, Uint8Array>()

  async read(name: string): Promise<Uint8Array | null> {
    const bytes = this.#artifacts.get(name)
    return bytes === undefined ? null : Uint8Array.from(bytes)
  }

  async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    this.#artifacts.set(name, Uint8Array.from(bytes))
  }

  async delete(name: string): Promise<void> {
    this.#artifacts.delete(name)
  }

  async list(prefix?: string): Promise<string[]> {
    const names = [...this.#artifacts.keys()]
    return (prefix === undefined ? names : names.filter((name) => name.startsWith(prefix))).sort()
  }
}
