import { canonicalizePath } from '../path.js'
import { ROOT_INODE } from '../schema/index.js'
import type { Database } from '../storage.js'

interface PathRow {
  path: string
}

// Recursive CTE that materializes every file path in the tree, then
// filters by the requested prefix. Files only (no directory entries)
// because that's the documented "flat list of file paths" semantics.
//
// The CTE walks from ROOT_INODE: each row is (inode, path, type). The
// path is built by concatenating dirent names with '/' separators;
// root contributes the empty string so its children start with '/'.
//
// Prefix matching is exact: '/wsp' must not match '/workspace/x'. We
// require either path == prefix (file at the exact prefix) or
// path starts with prefix + '/' (descendants of a directory prefix).
const LS_QUERY = `
  WITH RECURSIVE walk(inode, path, type) AS (
    SELECT inode, '', type FROM vfs_nodes WHERE inode = ?
    UNION ALL
    SELECT n.inode, w.path || '/' || d.name, n.type
      FROM walk w
      JOIN vfs_dirents d ON d.parent_inode = w.inode
      JOIN vfs_nodes n ON n.inode = d.child_inode
  )
  SELECT path FROM walk
   WHERE type = 'file'
     AND (? = '/' OR path = ? OR path LIKE ? || '/%')
   ORDER BY path
`

export function ls(db: Database, prefix: string): string[] {
  const { path: canonical } = canonicalizePath(prefix)
  return db
    .all<PathRow>(LS_QUERY, ROOT_INODE, canonical, canonical, canonical)
    .map((row) => row.path)
}
