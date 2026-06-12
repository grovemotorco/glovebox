import { LoroFileDoc } from './file-doc.ts'
import type {
  LoroContentVersion,
  LoroFileImportResult,
  LoroFileMaterialized,
  LoroFileState,
  LoroSnapshot,
  LoroUpdate,
} from './types.ts'

/**
 * The minimum interface a workspace-side store must implement to back a Loro
 * file. Persistence shape (KV vs SQL) is the implementer's choice; this just
 * pins the read/write surface that the WorkspaceDO and tests need.
 */
export interface LoroFileStore {
  /** Read the current persisted snapshot + update log for a file. */
  loadState(fileId: string): Promise<LoroFileState | null>

  /** Append updates to a file's update log; storage MUST preserve order. */
  appendUpdates(fileId: string, updates: readonly LoroUpdate[]): Promise<void>

  /** Replace the current snapshot and clear the update log atomically. */
  replaceSnapshot(fileId: string, snapshot: LoroSnapshot): Promise<void>

  /** Drop all state for a file (e.g. when the workspace tombstones it). */
  deleteFile(fileId: string): Promise<void>
}

/**
 * Compaction policy. The server can run compaction synchronously after a
 * batch (`{ inline: true }`) or defer to alarms.
 */
export interface CompactionPolicy {
  /** Force a snapshot rewrite once the update log size meets/exceeds this byte budget. */
  maxUpdateBytes?: number
  /** Force a snapshot rewrite once the update log length meets/exceeds this count. */
  maxUpdateCount?: number
}

const DEFAULT_COMPACTION: CompactionPolicy = {
  maxUpdateBytes: 64 * 1024,
  maxUpdateCount: 64,
}

export interface LoroFileServiceOptions {
  compaction?: CompactionPolicy
}

/**
 * Thrown by `importUpdates` when applying a batch would grow the materialized
 * text past the caller's cap. Raised before anything is persisted — the
 * stored doc is unchanged.
 */
export class LoroFileTooLargeError extends Error {
  constructor(fileId: string, sizeBytes: number, maxBytes: number) {
    super(`File ${fileId} would be ${sizeBytes} bytes; cap is ${maxBytes}`)
    this.name = 'LoroFileTooLargeError'
  }
}

/**
 * Cached materialized doc plus the update-log accounting `#maybeCompact`
 * needs, so the hot path never re-reads the log just to size it.
 */
interface CachedFile {
  doc: LoroFileDoc
  logCount: number
  logBytes: number
}

/** Bounded LRU so a many-file workspace can't pin unbounded WASM memory. */
const DOC_CACHE_LIMIT = 64

const utf8 = new TextEncoder()

/**
 * High-level operations on a Loro-backed file. Encapsulates load/import/export
 * around the storage interface so callers don't have to round-trip through
 * `LoroFileDoc` themselves.
 *
 * Materialized docs are cached per fileId: re-importing a large doc's full
 * snapshot from storage on every submit made each keystroke O(doc). The store
 * stays the source of truth — every mutation flows through this service, which
 * keeps the cached doc in lockstep and drops it whenever the persisted shape
 * could diverge (trim, failed import, delete).
 */
export class LoroFileService {
  readonly #store: LoroFileStore
  readonly #compaction: CompactionPolicy
  readonly #cache = new Map<string, CachedFile>()

  constructor(store: LoroFileStore, options: LoroFileServiceOptions = {}) {
    this.#store = store
    this.#compaction = { ...DEFAULT_COMPACTION, ...options.compaction }
  }

  /**
   * Materialize a PRIVATE copy from storage. Returns null when the file has
   * no state yet. Callers mutate the returned doc as a scratch pad (e.g. to
   * diff a server edit), so it must never alias the cached instance.
   */
  async load(fileId: string): Promise<LoroFileDoc | null> {
    const state = await this.#store.loadState(fileId)
    if (!state) {
      return null
    }

    return LoroFileDoc.fromState(state)
  }

  /**
   * The shared materialized doc, loaded once and kept in lockstep with the
   * store. READ/IMPORT ONLY inside this service — never handed to callers.
   */
  async #getCached(fileId: string): Promise<CachedFile | null> {
    const cached = this.#cache.get(fileId)
    if (cached) {
      // LRU bump.
      this.#cache.delete(fileId)
      this.#cache.set(fileId, cached)
      return cached
    }
    const state = await this.#store.loadState(fileId)
    if (!state) return null
    let logBytes = 0
    for (const update of state.updates) logBytes += update.byteLength
    return this.#cachePut(fileId, {
      doc: LoroFileDoc.fromState(state),
      logCount: state.updates.length,
      logBytes,
    })
  }

  #cachePut(fileId: string, entry: CachedFile): CachedFile {
    this.#cache.delete(fileId)
    this.#cache.set(fileId, entry)
    while (this.#cache.size > DOC_CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value
      if (oldest === undefined) break
      this.#cache.delete(oldest)
    }
    return entry
  }

  async materialize(fileId: string): Promise<LoroFileMaterialized | null> {
    const cached = await this.#getCached(fileId)
    if (!cached) {
      return null
    }

    const textContent = cached.doc.getTextContent()
    return {
      contentVersion: cached.doc.contentVersion(),
      textContent,
      sizeBytes: utf8.encode(textContent).byteLength,
    }
  }

  /** History floor of the stored doc; null when the file has no state yet. */
  async shallowSinceVersion(fileId: string): Promise<LoroContentVersion | null> {
    const cached = await this.#getCached(fileId)
    return cached ? cached.doc.shallowSinceVersion() : null
  }

  /**
   * Initialize a new file with optional initial content. Persists the snapshot
   * immediately so subsequent loads have a baseline.
   */
  async initialize(fileId: string, initialContent?: string): Promise<LoroFileMaterialized> {
    const doc = LoroFileDoc.empty(initialContent)
    const snapshot = doc.exportSnapshot()
    await this.#store.replaceSnapshot(fileId, snapshot)
    this.#cachePut(fileId, { doc, logCount: 0, logBytes: 0 })

    const textContent = doc.getTextContent()
    return {
      contentVersion: doc.contentVersion(),
      textContent,
      sizeBytes: utf8.encode(textContent).byteLength,
    }
  }

  /**
   * Apply a batch of updates from a peer. The store is the source of truth:
   * we apply to the cached doc, persist the deltas, then optionally compact.
   */
  async importUpdates(
    fileId: string,
    updates: readonly (LoroUpdate | LoroSnapshot)[],
    options: { maxTextBytes?: number } = {},
  ): Promise<LoroFileImportResult> {
    if (updates.length === 0) {
      const materialized = await this.materialize(fileId)
      const empty = materialized ?? (await this.initialize(fileId))
      return {
        appliedUpdates: 0,
        contentVersion: empty.contentVersion,
        textContent: empty.textContent,
        changed: false,
      }
    }

    const cached = await this.#getCached(fileId)
    const entry = cached ?? { doc: LoroFileDoc.empty(), logCount: 0, logBytes: 0 }

    const accepted: LoroUpdate[] = []
    try {
      for (const update of updates) {
        if (entry.doc.importUpdate(update)) {
          accepted.push(update)
        }
      }
    } catch (error) {
      // The import may have partially applied — the cached doc no longer
      // mirrors the store. Drop it so the next access reloads clean state.
      this.#cache.delete(fileId)
      throw error
    }

    if (accepted.length === 0) {
      return {
        appliedUpdates: 0,
        contentVersion: entry.doc.contentVersion(),
        textContent: entry.doc.getTextContent(),
        changed: false,
      }
    }

    const textContent = entry.doc.getTextContent()
    if (options.maxTextBytes !== undefined) {
      const sizeBytes = utf8.encode(textContent).byteLength
      if (sizeBytes > options.maxTextBytes) {
        // Nothing was persisted; un-cache the now-diverged doc.
        this.#cache.delete(fileId)
        throw new LoroFileTooLargeError(fileId, sizeBytes, options.maxTextBytes)
      }
    }

    if (cached === null) {
      await this.#store.replaceSnapshot(fileId, entry.doc.exportSnapshot())
      this.#cachePut(fileId, entry)
    } else {
      await this.#store.appendUpdates(fileId, accepted)
      for (const update of accepted) {
        entry.logCount += 1
        entry.logBytes += update.byteLength
      }
      await this.#maybeCompact(fileId, entry)
    }

    return {
      appliedUpdates: accepted.length,
      contentVersion: entry.doc.contentVersion(),
      textContent,
      changed: true,
    }
  }

  /**
   * Replace text content directly (server-driven authoritative writes, e.g.
   * the daemon submitting a fresh-create snapshot). Re-snapshots the file.
   */
  async setTextContent(fileId: string, content: string): Promise<LoroFileMaterialized> {
    const cached = await this.#getCached(fileId)
    const entry = cached ?? { doc: LoroFileDoc.empty(), logCount: 0, logBytes: 0 }
    entry.doc.setTextContent(content)
    const snapshot = entry.doc.exportSnapshot()
    await this.#store.replaceSnapshot(fileId, snapshot)
    entry.logCount = 0
    entry.logBytes = 0
    this.#cachePut(fileId, entry)

    const textContent = entry.doc.getTextContent()
    return {
      contentVersion: entry.doc.contentVersion(),
      textContent,
      sizeBytes: utf8.encode(textContent).byteLength,
    }
  }

  /**
   * Export the bytes a remote peer would need to advance from `since`. Returns
   * null when the file has no persisted state yet.
   */
  async exportUpdateSince(
    fileId: string,
    since: LoroContentVersion | null,
  ): Promise<LoroUpdate | null> {
    const cached = await this.#getCached(fileId)
    if (!cached) {
      return null
    }

    return cached.doc.exportUpdateSince(since)
  }

  async exportSnapshot(fileId: string): Promise<LoroSnapshot | null> {
    const cached = await this.#getCached(fileId)
    if (!cached) {
      return null
    }

    return cached.doc.exportSnapshot()
  }

  async exportShallowSnapshot(fileId: string): Promise<LoroSnapshot | null> {
    const cached = await this.#getCached(fileId)
    if (!cached) {
      return null
    }

    return cached.doc.exportShallowSnapshot()
  }

  async compact(fileId: string): Promise<boolean> {
    const cached = await this.#getCached(fileId)
    if (!cached) {
      return false
    }

    await this.#store.replaceSnapshot(fileId, cached.doc.exportSnapshot())
    cached.logCount = 0
    cached.logBytes = 0
    return true
  }

  /**
   * Discard history before the doc's current frontiers (spec §3.4 trim).
   * The caller owns the coordination gate — after this, updates whose base
   * predates the new floor can only land via `history-pruned` repair.
   */
  async trimToShallow(fileId: string): Promise<boolean> {
    const cached = await this.#getCached(fileId)
    if (!cached) {
      return false
    }

    await this.#store.replaceSnapshot(fileId, cached.doc.exportShallowSnapshot())
    // The in-memory doc still carries the trimmed history (its shallow floor
    // is stale) — reload from the store on next access.
    this.#cache.delete(fileId)
    return true
  }

  async delete(fileId: string): Promise<void> {
    this.#cache.delete(fileId)
    await this.#store.deleteFile(fileId)
  }

  /**
   * Drop the cached doc for a file whose storage was mutated outside this
   * service (e.g. the batch applier's raw structural delete). Sync so it can
   * be called from sync applier hooks.
   */
  evict(fileId: string): void {
    this.#cache.delete(fileId)
  }

  async #maybeCompact(fileId: string, entry: CachedFile): Promise<void> {
    const policy = this.#compaction
    const dueByCount =
      policy.maxUpdateCount !== undefined && entry.logCount >= policy.maxUpdateCount
    const dueByBytes =
      policy.maxUpdateBytes !== undefined && entry.logBytes >= policy.maxUpdateBytes
    if (!dueByCount && !dueByBytes) return
    await this.#store.replaceSnapshot(fileId, entry.doc.exportSnapshot())
    entry.logCount = 0
    entry.logBytes = 0
  }
}

/**
 * In-memory store. Convenient for tests and for the daemon's pending-op queue
 * before it's been promoted to disk persistence.
 */
export class InMemoryLoroFileStore implements LoroFileStore {
  readonly #files = new Map<string, { snapshot: LoroSnapshot | null; updates: LoroUpdate[] }>()

  async loadState(fileId: string): Promise<LoroFileState | null> {
    const entry = this.#files.get(fileId)
    if (!entry) return null
    return { snapshot: entry.snapshot, updates: [...entry.updates] }
  }

  async appendUpdates(fileId: string, updates: readonly LoroUpdate[]): Promise<void> {
    const entry = this.#files.get(fileId) ?? { snapshot: null, updates: [] }
    entry.updates.push(...updates)
    this.#files.set(fileId, entry)
  }

  async replaceSnapshot(fileId: string, snapshot: LoroSnapshot): Promise<void> {
    this.#files.set(fileId, { snapshot, updates: [] })
  }

  async deleteFile(fileId: string): Promise<void> {
    this.#files.delete(fileId)
  }

  /** Test helper: peek state without copying the update array. */
  peek(fileId: string): LoroFileState | null {
    const entry = this.#files.get(fileId)
    if (!entry) return null
    return { snapshot: entry.snapshot, updates: entry.updates }
  }
}
