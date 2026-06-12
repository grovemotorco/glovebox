import { describe, expect, it } from 'vitest'
import {
  DaemonStateStore,
  MemoryDaemonStorage,
  type DaemonStorage,
} from '../../src/daemon/state.ts'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { bytesToBase64 } from '../../src/loro/base64.ts'

/**
 * Two-artifact crash-ordering reconcile (INV-6): every window between the
 * snapshot-envelope write and the state write — in both directions, for
 * create/update/remove — must resolve to ready, refetch, or fresh. Never a
 * guessed pair.
 */

function makePair(text: string): { snapshot: Uint8Array; syncedVVB64: string } {
  const doc = LoroFileDoc.empty(text)
  return {
    snapshot: doc.exportSnapshot(),
    syncedVVB64: bytesToBase64(doc.contentVersion()),
  }
}

const markdownMeta = {
  path: 'notes/a.md',
  nodeId: '0:1',
  lastWrittenHash: 'hash-a',
  lastWrittenVVB64: 'dnYtYQ==',
  sizeBytes: 5,
}

function makeStore(storage: DaemonStorage, now?: () => number): DaemonStateStore {
  return new DaemonStateStore(storage, {
    workspaceId: 'ws-1',
    mountId: 'mount-1',
    deviceId: 'device-1',
    now,
  })
}

/** Throws on the Nth write/delete and on every one after — a dead process. */
class CrashingStorage implements DaemonStorage {
  #writesUntilCrash: number

  constructor(
    readonly inner: DaemonStorage,
    writesUntilCrash: number,
  ) {
    this.#writesUntilCrash = writesUntilCrash
  }

  read(name: string): Promise<Uint8Array | null> {
    return this.inner.read(name)
  }

  writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    this.#checkpoint()
    return this.inner.writeAtomic(name, bytes)
  }

  delete(name: string): Promise<void> {
    this.#checkpoint()
    return this.inner.delete(name)
  }

  list(): Promise<string[]> {
    return this.inner.list()
  }

  #checkpoint(): void {
    this.#writesUntilCrash -= 1
    if (this.#writesUntilCrash < 0) throw new Error('simulated crash')
  }
}

describe('DaemonStateStore', () => {
  it('round-trips a markdown file as an intact pair', async () => {
    const storage = new MemoryDaemonStorage()
    const pair = makePair('hello')
    await makeStore(storage).persistMarkdownFile('file-1', pair, markdownMeta)

    const result = await makeStore(storage).load()
    expect(result.fresh).toBe(false)
    expect(result.refetch).toEqual([])
    expect(result.ready).toHaveLength(1)
    const ready = result.ready[0]!
    expect(ready.fileId).toBe('file-1')
    expect(ready.syncedVVB64).toBe(pair.syncedVVB64)
    expect(LoroFileDoc.fromSnapshot(ready.snapshot).getTextContent()).toBe('hello')
    expect(ready.fileState.path).toBe('notes/a.md')
    expect(ready.fileState.nodeId).toBe('0:1')
    expect(ready.fileState.lastWrittenHash).toBe('hash-a')
  })

  it('round-trips opaque files from state alone, no envelope', async () => {
    const storage = new MemoryDaemonStorage()
    await makeStore(storage).persistOpaqueFile('file-img', {
      path: 'assets/logo.png',
      nodeId: '0:2',
      opaqueHash: 'hash-img',
      sizeBytes: 1234,
    })

    const result = await makeStore(storage).load()
    expect(result.fresh).toBe(false)
    expect(result.ready).toEqual([])
    expect(result.refetch).toEqual([])
    const file = result.state.files['file-img']!
    expect(file.contentKind).toBe('opaque')
    expect(file.opaqueHash).toBe('hash-img')
    expect(file.lastWrittenHash).toBe('hash-img')
    expect(await storage.list()).toEqual(['workspace-state.json'])
  })

  it('crash between first envelope and state write → fresh start, orphan dropped', async () => {
    const storage = new MemoryDaemonStorage()
    const crashing = new CrashingStorage(storage, 1) // envelope lands, state write dies
    await expect(
      makeStore(crashing).persistMarkdownFile('file-1', makePair('hello'), markdownMeta),
    ).rejects.toThrow('simulated crash')
    expect(await storage.list()).toHaveLength(1)

    const result = await makeStore(storage).load()
    expect(result.fresh).toBe(true)
    expect(result.ready).toEqual([])
    expect(await storage.list()).toEqual([])
  })

  it('crash between envelope UPDATE and state write → newer envelope wins (case 1)', async () => {
    const storage = new MemoryDaemonStorage()
    let clock = 1000
    const store = makeStore(storage, () => clock++)
    await store.persistMarkdownFile('file-1', makePair('v1'), markdownMeta)

    const newPair = makePair('v2 with more text')
    const crashing = new CrashingStorage(storage, 1)
    await expect(
      makeStore(crashing, () => clock++).persistMarkdownFile('file-1', newPair, {
        ...markdownMeta,
        lastWrittenHash: 'hash-v2',
      }),
    ).rejects.toThrow('simulated crash')

    const result = await makeStore(storage).load()
    expect(result.fresh).toBe(false)
    expect(result.refetch).toEqual([])
    expect(result.ready).toHaveLength(1)
    const ready = result.ready[0]!
    // The envelope is the authority for the pair; the stale state entry's
    // VV cache and watermark are tolerated (scan re-derives the watermark).
    expect(ready.syncedVVB64).toBe(newPair.syncedVVB64)
    expect(LoroFileDoc.fromSnapshot(ready.snapshot).getTextContent()).toBe('v2 with more text')
    expect(ready.fileState.lastWrittenHash).toBe('hash-a')
  })

  it('state entry with a lost envelope → refetch, cursor preserved (case 2)', async () => {
    const storage = new MemoryDaemonStorage()
    const store = makeStore(storage)
    await store.persistMarkdownFile('file-1', makePair('hello'), markdownMeta)
    await store.setLastAckedSeq(42)
    await storage.delete('loro/file-1.snapshot.json')

    const result = await makeStore(storage).load()
    expect(result.fresh).toBe(false)
    expect(result.ready).toEqual([])
    expect(result.refetch).toHaveLength(1)
    expect(result.refetch[0]!.fileId).toBe('file-1')
    expect(result.state.lastAckedSeq).toBe(42)
  })

  it('corrupt envelope bytes → refetch and envelope dropped (case 3)', async () => {
    const storage = new MemoryDaemonStorage()
    await makeStore(storage).persistMarkdownFile('file-1', makePair('hello'), markdownMeta)
    await storage.writeAtomic(
      'loro/file-1.snapshot.json',
      new TextEncoder().encode(
        '{"fileId":"file-1","snapshotB64":"AAAA","syncedVVB64":"","savedAt":9999999999}',
      ),
    )

    const result = await makeStore(storage).load()
    expect(result.refetch.map((entry) => entry.fileId)).toEqual(['file-1'])
    expect(await storage.read('loro/file-1.snapshot.json')).toBeNull()
  })

  it('envelope older than the state entry → refetch (unprovable pair)', async () => {
    const storage = new MemoryDaemonStorage()
    let clock = 1000
    const store = makeStore(storage, () => clock++)
    await store.persistMarkdownFile('file-1', makePair('v1'), markdownMeta)
    // Simulate a lost envelope write paired with a landed state write: put
    // back an envelope with an older savedAt than the state entry.
    const old = await storage.read('loro/file-1.snapshot.json')
    await store.persistMarkdownFile('file-1', makePair('v2'), markdownMeta)
    await storage.writeAtomic('loro/file-1.snapshot.json', old!)

    const result = await makeStore(storage).load()
    expect(result.ready).toEqual([])
    expect(result.refetch.map((entry) => entry.fileId)).toEqual(['file-1'])
  })

  it('corrupt state artifact → fresh start, all envelopes swept', async () => {
    const storage = new MemoryDaemonStorage()
    await makeStore(storage).persistMarkdownFile('file-1', makePair('hello'), markdownMeta)
    await storage.writeAtomic('workspace-state.json', new TextEncoder().encode('not json{'))

    const result = await makeStore(storage).load()
    expect(result.fresh).toBe(true)
    expect(result.ready).toEqual([])
    expect(await storage.list()).toEqual(['workspace-state.json'])
  })

  it('crash inside removeFile (envelope deleted, state entry kept) → refetch', async () => {
    const storage = new MemoryDaemonStorage()
    const store = makeStore(storage)
    await store.persistMarkdownFile('file-1', makePair('hello'), markdownMeta)

    const crashing = new CrashingStorage(storage, 1) // envelope delete lands, state write dies
    await expect(makeStore(crashing).removeFile('file-1')).rejects.toThrow('simulated crash')

    const result = await makeStore(storage).load()
    expect(result.refetch.map((entry) => entry.fileId)).toEqual(['file-1'])
  })

  it('removeFile drops both artifacts', async () => {
    const storage = new MemoryDaemonStorage()
    const store = makeStore(storage)
    await store.persistMarkdownFile('file-1', makePair('hello'), markdownMeta)
    await store.removeFile('file-1')

    const result = await makeStore(storage).load()
    expect(result.state.files).toEqual({})
    expect(result.ready).toEqual([])
    expect(result.refetch).toEqual([])
    expect(await storage.list()).toEqual(['workspace-state.json'])
  })

  it('updateFileMeta rolls the watermark without breaking the pair', async () => {
    const storage = new MemoryDaemonStorage()
    let clock = 1000
    const store = makeStore(storage, () => clock++)
    const pair = makePair('hello')
    await store.persistMarkdownFile('file-1', pair, markdownMeta)
    await store.updateFileMeta('file-1', {
      path: 'notes/renamed.md',
      lastWrittenHash: 'hash-after-checkout',
      sizeBytes: 99,
    })

    const result = await makeStore(storage).load()
    expect(result.refetch).toEqual([])
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0]!.fileState.path).toBe('notes/renamed.md')
    expect(result.ready[0]!.fileState.lastWrittenHash).toBe('hash-after-checkout')
    expect(result.ready[0]!.syncedVVB64).toBe(pair.syncedVVB64)
  })

  it('persists cursor and pending tree intents across reload', async () => {
    const storage = new MemoryDaemonStorage()
    const store = makeStore(storage)
    await store.setLastAckedSeq(7)
    await store.setPendingRenames([
      { opId: 'op-r1', fileId: 'file-1', fromPath: 'a.md', toPath: 'b.md', baseSeq: 7 },
    ])
    await store.setPendingDeletes([
      { opId: 'op-d1', fileId: 'file-2', path: 'c.md', baseSeq: 7, observedMissingAtMs: 123 },
    ])

    const result = await makeStore(storage).load()
    expect(result.state.lastAckedSeq).toBe(7)
    expect(result.state.pendingRenames).toEqual([
      { opId: 'op-r1', fileId: 'file-1', fromPath: 'a.md', toPath: 'b.md', baseSeq: 7 },
    ])
    expect(result.state.pendingDeletes).toEqual([
      { opId: 'op-d1', fileId: 'file-2', path: 'c.md', baseSeq: 7, observedMissingAtMs: 123 },
    ])
  })

  it('fileIds with path-hostile characters stay confined to one artifact name', async () => {
    const storage = new MemoryDaemonStorage()
    const fileId = '../weird/..id'
    await makeStore(storage).persistMarkdownFile(fileId, makePair('x'), markdownMeta)

    const names = await storage.list()
    const envelope = names.find((name) => name !== 'workspace-state.json')!
    // Exactly the loro/ prefix segment plus one encoded leaf — the hostile
    // fileId must not introduce extra path segments or '..' segments.
    const segments = envelope.split('/')
    expect(segments).toHaveLength(2)
    expect(segments[0]).toBe('loro')
    expect(segments[1]).not.toBe('..')

    const result = await makeStore(storage).load()
    expect(result.ready.map((entry) => entry.fileId)).toEqual([fileId])
  })
})
