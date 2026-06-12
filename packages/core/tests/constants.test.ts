import { describe, expect, test } from 'vitest'
import {
  CUSTOM_MESSAGE_PREFIX,
  DO_STORAGE_KEYS,
  LIMITS,
  PERSISTENCE,
  SYNC,
  TREE_STORAGE_KEYS,
  WS_PATHS,
  snapshotKey,
} from '../src/index.ts'

describe('core constants', () => {
  test('exposes expected websocket paths and protocol prefix', () => {
    expect(WS_PATHS).toEqual({
      doc: '/ws/doc',
      tree: '/ws/tree',
      workspace: '/ws/workspace',
    })
    expect(CUSTOM_MESSAGE_PREFIX).toBe('__GB:')
  })

  test('keeps persistence and size guardrails intact', () => {
    expect(PERSISTENCE.debounceMs).toBe(250)
    expect(PERSISTENCE.compactBytesThreshold).toBe(10_240)
    expect(PERSISTENCE.compactCountThreshold).toBe(500)
    expect(LIMITS.maxUpdateBytes).toBe(1_048_576)
    expect(LIMITS.maxMarkdownBytes).toBe(1_048_576)
    expect(SYNC.watcherStabilityThresholdMs).toBe(250)
    expect(SYNC.renameCorrectionWindowMs).toBe(2_000)
    expect(SYNC.deleteDelayMs).toBe(30_000)
    expect(SYNC.reconnectGracePeriodMs).toBe(5_000)
  })

  test('exposes durable object storage keys', () => {
    expect(DO_STORAGE_KEYS).toEqual({
      state: 'ydoc:state:doc',
      bytes: 'ydoc:state:bytes',
      count: 'ydoc:state:count',
      updatePrefix: 'ydoc:update:',
    })
    expect(TREE_STORAGE_KEYS).toEqual({
      state: 'tree:state:doc',
    })
  })

  test('builds snapshot object key', () => {
    expect(snapshotKey('ws-123', 'file-456')).toBe('ws-123/snapshots/file-456/latest')
  })
})
