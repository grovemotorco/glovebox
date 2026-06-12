import { describe, expect, it } from 'vitest'
import { sha256Hex, type LocalFS } from '@glovebox/sync'
import { scanMount, type DaemonFileView } from '@glovebox/sync/daemon'
import { MemoryFS } from '../src/fs/memory-fs.ts'
import { EDITOR_SAVE_PATTERNS } from '../src/corpus/editor-saves.ts'

async function view(fs: LocalFS, fileId: string, path: string): Promise<DaemonFileView> {
  const stat = await fs.stat(path)
  const bytes = await fs.readFileBytes(path)
  return {
    fileId,
    path,
    contentKind: path.endsWith('.md') ? 'markdown' : 'opaque',
    nodeId: stat?.nodeId ?? null,
    lastWrittenHash: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
  }
}

async function seeded(): Promise<{ fs: MemoryFS; files: DaemonFileView[] }> {
  const fs = new MemoryFS('/mount')
  await fs.writeFile('notes/a.md', 'alpha\n')
  await fs.writeFile('notes/b.md', 'beta\n')
  await fs.writeFile('assets/img.bin', 'binary-ish\n')
  const files = [
    await view(fs, 'f-a', 'notes/a.md'),
    await view(fs, 'f-b', 'notes/b.md'),
    await view(fs, 'f-img', 'assets/img.bin'),
  ]
  return { fs, files }
}

describe('daemon scanMount', () => {
  it('reports nothing when disk matches the watermarks', async () => {
    const { fs, files } = await seeded()
    const diff = await scanMount({ fs, files })
    expect(diff).toEqual({ renames: [], deletes: [], creates: [], contentChanges: [] })
  })

  it('classifies creates, edits, and deletes', async () => {
    const { fs, files } = await seeded()
    await fs.writeFile('notes/new.md', 'fresh\n')
    await fs.writeFile('notes/a.md', 'alpha edited\n')
    await fs.deletePath('notes/b.md')

    const diff = await scanMount({ fs, files })
    expect(diff.creates.map((entry) => entry.path)).toEqual(['notes/new.md'])
    expect(diff.contentChanges.map((change) => change.fileId)).toEqual(['f-a'])
    expect(diff.deletes).toEqual([{ fileId: 'f-b', path: 'notes/b.md' }])
    expect(diff.renames).toEqual([])
  })

  it('detects a rename by nodeId even when content changed too', async () => {
    const { fs, files } = await seeded()
    await fs.rename('notes/a.md', 'notes/renamed.md')
    await fs.writeFile('notes/renamed.md', 'alpha edited after move\n')

    const diff = await scanMount({ fs, files })
    expect(diff.renames).toHaveLength(1)
    expect(diff.renames[0]).toMatchObject({
      fileId: 'f-a',
      fromPath: 'notes/a.md',
      toPath: 'notes/renamed.md',
    })
    expect(diff.deletes).toEqual([])
    expect(diff.creates).toEqual([])
    // The post-move edit surfaces as a content change for the SAME file.
    expect(diff.contentChanges.map((change) => change.fileId)).toEqual(['f-a'])
  })

  it('falls back to hash+size matching when the inode changed (copy+delete move)', async () => {
    const { fs, files } = await seeded()
    const content = await fs.readFile('notes/a.md')
    await fs.deletePath('notes/a.md')
    await fs.writeFile('archive/a.md', content) // new inode, same bytes

    const diff = await scanMount({ fs, files })
    expect(diff.renames).toHaveLength(1)
    expect(diff.renames[0]).toMatchObject({ fileId: 'f-a', toPath: 'archive/a.md' })
    expect(diff.deletes).toEqual([])
    expect(diff.contentChanges).toEqual([])
  })

  it('never pairs one new path with two missing files', async () => {
    const fs = new MemoryFS('/mount')
    await fs.writeFile('x.md', 'same\n')
    await fs.writeFile('y.md', 'same\n')
    const files = [await view(fs, 'f-x', 'x.md'), await view(fs, 'f-y', 'y.md')]
    await fs.deletePath('x.md')
    await fs.deletePath('y.md')
    await fs.writeFile('z.md', 'same\n')

    const diff = await scanMount({ fs, files })
    expect(diff.renames).toHaveLength(1)
    expect(diff.deletes).toHaveLength(1)
    expect(diff.creates).toEqual([])
  })

  it('sees every editor-save pattern as exactly one content change (never delete+create)', async () => {
    for (const pattern of EDITOR_SAVE_PATTERNS) {
      const fs = new MemoryFS('/mount')
      await fs.writeFile('doc.md', 'before\n')
      const files = [await view(fs, 'f-doc', 'doc.md')]

      await pattern.run(fs, 'doc.md', 'after the save\n')
      const diff = await scanMount({ fs, files })

      expect(diff.deletes, pattern.name).toEqual([])
      expect(diff.creates, pattern.name).toEqual([])
      const changed = [...diff.contentChanges, ...diff.renames.map((r) => ({ fileId: r.fileId }))]
      expect(changed.length, pattern.name).toBeGreaterThanOrEqual(1)
      expect(new Set(changed.map((c) => c.fileId)), pattern.name).toEqual(new Set(['f-doc']))
      const content = diff.contentChanges[0]?.entry.text
      expect(content, pattern.name).toBe('after the save\n')
    }
  })
})
