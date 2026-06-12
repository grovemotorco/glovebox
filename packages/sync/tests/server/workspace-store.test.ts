import { afterEach, describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { LIMITS } from '@glovebox/core'
import {
  WorkspaceFileTooLargeError,
  WorkspaceStore,
  type WorkspaceStoreLimits,
  type WorkspaceSqlStorageLike,
} from '../../src/server/workspace-store.ts'
import { sha256Hex } from '../../src/fs/hash.ts'

function createTestStorage(
  initializer?: (db: DatabaseSync) => void,
): WorkspaceSqlStorageLike & { close(): void; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  initializer?.(db)

  return {
    db,
    sql: {
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: unknown[]
      ): { toArray(): T[] } {
        const statement = db.prepare(query)
        const upper = query.trimStart().slice(0, 6).toUpperCase()
        const sqlBindings = bindings as Parameters<typeof statement.all>

        if (upper === 'SELECT') {
          const rows = statement.all(...sqlBindings) as T[]
          return {
            toArray(): T[] {
              return rows
            },
          }
        }

        statement.run(...sqlBindings)
        return {
          toArray(): T[] {
            return []
          },
        }
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec('BEGIN')
      try {
        const result = closure()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    close() {
      db.close()
    },
  }
}

describe('WorkspaceStore', () => {
  const openStores: Array<{ close(): void }> = []

  afterEach(() => {
    while (openStores.length > 0) {
      openStores.pop()?.close()
    }
  })

  function createStore(
    initializer?: (db: DatabaseSync) => void,
    limits?: WorkspaceStoreLimits,
  ): WorkspaceStore {
    const storage = createTestStorage(initializer)
    openStores.push(storage)
    return new WorkspaceStore(storage, limits)
  }

  test('creates files, normalizes paths, and creates parent directories', () => {
    const store = createStore()

    const result = store.createFile('docs/cafe\u0301.md', '# hello\n', { modifiedBy: 'daemon' })

    expect(result).toEqual({
      fileId: result.fileId,
      created: true,
      contentHash: sha256Hex('# hello\n'),
      sizeBytes: new TextEncoder().encode('# hello\n').byteLength,
      version: 1,
    })

    expect(store.readFileById(result.fileId)).toBe('# hello\n')
    expect(store.getFileByPath('docs/café.md')).toMatchObject({
      id: result.fileId,
      path: 'docs/café.md',
      contentHash: sha256Hex('# hello\n'),
      sizeBytes: new TextEncoder().encode('# hello\n').byteLength,
      version: 1,
    })
  })

  test('returns the existing file id on duplicate create without rewriting content', () => {
    const store = createStore()

    const first = store.createFile('notes/todo.md', '# one\n', { modifiedBy: 'daemon' })
    const second = store.createFile('notes/todo.md', '# two\n', { modifiedBy: 'browser' })

    expect(second).toEqual({
      fileId: first.fileId,
      created: false,
      contentHash: sha256Hex('# one\n'),
      sizeBytes: new TextEncoder().encode('# one\n').byteLength,
      version: 1,
    })
    expect(store.readFileById(first.fileId)).toBe('# one\n')
  })

  test('createOrSuffix atomically assigns a free sibling path', () => {
    const store = createStore()

    const first = store.createFile('notes/todo.md', '# one\n', { modifiedBy: 'daemon' })
    const second = store.createFileOrSuffix('notes/todo.md', '# two\n', { modifiedBy: 'browser' })
    const third = store.createFileOrSuffix('notes/todo.md', '# three\n', { modifiedBy: 'browser' })

    expect(second).toMatchObject({
      created: true,
      path: 'notes/todo-2.md',
      contentHash: sha256Hex('# two\n'),
    })
    expect(third).toMatchObject({
      created: true,
      path: 'notes/todo-3.md',
      contentHash: sha256Hex('# three\n'),
    })
    expect(second.fileId).not.toBe(first.fileId)
    expect(store.readFileById(second.fileId)).toBe('# two\n')
    expect(store.getFileByPath('notes/todo-2.md')).toMatchObject({
      id: second.fileId,
      path: 'notes/todo-2.md',
    })
  })

  test('writes and renames by stable file id while preserving version on rename', () => {
    const store = createStore()

    const created = store.createFile('notes/guide.md', '# guide\n', { modifiedBy: 'daemon' })
    const updated = store.writeFileById(created.fileId, '# updated\n', { modifiedBy: 'browser' })

    expect(updated).toEqual({
      fileId: created.fileId,
      contentHash: sha256Hex('# updated\n'),
      sizeBytes: new TextEncoder().encode('# updated\n').byteLength,
      version: 2,
    })

    expect(
      store.renameFileById(created.fileId, 'archive/guide.md', { modifiedBy: 'renamer' }),
    ).toEqual({
      fileId: created.fileId,
      oldPath: 'notes/guide.md',
      newPath: 'archive/guide.md',
    })

    expect(store.getFileByPath('notes/guide.md')).toBeNull()
    expect(store.readFileById(created.fileId)).toBe('# updated\n')
    expect(store.getByFileId(created.fileId)).toMatchObject({
      id: created.fileId,
      path: 'archive/guide.md',
      version: 2,
    })
    expect(store.getTreeEntryByFileId(created.fileId)).toEqual({
      fileId: created.fileId,
      path: 'archive/guide.md',
      contentHash: sha256Hex('# updated\n'),
      sizeBytes: new TextEncoder().encode('# updated\n').byteLength,
      version: 2,
      versionVector: { daemon: 1, browser: 1, renamer: 1 },
      remoteRev: 3,
      tombstone: false,
      seq: 3,
      modifiedBy: 'renamer',
      modifiedAt: expect.any(Number),
    })
    expect(store.listAll()).toEqual([
      {
        fileId: created.fileId,
        path: 'archive/guide.md',
        contentHash: sha256Hex('# updated\n'),
        sizeBytes: new TextEncoder().encode('# updated\n').byteLength,
        version: 2,
        versionVector: { daemon: 1, browser: 1, renamer: 1 },
        remoteRev: 3,
        tombstone: false,
        seq: 3,
        modifiedBy: 'renamer',
        modifiedAt: expect.any(Number),
      },
    ])
  })

  test('returns null when renaming a missing file id', () => {
    const store = createStore()

    expect(
      store.renameFileById('missing-file', 'archive/missing.md', { modifiedBy: 'renamer' }),
    ).toBeNull()
  })

  test('rename tiebreak keeps the lexicographically winning path', () => {
    const store = createStore()

    const created = store.createFile('notes/zeta.md', '# zeta\n', { modifiedBy: 'daemon' })
    const applied = store.renameFileByIdWithTiebreak(created.fileId, 'notes/alpha.md', {
      modifiedBy: 'renamer',
    })
    const rejected = store.renameFileByIdWithTiebreak(created.fileId, 'notes/omega.md', {
      modifiedBy: 'renamer',
    })

    expect(applied).toMatchObject({
      fileId: created.fileId,
      oldPath: 'notes/zeta.md',
      newPath: 'notes/alpha.md',
      applied: true,
    })
    expect(rejected).toEqual({
      fileId: created.fileId,
      oldPath: 'notes/alpha.md',
      newPath: 'notes/alpha.md',
      applied: false,
    })
    expect(store.getByFileId(created.fileId)).toMatchObject({
      id: created.fileId,
      path: 'notes/alpha.md',
    })
  })

  test('rename tiebreak applies a dominating expected vector before lexicographic fallback', () => {
    const store = createStore()

    const created = store.createFile('notes/alpha.md', '# alpha\n', { modifiedBy: 'remote' })
    const applied = store.renameFileByIdWithTiebreak(
      created.fileId,
      'notes/zeta.md',
      { modifiedBy: 'local' },
      { remote: 1, local: 1 },
    )

    expect(applied).toMatchObject({
      fileId: created.fileId,
      oldPath: 'notes/alpha.md',
      newPath: 'notes/zeta.md',
      applied: true,
    })
  })

  test('rename tiebreak rejects stale expected vectors before lexicographic fallback', () => {
    const store = createStore()

    const created = store.createFile('notes/zeta.md', '# zeta\n', { modifiedBy: 'remote' })
    store.writeFileById(created.fileId, '# newer\n', { modifiedBy: 'remote' })
    const rejected = store.renameFileByIdWithTiebreak(
      created.fileId,
      'notes/alpha.md',
      { modifiedBy: 'local' },
      { remote: 1 },
    )

    expect(rejected).toEqual({
      fileId: created.fileId,
      oldPath: 'notes/zeta.md',
      newPath: 'notes/zeta.md',
      applied: false,
    })
  })

  test('rejects invalid paths at the store boundary', () => {
    const store = createStore()

    expect(() => store.createFile('../readme.md', '# readme\n', { modifiedBy: 'daemon' })).toThrow(
      'Invalid workspace path',
    )

    const created = store.createFile('notes/readme.md', '# readme\n', { modifiedBy: 'daemon' })
    expect(() =>
      store.renameFileById(created.fileId, '../readme.md', { modifiedBy: 'daemon' }),
    ).toThrow('Invalid workspace path')
  })

  test('deletes files and prunes empty directories', () => {
    const store = createStore()

    const created = store.createFile('docs/nested/a.md', '# a\n', { modifiedBy: 'daemon' })
    store.deleteFile('docs/nested/a.md')

    expect(store.readFileById(created.fileId)).toBeNull()
    expect(store.readTombstoneContentById(created.fileId)).toMatchObject({
      fileId: created.fileId,
      path: 'docs/nested/a.md',
      content: '# a\n',
      versionVector: { daemon: 1, server: 1 },
      remoteRev: 2,
      seq: 2,
      deletedAt: expect.any(Number),
    })
    expect(store.getFileByPath('docs/nested/a.md')).toBeNull()
    expect(store.listFileMetadata()).toEqual([])
    expect(store.listAll()).toEqual([
      {
        fileId: created.fileId,
        path: 'docs/nested/a.md',
        contentHash: sha256Hex('# a\n'),
        sizeBytes: new TextEncoder().encode('# a\n').byteLength,
        version: 1,
        versionVector: { daemon: 1, server: 1 },
        remoteRev: 2,
        tombstone: true,
        seq: 2,
        modifiedBy: 'server',
        modifiedAt: expect.any(Number),
      },
    ])
  })

  test('deletes by stable file id after paths have changed', () => {
    const store = createStore()

    const target = store.createFile('docs/a.md', '# target\n', { modifiedBy: 'daemon' })
    const other = store.createFile('docs/b.md', '# other\n', { modifiedBy: 'daemon' })

    store.renameFileById(target.fileId, 'docs/archive/a.md', { modifiedBy: 'renamer' })
    store.renameFileById(other.fileId, 'docs/a.md', { modifiedBy: 'renamer' })

    expect(store.deleteFileById(target.fileId)).toMatchObject({
      fileId: target.fileId,
      path: 'docs/archive/a.md',
      versionVector: { daemon: 1, renamer: 1, server: 1 },
      remoteRev: 3,
      seq: 5,
    })
    expect(store.deleteFileById('missing-file')).toBeNull()

    expect(store.readFileById(target.fileId)).toBeNull()
    expect(store.getFileByPath('docs/archive/a.md')).toBeNull()
    expect(store.getFileByPath('docs/a.md')).toMatchObject({
      id: other.fileId,
      path: 'docs/a.md',
    })
    expect(store.readFileById(other.fileId)).toBe('# other\n')
    expect(store.listAll()).toEqual([
      {
        fileId: other.fileId,
        path: 'docs/a.md',
        contentHash: sha256Hex('# other\n'),
        sizeBytes: new TextEncoder().encode('# other\n').byteLength,
        version: 1,
        versionVector: { daemon: 1, renamer: 1 },
        remoteRev: 2,
        tombstone: false,
        seq: 4,
        modifiedBy: 'renamer',
        modifiedAt: expect.any(Number),
      },
      {
        fileId: target.fileId,
        path: 'docs/archive/a.md',
        contentHash: sha256Hex('# target\n'),
        sizeBytes: new TextEncoder().encode('# target\n').byteLength,
        version: 1,
        versionVector: { daemon: 1, renamer: 1, server: 1 },
        remoteRev: 3,
        tombstone: true,
        seq: 5,
        modifiedBy: 'server',
        modifiedAt: expect.any(Number),
      },
    ])
  })

  test('delete tiebreak preserves remote changes newer than the local tombstone vector', () => {
    const store = createStore()

    const created = store.createFile('docs/a.md', '# base\n', { modifiedBy: 'daemon' })
    store.writeFileById(created.fileId, '# remote\n', { modifiedBy: 'browser' })

    const rejected = store.deleteFileByIdWithTiebreak(
      created.fileId,
      { daemon: 1, local: 1 },
      { modifiedBy: 'local' },
    )

    expect(rejected).toMatchObject({
      fileId: created.fileId,
      path: 'docs/a.md',
      deleted: false,
      reason: 'remote-changed',
      tombstone: false,
      versionVector: { daemon: 1, browser: 1 },
      remoteRev: 2,
    })
    expect(store.readFileById(created.fileId)).toBe('# remote\n')

    const deleted = store.deleteFileByIdWithTiebreak(
      created.fileId,
      { daemon: 1, browser: 1, local: 1 },
      { modifiedBy: 'local' },
    )

    expect(deleted).toMatchObject({
      fileId: created.fileId,
      path: 'docs/a.md',
      deleted: true,
      reason: 'deleted',
      tombstone: true,
      versionVector: { daemon: 1, browser: 1, local: 1 },
      remoteRev: 3,
    })
    expect(store.readFileById(created.fileId)).toBeNull()
    expect(store.readTombstoneContentById(created.fileId)).toMatchObject({
      fileId: created.fileId,
      content: '# remote\n',
      versionVector: { daemon: 1, browser: 1, local: 1 },
      remoteRev: 3,
    })

    expect(
      store.deleteFileByIdWithTiebreak(created.fileId, { local: 1 }, { modifiedBy: 'local' }),
    ).toMatchObject({
      fileId: created.fileId,
      deleted: true,
      reason: 'already-tombstoned',
      tombstone: true,
      remoteRev: 3,
    })
  })

  test('records replayable tree changes with monotonic cursors', () => {
    const store = createStore()

    const created = store.createFile('docs/a.md', '# base\n', { modifiedBy: 'daemon' })
    store.writeFileById(created.fileId, '# updated\n', { modifiedBy: 'browser' })
    store.renameFileById(created.fileId, 'docs/b.md', { modifiedBy: 'renamer' })
    store.deleteFileById(created.fileId, { modifiedBy: 'daemon' })

    expect(store.currentSequence()).toBe(4)
    expect(store.listChangesSince(0)).toMatchObject({
      reset: false,
      fromSeq: 0,
      currentSeq: 4,
      events: [
        {
          type: 'create',
          path: 'docs/a.md',
          seq: 1,
          entry: {
            fileId: created.fileId,
            path: 'docs/a.md',
            seq: 1,
          },
        },
        {
          type: 'update',
          path: 'docs/a.md',
          seq: 2,
          entry: {
            fileId: created.fileId,
            contentHash: sha256Hex('# updated\n'),
            seq: 2,
          },
        },
        {
          type: 'rename',
          oldPath: 'docs/a.md',
          newPath: 'docs/b.md',
          seq: 3,
          entry: {
            fileId: created.fileId,
            path: 'docs/b.md',
            seq: 3,
          },
        },
        {
          type: 'delete',
          path: 'docs/b.md',
          fileId: created.fileId,
          seq: 4,
          tombstone: true,
        },
      ],
    })

    expect(store.listChangesSince(2).events.map((event) => event.type)).toEqual([
      'rename',
      'delete',
    ])
    expect(store.listChangesSince(4)).toEqual({
      reset: false,
      fromSeq: 4,
      currentSeq: 4,
      events: [],
    })
  })

  test('falls back to a snapshot when the change cursor is older than retained events', () => {
    const store = createStore(undefined, { maxChangeEvents: 2 })

    const created = store.createFile('docs/a.md', '# base\n', { modifiedBy: 'daemon' })
    store.writeFileById(created.fileId, '# updated\n', { modifiedBy: 'browser' })
    store.renameFileById(created.fileId, 'docs/b.md', { modifiedBy: 'renamer' })
    store.deleteFileById(created.fileId, { modifiedBy: 'daemon' })

    expect(store.listChangesSince(2).events.map((event) => event.type)).toEqual([
      'rename',
      'delete',
    ])
    expect(store.listChangesSince(1)).toMatchObject({
      reset: true,
      fromSeq: 1,
      currentSeq: 4,
      events: [
        {
          type: 'snapshot',
          seq: 4,
          entries: [
            {
              fileId: created.fileId,
              path: 'docs/b.md',
              tombstone: true,
              seq: 4,
            },
          ],
        },
      ],
    })
  })

  test('prunes workspace change events to the configured retention window', () => {
    const storage = createTestStorage()
    openStores.push(storage)
    const store = new WorkspaceStore(storage, { maxChangeEvents: 2 })

    const created = store.createFile('docs/a.md', '# base\n', { modifiedBy: 'daemon' })
    store.writeFileById(created.fileId, '# one\n', { modifiedBy: 'browser' })
    store.writeFileById(created.fileId, '# two\n', { modifiedBy: 'browser' })
    store.renameFileById(created.fileId, 'docs/b.md', { modifiedBy: 'browser' })

    expect(
      storage.db.prepare('SELECT COUNT(*) AS count FROM workspace_store_changes').get() as {
        count: number
      },
    ).toEqual({ count: 2 })
    expect(
      storage.db.prepare('SELECT MIN(seq) AS minSeq FROM workspace_store_changes').get() as {
        minSeq: number
      },
    ).toEqual({ minSeq: 3 })
    expect(store.listChangesSince(2).reset).toBe(false)
    expect(store.listChangesSince(1)).toMatchObject({
      reset: true,
      fromSeq: 1,
      currentSeq: 4,
      events: [{ type: 'snapshot', seq: 4 }],
    })
  })

  test('falls back to a snapshot when retained change events are not contiguous', () => {
    const storage = createTestStorage()
    openStores.push(storage)
    const store = new WorkspaceStore(storage)

    const created = store.createFile('docs/a.md', '# base\n', { modifiedBy: 'daemon' })
    store.writeFileById(created.fileId, '# updated\n', { modifiedBy: 'browser' })
    store.renameFileById(created.fileId, 'docs/b.md', { modifiedBy: 'renamer' })
    storage.db.prepare(`DELETE FROM workspace_store_changes WHERE seq = ?`).run(2)

    expect(store.listChangesSince(1)).toMatchObject({
      reset: true,
      fromSeq: 1,
      currentSeq: 3,
      events: [
        {
          type: 'snapshot',
          seq: 3,
          entries: [
            {
              fileId: created.fileId,
              path: 'docs/b.md',
              tombstone: false,
              seq: 3,
            },
          ],
        },
      ],
    })
  })

  test('allows a new file at a tombstoned path while retaining the old tombstone', () => {
    const store = createStore()

    const deleted = store.createFile('docs/reused.md', '# old\n', { modifiedBy: 'daemon' })
    store.deleteFileById(deleted.fileId, { modifiedBy: 'daemon' })
    const replacement = store.createFile('docs/reused.md', '# new\n', { modifiedBy: 'daemon' })

    expect(replacement.fileId).not.toBe(deleted.fileId)
    expect(store.getFileByPath('docs/reused.md')).toMatchObject({
      id: replacement.fileId,
      path: 'docs/reused.md',
      contentHash: sha256Hex('# new\n'),
    })
    expect(store.readTombstoneContentById(deleted.fileId)).toMatchObject({
      fileId: deleted.fileId,
      path: 'docs/reused.md',
      content: '# old\n',
      versionVector: { daemon: 2 },
      remoteRev: 2,
      seq: 2,
      deletedAt: expect.any(Number),
    })
    expect(store.listAll()).toEqual([
      {
        fileId: replacement.fileId,
        path: 'docs/reused.md',
        contentHash: sha256Hex('# new\n'),
        sizeBytes: new TextEncoder().encode('# new\n').byteLength,
        version: 1,
        versionVector: { daemon: 1 },
        remoteRev: 1,
        tombstone: false,
        seq: 3,
        modifiedBy: 'daemon',
        modifiedAt: expect.any(Number),
      },
      {
        fileId: deleted.fileId,
        path: 'docs/reused.md',
        contentHash: sha256Hex('# old\n'),
        sizeBytes: new TextEncoder().encode('# old\n').byteLength,
        version: 1,
        versionVector: { daemon: 2 },
        remoteRev: 2,
        tombstone: true,
        seq: 2,
        modifiedBy: 'daemon',
        modifiedAt: expect.any(Number),
      },
    ])
  })

  test('enforces the workspace file-count limit on create', () => {
    const store = createStore(undefined, { maxFiles: 1 })

    store.createFile('docs/first.md', '# first\n', { modifiedBy: 'daemon' })

    expect(() =>
      store.createFile('docs/second.md', '# second\n', { modifiedBy: 'daemon' }),
    ).toThrow('Workspace file limit exceeded')
  })

  test('enforces the workspace size limit on writes', () => {
    const store = createStore(undefined, { maxTotalSizeBytes: 12 })
    const created = store.createFile('docs/notes.md', '1234', { modifiedBy: 'daemon' })

    expect(() =>
      store.writeFileById(created.fileId, '1234567890123', { modifiedBy: 'browser' }),
    ).toThrow('Workspace size limit exceeded')

    expect(store.readFileById(created.fileId)).toBe('1234')
  })

  test('accepts content exactly at the 1 MiB per-file limit', () => {
    const store = createStore()
    const atLimit = 'a'.repeat(LIMITS.maxMarkdownBytes)
    expect(() =>
      store.createFile('docs/at-limit.md', atLimit, { modifiedBy: 'daemon' }),
    ).not.toThrow()
  })

  test('rejects content one byte over the limit with WorkspaceFileTooLargeError', () => {
    const store = createStore()
    const overLimit = 'a'.repeat(LIMITS.maxMarkdownBytes + 1)
    let thrown: unknown
    try {
      store.createFile('docs/over.md', overLimit, { modifiedBy: 'daemon' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(WorkspaceFileTooLargeError)
    expect((thrown as WorkspaceFileTooLargeError).sizeBytes).toBe(LIMITS.maxMarkdownBytes + 1)
    expect((thrown as WorkspaceFileTooLargeError).limitBytes).toBe(LIMITS.maxMarkdownBytes)
  })

  test('measures UTF-8 multi-byte characters by byte length, not code points', () => {
    const store = createStore()
    const foxesAtLimit = '🦊'.repeat(LIMITS.maxMarkdownBytes / 4)
    expect(() =>
      store.createFile('docs/fox-at-limit.md', foxesAtLimit, { modifiedBy: 'daemon' }),
    ).not.toThrow()

    const foxesOver = foxesAtLimit + '🦊'
    expect(() => store.createFile('docs/fox-over.md', foxesOver, { modifiedBy: 'daemon' })).toThrow(
      WorkspaceFileTooLargeError,
    )
  })

  test('writeFileById rejects oversize updates before touching SQLite', () => {
    const store = createStore()
    const created = store.createFile('docs/notes.md', '# notes\n', { modifiedBy: 'daemon' })

    expect(() =>
      store.writeFileById(created.fileId, 'a'.repeat(LIMITS.maxMarkdownBytes + 1), {
        modifiedBy: 'browser',
      }),
    ).toThrow(WorkspaceFileTooLargeError)

    expect(store.readFileById(created.fileId)).toBe('# notes\n')
  })

  test('createOpaqueFile binds a provided fileId and returns the existing row on duplicate path', () => {
    const store = createStore()
    const bytes = new TextEncoder().encode('binary payload')

    const created = store.createOpaqueFile(
      'assets/icon.png',
      bytes,
      { modifiedBy: 'daemon' },
      'fixed-file-id',
    )

    expect(created).toEqual({
      fileId: 'fixed-file-id',
      created: true,
      contentHash: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      version: 1,
    })
    expect(store.readFileBytesById('fixed-file-id')).toEqual(bytes)
    expect(store.getTreeEntryByFileId('fixed-file-id')).toMatchObject({
      fileId: 'fixed-file-id',
      path: 'assets/icon.png',
      contentKind: 'opaque',
    })

    // Duplicate path returns the existing row without rewriting content —
    // an idempotent replay must not double-create or clobber bytes.
    const duplicate = store.createOpaqueFile(
      'assets/icon.png',
      new TextEncoder().encode('other bytes'),
      { modifiedBy: 'browser' },
      'other-file-id',
    )
    expect(duplicate).toEqual({
      fileId: 'fixed-file-id',
      created: false,
      contentHash: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      version: 1,
    })
    expect(store.readFileBytesById('fixed-file-id')).toEqual(bytes)
    expect(store.getByFileId('other-file-id')).toBeNull()
  })

  test('transitionContentKind round-trips md→opaque→md preserving UTF-8 content', () => {
    const store = createStore()
    const created = store.createFile('docs/notes.md', '# hello\n', { modifiedBy: 'daemon' })
    const utf8 = new TextEncoder().encode('# hello\n')

    // Same-kind and missing rows are no-ops.
    expect(store.transitionContentKind(created.fileId, 'markdown')).toBe(false)
    expect(store.transitionContentKind('missing-file', 'opaque')).toBe(false)

    expect(store.transitionContentKind(created.fileId, 'opaque')).toBe(true)
    expect(store.getTreeEntryByFileId(created.fileId)).toMatchObject({
      contentKind: 'opaque',
      contentHash: sha256Hex(utf8),
      sizeBytes: utf8.byteLength,
    })
    expect(store.readFileBytesById(created.fileId)).toEqual(utf8)
    expect(store.transitionContentKind(created.fileId, 'opaque')).toBe(false)

    expect(store.transitionContentKind(created.fileId, 'markdown')).toBe(true)
    const entry = store.getTreeEntryByFileId(created.fileId)!
    // Markdown is the implicit kind — entries only carry contentKind when opaque.
    expect(entry.contentKind).toBeUndefined()
    expect(entry.contentHash).toBe(sha256Hex('# hello\n'))
    expect(store.readFileById(created.fileId)).toBe('# hello\n')

    // No seq was allocated by any transition: the create's seq still stands.
    expect(entry.seq).toBe(1)
    expect(store.currentSequence()).toBe(1)
  })
})
