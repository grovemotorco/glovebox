import { normalizeWorkspaceRelativePath } from '@glovebox/core'
import { constants as fsConstants } from 'node:fs'
import {
  lstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  realpath,
  rename as nodeRename,
  rmdir,
  rm,
  writeFile as nodeWriteFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sha256Hex } from './hash.ts'
import {
  LocalFSError,
  type DirEntry,
  type FileStat,
  type LocalFS,
  type ScanResult,
} from './local-fs.ts'

/**
 * `LocalFS` over a real directory (ported from loro-2 `mounted-fs.ts`,
 * interface unchanged). Symlinks are refused both as targets and as path
 * parents (`SYMLINK_TARGET`/`SYMLINK_PARENT`), every path is validated
 * against mount escape, and `nodeId` is the `dev:ino` pair from bigint
 * lstat — the identity the scanner's nodeId-first rename detection rides.
 */

interface PathOptions {
  allowRoot?: boolean
}

function isMissingPathError(error: unknown): boolean {
  return !!(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

async function writeAtomically(destPath: string, content: Uint8Array | string): Promise<void> {
  await nodeMkdir(dirname(destPath), { recursive: true })
  const tmpPath = join(
    dirname(destPath),
    `.glovebox-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )

  try {
    await nodeWriteFile(tmpPath, content)
    await nodeRename(tmpPath, destPath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

export class NodeFS implements LocalFS {
  readonly mountDir: string

  constructor(canonicalMountDir: string) {
    this.mountDir = canonicalMountDir
  }

  async readFile(relativePath: string): Promise<string> {
    const absolutePath = await this.validateAndResolve(relativePath)
    try {
      return await nodeReadFile(absolutePath, 'utf-8')
    } catch (error) {
      throw this.mapIOError(relativePath, error, 'file')
    }
  }

  async readFileBytes(relativePath: string): Promise<Uint8Array> {
    const absolutePath = await this.validateAndResolve(relativePath)
    try {
      return await nodeReadFile(absolutePath)
    } catch (error) {
      throw this.mapIOError(relativePath, error, 'file')
    }
  }

  async stat(relativePath: string): Promise<FileStat | null> {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    if (normalized === '') {
      const rootStat = await lstat(this.mountDir, { bigint: true })
      return this.toFileStat(rootStat)
    }

    const absolutePath = this.resolveNormalized(normalized)
    await this.assertNoSymlinks(absolutePath, normalized, { includeLeaf: false })
    const stats = await lstatOrNull(absolutePath)
    return stats ? this.toFileStat(stats) : null
  }

  async exists(relativePath: string): Promise<boolean> {
    return (await this.stat(relativePath)) !== null
  }

  async readdir(relativePath: string): Promise<DirEntry[]> {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    const absolutePath =
      normalized === ''
        ? this.mountDir
        : await this.validateAndResolve(normalized, { allowRoot: true })
    const stats = await lstatOrNull(absolutePath)
    if (!stats?.isDirectory()) {
      throw new LocalFSError('NOT_A_DIRECTORY', relativePath)
    }

    const entries = await nodeReaddir(absolutePath, { withFileTypes: true })
    const results: DirEntry[] = []
    for (const entry of entries) {
      const entryPath = join(absolutePath, entry.name)
      const entryStats = await lstatOrNull(entryPath)
      if (!entryStats || entryStats.isSymbolicLink()) {
        continue
      }
      if (entryStats.isFile()) {
        results.push({ name: entry.name, type: 'file' })
      } else if (entryStats.isDirectory()) {
        results.push({ name: entry.name, type: 'directory' })
      }
    }

    return results
  }

  async writeFile(relativePath: string, content: string): Promise<string> {
    const hash = sha256Hex(content)
    await this.writeContent(relativePath, content)
    return hash
  }

  async writeFileBytes(relativePath: string, content: Uint8Array): Promise<string> {
    const hash = sha256Hex(content)
    await this.writeContent(relativePath, content)
    return hash
  }

  /**
   * True in-place write — truncate + write on the SAME inode, no tmp+rename
   * (the regular `writeFile` is atomic-replace, which changes the nodeId on
   * a real filesystem). Exists for editor-save simulation: in-place savers
   * (vim backupcopy=yes, `echo >`, stream appenders) keep the inode, and the
   * corpus asserts that on real disks. Daemon code never calls this.
   */
  async writeInPlace(relativePath: string, content: string): Promise<string> {
    const absolutePath = await this.validateAndResolve(relativePath)
    try {
      await nodeMkdir(dirname(absolutePath), { recursive: true })
      // O_NOFOLLOW: the symlink check in validateAndResolve is
      // time-of-check — a symlink swapped in before the open would
      // otherwise be FOLLOWED (O_TRUNC write through it escapes the
      // mount). The atomic-replace writeFile is immune (rename never
      // follows); the in-place path must refuse at open time.
      const handle = await nodeOpen(
        absolutePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      )
      try {
        await handle.writeFile(content)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new LocalFSError('SYMLINK_TARGET', relativePath)
      }
      throw this.mapIOError(relativePath, error, 'file')
    }
    return sha256Hex(content)
  }

  /**
   * Atomic move (rename(2)): the moved node keeps its identity (nodeId
   * travels), an existing target is replaced atomically, parents are
   * created. The daemon uses this to relocate a colliding local file in a
   * single syscall (ISSUE-0050 B) — never read+write+unlink, which a crash
   * could leave half-done (both copies on disk).
   */
  async move(fromPath: string, toPath: string): Promise<void> {
    const fromAbsolute = await this.validateAndResolve(fromPath)
    const toAbsolute = await this.validateAndResolve(toPath)
    try {
      await nodeMkdir(dirname(toAbsolute), { recursive: true })
      await nodeRename(fromAbsolute, toAbsolute)
    } catch (error) {
      throw this.mapIOError(fromPath, error, 'file')
    }
  }

  /**
   * POSIX rename(2) for editor-save simulation — identical semantics to
   * `move`, kept as the name the editor-save corpus reads.
   */
  async rename(fromPath: string, toPath: string): Promise<void> {
    await this.move(fromPath, toPath)
  }

  async deletePath(relativePath: string): Promise<void> {
    const absolutePath = await this.validateAndResolve(relativePath)
    const stats = await lstatOrNull(absolutePath)
    if (stats?.isDirectory()) {
      await rmdir(absolutePath).catch((error) => {
        if (isMissingPathError(error)) {
          return
        }
        throw this.mapIOError(relativePath, error, 'directory')
      })
      return
    }

    await rm(absolutePath, { force: true }).catch((error) => {
      if (isMissingPathError(error)) {
        return
      }
      throw this.mapIOError(relativePath, error, 'file')
    })
  }

  async mkdir(relativePath: string): Promise<void> {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    if (normalized === '') {
      return
    }

    const absolutePath = await this.validateAndResolve(normalized, { allowRoot: true })
    try {
      await nodeMkdir(absolutePath, { recursive: true })
    } catch (error) {
      throw this.mapIOError(relativePath, error, 'directory')
    }
  }

  async hash(relativePath: string): Promise<string> {
    const content = await this.readFileBytes(relativePath)
    return sha256Hex(content)
  }

  async scan(predicate: (name: string) => boolean): Promise<ScanResult[]> {
    const results: ScanResult[] = []
    await this.walkDir(this.mountDir, predicate, results)
    return results
  }

  resolve(relativePath: string): string {
    const normalized = this.normalizePath(relativePath, { allowRoot: true })
    return this.resolveNormalized(normalized)
  }

  toRelative(absolutePath: string): string | null {
    const rel = relative(this.mountDir, resolve(absolutePath))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return null
    }

    return normalizeWorkspaceRelativePath(rel.split(sep).join('/'))
  }

  private async writeContent(relativePath: string, content: Uint8Array | string): Promise<void> {
    const absolutePath = await this.validateAndResolve(relativePath)
    try {
      await writeAtomically(absolutePath, content)
    } catch (error) {
      throw this.mapIOError(relativePath, error, 'file')
    }
  }

  private normalizePath(relativePath: string, options: PathOptions = {}): string {
    if (options.allowRoot && relativePath === '') {
      return ''
    }

    const normalized = normalizeWorkspaceRelativePath(relativePath)
    if (!normalized) {
      throw new LocalFSError('INVALID_PATH', relativePath)
    }

    return normalized
  }

  private resolveNormalized(normalizedRelativePath: string): string {
    if (normalizedRelativePath === '') {
      return this.mountDir
    }

    return join(this.mountDir, ...normalizedRelativePath.split('/'))
  }

  private toRelativeInternal(absolutePath: string): string {
    const relativePath = this.toRelative(absolutePath)
    if (!relativePath) {
      throw new LocalFSError('OUTSIDE_MOUNT', absolutePath)
    }
    return relativePath
  }

  private async validateAndResolve(
    relativePath: string,
    options: PathOptions = {},
  ): Promise<string> {
    const normalized = this.normalizePath(relativePath, options)
    const absolutePath = this.resolveNormalized(normalized)
    await this.assertNoSymlinks(absolutePath, normalized, { includeLeaf: normalized !== '' })
    return absolutePath
  }

  private async assertNoSymlinks(
    absolutePath: string,
    normalizedRelativePath: string,
    options: { includeLeaf: boolean },
  ): Promise<void> {
    if (normalizedRelativePath === '') {
      return
    }

    const parts = normalizedRelativePath.split('/')
    let current = this.mountDir

    for (let index = 0; index < parts.length; index += 1) {
      if (!options.includeLeaf && index === parts.length - 1) {
        return
      }

      current = join(current, parts[index]!)
      const stats = await lstatOrNull(current)
      if (!stats) {
        return
      }
      if (stats.isSymbolicLink()) {
        throw new LocalFSError(
          index === parts.length - 1 ? 'SYMLINK_TARGET' : 'SYMLINK_PARENT',
          normalizedRelativePath,
        )
      }
    }

    const relativePath = this.toRelative(absolutePath)
    if (relativePath === null && absolutePath !== this.mountDir) {
      throw new LocalFSError('OUTSIDE_MOUNT', absolutePath)
    }
  }

  private async walkDir(
    dir: string,
    predicate: (name: string) => boolean,
    out: ScanResult[],
  ): Promise<void> {
    const entries = await nodeReaddir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = join(dir, entry.name)
      const stats = await lstatOrNull(absolutePath)
      if (!stats || stats.isSymbolicLink()) {
        continue
      }
      if (stats.isDirectory()) {
        await this.walkDir(absolutePath, predicate, out)
      } else if (stats.isFile() && predicate(entry.name)) {
        out.push({
          relativePath: this.toRelativeInternal(absolutePath),
          absolutePath,
          nodeId: this.toNodeId(stats),
        })
      }
    }
  }

  private mapIOError(
    relativePath: string,
    error: unknown,
    expected: 'file' | 'directory',
  ): LocalFSError {
    if (error instanceof LocalFSError) {
      return error
    }

    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return new LocalFSError(
          expected === 'directory' ? 'NOT_A_DIRECTORY' : 'NOT_FOUND',
          relativePath,
        )
      }
      if (error.code === 'EISDIR') {
        return new LocalFSError('NOT_A_FILE', relativePath)
      }
      if (error.code === 'EEXIST') {
        return new LocalFSError('NOT_A_DIRECTORY', relativePath)
      }
    }

    return new LocalFSError(
      'IO_ERROR',
      relativePath,
      error instanceof Error ? error.message : `Filesystem operation failed for ${relativePath}`,
    )
  }

  private toFileStat(stats: Awaited<ReturnType<typeof lstat>>): FileStat {
    return {
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeMs),
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymlink: stats.isSymbolicLink(),
      nodeId: stats.isFile() ? this.toNodeId(stats) : null,
    }
  }

  private toNodeId(stats: Awaited<ReturnType<typeof lstat>>): string | null {
    if (!stats.isFile()) {
      return null
    }

    return `${stats.dev.toString()}:${stats.ino.toString()}`
  }
}

export async function createNodeFS(mountDir: string): Promise<NodeFS> {
  return new NodeFS(await realpath(mountDir))
}
