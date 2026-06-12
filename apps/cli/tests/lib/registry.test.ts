import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gloveboxPaths } from '../../src/lib/paths.ts'
import {
  addMount,
  findMountForDir,
  findOverlap,
  loadRegistry,
  removeMount,
  type MountEntry,
} from '../../src/lib/registry.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function tempPaths() {
  const home = await mkdtemp(join(tmpdir(), 'glovebox-home-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return gloveboxPaths({ GLOVEBOX_HOME: home })
}

function entry(overrides: Partial<MountEntry>): MountEntry {
  return {
    mountId: 'm-1',
    dir: '/work/notes',
    workspaceId: 'ws-1',
    serverUrl: 'https://api.glovebox.test',
    deviceId: 'd-1',
    createdAt: 1,
    ...overrides,
  }
}

describe('mount registry', () => {
  it('persists entries with owner-only permissions and round-trips', async () => {
    const paths = await tempPaths()
    await addMount(paths, entry({}))

    const registry = await loadRegistry(paths)
    expect(registry.mounts).toHaveLength(1)
    expect(registry.mounts[0]!.dir).toBe('/work/notes')

    const mode = (await stat(paths.mountsFile)).mode & 0o777
    expect(mode).toBe(0o600)

    await removeMount(paths, 'm-1')
    expect((await loadRegistry(paths)).mounts).toHaveLength(0)
  })

  it('missing or corrupt registry degrades to empty, bad entries are dropped', async () => {
    const paths = await tempPaths()
    expect((await loadRegistry(paths)).mounts).toEqual([])

    await addMount(paths, entry({}))
    const raw = JSON.parse(await readFile(paths.mountsFile, 'utf-8')) as {
      mounts: unknown[]
    }
    raw.mounts.push({ mountId: 'evil', extraKey: true })
    raw.mounts.push('not-an-object')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(paths.mountsFile, JSON.stringify(raw))

    const registry = await loadRegistry(paths)
    expect(registry.mounts.map((m) => m.mountId)).toEqual(['m-1'])
  })

  it('refuses identical, nested, and containing mounts', async () => {
    const paths = await tempPaths()
    await addMount(paths, entry({ dir: '/work/notes' }))

    await expect(addMount(paths, entry({ mountId: 'm-2', dir: '/work/notes' }))).rejects.toThrow(
      /already mounted/,
    )
    await expect(
      addMount(paths, entry({ mountId: 'm-3', dir: '/work/notes/sub' })),
    ).rejects.toThrow(/overlaps/)
    await expect(addMount(paths, entry({ mountId: 'm-4', dir: '/work' }))).rejects.toThrow(
      /overlaps/,
    )
    // Sibling with a shared name prefix is NOT an overlap.
    await addMount(paths, entry({ mountId: 'm-5', dir: '/work/notes-2' }))
    expect(findOverlap(await loadRegistry(paths), '/elsewhere')).toBeNull()
  })

  it('findMountForDir picks the deepest ancestor', async () => {
    const paths = await tempPaths()
    await addMount(paths, entry({ mountId: 'outer', dir: '/a' }))
    const registry = await loadRegistry(paths)

    expect(findMountForDir(registry, '/a/b/c')?.mountId).toBe('outer')
    expect(findMountForDir(registry, '/a')?.mountId).toBe('outer')
    expect(findMountForDir(registry, '/ab')).toBeNull()
  })
})

describe('registry mutation hardening (review findings)', () => {
  it('concurrent overlapping addMounts: exactly one wins', async () => {
    const paths = await tempPaths()
    const results = await Promise.allSettled([
      addMount(paths, entry({ mountId: 'r-1', dir: '/race/a' })),
      addMount(paths, entry({ mountId: 'r-2', dir: '/race/a/nested' })),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    const registry = await loadRegistry(paths)
    expect(registry.mounts).toHaveLength(1)
  })

  it('normalizes trailing separators from hand-edited registries', async () => {
    const paths = await tempPaths()
    await addMount(paths, entry({ mountId: 't-1', dir: '/clean/notes' }))
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(paths.mountsFile, 'utf-8')) as {
      mounts: { dir: string }[]
    }
    raw.mounts[0]!.dir = '/clean/notes/'
    await writeFile(paths.mountsFile, JSON.stringify(raw))

    const registry = await loadRegistry(paths)
    expect(registry.mounts[0]!.dir).toBe('/clean/notes')
    expect(findMountForDir(registry, '/clean/notes')?.mountId).toBe('t-1')
    expect(findMountForDir(registry, '/clean/notes/sub')?.mountId).toBe('t-1')
  })
})
