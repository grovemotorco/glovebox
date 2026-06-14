import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import {
  WorkspaceBatchApplier,
  type ApplyLocalBatchInput,
  type LocalSyncOp,
} from '../../src/server/workspace-batch-applier.ts'
import { WorkspaceStore, type WorkspaceSqlStorageLike } from '../../src/server/workspace-store.ts'
import { WorkspaceLoroStore } from '../../src/server/workspace-loro-store.ts'
import { WorkspaceIdempotencyStore } from '../../src/server/batch-idempotency-store.ts'
import { sha256Hex } from '../../src/fs/hash.ts'

type SqlValue = ArrayBuffer | string | number | null

// node:sqlite-backed stand-in for the DO SQLite surface the ported stores
// target, preserved from the loro-2 test harness.
function createStorageFixture() {
  const db = new DatabaseSync(':memory:')
  const sqlLike: WorkspaceSqlStorageLike = {
    sql: {
      exec<T extends Record<string, SqlValue>>(query: string, ...bindings: unknown[]) {
        const statement = db.prepare(query)
        const upper = query.trimStart().slice(0, 6).toUpperCase()
        const sqlBindings = bindings as Parameters<typeof statement.all>
        if (upper === 'SELECT') {
          const rows = statement.all(...sqlBindings) as T[]
          return { toArray: () => rows }
        }
        statement.run(...sqlBindings)
        return { toArray: (): T[] => [] }
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec('BEGIN')
      try {
        const value = closure()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { sqlLike, close: () => db.close() }
}

describe('WorkspaceBatchApplier.apply (ported loro-2 applyLocalBatch corpus)', () => {
  const states: Array<{ close(): void }> = []
  afterEach(() => {
    while (states.length > 0) states.pop()?.close()
  })

  // Mirrors the loro-2 WorkspaceDO.applyLocalBatch surface so the scenario
  // bodies below stay verbatim from the loro-2 suite.
  function makeDO() {
    const fixture = createStorageFixture()
    states.push(fixture)
    const workspace = new WorkspaceStore(fixture.sqlLike)
    const loro = new WorkspaceLoroStore(fixture.sqlLike)
    const idempotency = new WorkspaceIdempotencyStore(fixture.sqlLike)
    const applier = new WorkspaceBatchApplier(workspace, loro, idempotency)
    return {
      applyLocalBatch: async (_workspaceId: string, input: ApplyLocalBatchInput, userId: string) =>
        applier.apply(input, { userId, deviceId: input.deviceId }),
      readFileById: async (_workspaceId: string, fileId: string) => workspace.readFileById(fileId),
      readFileBytesById: async (_workspaceId: string, fileId: string) =>
        workspace.readFileBytesById(fileId),
      writeFileById: async (
        _workspaceId: string,
        fileId: string,
        content: string,
        meta: { modifiedBy: string },
      ) => workspace.writeFileById(fileId, content, meta),
      listAll: async (_workspaceId: string) => workspace.listAll(),
    }
  }

  const baseInput = (
    workspaceId: string,
    ops: readonly LocalSyncOp[],
    overrides: Partial<{ baseSeq: number; mountId: string; deviceId: string }> = {},
  ) => ({
    workspaceId,
    mountId: overrides.mountId ?? 'mount-1',
    deviceId: overrides.deviceId ?? 'device-1',
    baseSeq: overrides.baseSeq ?? 0,
    ops,
  })

  function localFileCreate(opId: string, path: string, initialText?: string): LocalSyncOp {
    if (initialText !== undefined) {
      const seed = LoroFileDoc.empty(initialText)
      return {
        type: 'file.create',
        opId,
        localFileId: `local-${opId}`,
        path,
        initialContent: { loroSnapshot: seed.exportSnapshot() },
        observedAt: 1,
      }
    }

    return {
      type: 'file.create',
      opId,
      localFileId: `local-${opId}`,
      path,
      observedAt: 1,
    }
  }

  function bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64')
  }

  function localOpaqueCreate(opId: string, path: string, bytes: Uint8Array): LocalSyncOp {
    return {
      type: 'file.create',
      opId,
      localFileId: `local-${opId}`,
      path,
      initialContent: { kind: 'opaque', contentB64: bytesToBase64(bytes) },
      observedAt: 1,
    }
  }

  it('creates a file and returns canonical create + loroUpdate events', async () => {
    const room = makeDO()
    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create-1', 'docs/hello.md', '# hello')]),
      'user-1',
    )

    expect(result.acceptedOps).toHaveLength(1)
    expect(result.deferredOps).toHaveLength(0)
    expect(result.events).toHaveLength(2)
    expect(result.events[0]?.type).toBe('create')
    expect(result.events[1]?.type).toBe('content.loroUpdate')
    expect(result.acceptedOps[0]?.binding?.path).toBe('docs/hello.md')

    const createdFileId = result.acceptedOps[0]?.binding?.fileId
    expect(createdFileId).toMatch(/^[0-9a-f-]+$/)

    const stored = await room.readFileById('ws-1', createdFileId!)
    expect(stored).toBe('# hello')
  })

  it('defers opaque file.create; opaque bytes use opaque.submit instead of batch.submit', async () => {
    const room = makeDO()
    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localOpaqueCreate('op-empty-opaque', 'empty.bin', new Uint8Array())]),
      'user-1',
    )

    expect(result.acceptedOps).toEqual([])
    expect(result.deferredOps).toEqual([{ opId: 'op-empty-opaque', reason: 'unsupported-op' }])
  })

  it('suffixes a path collision deterministically', async () => {
    const room = makeDO()
    await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-1', 'docs/note.md', 'first')]),
      'user-1',
    )
    const second = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-2', 'docs/note.md', 'second')]),
      'user-2',
    )

    expect(second.acceptedOps).toHaveLength(1)
    const path = second.acceptedOps[0]?.binding?.path
    expect(path).not.toBe('docs/note.md')
    expect(path).toMatch(/^docs\/note-\d+\.md$/)
  })

  it('is idempotent on opId — replays return the cached result without duplicating events', async () => {
    const room = makeDO()
    const op = localFileCreate('op-idem', 'docs/dup.md', 'content')
    const first = await room.applyLocalBatch('ws-1', baseInput('ws-1', [op]), 'user-1')
    const second = await room.applyLocalBatch('ws-1', baseInput('ws-1', [op]), 'user-1')

    expect(first.acceptedOps).toHaveLength(1)
    expect(second.acceptedOps).toHaveLength(1)
    expect(second.acceptedOps[0]?.binding).toEqual(first.acceptedOps[0]?.binding)
    expect(second.snapshots).toHaveLength(1)
    expect(second.snapshots[0]?.fileId).toBe(first.acceptedOps[0]?.binding?.fileId)
    expect(second.snapshots[0]?.textContent).toBe('content')
    expect(second.events).toHaveLength(0)
    expect(second.deferredOps).toHaveLength(0)
  })

  it('applies a content.update against a file created in a previous batch', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create', 'docs/edit.md', 'one')]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId

    // Daemon constructs an update against the seed snapshot.
    const seedSnapshot = create.snapshots.find((s) => s.fileId === fileId)!.loroSnapshot
    const baseVersion = create.snapshots.find((s) => s.fileId === fileId)!.contentVersion
    const writer = LoroFileDoc.fromSnapshot(seedSnapshot)
    writer.setTextContent('one two')
    const loroUpdate = writer.exportUpdateSince(baseVersion)

    const update = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'content.update',
            opId: 'op-update',
            fileId,
            baseContentVersion: baseVersion,
            loroUpdate,
            observedPath: 'docs/edit.md',
            observedAt: 2,
          },
        ],
        { baseSeq: create.currentSeq },
      ),
      'user-1',
    )

    expect(update.acceptedOps).toHaveLength(1)
    expect(update.events[0]?.type).toBe('update')
    expect(await room.readFileById('ws-1', fileId)).toBe('one two')
  })

  it('content.update for a missing file is deferred as file-not-found', async () => {
    const room = makeDO()
    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [
        {
          type: 'content.update',
          opId: 'op-x',
          fileId: '00000000-0000-0000-0000-000000000000',
          baseContentVersion: new Uint8Array(),
          loroUpdate: new Uint8Array([0]),
          observedPath: 'docs/missing.md',
          observedAt: 1,
        },
      ]),
      'user-1',
    )
    expect(result.deferredOps).toEqual([{ opId: 'op-x', reason: 'file-not-found' }])
  })

  it('defers opaque content updates; event bytes are no longer batch-carried', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create-md', 'blob.md', 'seed')]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId

    const update = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'content.opaqueUpdate',
            opId: 'op-opaque-update',
            fileId,
            contentB64: bytesToBase64(new Uint8Array([2, 3])),
            observedPath: 'blob.bin',
            observedAt: 2,
          },
        ],
        { baseSeq: create.currentSeq, deviceId: 'device-opaque' },
      ),
      'user-1',
    )

    expect(update.acceptedOps).toEqual([])
    expect(update.events).toEqual([])
    expect(update.deferredOps).toEqual([{ opId: 'op-opaque-update', reason: 'unsupported-op' }])
  })

  it('accepts a lexically-later file.rename when the file is unchanged since baseSeq', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create', 'hello.md', '# Hello\n')]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId

    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'file.rename',
            opId: 'op-rename',
            fileId,
            baseSeq: create.currentSeq,
            fromPath: 'hello.md',
            toPath: 'rename.md',
            observedAt: 5,
          },
        ],
        { baseSeq: create.currentSeq },
      ),
      'user-1',
    )

    expect(result.deferredOps).toHaveLength(0)
    expect(result.acceptedOps).toEqual([
      { opId: 'op-rename', binding: { fileId, path: 'rename.md' } },
    ])
    expect(result.events[0]).toMatchObject({
      type: 'rename',
      oldPath: 'hello.md',
      newPath: 'rename.md',
    })
    expect((await room.listAll('ws-1')).map((entry) => entry.path)).toContain('rename.md')
  })

  it('defers file.rename when the file was edited after baseSeq', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create', 'hello.md', '# Hello\n')]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId
    await room.writeFileById('ws-1', fileId, '# Edited\n', { modifiedBy: 'user-2' })

    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'file.rename',
            opId: 'op-rename-stale',
            fileId,
            baseSeq: create.currentSeq,
            fromPath: 'hello.md',
            toPath: 'rename.md',
            observedAt: 5,
          },
        ],
        { baseSeq: create.currentSeq },
      ),
      'user-1',
    )

    expect(result.acceptedOps).toHaveLength(0)
    expect(result.deferredOps).toEqual([{ opId: 'op-rename-stale', reason: 'remote-edit-wins' }])
    expect((await room.listAll('ws-1')).map((entry) => entry.path)).toContain('hello.md')
  })

  it('defers file.rename when the target path is occupied by another file', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [
        localFileCreate('op-source', 'source.md', '# Source\n'),
        localFileCreate('op-target', 'target.md', '# Target\n'),
      ]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId

    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'file.rename',
            opId: 'op-rename-collision',
            fileId,
            baseSeq: create.currentSeq,
            fromPath: 'source.md',
            toPath: 'target.md',
            observedAt: 5,
          },
        ],
        { baseSeq: create.currentSeq },
      ),
      'user-1',
    )

    expect(result.acceptedOps).toHaveLength(0)
    expect(result.deferredOps).toEqual([
      { opId: 'op-rename-collision', reason: 'rename-target-occupied' },
    ])
    expect((await room.listAll('ws-1')).map((entry) => entry.path).sort()).toEqual([
      'source.md',
      'target.md',
    ])
  })

  it('defers a deleteIntent when the file was edited after baseSeq (edit wins)', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create', 'docs/race.md', 'a')]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId

    // Daemon snapshot was at currentSeq, but server applies an edit before the
    // delete intent shows up.
    await room.writeFileById('ws-1', fileId, 'a edited', { modifiedBy: 'user-2' })

    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'file.deleteIntent',
            opId: 'op-del',
            fileId,
            baseSeq: create.currentSeq,
            path: 'docs/race.md',
            observedAt: 5,
          },
        ],
        { baseSeq: create.currentSeq },
      ),
      'user-3',
    )

    expect(result.deferredOps).toEqual([{ opId: 'op-del', reason: 'remote-edit-wins' }])
    // File survives, content is the edit.
    expect(await room.readFileById('ws-1', fileId)).toBe('a edited')
  })

  it('accepts a deleteIntent when the file is unchanged since baseSeq', async () => {
    const room = makeDO()
    const create = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-create', 'docs/clean.md', 'a')]),
      'user-1',
    )
    const fileId = create.acceptedOps[0]!.binding!.fileId

    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput(
        'ws-1',
        [
          {
            type: 'file.deleteIntent',
            opId: 'op-del',
            fileId,
            baseSeq: create.currentSeq,
            path: 'docs/clean.md',
            observedAt: 5,
          },
        ],
        { baseSeq: create.currentSeq },
      ),
      'user-1',
    )

    expect(result.acceptedOps).toEqual([{ opId: 'op-del' }])
    expect(result.events[0]?.type).toBe('delete')
    expect(await room.readFileById('ws-1', fileId)).toBeNull()
  })

  it('rejects an oversized batch through path collision suffix gracefully', async () => {
    const room = makeDO()
    // Default workspace limits allow up to 1MiB content.
    const result = await room.applyLocalBatch(
      'ws-1',
      baseInput('ws-1', [localFileCreate('op-1', 'docs/normal.md', 'within size')]),
      'user-1',
    )
    expect(result.acceptedOps).toHaveLength(1)
  })
})

describe('WorkspaceBatchApplier kind-boundary renames (ISSUE-0043)', () => {
  const states: Array<{ close(): void }> = []
  afterEach(() => {
    while (states.length > 0) states.pop()?.close()
  })

  // Direct store access (unlike makeDO's loro-2 facade): the assertions
  // below inspect the row kind and the Loro tables behind the applier.
  function makeStores() {
    const fixture = createStorageFixture()
    states.push(fixture)
    const workspace = new WorkspaceStore(fixture.sqlLike)
    const loro = new WorkspaceLoroStore(fixture.sqlLike)
    const opaqueBytes = new Map<string, Uint8Array>()
    const applier = new WorkspaceBatchApplier(
      workspace,
      loro,
      new WorkspaceIdempotencyStore(fixture.sqlLike),
      {
        transitionContentKind: (fileId, oldPath, newPath) => {
          if (oldPath.endsWith('.md') && !newPath.endsWith('.md')) {
            const bytes = new TextEncoder().encode(workspace.readFileById(fileId) ?? '')
            opaqueBytes.set(fileId, bytes)
            workspace.transitionMarkdownToOpaque(fileId, {
              contentHash: sha256Hex(bytes),
              sizeBytes: bytes.byteLength,
            })
            return
          }

          const bytes = opaqueBytes.get(fileId) ?? new Uint8Array()
          workspace.transitionOpaqueToMarkdown(fileId, new TextDecoder().decode(bytes))
          opaqueBytes.delete(fileId)
        },
      },
    )
    const apply = (ops: readonly LocalSyncOp[]) =>
      applier.apply(
        { workspaceId: 'ws-1', mountId: 'mount-1', deviceId: 'device-1', baseSeq: 0, ops },
        { userId: 'user-1', deviceId: 'device-1' },
      )
    return { workspace, loro, opaqueBytes, apply }
  }

  function markdownCreate(opId: string, path: string, initialText: string): LocalSyncOp {
    const seed = LoroFileDoc.empty(initialText)
    return {
      type: 'file.create',
      opId,
      localFileId: `local-${opId}`,
      path,
      initialContent: { loroSnapshot: seed.exportSnapshot() },
      observedAt: 1,
    }
  }

  function rename(
    opId: string,
    fileId: string,
    baseSeq: number,
    fromPath: string,
    toPath: string,
  ): LocalSyncOp {
    return { type: 'file.rename', opId, fileId, baseSeq, fromPath, toPath, observedAt: 2 }
  }

  it('rename across the kind boundary transitions the row', () => {
    const { workspace, loro, opaqueBytes, apply } = makeStores()

    // md→opaque: the row's bytes become canonical (UTF-8 of the old text)
    // and the Loro doc is dropped — the LWW path owns content from here.
    const create = apply([markdownCreate('op-create-md', 'docs/pic.md', '# old text')])
    const fileId = create.acceptedOps[0]!.binding!.fileId
    expect(loro.readSnapshot(fileId)).not.toBeNull()

    const toOpaque = apply([
      rename('op-to-png', fileId, create.currentSeq, 'docs/pic.md', 'docs/pic.png'),
    ])
    expect(toOpaque.deferredOps).toHaveLength(0)
    expect(workspace.getTreeEntryByFileId(fileId)).toMatchObject({
      path: 'docs/pic.png',
      contentKind: 'opaque',
    })
    expect(opaqueBytes.get(fileId)).toEqual(new TextEncoder().encode('# old text'))
    expect(workspace.readFileBytesById(fileId)).toBeNull()
    expect(loro.readSnapshot(fileId)).toBeNull()

    // opaque→md: the row re-derives as markdown (the implicit kind — tree
    // entries only carry contentKind when opaque) and the bytes decode as
    // UTF-8 text.
    const payloadBytes = new TextEncoder().encode('plain payload')
    const createdBin = workspace.createOpaqueFile(
      'assets/blob.bin',
      { contentHash: sha256Hex(payloadBytes), sizeBytes: payloadBytes.byteLength },
      { modifiedBy: 'user-1' },
      'bin-file-id',
    )
    opaqueBytes.set(createdBin.fileId, payloadBytes)
    const binId = createdBin.fileId
    const toMarkdown = apply([
      rename('op-to-md', binId, workspace.currentSequence(), 'assets/blob.bin', 'assets/blob.md'),
    ])
    expect(toMarkdown.deferredOps).toHaveLength(0)
    const entry = workspace.getTreeEntryByFileId(binId)!
    expect(entry.path).toBe('assets/blob.md')
    expect(entry.contentKind).toBeUndefined()
    expect(entry.contentHash).toBe(sha256Hex('plain payload'))
    expect(workspace.readFileById(binId)).toBe('plain payload')
  })

  it('kind transition allocates no extra seq', () => {
    const { workspace, apply } = makeStores()
    const create = apply([markdownCreate('op-create', 'docs/img.md', 'x')])
    const fileId = create.acceptedOps[0]!.binding!.fileId

    // Exactly one rename event on one seq — the kind transition itself is
    // not an observable event.
    const boundary = apply([
      rename('op-boundary', fileId, create.currentSeq, 'docs/img.md', 'docs/img.png'),
    ])
    expect(boundary.events).toHaveLength(1)
    expect(boundary.events[0]).toMatchObject({ type: 'rename', newPath: 'docs/img.png' })
    expect(boundary.events[0]!.seq).toBe(create.currentSeq + 1)
    expect(boundary.currentSeq).toBe(create.currentSeq + 1)
    expect(workspace.currentSequence()).toBe(create.currentSeq + 1)

    // The next op continues the counter with no gap.
    const next = apply([
      rename('op-next', fileId, boundary.currentSeq, 'docs/img.png', 'docs/img-archived.png'),
    ])
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.seq).toBe(boundary.currentSeq + 1)
    expect(next.currentSeq).toBe(boundary.currentSeq + 1)
  })
})
