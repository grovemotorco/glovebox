import type { LoroFileStore } from '../loro/file-store.ts'
import type { LoroFileState, LoroSnapshot, LoroUpdate } from '../loro/types.ts'
import type { WorkspaceSqlStorage } from './workspace-server.ts'

/**
 * Loro per-file store on DO SQLite: one row per pending update (ordered by
 * `idx`) and the compaction snapshot chunked across rows, staying under the
 * 2 MiB DO SQLite value cap (glyphdown's STATE_CHUNK_BYTES discipline).
 * Replaces the demo-grade one-JSON-value-per-file KV shape.
 */

export const SNAPSHOT_CHUNK_BYTES = 1_572_864 // 1.5 MiB

export class SqliteLoroFileStore implements LoroFileStore {
  readonly #sql: WorkspaceSqlStorage
  readonly #chunkBytes: number

  constructor(sql: WorkspaceSqlStorage, chunkBytes = SNAPSHOT_CHUNK_BYTES) {
    this.#sql = sql
    this.#chunkBytes = chunkBytes
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS loro_snapshots (file_id TEXT NOT NULL, chunk_idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (file_id, chunk_idx))',
    )
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS loro_updates (file_id TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (file_id, idx))',
    )
  }

  async loadState(fileId: string): Promise<LoroFileState | null> {
    const chunks = this.#sql
      .exec('SELECT bytes FROM loro_snapshots WHERE file_id = ? ORDER BY chunk_idx ASC', fileId)
      .toArray()
      .map((row) => toBytes(row.bytes))
    const updates = this.#sql
      .exec('SELECT bytes FROM loro_updates WHERE file_id = ? ORDER BY idx ASC', fileId)
      .toArray()
      .map((row) => toBytes(row.bytes))

    if (chunks.length === 0 && updates.length === 0) return null
    return {
      snapshot: chunks.length > 0 ? concat(chunks) : null,
      updates,
    }
  }

  async appendUpdates(fileId: string, updates: readonly LoroUpdate[]): Promise<void> {
    if (updates.length === 0) return
    const rows = this.#sql
      .exec('SELECT MAX(idx) AS top FROM loro_updates WHERE file_id = ?', fileId)
      .toArray()
    const top = rows[0]?.top
    let next = top === null || top === undefined ? 0 : Number(top) + 1
    for (const update of updates) {
      this.#sql.exec(
        'INSERT INTO loro_updates (file_id, idx, bytes) VALUES (?, ?, ?)',
        fileId,
        next,
        toArrayBuffer(update),
      )
      next += 1
    }
  }

  async replaceSnapshot(fileId: string, snapshot: LoroSnapshot): Promise<void> {
    this.#sql.exec('DELETE FROM loro_snapshots WHERE file_id = ?', fileId)
    this.#sql.exec('DELETE FROM loro_updates WHERE file_id = ?', fileId)
    for (let i = 0, idx = 0; i < snapshot.byteLength; i += this.#chunkBytes, idx += 1) {
      this.#sql.exec(
        'INSERT INTO loro_snapshots (file_id, chunk_idx, bytes) VALUES (?, ?, ?)',
        fileId,
        idx,
        toArrayBuffer(snapshot.subarray(i, i + this.#chunkBytes)),
      )
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    this.#sql.exec('DELETE FROM loro_snapshots WHERE file_id = ?', fileId)
    this.#sql.exec('DELETE FROM loro_updates WHERE file_id = ?', fileId)
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  throw new Error('Expected BLOB bytes from SQLite')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
