import type { Database } from '../storage.js'

// Watermarks owned by the DO. Keyed by (k, backend) so a single
// workspace can host more than one backend and each keeps its own
// sync cursors. The container's appliedPushRev lives in-memory on
// the container side; we don't store it here.
//
// pushRev   — last DO-side rev successfully pushed to the backend.
// fetchRev  — last backend-side rev the DO has fetched and applied.
//
// initializeSchema() seeds both at 0 in _vfs_watermark for the
// default backend. The schema table is the durability surface;
// readers and writers always go through this module so the SQL
// stays in one place.
//
// `backend` defaults to DEFAULT_BACKEND_ID so older callers that
// only ran one backend (or ran the package against a schema before
// per-backend keying landed) keep working unchanged. The v2 → v3
// schema migration backfills the column on existing rows with the
// same default.
export type WatermarkKey = 'pushRev' | 'fetchRev'

export const DEFAULT_BACKEND_ID = 'default'

export function readWatermark(
  db: Database,
  key: WatermarkKey,
  backend: string = DEFAULT_BACKEND_ID,
): number {
  return (
    db.scalar<number>('SELECT v FROM _vfs_watermark WHERE k = ? AND backend = ?', key, backend) ?? 0
  )
}

export function writeWatermark(
  db: Database,
  key: WatermarkKey,
  value: number,
  backend: string = DEFAULT_BACKEND_ID,
): void {
  db.run(
    'INSERT INTO _vfs_watermark (k, backend, v) VALUES (?, ?, ?) ' +
      'ON CONFLICT(k, backend) DO UPDATE SET v = excluded.v',
    key,
    backend,
    value,
  )
}

// The latest rev stamped on any DO-side mutation. coalesceChanges
// reads this implicitly via vfs_nodes.rev; the sync layer exposes it
// to callers that want to record "what cursor should I pass back as
// sinceRev next time".
export function currentRev(db: Database): number {
  return db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0
}
