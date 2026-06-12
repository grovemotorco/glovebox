import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import type { DaemonStorage } from './state.ts'

/**
 * DaemonStorage over a real directory (the daemon's data dir, NEVER inside
 * the mount). Atomic artifact writes per the spec: write to a sibling tmp
 * file, fsync the file BEFORE rename (so the rename can't land pointing at
 * unflushed bytes after a power loss), then rename over the final name.
 * Leftover `*.tmp` files from a crash are invisible to read/list and are
 * overwritten-or-ignored, never promoted.
 */
export class NodeDaemonStorage implements DaemonStorage {
  readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  async read(name: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#resolve(name)))
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
    const finalPath = this.#resolve(name)
    const directory = dirname(finalPath)
    await mkdir(directory, { recursive: true })
    const tmpPath = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmpPath, 'w')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmpPath, finalPath)
    // Directory fsync makes the rename itself durable. Best-effort: not
    // every platform allows opening a directory for sync (Windows doesn't).
    try {
      const dirHandle = await open(directory, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      // The artifact is still atomic; only rename durability is weakened.
    }
  }

  async delete(name: string): Promise<void> {
    await rm(this.#resolve(name), { force: true })
  }

  async list(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.dataDir, { recursive: true, withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.tmp')) continue
      const absolute = join(entry.parentPath, entry.name)
      const relative = absolute.slice(this.dataDir.length + 1)
      names.push(relative.split(sep).join('/'))
    }
    return names.sort()
  }

  #resolve(name: string): string {
    const segments = name.split('/')
    if (
      name === '' ||
      name.startsWith('/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`invalid artifact name: ${name}`)
    }
    return join(this.dataDir, ...segments)
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
