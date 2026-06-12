import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFSError, sha256Hex, type LocalFS } from '@glovebox/sync'
import { NodeFS, createNodeFS } from '@glovebox/sync/daemon'
import { MemoryFS } from '../src/fs/memory-fs.ts'
import { EDITOR_SAVE_PATTERNS, type EditorFS } from '../src/corpus/editor-saves.ts'

/**
 * Shared LocalFS conformance suite (M8): the same behavioral contract,
 * asserted against MemoryFS (what the simulation harness trusts) AND NodeFS
 * on a real tmpdir (what production mounts run on). Includes the ISSUE-0026
 * editor-save matrix on real inodes — `replacesNode` expectations must hold
 * on the actual filesystem, not just in the simulator.
 */

type ConformantFS = LocalFS & EditorFS

interface Target {
  name: string
  /** MemoryFS has no symlinks to refuse. */
  supportsSymlinks: boolean
  make(): Promise<{ fs: ConformantFS; root: string | null }>
}

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

const TARGETS: Target[] = [
  {
    name: 'MemoryFS',
    supportsSymlinks: false,
    async make() {
      return { fs: new MemoryFS('/mount'), root: null }
    },
  },
  {
    name: 'NodeFS (real tmpdir)',
    supportsSymlinks: true,
    async make() {
      const root = await mkdtemp(join(tmpdir(), 'glovebox-conformance-'))
      cleanups.push(() => rm(root, { recursive: true, force: true }))
      const fs = await createNodeFS(root)
      return { fs, root: fs.mountDir }
    },
  },
]

for (const target of TARGETS) {
  describe(`LocalFS conformance: ${target.name}`, () => {
    it('round-trips text and bytes, with consistent hashes', async () => {
      const { fs } = await target.make()
      const text = 'hello\nworld\n'
      const writtenHash = await fs.writeFile('notes/a.md', text)
      expect(writtenHash).toBe(sha256Hex(text))
      expect(await fs.readFile('notes/a.md')).toBe(text)
      expect(await fs.hash('notes/a.md')).toBe(writtenHash)

      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252])
      const bytesHash = await fs.writeFileBytes('blob.bin', bytes)
      expect(bytesHash).toBe(sha256Hex(bytes))
      expect(Array.from(await fs.readFileBytes('blob.bin'))).toEqual(Array.from(bytes))
    })

    it('stat reports files, directories, and absence', async () => {
      const { fs } = await target.make()
      await fs.writeFile('dir/file.md', 'x')

      const fileStat = await fs.stat('dir/file.md')
      expect(fileStat).not.toBeNull()
      expect(fileStat!.isFile).toBe(true)
      expect(fileStat!.isDirectory).toBe(false)
      expect(fileStat!.size).toBe(1)
      expect(fileStat!.nodeId).not.toBeNull()

      const dirStat = await fs.stat('dir')
      expect(dirStat!.isDirectory).toBe(true)
      expect(dirStat!.nodeId).toBeNull()

      expect(await fs.stat('missing.md')).toBeNull()
      expect(await fs.exists('dir/file.md')).toBe(true)
      expect(await fs.exists('missing.md')).toBe(false)

      const rootStat = await fs.stat('')
      expect(rootStat!.isDirectory).toBe(true)
    })

    it('readdir lists entries and rejects files', async () => {
      const { fs } = await target.make()
      await fs.writeFile('dir/a.md', 'a')
      await fs.writeFile('dir/sub/b.md', 'b')

      const entries = await fs.readdir('dir')
      const byName = new Map(entries.map((entry) => [entry.name, entry.type]))
      expect(byName.get('a.md')).toBe('file')
      expect(byName.get('sub')).toBe('directory')

      const root = await fs.readdir('')
      expect(root.some((entry) => entry.name === 'dir' && entry.type === 'directory')).toBe(true)

      await expect(fs.readdir('dir/a.md')).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' })
      await expect(fs.readdir('missing')).rejects.toMatchObject({ code: 'NOT_A_DIRECTORY' })
    })

    it('mkdir is recursive and idempotent', async () => {
      const { fs } = await target.make()
      await fs.mkdir('x/y/z')
      await fs.mkdir('x/y/z')
      expect((await fs.stat('x/y/z'))!.isDirectory).toBe(true)
      await fs.mkdir('')
    })

    it('deletePath removes files and empty directories, tolerates absence', async () => {
      const { fs } = await target.make()
      await fs.writeFile('doomed.md', 'x')
      await fs.deletePath('doomed.md')
      expect(await fs.exists('doomed.md')).toBe(false)
      await fs.deletePath('doomed.md')

      await fs.mkdir('hollow')
      await fs.deletePath('hollow')
      expect(await fs.exists('hollow')).toBe(false)
    })

    it('scan walks nested files with predicate filtering and nodeIds', async () => {
      const { fs } = await target.make()
      await fs.writeFile('a.md', '1')
      await fs.writeFile('notes/b.md', '2')
      await fs.writeFile('notes/deep/c.md', '3')
      await fs.writeFile('image.png', 'not-md')

      const all = await fs.scan(() => true)
      expect(all.map((r) => r.relativePath).sort()).toEqual([
        'a.md',
        'image.png',
        'notes/b.md',
        'notes/deep/c.md',
      ])
      for (const result of all) {
        expect(result.nodeId).not.toBeNull()
        expect(result.absolutePath).toBe(fs.resolve(result.relativePath))
      }

      const markdown = await fs.scan((name) => name.endsWith('.md'))
      expect(markdown.map((r) => r.relativePath).sort()).toEqual([
        'a.md',
        'notes/b.md',
        'notes/deep/c.md',
      ])
    })

    it('refuses path escapes and invalid paths', async () => {
      const { fs } = await target.make()
      await expect(fs.readFile('../outside.md')).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(fs.readFile('/etc/passwd')).rejects.toMatchObject({ code: 'INVALID_PATH' })
      await expect(fs.writeFile('a/../../b.md', 'x')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      })
      expect(fs.toRelative(join(fs.mountDir, '..', 'sibling'))).toBeNull()
      expect(fs.toRelative(join(fs.mountDir, 'inside', 'x.md'))).toBe('inside/x.md')
    })

    it('writeInPlace keeps the nodeId; rename moves it; target is replaced', async () => {
      const { fs } = await target.make()
      await fs.writeFile('a.md', 'first')
      const original = (await fs.stat('a.md'))!.nodeId

      await fs.writeInPlace('a.md', 'second')
      expect((await fs.stat('a.md'))!.nodeId).toBe(original)
      expect(await fs.readFile('a.md')).toBe('second')

      await fs.writeFile('b.md', 'occupied')
      await fs.rename('a.md', 'b.md')
      expect(await fs.exists('a.md')).toBe(false)
      expect(await fs.readFile('b.md')).toBe('second')
      expect((await fs.stat('b.md'))!.nodeId).toBe(original)

      await expect(fs.rename('missing.md', 'c.md')).rejects.toBeInstanceOf(LocalFSError)
    })

    describe('editor-save syscall matrix (ISSUE-0026) on this FS', () => {
      const TARGET_FILE = 'notes/a.md'
      const BEFORE = 'original content\n'
      const AFTER = 'saved content v2\n'

      async function seeded(): Promise<ConformantFS> {
        const { fs } = await target.make()
        await fs.writeFile('.glovebox.json', '{"workspaceId":"conformance"}\n')
        await fs.writeFile(TARGET_FILE, BEFORE)
        await fs.writeFile('notes/b.md', 'bystander\n')
        return fs
      }

      for (const pattern of EDITOR_SAVE_PATTERNS) {
        it(`${pattern.name}: content lands, no litter, nodeId continuity holds`, async () => {
          const fs = await seeded()
          const statBefore = await fs.stat(TARGET_FILE)
          await pattern.run(fs, TARGET_FILE, AFTER)

          expect(await fs.readFile(TARGET_FILE)).toBe(AFTER)
          for (const transient of pattern.transientPaths(TARGET_FILE)) {
            expect(await fs.exists(transient)).toBe(false)
          }
          expect(await fs.readFile('notes/b.md')).toBe('bystander\n')

          const statAfter = await fs.stat(TARGET_FILE)
          if (pattern.replacesNode) {
            // tmp+rename savers replace the inode — nodeId-first rename
            // detection must treat this as the same logical file.
            expect(statAfter!.nodeId).not.toBe(statBefore!.nodeId)
          } else {
            expect(statAfter!.nodeId).toBe(statBefore!.nodeId)
          }
        })
      }

      it('every pattern is idempotent over repeated saves', async () => {
        for (const pattern of EDITOR_SAVE_PATTERNS) {
          const fs = await seeded()
          await pattern.run(fs, TARGET_FILE, 'first\n')
          await pattern.run(fs, TARGET_FILE, 'second\n')
          await pattern.run(fs, TARGET_FILE, 'third\n')
          expect(await fs.readFile(TARGET_FILE)).toBe('third\n')
        }
      })
    })

    if (target.supportsSymlinks) {
      it('refuses symlink targets and symlinked parents; scan skips them', async () => {
        const made = await target.make()
        const fs = made.fs as NodeFS
        const root = made.root!

        await fs.writeFile('real/inner.md', 'real')
        await symlink(join(root, 'real'), join(root, 'linkdir'))
        await symlink(join(root, 'real/inner.md'), join(root, 'link.md'))

        await expect(fs.readFile('link.md')).rejects.toMatchObject({ code: 'SYMLINK_TARGET' })
        await expect(fs.readFile('linkdir/inner.md')).rejects.toMatchObject({
          code: 'SYMLINK_PARENT',
        })
        await expect(fs.writeFile('linkdir/new.md', 'x')).rejects.toMatchObject({
          code: 'SYMLINK_PARENT',
        })

        const scanned = await fs.scan(() => true)
        expect(scanned.map((r) => r.relativePath).sort()).toEqual(['real/inner.md'])
      })
    }
  })
}
