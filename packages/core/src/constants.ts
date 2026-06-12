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
} as const

export const SYNC = {
  watcherStabilityThresholdMs: 250,
  localDirtyCoalesceMs: 1_000,
  renameCorrectionWindowMs: 2_000,
  deleteDelayMs: 30_000,
  runtimeBulkDeleteWindowMs: 10_000,
  runtimeBulkDeleteMinCount: 20,
  runtimeBulkDeleteRatio: 0.1,
  /** The ratio guard needs at least this many deletes in the window —
   *  without a floor, one delete in a 3-file workspace (ratio 0.33) would
   *  hold every single-file delete forever. */
  runtimeBulkDeleteRatioFloor: 3,
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
