/**
 * Loro per-file CRDT primitives used by both the server (WorkspaceDO) and the
 * daemon. The server is authoritative: it owns path/identity policy and the
 * canonical workspace event log; this module only owns markdown content merge.
 *
 * All byte fields are wasm-bindgen-shaped Uint8Array values that round-trip
 * through `LoroDoc.export(...)`/`LoroDoc.import(...)`.
 */

/**
 * Serialized Loro version vector — output of `LoroDoc.oplogVersion().encode()`.
 * Used by clients to ask "give me updates after this point".
 */
export type LoroContentVersion = Uint8Array

/**
 * Serialized Loro frontiers — output of
 * `LoroDoc.oplogFrontiers().toJSON()` re-encoded as bytes.
 * Used by shallow snapshots so older history can be archived.
 */
export type LoroFrontiers = Uint8Array

/** Update bytes from `LoroDoc.export({ mode: 'update', from }).` */
export type LoroUpdate = Uint8Array

/**
 * Snapshot bytes from `LoroDoc.export({ mode: 'snapshot' })` or
 * `{ mode: 'shallow-snapshot', frontiers }`.
 */
export type LoroSnapshot = Uint8Array

/** The single root text container used for markdown documents. */
export const TEXT_CONTAINER_ID = 'content'

/**
 * Stored shape for a single file's Loro state.
 *
 * Snapshot is the compaction baseline. Updates are append-only deltas that have
 * not yet been folded into the snapshot. Materializing the doc means importing
 * the snapshot then replaying updates in order.
 */
export interface LoroFileState {
  snapshot: LoroSnapshot | null
  updates: readonly LoroUpdate[]
}

/** Result of importing a batch of updates into a stored file. */
export interface LoroFileImportResult {
  /** Number of updates that were not already-known to the doc. */
  appliedUpdates: number
  /** Version vector after the batch. */
  contentVersion: LoroContentVersion
  /** Materialized text content after the batch. */
  textContent: string
  /** Whether the batch advanced the doc version (some update was new). */
  changed: boolean
}

export interface LoroFileMaterialized {
  contentVersion: LoroContentVersion
  textContent: string
  sizeBytes: number
}
