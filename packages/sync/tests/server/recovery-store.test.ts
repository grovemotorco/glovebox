import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { WorkspaceRecoveryStore } from '../../src/server/recovery-store.ts'
import type { WorkspaceSqlStorage, WorkspaceSqlValue } from '../../src/server/workspace-server.ts'

class FakeSqlStorage implements WorkspaceSqlStorage {
  readonly #db = new DatabaseSync(':memory:')

  exec(
    query: string,
    ...bindings: WorkspaceSqlValue[]
  ): { toArray(): Record<string, WorkspaceSqlValue>[] } {
    const rows = this.#db.prepare(query).all(...(bindings as (string | number | null)[])) as Record<
      string,
      WorkspaceSqlValue
    >[]
    return { toArray: () => rows }
  }
}

const T0 = 1_750_000_000_000
const DAY = 24 * 60 * 60 * 1000

function makeStore(clock: { now: number }) {
  return new WorkspaceRecoveryStore(new FakeSqlStorage(), () => clock.now)
}

const INPUT = {
  fileId: 'f1',
  opId: 'op-1',
  reason: 'opaque-conflict-loser',
  deviceId: 'device-a',
  observedPath: 'assets/img.png',
  payload: JSON.stringify({ hashHex: 'abc', sizeBytes: 2, manifest: { chunks: [] } }),
}

describe('WorkspaceRecoveryStore', () => {
  it('records once per opId — replays never double-write', () => {
    const store = makeStore({ now: T0 })
    const recordId = store.record(INPUT)
    expect(recordId).not.toBeNull()
    expect(store.record(INPUT)).toBeNull()

    const records = store.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      recordId,
      fileId: 'f1',
      opId: 'op-1',
      reason: 'opaque-conflict-loser',
      observedPath: 'assets/img.png',
      createdAt: T0,
      acknowledgedAt: null,
    })
    expect(JSON.parse(records[0]!.payload)).toEqual({
      hashHex: 'abc',
      sizeBytes: 2,
      manifest: { chunks: [] },
    })
  })

  it('acknowledge sets the timestamp once and pendingOnly filters it out', () => {
    const clock = { now: T0 }
    const store = makeStore(clock)
    const recordId = store.record(INPUT)!
    store.record({ ...INPUT, opId: 'op-2' })

    clock.now = T0 + 1000
    expect(store.acknowledge(recordId)).toBe(true)
    expect(store.acknowledge(recordId)).toBe(false)

    expect(store.list()).toHaveLength(2)
    const pending = store.list({ pendingOnly: true })
    expect(pending).toHaveLength(1)
    expect(pending[0]!.opId).toBe('op-2')
  })

  it('prunes acknowledged after 7 days and unacknowledged after 90 days', () => {
    const clock = { now: T0 }
    const store = makeStore(clock)
    const acked = store.record({ ...INPUT, opId: 'op-acked' })!
    store.record({ ...INPUT, opId: 'op-pending' })
    store.acknowledge(acked)

    clock.now = T0 + 7 * DAY + 1
    expect(store.prune()).toBe(1)
    expect(store.list().map((r) => r.opId)).toEqual(['op-pending'])

    clock.now = T0 + 90 * DAY + 1
    expect(store.prune()).toBe(1)
    expect(store.list()).toHaveLength(0)
  })
})
