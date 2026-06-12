import { createWorkspaceError } from '../errors.js'
import { canonicalizePath } from '../path.js'
import type { Database } from '../storage.js'
import { resolveInode } from './resolve.js'

export interface WorkspaceStatResult {
  name: string
  mode: number
  mtime: number
  size: number
  isFile: boolean
  isDirectory: boolean
  // True when the result describes a symlink itself rather than
  // its target. Only lstat() can produce a true value here; stat()
  // follows links and reports the final node.
  isSymbolicLink: boolean
}

export function stat(db: Database, path: string): WorkspaceStatResult {
  return statShared(db, path, true)
}

// Like stat, but does not follow a trailing symlink. Mirrors POSIX
// lstat: the returned size for a symlink is the byte length of the
// stored target, and mode is the symlink node's own mode.
export function lstat(db: Database, path: string): WorkspaceStatResult {
  return statShared(db, path, false)
}

function statShared(db: Database, path: string, followFinal: boolean): WorkspaceStatResult {
  const { name } = canonicalizePath(path)
  const node = resolveInode(db, path, { followSymlinks: followFinal })
  if (node === null) {
    throw createWorkspaceError('ENOENT', `no such path: ${path}`, path)
  }

  const isDirectory = node.type === 'dir'
  const isFile = node.type === 'file'
  const isSymbolicLink = node.type === 'symlink'
  let size = 0
  if (isFile) {
    size = node.size
  } else if (isSymbolicLink) {
    size = (node.linkTarget ?? '').length
  }

  return {
    name,
    mode: node.mode,
    mtime: node.mtime,
    size,
    isFile,
    isDirectory,
    isSymbolicLink,
  }
}
