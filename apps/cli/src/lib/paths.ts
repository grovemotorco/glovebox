import { chmod, mkdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * `~/.glovebox/` layout (M8 scope note §5). Everything the daemon persists
 * lives OUTSIDE the mount: registry, auth tokens, per-mount daemon state
 * (the NodeDaemonStorage root) and per-mount lockfiles. The only in-mount
 * artifact is the `.glovebox.json` sentinel, owned by the engine (INV-3's
 * mount-suspect probe has to live in-mount to detect the mount vanishing).
 * `GLOVEBOX_HOME` overrides the root for tests.
 */

export interface GloveboxPaths {
  home: string
  mountsFile: string
  authFile: string
  stateDir(mountId: string): string
  lockFile(mountId: string): string
}

export function gloveboxPaths(env: NodeJS.ProcessEnv = process.env): GloveboxPaths {
  const home = env.GLOVEBOX_HOME ? resolve(env.GLOVEBOX_HOME) : join(homedir(), '.glovebox')
  return {
    home,
    mountsFile: join(home, 'mounts.json'),
    authFile: join(home, 'auth.json'),
    stateDir: (mountId) => join(home, 'state', encodeURIComponent(mountId)),
    lockFile: (mountId) => join(home, 'locks', `${encodeURIComponent(mountId)}.lock`),
  }
}

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE })
}

/**
 * Atomic write with owner-only permissions (tokens, registry): full
 * content to a sibling tmp file, then rename — a crash or concurrent
 * reader never observes a truncated file (a torn registry would silently
 * read as "no mounts" and the next save would erase every binding).
 */
export async function writeFileSecure(path: string, data: string): Promise<void> {
  await ensureDir(dirname(path))
  const tmpPath = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await writeFile(tmpPath, data, { encoding: 'utf-8', mode: FILE_MODE })
    await chmod(tmpPath, FILE_MODE).catch(() => {})
    await rename(tmpPath, path)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Serialize a critical section across processes with a mkdir mutex
 * (atomic create, no content to tear). An orphaned mutex (crash inside
 * the section) is taken over by age. Used for registry load-mutate-save —
 * two concurrent `glovebox mount` calls must not interleave (lost updates,
 * overlap refusal bypass).
 */
export async function withDirMutex<T>(
  mutexPath: string,
  fn: () => Promise<T>,
  options: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const staleMs = options.staleMs ?? 10_000
  const timeoutMs = options.timeoutMs ?? 10_000
  await ensureDir(dirname(mutexPath))
  const start = Date.now()
  for (;;) {
    try {
      await mkdir(mutexPath)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      const age = await stat(mutexPath).then(
        (s) => Date.now() - s.mtimeMs,
        () => null,
      )
      if (age !== null && age > staleMs) {
        await rmdir(mutexPath).catch(() => {})
        continue
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting for ${mutexPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await fn()
  } finally {
    await rmdir(mutexPath).catch(() => {})
  }
}

/** Resolve a user-supplied directory to its canonical absolute path. */
export async function canonicalizeDir(path: string): Promise<string | null> {
  try {
    return await realpath(resolve(path))
  } catch {
    return null
  }
}
