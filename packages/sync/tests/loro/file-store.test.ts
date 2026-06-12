import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { InMemoryLoroFileStore, LoroFileService } from '../../src/loro/file-store.ts'

const FILE_ID = 'file-1'

describe('LoroFileService — store-mediated convergence', () => {
  it('initializes and re-materializes a file', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)

    const initial = await service.initialize(FILE_ID, 'hello')
    expect(initial.textContent).toBe('hello')

    const reloaded = await service.materialize(FILE_ID)
    expect(reloaded?.textContent).toBe('hello')
  })

  it('returns null on materialize for an unknown file', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)
    expect(await service.materialize('missing')).toBeNull()
  })

  it('records appended updates without rewriting the snapshot', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store, {
      compaction: { maxUpdateBytes: 1_000_000, maxUpdateCount: 1_000 },
    })
    await service.initialize(FILE_ID, 'baseline')

    const writer = LoroFileDoc.fromState(store.peek(FILE_ID) ?? { snapshot: null, updates: [] })
    const since = writer.contentVersion()
    writer.setTextContent('baseline +1')
    const update = writer.exportUpdateSince(since)

    const result = await service.importUpdates(FILE_ID, [update])
    expect(result.appliedUpdates).toBe(1)
    expect(result.changed).toBe(true)
    expect(result.textContent).toBe('baseline +1')

    const peeked = store.peek(FILE_ID)
    expect(peeked?.snapshot).not.toBeNull()
    expect(peeked?.updates.length).toBe(1)
  })

  it('compacts after the update count threshold', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store, {
      compaction: { maxUpdateCount: 3 },
    })
    await service.initialize(FILE_ID, '0')

    for (let i = 1; i <= 3; i++) {
      const writer = LoroFileDoc.fromState(store.peek(FILE_ID) ?? { snapshot: null, updates: [] })
      const since = writer.contentVersion()
      writer.setTextContent(String(i))
      const update = writer.exportUpdateSince(since)
      await service.importUpdates(FILE_ID, [update])
    }

    const peeked = store.peek(FILE_ID)
    expect(peeked?.updates.length).toBe(0)
  })

  it('drops a known-update on idempotent re-import', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)
    await service.initialize(FILE_ID, 'a')

    const writer = LoroFileDoc.fromState(store.peek(FILE_ID)!)
    const since = writer.contentVersion()
    writer.setTextContent('ab')
    const update = writer.exportUpdateSince(since)

    const first = await service.importUpdates(FILE_ID, [update])
    const second = await service.importUpdates(FILE_ID, [update])

    expect(first.appliedUpdates).toBe(1)
    expect(second.appliedUpdates).toBe(0)
    expect(second.changed).toBe(false)
    expect(second.textContent).toBe('ab')
  })

  it('exit criteria — two offline editors converge through the store', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)
    await service.initialize(FILE_ID, '# Heading\n\nbody')

    // Each editor pulls a fresh snapshot of the file.
    const seedState = store.peek(FILE_ID)!
    const editorA = LoroFileDoc.fromState(seedState, { peerId: 11n })
    const editorB = LoroFileDoc.fromState(seedState, { peerId: 22n })

    const versionA0 = editorA.contentVersion()
    const versionB0 = editorB.contentVersion()

    // Concurrent offline edits.
    editorA.setTextContent('# Heading\n\nbody A')
    editorB.setTextContent('# Heading B\n\nbody')

    const updateFromA = editorA.exportUpdateSince(versionA0)
    const updateFromB = editorB.exportUpdateSince(versionB0)

    // Editor A submits first, then editor B (out of order delivery is OK).
    const r1 = await service.importUpdates(FILE_ID, [updateFromA])
    const r2 = await service.importUpdates(FILE_ID, [updateFromB])
    expect(r1.appliedUpdates).toBe(1)
    expect(r2.appliedUpdates).toBe(1)

    // Both editors pull the canonical text and apply each other's update.
    const canonical = (await service.materialize(FILE_ID))!
    editorA.importUpdate(updateFromB)
    editorB.importUpdate(updateFromA)

    expect(editorA.getTextContent()).toBe(canonical.textContent)
    expect(editorB.getTextContent()).toBe(canonical.textContent)
    // Loro's text merge keeps both edits — the deterministic LWW is up to Loro
    // and only matters in that both sides agree.
    expect(canonical.textContent).toContain('# Heading')
    expect(canonical.textContent).toContain('body')
  })

  it('exports updates since a peer-supplied version vector', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)
    await service.initialize(FILE_ID, 'one')

    const baseSnapshot = (await store.loadState(FILE_ID))!.snapshot!
    const writer = LoroFileDoc.fromSnapshot(baseSnapshot)
    const baseVersion = writer.contentVersion()
    writer.setTextContent('one two')
    await service.importUpdates(FILE_ID, [writer.exportUpdateSince(baseVersion)])

    const since = await service.exportUpdateSince(FILE_ID, baseVersion)
    expect(since).not.toBeNull()

    const replayer = LoroFileDoc.fromSnapshot(baseSnapshot)
    expect(replayer.getTextContent()).toBe('one')
    expect(replayer.importUpdate(since!)).toBe(true)
    expect(replayer.getTextContent()).toBe('one two')
  })

  it('replaces text content and persists a fresh snapshot', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)
    await service.initialize(FILE_ID, 'old')
    const result = await service.setTextContent(FILE_ID, 'new')
    expect(result.textContent).toBe('new')
    const peek = store.peek(FILE_ID)
    expect(peek?.updates.length).toBe(0)
    expect(peek?.snapshot).not.toBeNull()
  })

  it('removes a file fully via delete', async () => {
    const store = new InMemoryLoroFileStore()
    const service = new LoroFileService(store)
    await service.initialize(FILE_ID, 'present')
    await service.delete(FILE_ID)
    expect(await service.materialize(FILE_ID)).toBeNull()
  })
})
