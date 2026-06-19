export const WS_PATHS = {
  doc: '/ws/doc',
  tree: '/ws/tree',
  workspace: '/ws/workspace',
} as const

export const CUSTOM_MESSAGE_PREFIX = '__GB:'

export const PERSISTENCE = {
  debounceMs: 250,
  compactBytesThreshold: 10_240,
  compactCountThreshold: 500,
} as const

export const LIMITS = {
  maxUpdateBytes: 1_048_576,
  maxMarkdownBytes: 1_048_576,
  maxOpaqueBytes: 10 * 1024 * 1024,
} as const

export const SYNC = {
  watcherStabilityThresholdMs: 250,
  localDirtyCoalesceMs: 1_000,
  renameCorrectionWindowMs: 2_000,
  deleteDelayMs: 30_000,
  runtimeBulkDeleteWindowMs: 10_000,
  /** Runtime bulk holds are an interim wipe guard, not a small-batch UX.
   *  Startup still catches 100% first-scan wipes, so runtime holds now require
   *  a materially larger burst: either 100 absences in the window, or at least
   *  25 absences that are 35%+ of the tracked tree. */
  runtimeBulkDeleteMinCount: 100,
  runtimeBulkDeleteRatio: 0.35,
  runtimeBulkDeleteRatioFloor: 25,
  periodicRescanMs: 1_800_000,
  periodicRescanJitterMin: 0.75,
  periodicRescanJitterMax: 1.25,
  stateFlushDebounceMs: 250,
  pingIntervalMs: 30_000,
  reconnectGracePeriodMs: 5_000,
  maxReconnectDurationMs: 30_000,
  snapshotDriftThreshold: 50,
} as const

export const DO_STORAGE_KEYS = {
  state: 'ydoc:state:doc',
  bytes: 'ydoc:state:bytes',
  count: 'ydoc:state:count',
  updatePrefix: 'ydoc:update:',
} as const

export const TREE_STORAGE_KEYS = {
  state: 'tree:state:doc',
} as const

export function snapshotKey(workspaceId: string, fileId: string): string {
  return `${workspaceId}/snapshots/${fileId}/latest`
}
