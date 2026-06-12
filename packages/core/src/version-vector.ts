import type { VersionVector } from './types.ts'

export type VersionRelation = 'equal' | 'left-dominates' | 'right-dominates' | 'concurrent'

export function compareVersionVectors(left: VersionVector, right: VersionVector): VersionRelation {
  const devices = new Set([...Object.keys(left), ...Object.keys(right)])
  let leftGreater = false
  let rightGreater = false

  for (const deviceId of devices) {
    const l = left[deviceId] ?? 0
    const r = right[deviceId] ?? 0
    if (l > r) leftGreater = true
    if (r > l) rightGreater = true
  }

  if (!leftGreater && !rightGreater) return 'equal'
  if (leftGreater && !rightGreater) return 'left-dominates'
  if (rightGreater && !leftGreater) return 'right-dominates'
  return 'concurrent'
}

export function sameVersionVector(left: VersionVector, right: VersionVector): boolean {
  const devices = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const deviceId of devices) {
    if ((left[deviceId] ?? 0) !== (right[deviceId] ?? 0)) {
      return false
    }
  }
  return true
}

export function sameOptionalVersionVector(
  left: VersionVector | undefined,
  right: VersionVector | undefined,
): boolean {
  if (!left || !right) {
    return left === right
  }
  return sameVersionVector(left, right)
}

export function mergeVersionVectors(
  left: VersionVector | undefined,
  right: VersionVector | undefined,
): VersionVector {
  const merged: VersionVector = {}
  for (const deviceId of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) {
    merged[deviceId] = Math.max(left?.[deviceId] ?? 0, right?.[deviceId] ?? 0)
  }
  return merged
}

export function bumpVersionVector(vector: VersionVector, deviceId: string): VersionVector {
  return {
    ...vector,
    [deviceId]: (vector[deviceId] ?? 0) + 1,
  }
}

export function versionVectorIncludes(left: VersionVector, right: VersionVector): boolean {
  const deviceIds = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const deviceId of deviceIds) {
    if ((left[deviceId] ?? 0) < (right[deviceId] ?? 0)) {
      return false
    }
  }
  return true
}

export function serializeVersionVector(vector: VersionVector): string {
  return JSON.stringify(vector)
}

export function parseVersionVector(raw: string | null, fallback: VersionVector): VersionVector {
  if (typeof raw !== 'string' || raw.length === 0) {
    return fallback
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const vector: VersionVector = {}
    for (const [deviceId, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        vector[deviceId] = value
      }
    }
    return Object.keys(vector).length > 0 ? vector : fallback
  } catch {
    return fallback
  }
}
