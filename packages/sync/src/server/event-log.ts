import type { WorkspaceSqlStorage } from './workspace-server.ts'

/**
 * Durable workspace event log (`workspace_changes`) in DO SQLite. `seq` is
 * the only ordering clients ever see (dofs's internal `rev` stays inside the
 * storage layer). The log keeps a bounded replay window; a client whose
 * cursor has fallen behind the window gets `snapshot-required` — never a
 * partial incremental stream.
 */

export interface WorkspaceEventRow {
  seq: number
  type: string
  fileId: string
  /** JSON-encoded event body as it was broadcast. */
  payload: string
}

export type WorkspaceEventRead =
  | { ok: true; events: WorkspaceEventRow[]; currentSeq: number }
  | { ok: false; reason: 'snapshot-required'; currentSeq: number }

export const DEFAULT_REPLAY_WINDOW = 10_000

export class WorkspaceEventLog {
  readonly #sql: WorkspaceSqlStorage
  readonly #window: number
  readonly #now: () => number

  constructor(sql: WorkspaceSqlStorage, now: () => number, window = DEFAULT_REPLAY_WINDOW) {
    this.#sql = sql
    this.#window = window
    this.#now = now
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS workspace_changes (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, file_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)',
    )
    // ONE seq domain for the whole workspace: this is the same counter row
    // WorkspaceStore allocates from (`workspace_meta`, key 'seq'), so wire
    // events and per-file tree seqs are directly comparable — the applier's
    // stale-baseSeq policy (file.seq > op.baseSeq) only works when a
    // client's events.since cursor lives in the same domain as file seqs.
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS workspace_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    )
  }

  /**
   * Persist an event and return its seq. The counter row (not MAX(seq)) is
   * the authority, so pruning the window can never regress or reuse a seq.
   */
  append(type: string, fileId: string, payload: string): number {
    const rows = this.#sql
      .exec(
        "INSERT INTO workspace_meta (key, value) VALUES ('seq', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value",
      )
      .toArray()
    const seq = Number(rows[0]!.value)
    this.#record(seq, type, fileId, payload)
    return seq
  }

  /**
   * Persist an event at a seq the WorkspaceStore already allocated for the
   * same change (shared counter). Every allocation must produce exactly one
   * wire event — a burned seq would read as a gap to live-broadcast
   * consumers and trigger spurious pulls.
   */
  appendAt(seq: number, type: string, fileId: string, payload: string): void {
    this.#record(seq, type, fileId, payload)
  }

  #record(seq: number, type: string, fileId: string, payload: string): void {
    this.#sql.exec(
      'INSERT INTO workspace_changes (seq, type, file_id, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      seq,
      type,
      fileId,
      payload,
      this.#now(),
    )
    this.#sql.exec('DELETE FROM workspace_changes WHERE seq <= ?', seq - this.#window)
  }

  currentSeq(): number {
    const rows = this.#sql.exec("SELECT value FROM workspace_meta WHERE key = 'seq'").toArray()
    return rows.length === 0 ? 0 : Number(rows[0]!.value)
  }

  /**
   * Events with seq > afterSeq, oldest first. When the cursor predates the
   * retained window the caller must re-snapshot — a gap is never papered
   * over with a partial stream.
   */
  since(afterSeq: number): WorkspaceEventRead {
    const currentSeq = this.currentSeq()
    if (afterSeq >= currentSeq) {
      return { ok: true, events: [], currentSeq }
    }

    const floorRows = this.#sql.exec('SELECT MIN(seq) AS floor FROM workspace_changes').toArray()
    const floor = floorRows[0]?.floor
    if (floor === null || floor === undefined || afterSeq + 1 < Number(floor)) {
      return { ok: false, reason: 'snapshot-required', currentSeq }
    }

    const events = this.#sql
      .exec(
        'SELECT seq, type, file_id, payload FROM workspace_changes WHERE seq > ? ORDER BY seq ASC',
        afterSeq,
      )
      .toArray()
      .map((row) => ({
        seq: Number(row.seq),
        type: row.type as string,
        fileId: row.file_id as string,
        payload: row.payload as string,
      }))
    return { ok: true, events, currentSeq }
  }
}
