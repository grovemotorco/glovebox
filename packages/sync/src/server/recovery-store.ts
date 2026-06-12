import type { WorkspaceSqlStorage } from './workspace-server.ts'

/**
 * Server-side recovery records (ISSUE-0041): every deferred/rejected op and
 * every conflict loser lands here instead of disappearing (INV-2). Payloads
 * are explicit JSON with base64-encoded byte fields. Deviation from the
 * issue's schema: no `workspaceId` column — the store lives inside the one
 * DO that IS the workspace.
 */

export interface WorkspaceRecoveryRecord {
  recordId: string
  fileId: string | null
  /** Original client opId; unique, so replays cannot double-write. */
  opId: string
  reason: string
  deviceId: string
  observedPath: string | null
  /** JSON with base64-encoded byte fields. */
  payload: string
  createdAt: number
  acknowledgedAt: number | null
}

export interface RecoveryRecordInput {
  fileId?: string
  opId: string
  reason: string
  deviceId: string
  observedPath?: string
  payload: string
}

const UNACKNOWLEDGED_TTL_MS = 90 * 24 * 60 * 60 * 1000
const ACKNOWLEDGED_TTL_MS = 7 * 24 * 60 * 60 * 1000

export class WorkspaceRecoveryStore {
  readonly #sql: WorkspaceSqlStorage
  readonly #now: () => number
  readonly #newRecordId: () => string

  constructor(sql: WorkspaceSqlStorage, now: () => number, newRecordId?: () => string) {
    this.#sql = sql
    this.#now = now
    this.#newRecordId = newRecordId ?? (() => crypto.randomUUID())
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS workspace_recovery_records (record_id TEXT PRIMARY KEY, file_id TEXT, op_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, device_id TEXT NOT NULL, observed_path TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER)',
    )
  }

  /** Insert a record; a replayed opId is a no-op. Returns the recordId or null when deduped. */
  record(input: RecoveryRecordInput): string | null {
    const recordId = this.#newRecordId()
    const rows = this.#sql
      .exec(
        'INSERT INTO workspace_recovery_records (record_id, file_id, op_id, reason, device_id, observed_path, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(op_id) DO NOTHING RETURNING record_id',
        recordId,
        input.fileId ?? null,
        input.opId,
        input.reason,
        input.deviceId,
        input.observedPath ?? null,
        input.payload,
        this.#now(),
      )
      .toArray()
    return rows.length > 0 ? recordId : null
  }

  list(options: { pendingOnly?: boolean } = {}): WorkspaceRecoveryRecord[] {
    const where = options.pendingOnly ? 'WHERE acknowledged_at IS NULL' : ''
    return this.#sql
      .exec(`SELECT * FROM workspace_recovery_records ${where} ORDER BY created_at ASC`)
      .toArray()
      .map((row) => ({
        recordId: row.record_id as string,
        fileId: row.file_id as string | null,
        opId: row.op_id as string,
        reason: row.reason as string,
        deviceId: row.device_id as string,
        observedPath: row.observed_path as string | null,
        payload: row.payload as string,
        createdAt: Number(row.created_at),
        acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
      }))
  }

  acknowledge(recordId: string): boolean {
    const rows = this.#sql
      .exec(
        'UPDATE workspace_recovery_records SET acknowledged_at = ? WHERE record_id = ? AND acknowledged_at IS NULL RETURNING record_id',
        this.#now(),
        recordId,
      )
      .toArray()
    return rows.length > 0
  }

  /** TTL pruning: 90 days unacknowledged, 7 days after acknowledgment. */
  prune(): number {
    const now = this.#now()
    const rows = this.#sql
      .exec(
        'DELETE FROM workspace_recovery_records WHERE (acknowledged_at IS NULL AND created_at + ? <= ?) OR (acknowledged_at IS NOT NULL AND acknowledged_at + ? <= ?) RETURNING record_id',
        UNACKNOWLEDGED_TTL_MS,
        now,
        ACKNOWLEDGED_TTL_MS,
        now,
      )
      .toArray()
    return rows.length
  }
}
