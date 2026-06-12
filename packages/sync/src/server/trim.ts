import { VersionVector, decodeImportBlobMeta } from 'loro-crdt'
import { versionDominates } from '../loro/file-doc.ts'
import type { WorkspaceSqlStorage } from './workspace-server.ts'

/**
 * Bookkeeping for server-coordinated shallow-snapshot trimming (spec §3.4):
 * the DO may trim a file's history to a frontier only when every registered
 * client's synced version dominates it — a shallow doc cannot import updates
 * concurrent with the trim point.
 *
 * What the server can know soundly, it tracks as a LOWER BOUND of each
 * device's knowledge, from the two signals that prove transfer:
 *
 * - a served snapshot (`snapshot.get`) proves the device holds the full doc
 *   at the served version;
 * - an accepted `content.submit` proves the device holds its declared base
 *   plus every op inside the submitted update (`decodeImportBlobMeta`'s
 *   partial end VV).
 *
 * Broadcast deliveries are NOT tracked (they may be dropped), so the bound
 * under-approximates — which only ever delays a trim, never corrupts one.
 * Registrations expire after `registrationTtlMs` of per-file inactivity; a
 * device that reappears from beyond a trim floor goes through the existing
 * `history-pruned` repair path (M0.3), which is exactly the spec's escape
 * hatch for stragglers.
 */

export interface TrimPolicy {
  /** A file is trim-eligible only after this long without content activity. */
  idleMs: number
  /** Per-device-per-file registrations expire after this much inactivity. */
  registrationTtlMs: number
}

export const DEFAULT_TRIM_POLICY: TrimPolicy = {
  idleMs: 60 * 60 * 1000,
  registrationTtlMs: 30 * 24 * 60 * 60 * 1000,
}

export class TrimCoordinator {
  readonly #sql: WorkspaceSqlStorage
  readonly #now: () => number
  readonly #policy: TrimPolicy

  constructor(sql: WorkspaceSqlStorage, now: () => number, policy?: Partial<TrimPolicy>) {
    this.#sql = sql
    this.#now = now
    this.#policy = { ...DEFAULT_TRIM_POLICY, ...policy }
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS trim_registrations (device_id TEXT NOT NULL, file_id TEXT NOT NULL, synced_vv BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (device_id, file_id))',
    )
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS file_activity (file_id TEXT PRIMARY KEY, last_content_at INTEGER NOT NULL)',
    )
  }

  /** A content change landed; the file is not idle. */
  noteActivity(fileId: string): void {
    this.#sql.exec(
      'INSERT INTO file_activity (file_id, last_content_at) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET last_content_at = excluded.last_content_at',
      fileId,
      this.#now(),
    )
  }

  /** A full snapshot at `version` was served to `deviceId`. */
  noteSnapshotServed(deviceId: string, fileId: string, version: Uint8Array): void {
    this.#mergeRegistration(deviceId, fileId, [version])
  }

  /**
   * An update from `deviceId` was accepted: the device provably holds its
   * declared base plus everything inside the update bytes.
   */
  noteSubmit(deviceId: string, fileId: string, base: Uint8Array, update: Uint8Array): void {
    let updateEnd: Uint8Array | null = null
    try {
      updateEnd = decodeImportBlobMeta(update, false).partialEndVersionVector.encode()
    } catch {
      // Unparseable header — fall back to the base alone (still sound).
    }
    this.#mergeRegistration(deviceId, fileId, updateEnd ? [base, updateEnd] : [base])
  }

  /** Files with no content activity for at least `idleMs`. */
  idleFiles(): string[] {
    return this.#sql
      .exec(
        'SELECT file_id FROM file_activity WHERE last_content_at + ? <= ?',
        this.#policy.idleMs,
        this.#now(),
      )
      .toArray()
      .map((row) => row.file_id as string)
  }

  /**
   * True when every live registration for the file dominates `version` —
   * the §3.4 gate for trimming to that version.
   */
  allRegistrantsDominate(fileId: string, version: Uint8Array): boolean {
    const liveAfter = this.#now() - this.#policy.registrationTtlMs
    const rows = this.#sql
      .exec(
        'SELECT synced_vv FROM trim_registrations WHERE file_id = ? AND updated_at > ?',
        fileId,
        liveAfter,
      )
      .toArray()
    return rows.every((row) => versionDominates(toBytes(row.synced_vv), version))
  }

  /**
   * A trim landed: consume the activity row so the file leaves the idle
   * set until the next content change re-inserts it. Without this an
   * unchanged idle file would re-trim on every maintenance pass (the
   * shallow root op is always retained, so the floor never reaches the
   * head and a floor-vs-head check cannot detect "nothing new").
   */
  noteTrimmed(fileId: string): void {
    this.#sql.exec('DELETE FROM file_activity WHERE file_id = ?', fileId)
  }

  /** Drop all bookkeeping for a deleted file. */
  forgetFile(fileId: string): void {
    this.#sql.exec('DELETE FROM trim_registrations WHERE file_id = ?', fileId)
    this.#sql.exec('DELETE FROM file_activity WHERE file_id = ?', fileId)
  }

  /** Remove registrations beyond the TTL (run from maintenance). */
  pruneRegistrations(): number {
    const liveAfter = this.#now() - this.#policy.registrationTtlMs
    return this.#sql
      .exec('DELETE FROM trim_registrations WHERE updated_at <= ? RETURNING device_id', liveAfter)
      .toArray().length
  }

  #mergeRegistration(deviceId: string, fileId: string, versions: readonly Uint8Array[]): void {
    const rows = this.#sql
      .exec(
        'SELECT synced_vv FROM trim_registrations WHERE device_id = ? AND file_id = ?',
        deviceId,
        fileId,
      )
      .toArray()
    const existing = rows[0] ? [toBytes(rows[0].synced_vv)] : []
    const merged = joinVersions([...existing, ...versions])
    this.#sql.exec(
      'INSERT INTO trim_registrations (device_id, file_id, synced_vv, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, file_id) DO UPDATE SET synced_vv = excluded.synced_vv, updated_at = excluded.updated_at',
      deviceId,
      fileId,
      toArrayBuffer(merged),
      this.#now(),
    )
  }
}

/** Per-peer maximum across encoded version vectors. */
export function joinVersions(versions: readonly Uint8Array[]): Uint8Array {
  const joined = new Map<`${number}`, number>()
  for (const bytes of versions) {
    if (bytes.byteLength === 0) continue
    const map = VersionVector.decode(bytes).toJSON()
    for (const [peer, counter] of map) {
      const current = joined.get(peer)
      if (current === undefined || counter > current) joined.set(peer, counter)
    }
  }
  return VersionVector.parseJSON(joined).encode()
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  throw new Error('Expected BLOB bytes from SQLite')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
