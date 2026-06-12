import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { SqliteLoroFileStore } from '../../src/server/sqlite-loro-store.ts'
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

describe('SqliteLoroFileStore', () => {
  it('round-trips snapshot + ordered updates and reopens from the same db', async () => {
    const sql = new FakeSqlStorage()
    const store = new SqliteLoroFileStore(sql)

    const doc = LoroFileDoc.empty('one\n')
    await store.replaceSnapshot('f1', doc.exportSnapshot())

    const v1 = doc.contentVersion()
    doc.setTextContent('one two\n')
    const u1 = doc.exportUpdateSince(v1)
    const v2 = doc.contentVersion()
    doc.setTextContent('one two three\n')
    const u2 = doc.exportUpdateSince(v2)
    await store.appendUpdates('f1', [u1])
    await store.appendUpdates('f1', [u2])

    const reopened = new SqliteLoroFileStore(sql)
    const state = await reopened.loadState('f1')
    expect(state).not.toBeNull()
    expect(state!.updates).toHaveLength(2)
    const materialized = LoroFileDoc.fromState(state!)
    expect(materialized.getTextContent()).toBe('one two three\n')

    expect(await reopened.loadState('missing')).toBeNull()
  })

  it('chunks snapshots across rows and reassembles them byte-exact', async () => {
    const sql = new FakeSqlStorage()
    const store = new SqliteLoroFileStore(sql, 64)

    const doc = LoroFileDoc.empty(`chunked ${'x'.repeat(500)}\n`)
    const snapshot = doc.exportSnapshot()
    expect(snapshot.byteLength).toBeGreaterThan(64 * 2)
    await store.replaceSnapshot('f-chunks', snapshot)

    const rows = sql
      .exec("SELECT COUNT(*) AS n FROM loro_snapshots WHERE file_id = 'f-chunks'")
      .toArray()
    expect(Number(rows[0]!.n)).toBe(Math.ceil(snapshot.byteLength / 64))

    const state = await store.loadState('f-chunks')
    expect(state!.snapshot).toHaveLength(snapshot.byteLength)
    expect(LoroFileDoc.fromState(state!).getTextContent()).toBe(doc.getTextContent())
  })

  it('replaceSnapshot clears the update log; deleteFile clears everything', async () => {
    const sql = new FakeSqlStorage()
    const store = new SqliteLoroFileStore(sql)

    const doc = LoroFileDoc.empty('base\n')
    await store.replaceSnapshot('f2', doc.exportSnapshot())
    const v = doc.contentVersion()
    doc.setTextContent('base edited\n')
    await store.appendUpdates('f2', [doc.exportUpdateSince(v)])

    await store.replaceSnapshot('f2', doc.exportSnapshot())
    const compacted = await store.loadState('f2')
    expect(compacted!.updates).toHaveLength(0)
    expect(LoroFileDoc.fromState(compacted!).getTextContent()).toBe('base edited\n')

    await store.deleteFile('f2')
    expect(await store.loadState('f2')).toBeNull()
  })
})
