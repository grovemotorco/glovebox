import { LoroFileDoc } from '../loro/file-doc.ts'
import type { LoroSnapshot, LoroUpdate } from '../loro/types.ts'
import type { WorkspaceSqlStorageLike } from './workspace-store.ts'

interface LoroFileRow extends Record<string, ArrayBuffer | string | number | null> {
  file_id: string
  snapshot: ArrayBuffer | null
  updated_at: number
}

interface LoroUpdateRow extends Record<string, ArrayBuffer | string | number | null> {
  seq: number
  update_data: ArrayBuffer
}

const COMPACT_AFTER_UPDATES = 64
const COMPACT_AFTER_BYTES = 64 * 1024
const DEFAULT_MAX_OPEN_DOCS = 32
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000

interface WorkspaceLoroStoreOptions {
  maxOpenDocs?: number
  idleTtlMs?: number
  now?: () => number
}

interface WorkspaceLoroCacheStats {
  openDocs: number
  maxOpenDocs: number
  idleTtlMs: number
}

function asUint8Array(value: ArrayBuffer | null): Uint8Array | null {
  if (!value) return null
  return new Uint8Array(value)
}

/**
 * SQL-backed per-file Loro store on the DO.
 *
 * Layout:
 *   workspace_loro_files       — snapshot blob per file, last-updated metadata
 *   workspace_loro_updates     — append-only update log per file
 *
 * The store is sync because DO sql is sync. Compaction runs inline once the
 * update log exceeds policy thresholds.
 */
export class WorkspaceLoroStore {
  readonly #storage: WorkspaceSqlStorageLike
  readonly #maxOpenDocs: number
  readonly #idleTtlMs: number
  readonly #now: () => number
  readonly #cache = new Map<string, { doc: LoroFileDoc; lastAccessedAt: number }>()
  #initialized = false

  constructor(storage: WorkspaceSqlStorageLike, options: WorkspaceLoroStoreOptions = {}) {
    this.#storage = storage
    this.#maxOpenDocs = Math.max(1, Math.trunc(options.maxOpenDocs ?? DEFAULT_MAX_OPEN_DOCS))
    this.#idleTtlMs = Math.max(1, Math.trunc(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS))
    this.#now = options.now ?? (() => Date.now())
  }

  ensureInitialized(): void {
    if (this.#initialized) return

    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspace_loro_files (
          file_id TEXT PRIMARY KEY,
          snapshot BLOB,
          updated_at INTEGER NOT NULL
        )
      `)
      this.#storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspace_loro_updates (
          file_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          update_data BLOB NOT NULL,
          PRIMARY KEY (file_id, seq)
        )
      `)
    })

    this.#initialized = true
  }

  /** Materialize a doc from snapshot + queued updates. */
  loadDoc(fileId: string): LoroFileDoc | null {
    this.ensureInitialized()
    this.#evictIdle()

    const cached = this.#cache.get(fileId)
    if (cached) {
      cached.lastAccessedAt = this.#now()
      return cached.doc
    }

    const snapshotRow = this.#storage.sql
      .exec<LoroFileRow>(
        `SELECT file_id, snapshot, updated_at FROM workspace_loro_files WHERE file_id = ? LIMIT 1`,
        fileId,
      )
      .toArray()[0]

    const updates = this.#storage.sql
      .exec<LoroUpdateRow>(
        `SELECT seq, update_data FROM workspace_loro_updates WHERE file_id = ? ORDER BY seq ASC`,
        fileId,
      )
      .toArray()
      .map((row) => new Uint8Array(row.update_data))

    const snapshot = snapshotRow ? asUint8Array(snapshotRow.snapshot) : null
    if (!snapshot && updates.length === 0) {
      return null
    }

    return this.#rememberDoc(fileId, LoroFileDoc.fromState({ snapshot, updates }))
  }

  /** Initialize a new file with optional initial content. */
  initialize(fileId: string, initialContent?: string): LoroFileDoc {
    this.ensureInitialized()

    const doc = LoroFileDoc.empty(initialContent)
    const snapshot = doc.exportSnapshot()

    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `
          INSERT INTO workspace_loro_files (file_id, snapshot, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(file_id) DO UPDATE SET
            snapshot = excluded.snapshot,
            updated_at = excluded.updated_at
        `,
        fileId,
        snapshot,
        this.#now(),
      )
      this.#storage.sql.exec(`DELETE FROM workspace_loro_updates WHERE file_id = ?`, fileId)
    })

    return this.#rememberDoc(fileId, doc)
  }

  /**
   * Apply an update to a file. Returns the materialized doc post-import, or
   * null if the file doesn't exist yet (caller should `initialize` first).
   * Compacts inline when policy thresholds are met.
   */
  importUpdate(fileId: string, update: LoroUpdate): { doc: LoroFileDoc; changed: boolean } | null {
    this.ensureInitialized()

    const doc = this.loadDoc(fileId)
    if (!doc) return null

    const changed = doc.importUpdate(update)
    if (!changed) {
      this.#rememberDoc(fileId, doc)
      return { doc, changed: false }
    }

    this.#storage.transactionSync(() => {
      const stats = this.#getStats(fileId)
      if (
        stats.updateCount + 1 >= COMPACT_AFTER_UPDATES ||
        stats.updateBytes + update.byteLength >= COMPACT_AFTER_BYTES
      ) {
        this.#storage.sql.exec(
          `
            INSERT INTO workspace_loro_files (file_id, snapshot, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(file_id) DO UPDATE SET
              snapshot = excluded.snapshot,
              updated_at = excluded.updated_at
          `,
          fileId,
          doc.exportSnapshot(),
          this.#now(),
        )
        this.#storage.sql.exec(`DELETE FROM workspace_loro_updates WHERE file_id = ?`, fileId)
        return
      }

      const nextSeq = stats.lastSeq + 1
      this.#storage.sql.exec(
        `INSERT INTO workspace_loro_updates (file_id, seq, update_data) VALUES (?, ?, ?)`,
        fileId,
        nextSeq,
        update,
      )
      this.#storage.sql.exec(
        `UPDATE workspace_loro_files SET updated_at = ? WHERE file_id = ?`,
        this.#now(),
        fileId,
      )
    })

    this.#rememberDoc(fileId, doc)
    return { doc, changed: true }
  }

  /**
   * Update the Loro doc's text to match an external authoritative value (e.g.
   * the Yjs path's debounced metadata sync). Loads existing state, runs
   * `setTextContent` (which Loro turns into a minimal diff), and persists
   * the new snapshot. Returns `null` when the text is unchanged.
   */
  setTextContent(fileId: string, newText: string): { changed: boolean; snapshot: LoroSnapshot } {
    this.ensureInitialized()

    const existing = this.loadDoc(fileId) ?? LoroFileDoc.empty()
    const before = existing.getTextContent()
    if (before === newText) {
      const snapshot = existing.exportSnapshot()
      this.replaceWithSnapshot(fileId, snapshot)
      return { changed: false, snapshot: new Uint8Array(snapshot) }
    }

    existing.setTextContent(newText)
    const snapshot = existing.exportSnapshot()
    this.replaceWithSnapshot(fileId, snapshot)
    return { changed: true, snapshot: new Uint8Array(snapshot) }
  }

  /** Replace text content directly and re-snapshot. Used for fresh creates. */
  replaceWithSnapshot(fileId: string, snapshot: LoroSnapshot): void {
    this.ensureInitialized()

    this.#persistSnapshot(fileId, snapshot)
    this.#rememberDoc(fileId, LoroFileDoc.fromSnapshot(snapshot))
  }

  delete(fileId: string): void {
    this.ensureInitialized()
    this.#cache.delete(fileId)
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(`DELETE FROM workspace_loro_files WHERE file_id = ?`, fileId)
      this.#storage.sql.exec(`DELETE FROM workspace_loro_updates WHERE file_id = ?`, fileId)
    })
  }

  /** Read just the snapshot bytes (without replaying updates). */
  readSnapshot(fileId: string): LoroSnapshot | null {
    this.ensureInitialized()
    const row = this.#storage.sql
      .exec<LoroFileRow>(
        `SELECT file_id, snapshot, updated_at FROM workspace_loro_files WHERE file_id = ? LIMIT 1`,
        fileId,
      )
      .toArray()[0]
    return row ? asUint8Array(row.snapshot) : null
  }

  cacheStats(): WorkspaceLoroCacheStats {
    this.#evictIdle()
    return {
      openDocs: this.#cache.size,
      maxOpenDocs: this.#maxOpenDocs,
      idleTtlMs: this.#idleTtlMs,
    }
  }

  #rememberDoc(fileId: string, doc: LoroFileDoc): LoroFileDoc {
    this.#cache.set(fileId, { doc, lastAccessedAt: this.#now() })
    this.#evictIfNeeded()
    return doc
  }

  #evictIdle(): void {
    const cutoff = this.#now() - this.#idleTtlMs
    for (const [fileId, cached] of this.#cache) {
      if (cached.lastAccessedAt < cutoff) {
        this.#snapshotAndDrop(fileId, cached.doc)
      }
    }
  }

  #evictIfNeeded(): void {
    this.#evictIdle()
    while (this.#cache.size > this.#maxOpenDocs) {
      let oldestFileId: string | null = null
      let oldestAccess = Number.POSITIVE_INFINITY
      for (const [fileId, cached] of this.#cache) {
        if (cached.lastAccessedAt < oldestAccess) {
          oldestFileId = fileId
          oldestAccess = cached.lastAccessedAt
        }
      }
      if (!oldestFileId) return
      const cached = this.#cache.get(oldestFileId)
      if (!cached) return
      this.#snapshotAndDrop(oldestFileId, cached.doc)
    }
  }

  #snapshotAndDrop(fileId: string, doc: LoroFileDoc): void {
    this.#persistSnapshot(fileId, doc.exportSnapshot())
    this.#cache.delete(fileId)
  }

  #persistSnapshot(fileId: string, snapshot: LoroSnapshot): void {
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `
          INSERT INTO workspace_loro_files (file_id, snapshot, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(file_id) DO UPDATE SET
            snapshot = excluded.snapshot,
            updated_at = excluded.updated_at
        `,
        fileId,
        snapshot,
        this.#now(),
      )
      this.#storage.sql.exec(`DELETE FROM workspace_loro_updates WHERE file_id = ?`, fileId)
    })
  }

  #getStats(fileId: string): { updateCount: number; updateBytes: number; lastSeq: number } {
    const aggregate = this.#storage.sql
      .exec<{ count: number; total_bytes: number | null; max_seq: number | null }>(
        `
          SELECT
            COUNT(*) as count,
            COALESCE(SUM(LENGTH(update_data)), 0) AS total_bytes,
            MAX(seq) AS max_seq
          FROM workspace_loro_updates
          WHERE file_id = ?
        `,
        fileId,
      )
      .toArray()[0]
    return {
      updateCount: aggregate?.count ?? 0,
      updateBytes: aggregate?.total_bytes ?? 0,
      lastSeq: aggregate?.max_seq ?? 0,
    }
  }
}
