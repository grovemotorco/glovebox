import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeDaemonStorage } from '../../src/daemon/node-storage.ts'

describe('NodeDaemonStorage', () => {
  let dataDir: string
  let storage: NodeDaemonStorage

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'glovebox-daemon-'))
    storage = new NodeDaemonStorage(dataDir)
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('writes, reads back, and overwrites artifacts', async () => {
    await storage.writeAtomic('workspace-state.json', new TextEncoder().encode('v1'))
    expect(new TextDecoder().decode((await storage.read('workspace-state.json'))!)).toBe('v1')

    await storage.writeAtomic('workspace-state.json', new TextEncoder().encode('v2'))
    expect(new TextDecoder().decode((await storage.read('workspace-state.json'))!)).toBe('v2')
  })

  it('creates parent directories for nested names', async () => {
    await storage.writeAtomic('loro/file-1.snapshot.json', new TextEncoder().encode('snap'))
    expect(new TextDecoder().decode((await storage.read('loro/file-1.snapshot.json'))!)).toBe(
      'snap',
    )
    expect(await storage.list()).toEqual(['loro/file-1.snapshot.json'])
  })

  it('read of a missing artifact returns null; delete is idempotent', async () => {
    expect(await storage.read('nope.json')).toBeNull()
    await storage.delete('nope.json')
    await storage.writeAtomic('a.json', new TextEncoder().encode('x'))
    await storage.delete('a.json')
    await storage.delete('a.json')
    expect(await storage.read('a.json')).toBeNull()
  })

  it('list returns sorted names with / separators and an empty dir is fine', async () => {
    expect(await storage.list()).toEqual([])
    await storage.writeAtomic('b.json', new TextEncoder().encode('x'))
    await storage.writeAtomic('loro/a.snapshot.json', new TextEncoder().encode('x'))
    expect(await storage.list()).toEqual(['b.json', 'loro/a.snapshot.json'])
  })

  it('leaves no tmp litter after a write and hides crash leftovers', async () => {
    await storage.writeAtomic('loro/file-1.snapshot.json', new TextEncoder().encode('snap'))
    const entries = await readdir(dataDir, { recursive: true })
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([])

    // A tmp file abandoned by a crashed writer must never surface.
    await writeFile(join(dataDir, 'loro', 'file-2.snapshot.json.abc123.tmp'), 'partial')
    expect(await storage.list()).toEqual(['loro/file-1.snapshot.json'])
    expect(await storage.read('loro/file-2.snapshot.json')).toBeNull()
  })

  it('rejects artifact names that escape the data dir', async () => {
    await expect(storage.writeAtomic('../escape.json', new Uint8Array())).rejects.toThrow(
      'invalid artifact name',
    )
    await expect(storage.read('/absolute.json')).rejects.toThrow('invalid artifact name')
    await expect(storage.delete('a/../../b.json')).rejects.toThrow('invalid artifact name')
  })
})
