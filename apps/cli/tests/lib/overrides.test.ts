import { describe, expect, it } from 'vitest'
import { parseSyncOverrides } from '../../src/lib/overrides.ts'

describe('GLOVEBOX_SYNC_OVERRIDES parsing', () => {
  it('accepts well-typed overrides', () => {
    const overrides = parseSyncOverrides({
      GLOVEBOX_SYNC_OVERRIDES: JSON.stringify({
        deletePolicy: { tombstoneDelayMs: 3000, sentinelPath: '.custom.json' },
        rescanIntervalMs: 250,
        watchDebounceMs: 50,
      }),
    })
    expect(overrides.deletePolicy).toEqual({ tombstoneDelayMs: 3000, sentinelPath: '.custom.json' })
    expect(overrides.rescanIntervalMs).toBe(250)
  })

  it('empty env means no overrides', () => {
    expect(parseSyncOverrides({})).toEqual({})
  })

  it('rejects unknown deletePolicy keys', () => {
    expect(() =>
      parseSyncOverrides({
        GLOVEBOX_SYNC_OVERRIDES: '{"deletePolicy":{"tombstonDelayMs":3000}}',
      }),
    ).toThrow(/unknown deletePolicy key/)
  })

  it('rejects mistyped deletePolicy values — a quoted number would make the daemon and status diverge', () => {
    // "2500" passes the daemon's coercing relational checks but
    // string-concatenates in status's countdown arithmetic (~564k years).
    expect(() =>
      parseSyncOverrides({
        GLOVEBOX_SYNC_OVERRIDES: '{"deletePolicy":{"tombstoneDelayMs":"2500"}}',
      }),
    ).toThrow(/must be a number/)
    expect(() =>
      parseSyncOverrides({
        GLOVEBOX_SYNC_OVERRIDES: '{"deletePolicy":{"sentinelPath":42}}',
      }),
    ).toThrow(/must be a string/)
  })

  it('rejects mistyped top-level keys and malformed JSON', () => {
    expect(() =>
      parseSyncOverrides({ GLOVEBOX_SYNC_OVERRIDES: '{"rescanIntervalMs":"250"}' }),
    ).toThrow(/must be a number/)
    expect(() => parseSyncOverrides({ GLOVEBOX_SYNC_OVERRIDES: 'not json' })).toThrow()
  })
})
