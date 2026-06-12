import { useCallback, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { normalizeWorkspaceRelativePath } from '@glovebox/core'
import { errorMessage } from '../lib/api.ts'
import { ancestorFolderIds, buildTree, isFolder } from '../lib/tree.ts'
import type { FileNode, FolderNode, TreeNode } from '../lib/tree.ts'
import { useUiActions, useUiState } from '../state/ui.ts'
import { useWorkspace } from '../state/workspace.tsx'
import { ChevronRightIcon, FolderIcon, PlusIcon } from './icons.tsx'

export function FileTree() {
  const { tree, createFile, connectionStatus } = useWorkspace()
  const { setActiveFile } = useUiActions()
  const [creating, setCreating] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  const nodes = useMemo(() => buildTree(tree), [tree])

  // The input only mounts after the user's "+" click, so focusing on mount
  // is intentional focus management — without the extra render an
  // autoFocus-replacement effect would cost.
  const focusOnMount = useCallback((node: HTMLInputElement | null) => node?.focus(), [])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    const normalized = normalizeWorkspaceRelativePath(newPath.trim())
    if (!normalized) {
      setError('Invalid path')
      return
    }
    setError(null)
    try {
      const fileId = await createFile(normalized)
      setActiveFile(fileId, ancestorFolderIds(normalized))
      setNewPath('')
      setCreating(false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1">
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--gb-text-muted)] opacity-80">
          Files
        </span>
        <button
          type="button"
          onClick={() => {
            setCreating(!creating)
            setError(null)
          }}
          disabled={connectionStatus === 'disconnected'}
          title={
            connectionStatus === 'disconnected' ? 'Connect to create files' : 'New markdown file'
          }
          aria-label="New markdown file"
          className="rounded p-1 text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)] disabled:opacity-40"
        >
          <PlusIcon size={14} />
        </button>
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="px-2 pb-2">
          <input
            ref={focusOnMount}
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCreating(false)
            }}
            placeholder="docs/new-note.md"
            aria-label="New file path"
            className="w-full px-2 py-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[11px] font-mono text-[var(--gb-text)] outline-none placeholder:text-[var(--gb-text-muted)]/50 focus:border-[var(--gb-accent)]"
          />
          {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
        </form>
      )}

      {nodes.length === 0 && !creating ? (
        <p className="px-2 py-3 text-[11px] text-[var(--gb-text-muted)] opacity-60">
          No files yet. Create one with the + button.
        </p>
      ) : (
        <TreeLevel nodes={nodes} depth={0} />
      )}
    </div>
  )
}

function TreeLevel({ nodes, depth }: { nodes: TreeNode[]; depth: number }) {
  return (
    <ul className="list-none m-0 p-0">
      {nodes.map((node) =>
        isFolder(node) ? (
          <FolderRow key={node.id} node={node} depth={depth} />
        ) : (
          <FileRow key={node.id} node={node} depth={depth} />
        ),
      )}
    </ul>
  )
}

function FolderRow({ node, depth }: { node: FolderNode; depth: number }) {
  const { expandedFolders } = useUiState()
  const { toggleFolder } = useUiActions()
  const isOpen = expandedFolders.has(node.id)

  return (
    <li>
      <button
        type="button"
        onClick={() => toggleFolder(node.id)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent px-2 py-[5px] text-left text-[13px] font-semibold text-[var(--gb-text)] transition-colors hover:bg-[var(--gb-hover)]"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        aria-expanded={isOpen}
      >
        <ChevronRightIcon
          size={12}
          className="flex-shrink-0 text-[var(--gb-text-muted)] transition-transform duration-150"
          style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <FolderIcon open={isOpen} className="flex-shrink-0 text-[var(--gb-accent)]" />
        <span className="truncate">{node.name}</span>
      </button>
      {isOpen && <TreeLevel nodes={node.children} depth={depth + 1} />}
    </li>
  )
}

function FileRow({ node, depth }: { node: FileNode; depth: number }) {
  const { activeFileId } = useUiState()
  const { setActiveFile } = useUiActions()
  const isActive = activeFileId === node.id

  return (
    <li>
      <button
        type="button"
        onClick={() => setActiveFile(node.id, ancestorFolderIds(node.path))}
        className={`flex items-center gap-1.5 w-full border-none bg-transparent text-[13px] cursor-pointer rounded-md px-2 py-[5px] text-left transition-colors ${
          isActive
            ? 'bg-[var(--gb-accent)] text-white font-medium'
            : 'text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <FileBadge name={node.name} active={isActive} />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  )
}

function FileBadge({ name, active }: { name: string; active: boolean }) {
  const ext = name.split('.').pop()
  const color = ext === 'md' ? 'var(--grove-velocity-cyan)' : 'var(--gb-text-muted)'

  return (
    <span
      className="inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded text-[9px] font-bold"
      style={{
        color: active ? 'white' : color,
        background: active
          ? 'rgb(255 255 255 / 0.2)'
          : `color-mix(in oklch, ${color} 16%, transparent)`,
      }}
    >
      {ext === 'md' ? 'M' : ext?.toUpperCase().slice(0, 2)}
    </span>
  )
}
