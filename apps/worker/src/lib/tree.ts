import type { WorkspaceTreeEntry } from '@glovebox/api'

export interface FileNode {
  kind: 'file'
  id: string
  name: string
  path: string
  entry: WorkspaceTreeEntry
}

export interface FolderNode {
  kind: 'folder'
  id: string
  name: string
  path: string
  children: TreeNode[]
}

export type TreeNode = FileNode | FolderNode

export function isFolder(node: TreeNode): node is FolderNode {
  return node.kind === 'folder'
}

export function liveEntries(entries: WorkspaceTreeEntry[]): WorkspaceTreeEntry[] {
  return entries.filter((entry) => !entry.tombstone)
}

/** Nest the workspace's flat path list into a folder hierarchy. */
export function buildTree(entries: WorkspaceTreeEntry[]): TreeNode[] {
  const root: TreeNode[] = []
  const folders = new Map<string, FolderNode>()

  const folderFor = (path: string): FolderNode => {
    const existing = folders.get(path)
    if (existing) return existing
    const lastSlash = path.lastIndexOf('/')
    const node: FolderNode = {
      kind: 'folder',
      id: `dir:${path}`,
      name: lastSlash === -1 ? path : path.slice(lastSlash + 1),
      path,
      children: [],
    }
    folders.set(path, node)
    const parent = lastSlash === -1 ? root : folderFor(path.slice(0, lastSlash)).children
    parent.push(node)
    return node
  }

  for (const entry of liveEntries(entries)) {
    const segments = entry.path.split('/').filter(Boolean)
    const name = segments[segments.length - 1] ?? entry.path
    const node: FileNode = { kind: 'file', id: entry.fileId, name, path: entry.path, entry }
    if (segments.length <= 1) {
      root.push(node)
    } else {
      folderFor(segments.slice(0, -1).join('/')).children.push(node)
    }
  }

  sortNodes(root)
  for (const folder of folders.values()) sortNodes(folder.children)
  return root
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** Folder paths that must be expanded for `path` to be visible. */
export function ancestorFolderIds(path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  const ids: string[] = []
  for (let i = 1; i < segments.length; i++) {
    ids.push(`dir:${segments.slice(0, i).join('/')}`)
  }
  return ids
}

export interface TreeStats {
  totalFiles: number
  totalSizeBytes: number
  folders: number
  lastModifiedAt: number | null
}

export function treeStats(entries: WorkspaceTreeEntry[]): TreeStats {
  const live = liveEntries(entries)
  const folders = new Set<string>()
  let totalSizeBytes = 0
  let lastModifiedAt: number | null = null
  for (const entry of live) {
    totalSizeBytes += entry.sizeBytes
    if (lastModifiedAt === null || entry.modifiedAt > lastModifiedAt) {
      lastModifiedAt = entry.modifiedAt
    }
    const segments = entry.path.split('/').filter(Boolean)
    for (let i = 1; i < segments.length; i++) {
      folders.add(segments.slice(0, i).join('/'))
    }
  }
  return { totalFiles: live.length, totalSizeBytes, folders: folders.size, lastModifiedAt }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function baseName(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}
