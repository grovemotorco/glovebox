import type { DaemonDeletePolicy } from '@glovebox/sync/daemon'

/**
 * `GLOVEBOX_SYNC_OVERRIDES` — a JSON env lever for tests and local
 * debugging ONLY (the M8 gate test shrinks the INV-3 tombstone delay and
 * rescan interval with it; production never sets it). Malformed JSON is a
 * hard error: a silently ignored override would make a test lie.
 */

export interface SyncOverrides {
  deletePolicy?: Partial<DaemonDeletePolicy>
  rescanIntervalMs?: number
  watchDebounceMs?: number
  backoffInitialMs?: number
}

const DELETE_POLICY_KEYS: Record<string, 'number' | 'string'> = {
  tombstoneDelayMs: 'number',
  renameCorrectionWindowMs: 'number',
  bulkWindowMs: 'number',
  bulkMinCount: 'number',
  bulkRatio: 'number',
  bulkRatioFloor: 'number',
  sentinelPath: 'string',
}

export function parseSyncOverrides(env: NodeJS.ProcessEnv = process.env): SyncOverrides {
  const raw = env.GLOVEBOX_SYNC_OVERRIDES
  if (!raw) {
    return {}
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const overrides: SyncOverrides = {}
  if (parsed.deletePolicy && typeof parsed.deletePolicy === 'object') {
    const policy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(parsed.deletePolicy)) {
      const expected = DELETE_POLICY_KEYS[key]
      if (!expected) {
        throw new Error(`GLOVEBOX_SYNC_OVERRIDES: unknown deletePolicy key "${key}"`)
      }
      // Values must be type-checked too: a quoted number coerces fine in
      // the daemon's relational checks but string-CONCATENATES in status's
      // countdown arithmetic — a silent daemon/status divergence.
      if (
        typeof value !== expected ||
        (expected === 'number' && !Number.isFinite(value as number))
      ) {
        throw new Error(`GLOVEBOX_SYNC_OVERRIDES: deletePolicy.${key} must be a ${expected}`)
      }
      policy[key] = value
    }
    overrides.deletePolicy = policy as Partial<DaemonDeletePolicy>
  }
  for (const key of ['rescanIntervalMs', 'watchDebounceMs', 'backoffInitialMs'] as const) {
    const value = parsed[key]
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`GLOVEBOX_SYNC_OVERRIDES: ${key} must be a number`)
      }
      overrides[key] = value
    }
  }
  return overrides
}
