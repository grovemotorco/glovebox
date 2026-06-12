import { createWorkspaceError } from '../errors.js'
import { canonicalizePath } from '../path.js'
import type { Database } from '../storage.js'
import { resolveInode } from './resolve.js'

export interface WorkspaceDirentResult {
  name: string
  parentPath: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

interface DirentRow {
  name: string
  type: 'file' | 'dir' | 'symlink'
}

export function readdir(db: Database, path: string): WorkspaceDirentResult[] {
  const { path: canonical } = canonicalizePath(path)
  const node = resolveInode(db, canonical)
  if (node === null) {
    throw createWorkspaceError('ENOENT', `no such path: ${canonical}`, canonical)
  }
  if (node.type !== 'dir') {
    throw createWorkspaceError('ENOTDIR', `not a directory: ${canonical}`, canonical)
  }

  const rows = db.all<DirentRow>(
    `SELECT d.name AS name, n.type AS type
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ?
      ORDER BY d.name`,
    node.inode,
  )

  const entries = rows.map((row) => ({
    name: row.name,
    parentPath: canonical,
    isFile: row.type === 'file',
    isDirectory: row.type === 'dir',
    isSymbolicLink: row.type === 'symlink',
  }))

  return entries
}
