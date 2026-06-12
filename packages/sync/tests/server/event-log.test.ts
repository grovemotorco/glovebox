import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { WorkspaceEventLog } from '../../src/server/event-log.ts'
import type { WorkspaceSqlStorage, WorkspaceSqlValue } from '../../src/server/workspace-server.ts'

class FakeSqlStorage implements WorkspaceSqlStorage {
  readonly #db = new DatabaseSync(':memory:')

  exec(
    query: string,
    ...bindings: WorkspaceSqlValue[]
  ): { toArray(): Record<string, WorkspaceSqlValue>[] } {
    const normalized = bindings.map((binding) =>
      binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
    )
    const rows = this.#db
      .prepare(query)
      .all(...(normalized as (string | number | null)[])) as Record<string, WorkspaceSqlValue>[]
    return { toArray: () => rows }
  }
}

const NOW = () => 1_750_000_000_000

describe('WorkspaceEventLog', () => {
  it('assigns strictly increasing seqs that survive re-instantiation', async () => {
    const sql = new FakeSqlStorage()
    const logA = new WorkspaceEventLog(sql, NOW)
    expect(logA.append('content.loroUpdate', 'f1', '{}')).toBe(1)
    expect(logA.append('content.loroUpdate', 'f1', '{}')).toBe(2)

    const logB = new WorkspaceEventLog(sql, NOW)
    expect(logB.append('content.loroUpdate', 'f2', '{}')).toBe(3)
    expect(logB.currentSeq()).toBe(3)
  })

  it('replays everything after a cursor inside the window, oldest first', () => {
    const sql = new FakeSqlStorage()
    const log = new WorkspaceEventLog(sql, NOW)
    for (let i = 1; i <= 4; i += 1) {
      log.append('content.loroUpdate', `f${i}`, JSON.stringify({ i }))
    }

    const read = log.since(2)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.currentSeq).toBe(4)
    expect(read.events.map((event) => event.seq)).toEqual([3, 4])
    expect(read.events[0]!.fileId).toBe('f3')
    expect(JSON.parse(read.events[1]!.payload)).toEqual({ i: 4 })
  })

  it('returns an empty batch at or past the head', () => {
    const sql = new FakeSqlStorage()
    const log = new WorkspaceEventLog(sql, NOW)
    log.append('content.loroUpdate', 'f1', '{}')

    expect(log.since(1)).toEqual({ ok: true, events: [], currentSeq: 1 })
    expect(log.since(99)).toEqual({ ok: true, events: [], currentSeq: 1 })
    const empty = new WorkspaceEventLog(new FakeSqlStorage(), NOW)
    expect(empty.since(0)).toEqual({ ok: true, events: [], currentSeq: 0 })
  })

  it('demands a snapshot for cursors behind the pruned window — never a partial stream', () => {
    const sql = new FakeSqlStorage()
    const log = new WorkspaceEventLog(sql, NOW, 5)
    for (let i = 1; i <= 8; i += 1) {
      log.append('content.loroUpdate', 'f', '{}')
    }

    // Window keeps seqs 4..8; cursor 3 is the exact boundary (next event
    // is 4, which is retained).
    expect(log.since(3)).toMatchObject({ ok: true })
    const boundary = log.since(3)
    if (boundary.ok) {
      expect(boundary.events.map((event) => event.seq)).toEqual([4, 5, 6, 7, 8])
    }

    expect(log.since(2)).toEqual({ ok: false, reason: 'snapshot-required', currentSeq: 8 })
    expect(log.since(0)).toEqual({ ok: false, reason: 'snapshot-required', currentSeq: 8 })
  })

  it('never reuses a seq even when the whole window has been pruned', () => {
    const sql = new FakeSqlStorage()
    const log = new WorkspaceEventLog(sql, NOW, 1)
    expect(log.append('content.loroUpdate', 'f', '{}')).toBe(1)
    expect(log.append('content.loroUpdate', 'f', '{}')).toBe(2)
    expect(log.append('content.loroUpdate', 'f', '{}')).toBe(3)
    expect(log.since(1)).toEqual({ ok: false, reason: 'snapshot-required', currentSeq: 3 })
  })
})
