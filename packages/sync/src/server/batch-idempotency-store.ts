import type { WorkspaceChangeEvent } from '@glovebox.md/core'
import { bytesToBase64 } from '../loro/base64.ts'
import type { WorkspaceSqlStorageLike } from './workspace-store.ts'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

interface IdempotencyRow extends Record<string, ArrayBuffer | string | number | null> {
  op_id: string
  device_id: string
  applied_at: number
  events_json: string
  accepted_op_json: string | null
  snapshots_json: string | null
}

interface IdempotencyAcceptedOp {
  opId: string
  binding?: {
    localFileId?: string
    fileId: string
    path: string
  }
}

interface IdempotencySnapshot {
  fileId: string
  contentVersion: Uint8Array<ArrayBuffer>
  loroSnapshot: Uint8Array<ArrayBuffer>
  textContent: string
}

interface IdempotencyRecord {
  opId: string
  deviceId: string
  appliedAt: number
  events: WorkspaceChangeEvent[]
  acceptedOp: IdempotencyAcceptedOp | null
  snapshots: IdempotencySnapshot[]
}

/**
 * Records the canonical events emitted for each accepted client opId so
 * retries return cached results instead of re-applying.
 *
 * Old records age out after `RETENTION_MS`. The applier never accepts an
 * opId older than that — clients are expected to rebase via baseSeq.
 */
export class WorkspaceIdempotencyStore {
  readonly #storage: WorkspaceSqlStorageLike
  #initialized = false

  constructor(storage: WorkspaceSqlStorageLike) {
    this.#storage = storage
  }

  ensureInitialized(): void {
    if (this.#initialized) return

    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspace_idempotency (
          op_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          applied_at INTEGER NOT NULL,
          events_json TEXT NOT NULL,
          accepted_op_json TEXT,
          snapshots_json TEXT
        )
      `)
      try {
        this.#storage.sql.exec(`ALTER TABLE workspace_idempotency ADD COLUMN accepted_op_json TEXT`)
      } catch {
        // Existing DO storage may already have this prototype column.
      }
      try {
        this.#storage.sql.exec(`ALTER TABLE workspace_idempotency ADD COLUMN snapshots_json TEXT`)
      } catch {
        // Existing DO storage may already have this prototype column.
      }
      this.#storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_workspace_idempotency_applied_at
        ON workspace_idempotency (applied_at)
      `)
    })

    this.#initialized = true
  }

  lookup(opId: string): IdempotencyRecord | null {
    this.ensureInitialized()
    const row = this.#storage.sql
      .exec<IdempotencyRow>(
        `
          SELECT
            op_id,
            device_id,
            applied_at,
            events_json,
            accepted_op_json,
            snapshots_json
          FROM workspace_idempotency
          WHERE op_id = ?
          LIMIT 1
        `,
        opId,
      )
      .toArray()[0]

    if (!row) return null

    let events: WorkspaceChangeEvent[]
    try {
      events = JSON.parse(row.events_json) as WorkspaceChangeEvent[]
    } catch {
      return null
    }

    let acceptedOp: IdempotencyAcceptedOp | null = null
    if (row.accepted_op_json) {
      try {
        acceptedOp = JSON.parse(row.accepted_op_json) as IdempotencyAcceptedOp
      } catch {
        acceptedOp = null
      }
    }

    let snapshots: IdempotencySnapshot[] = []
    if (row.snapshots_json) {
      try {
        snapshots = (JSON.parse(row.snapshots_json) as StoredSnapshot[]).map(fromStoredSnapshot)
      } catch {
        snapshots = []
      }
    }

    return {
      opId: row.op_id,
      deviceId: row.device_id,
      appliedAt: row.applied_at,
      events,
      acceptedOp,
      snapshots,
    }
  }

  record(
    opId: string,
    deviceId: string,
    record: {
      events: WorkspaceChangeEvent[]
      acceptedOp: IdempotencyAcceptedOp
      snapshots: readonly IdempotencySnapshot[]
    },
  ): void {
    this.ensureInitialized()
    const now = Date.now()
    this.#storage.transactionSync(() => {
      this.#storage.sql.exec(
        `
          INSERT OR REPLACE INTO workspace_idempotency (
            op_id,
            device_id,
            applied_at,
            events_json,
            accepted_op_json,
            snapshots_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        opId,
        deviceId,
        now,
        JSON.stringify(record.events),
        JSON.stringify(record.acceptedOp),
        JSON.stringify(record.snapshots.map(toStoredSnapshot)),
      )
      this.#prune(now)
    })
  }

  #prune(now: number): void {
    this.#storage.sql.exec(
      `DELETE FROM workspace_idempotency WHERE applied_at < ?`,
      now - RETENTION_MS,
    )
  }
}

interface StoredSnapshot {
  fileId: string
  contentVersionB64: string
  loroSnapshotB64: string
  textContent: string
}

function toStoredSnapshot(snapshot: IdempotencySnapshot): StoredSnapshot {
  return {
    fileId: snapshot.fileId,
    contentVersionB64: bytesToBase64(snapshot.contentVersion),
    loroSnapshotB64: bytesToBase64(snapshot.loroSnapshot),
    textContent: snapshot.textContent,
  }
}

function fromStoredSnapshot(snapshot: StoredSnapshot): IdempotencySnapshot {
  return {
    fileId: snapshot.fileId,
    contentVersion: base64ToBytes(snapshot.contentVersionB64),
    loroSnapshot: base64ToBytes(snapshot.loroSnapshotB64),
    textContent: snapshot.textContent,
  }
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value) return new Uint8Array()
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
