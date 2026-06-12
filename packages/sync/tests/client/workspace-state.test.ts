import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { bytesToBase64 } from '../../src/loro/base64.ts'
import {
  MemoryClientStorage,
  WorkspaceStateStore,
  type SnapshotRecord,
  type WorkspaceState,
} from '../../src/client/workspace-state.ts'

function makeStore(clock: { now: number }, storage = new MemoryClientStorage()) {
  const store = new WorkspaceStateStore(storage, {
    workspaceId: 'ws-1',
    deviceId: 'device-1',
    now: () => clock.now,
  })
  return { store, storage }
}

function makePair(text: string) {
  const doc = LoroFileDoc.empty(text)
  return {
    snapshot: doc.exportSnapshot(),
    syncedVVB64: bytesToBase64(doc.contentVersion()),
    text,
  }
}

const META = { path: 'notes.md', contentKind: 'markdown' as const, lastKnownServerHash: 'h1' }

describe('WorkspaceStateStore', () => {
  it('round-trips files and the cursor through a reload', async () => {
    const clock = { now: 1000 }
    const { store, storage } = makeStore(clock)
    const a = makePair('alpha\n')
    const b = makePair('beta\n')
    await store.persistFile('f-a', a, META)
    await store.persistFile('f-b', b, { ...META, path: 'b.md' })
    await store.setLastAckedSeq(7)

    const reloaded = makeStore(clock, storage).store
    const result = await reloaded.load()
    expect(result.fresh).toBe(false)
    expect(result.refetch).toHaveLength(0)
    expect(result.state.lastAckedSeq).toBe(7)
    expect(result.ready).toHaveLength(2)

    const readyA = result.ready.find((file) => file.fileId === 'f-a')!
    expect(readyA.syncedVVB64).toBe(a.syncedVVB64)
    expect(LoroFileDoc.fromSnapshot(readyA.snapshot).getTextContent()).toBe('alpha\n')
    expect(readyA.fileState.path).toBe('notes.md')
  })

  it('starts fresh and clears orphan snapshots when the state record is missing', async () => {
    const clock = { now: 1000 }
    const { store, storage } = makeStore(clock)
    // Simulate a first save that crashed after the snapshot write: snapshot
    // exists, state record never landed.
    const pair = makePair('orphan\n')
    await storage.put('snapshots', 'f-orphan', {
      fileId: 'f-orphan',
      snapshot: pair.snapshot,
      syncedVVB64: pair.syncedVVB64,
      savedAt: 999,
    } satisfies SnapshotRecord)

    const result = await store.load()
    expect(result.fresh).toBe(true)
    expect(result.state.lastAckedSeq).toBe(0)
    expect(result.ready).toHaveLength(0)
    expect(await storage.listKeys('snapshots')).toHaveLength(0)
  })

  it('refetches a file whose snapshot write was lost (state newer), keeping the cursor', async () => {
    const clock = { now: 1000 }
    const { store, storage } = makeStore(clock)
    await store.persistFile('f-a', makePair('v1\n'), META)
    await store.setLastAckedSeq(5)

    // Simulate a later save where the state entry landed but the snapshot
    // write was lost: bump only the state entry's savedAt.
    const state = (await storage.get('state', 'workspace')) as WorkspaceState
    state.files['f-a']!.savedAt = 2000
    await storage.put('state', 'workspace', state)

    const result = await store.load()
    expect(result.fresh).toBe(false)
    expect(result.ready).toHaveLength(0)
    expect(result.refetch).toHaveLength(1)
    expect(result.refetch[0]!.fileId).toBe('f-a')
    expect(result.state.lastAckedSeq).toBe(5)
    // The stale snapshot is gone so nothing can pair with it later.
    expect(await storage.listKeys('snapshots')).toHaveLength(0)
  })

  it('refetches a file whose snapshot bytes are corrupt — never guesses', async () => {
    const clock = { now: 1000 }
    const { store, storage } = makeStore(clock)
    await store.persistFile('f-a', makePair('good\n'), META)
    await storage.put('snapshots', 'f-a', {
      fileId: 'f-a',
      snapshot: new Uint8Array([1, 2, 3, 4]),
      syncedVVB64: 'AA==',
      savedAt: 5000,
    } satisfies SnapshotRecord)

    const result = await store.load()
    expect(result.ready).toHaveLength(0)
    expect(result.refetch.map((file) => file.fileId)).toEqual(['f-a'])
  })

  it('drops orphan snapshots that have no state entry', async () => {
    const clock = { now: 1000 }
    const { store, storage } = makeStore(clock)
    await store.persistFile('f-a', makePair('keep\n'), META)
    const pair = makePair('orphan\n')
    await storage.put('snapshots', 'f-ghost', {
      fileId: 'f-ghost',
      snapshot: pair.snapshot,
      syncedVVB64: pair.syncedVVB64,
      savedAt: 1500,
    } satisfies SnapshotRecord)

    const result = await store.load()
    expect(result.ready.map((file) => file.fileId)).toEqual(['f-a'])
    expect(await storage.listKeys('snapshots')).toEqual(['f-a'])
  })

  it('removeFile clears both artifacts', async () => {
    const clock = { now: 1000 }
    const { store, storage } = makeStore(clock)
    await store.persistFile('f-a', makePair('bye\n'), META)
    await store.removeFile('f-a')

    expect(await storage.listKeys('snapshots')).toHaveLength(0)
    const result = await store.load()
    expect(result.ready).toHaveLength(0)
    expect(result.refetch).toHaveLength(0)
  })
})
