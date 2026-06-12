import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@glovebox/sync'
import { LocalFSError } from '@glovebox/sync'
import { MemoryFS } from '../src/fs/memory-fs.ts'

describe('MemoryFS', () => {
  it('reads content that was written and auto-creates parents', async () => {
    const fs = new MemoryFS()

    const hash = await fs.writeFile('docs/guide.md', '# Guide\n')

    expect(hash).toBe(sha256Hex('# Guide\n'))
    expect(await fs.readFile('docs/guide.md')).toBe('# Guide\n')
    expect(fs.snapshot()).toEqual({ 'docs/guide.md': '# Guide\n' })
  })

  it('scans markdown files with synthetic node ids', async () => {
    const fs = MemoryFS.from({
      'docs/guide.md': '# Guide\n',
      'notes.txt': 'skip',
      'readme.md': '# Readme\n',
    })

    const files = await fs.scan((name) => name.endsWith('.md'))

    expect(files.map((entry) => entry.relativePath).sort()).toEqual(['docs/guide.md', 'readme.md'])
    expect(
      files.every((entry) => typeof entry.nodeId === 'string' && entry.nodeId.length > 0),
    ).toBe(true)
  })

  it('preserves node ids when moving files', async () => {
    const fs = MemoryFS.from({ 'old-name.md': '# Base\n' })
    const nodeId = fs.getNodeId('old-name.md')

    fs.moveFile('old-name.md', 'nested/new-name.md')

    expect(fs.getNodeId('old-name.md')).toBeNull()
    expect(fs.getNodeId('nested/new-name.md')).toBe(nodeId)
    expect(fs.allPaths()).toEqual(['nested/new-name.md'])
  })

  it('lists direct children from the root', async () => {
    const fs = MemoryFS.from({
      'docs/guide.md': '# Guide\n',
      'readme.md': '# Readme\n',
    })

    expect(await fs.readdir('')).toEqual(
      expect.arrayContaining([
        { name: 'docs', type: 'directory' },
        { name: 'readme.md', type: 'file' },
      ]),
    )
  })

  it('rejects invalid relative paths', async () => {
    const fs = new MemoryFS()

    await expect(fs.writeFile('../secret.md', 'bad')).rejects.toBeInstanceOf(LocalFSError)
  })
})
