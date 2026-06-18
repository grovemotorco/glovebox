import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { normalizeWorkspaceRelativePath } from '@glovebox.md/core'
import { errorMessage } from '../lib/api.ts'
import {
  ancestorFolderIds,
  buildTree,
  deleteFileOp,
  deleteFolderOps,
  describeDeferredOp,
  entriesUnderFolder,
  isFolder,
  renameFileOp,
  renameFolderOps,
  withBaseName,
} from '../lib/tree.ts'
import type { FileNode, FolderNode, TreeNode } from '../lib/tree.ts'
import type { BatchSubmitResult } from '../lib/transport.ts'
import { useUiActions, useUiState } from '../state/ui.ts'
import { useWorkspace } from '../state/workspace.tsx'
import {
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  MoreIcon,
  MoveIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from './icons.tsx'

type DialogMode = 'rename' | 'move'

interface TreeMenuContextValue {
  openMenu: (node: TreeNode, x: number, y: number) => void
}

const TreeMenuContext = createContext<TreeMenuContextValue | null>(null)

function useTreeMenu(): TreeMenuContextValue {
  const context = use(TreeMenuContext)
  if (!context) throw new Error('useTreeMenu must be used inside FileTree')
  return context
}

export function FileTree() {
  const { tree, createFile, submitTreeOps, connectionStatus } = useWorkspace()
  const { setActiveFile } = useUiActions()
  const { activeFileId } = useUiState()
  const [creating, setCreating] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<{ mode: DialogMode; node: TreeNode } | null>(null)
  const [deleting, setDeleting] = useState<TreeNode | null>(null)

  const nodes = useMemo(() => buildTree(tree), [tree])
  const disabled = connectionStatus === 'disconnected'

  // The input only mounts after the user's "+" click, so focusing on mount
  // is intentional focus management — without the extra render an
  // autoFocus-replacement effect would cost.
  const focusOnMount = useCallback((node: HTMLInputElement | null) => node?.focus(), [])

  const openMenu = useCallback((node: TreeNode, x: number, y: number) => {
    // Clamp so the menu never opens off-screen near the viewport edges.
    setMenu({
      node,
      x: Math.min(x, window.innerWidth - 192),
      y: Math.min(y, window.innerHeight - 224),
    })
  }, [])

  const menuContext = useMemo<TreeMenuContextValue>(() => ({ openMenu }), [openMenu])

  function startCreate(prefix?: string) {
    setNewPath(prefix ? `${prefix}/` : '')
    setError(null)
    setCreating(true)
  }

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

  // Surfaces server adjudication: a rejected batch or a deferred op did not
  // apply, so callers must see it as a failure rather than a silent no-op.
  function assertApplied(result: BatchSubmitResult) {
    if (result.type === 'rejected') {
      throw new Error(
        result.reason === 'rate-limited'
          ? 'Too many changes — try again shortly'
          : 'You do not have permission to do that',
      )
    }
    const deferred = result.deferredOps[0]
    if (deferred) throw new Error(describeDeferredOp(deferred.reason))
  }

  async function handleRenameOrMove(value: string) {
    if (!dialog) return
    const { mode, node } = dialog
    const requested = mode === 'rename' ? withBaseName(node.path, value.trim()) : value.trim()
    const target = normalizeWorkspaceRelativePath(requested)
    if (!target) throw new Error('Invalid path')
    if (target === node.path) {
      setDialog(null)
      return
    }
    const ops = isFolder(node)
      ? renameFolderOps(tree, node.path, target)
      : [renameFileOp(node.entry, target)]
    if (ops.length === 0) {
      setDialog(null)
      return
    }
    assertApplied(await submitTreeOps(ops))
    setDialog(null)
  }

  async function handleDelete() {
    if (!deleting) return
    const node = deleting
    const ops = isFolder(node) ? deleteFolderOps(tree, node.path) : [deleteFileOp(node.entry)]
    assertApplied(await submitTreeOps(ops))
    const deletedIds = new Set(ops.map((op) => op.fileId))
    if (activeFileId && deletedIds.has(activeFileId)) setActiveFile(null)
    setDeleting(null)
  }

  return (
    <TreeMenuContext.Provider value={menuContext}>
      <div>
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--gb-text-muted)] opacity-80">
            Files
          </span>
          <button
            type="button"
            onClick={() => {
              if (creating) {
                setCreating(false)
                setError(null)
              } else {
                startCreate()
              }
            }}
            disabled={disabled}
            title={disabled ? 'Connect to create files' : 'New markdown file'}
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

      {menu &&
        (() => {
          const node = menu.node
          // Dismiss the menu before running the action so it never lingers
          // behind the dialog it opens.
          const run = (action: () => void) => () => {
            setMenu(null)
            action()
          }
          return (
            <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
              {isFolder(node) && (
                <MenuItem
                  icon={<PlusIcon size={14} />}
                  label="New file…"
                  disabled={disabled}
                  onSelect={run(() => startCreate(node.path))}
                />
              )}
              <MenuItem
                icon={<PencilIcon size={14} />}
                label="Rename…"
                disabled={disabled}
                onSelect={run(() => setDialog({ mode: 'rename', node }))}
              />
              <MenuItem
                icon={<MoveIcon size={14} />}
                label="Move…"
                disabled={disabled}
                onSelect={run(() => setDialog({ mode: 'move', node }))}
              />
              <div className="my-1 h-px bg-[var(--gb-border)]" />
              <MenuItem
                icon={<TrashIcon size={14} />}
                label="Delete"
                danger
                disabled={disabled}
                onSelect={run(() => setDeleting(node))}
              />
            </ContextMenu>
          )
        })()}

      {dialog && (
        <PathDialog
          key={`${dialog.mode}:${dialog.node.id}`}
          title={`${dialog.mode === 'rename' ? 'Rename' : 'Move'} ${isFolder(dialog.node) ? 'folder' : 'file'}`}
          label={dialog.mode === 'rename' ? 'New name' : 'New path'}
          initialValue={dialog.mode === 'rename' ? dialog.node.name : dialog.node.path}
          submitLabel={dialog.mode === 'rename' ? 'Rename' : 'Move'}
          mono={dialog.mode === 'move'}
          onSubmit={handleRenameOrMove}
          onClose={() => setDialog(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          node={deleting}
          fileCount={isFolder(deleting) ? entriesUnderFolder(tree, deleting.path).length : 1}
          onConfirm={handleDelete}
          onClose={() => setDeleting(null)}
        />
      )}
    </TreeMenuContext.Provider>
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
  const { openMenu } = useTreeMenu()
  const isOpen = expandedFolders.has(node.id)

  return (
    <li>
      <div className="group/row relative flex items-center">
        <button
          type="button"
          onClick={() => toggleFolder(node.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(node, e.clientX, e.clientY)
          }}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-none bg-transparent py-[5px] pr-7 text-left text-[13px] font-semibold text-[var(--gb-text)] transition-colors hover:bg-[var(--gb-hover)]"
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
        <RowMenuButton node={node} onOpen={openMenu} />
      </div>
      {isOpen && <TreeLevel nodes={node.children} depth={depth + 1} />}
    </li>
  )
}

function FileRow({ node, depth }: { node: FileNode; depth: number }) {
  const { activeFileId } = useUiState()
  const { setActiveFile } = useUiActions()
  const { openMenu } = useTreeMenu()
  const isActive = activeFileId === node.id

  return (
    <li>
      <div className="group/row relative flex items-center">
        <button
          type="button"
          onClick={() => setActiveFile(node.id, ancestorFolderIds(node.path))}
          onContextMenu={(e) => {
            e.preventDefault()
            openMenu(node, e.clientX, e.clientY)
          }}
          className={`flex w-full items-center gap-1.5 cursor-pointer rounded-md border-none bg-transparent py-[5px] pr-7 text-left text-[13px] transition-colors ${
            isActive
              ? 'bg-[var(--gb-accent)] text-white font-medium'
              : 'text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <FileBadge name={node.name} active={isActive} />
          <span className="truncate">{node.name}</span>
        </button>
        <RowMenuButton node={node} onOpen={openMenu} active={isActive} />
      </div>
    </li>
  )
}

/** Keyboard-accessible affordance for the row context menu (mirrors right-click). */
function RowMenuButton({
  node,
  onOpen,
  active,
}: {
  node: TreeNode
  onOpen: (node: TreeNode, x: number, y: number) => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={`Actions for ${node.name}`}
      aria-haspopup="menu"
      onClick={(e) => {
        e.stopPropagation()
        const rect = e.currentTarget.getBoundingClientRect()
        onOpen(node, rect.right, rect.bottom)
      }}
      className={`absolute right-1 rounded p-0.5 opacity-0 transition-opacity focus:opacity-100 group-hover/row:opacity-100 ${
        active
          ? 'text-white/80 hover:bg-white/20'
          : 'text-[var(--gb-text-muted)] hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]'
      }`}
    >
      <MoreIcon size={14} />
    </button>
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

function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', top: y, left: x }}
      className="z-50 min-w-[176px] rounded-lg border border-[var(--gb-border)] bg-[var(--gb-surface)] p-1 shadow-2xl"
    >
      {children}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onSelect,
  danger,
  disabled,
}: {
  icon: ReactNode
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
      }`}
    >
      <span className="flex-shrink-0">{icon}</span>
      {label}
    </button>
  )
}

function PathDialog({
  title,
  label,
  initialValue,
  submitLabel,
  mono,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initialValue: string
  submitLabel: string
  mono?: boolean
  onSubmit: (value: string) => Promise<void>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  const focusInput = useCallback((input: HTMLInputElement | null) => {
    if (!input) return
    input.focus()
    input.select()
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      onClose={onClose}
      className="m-auto w-full max-w-sm bg-transparent p-0 text-[var(--gb-text)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <form
        onSubmit={submit}
        className="rounded-xl border border-[var(--gb-border)] bg-[var(--gb-surface)] p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-[var(--gb-text)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel"
            className="rounded-md p-1 text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
          >
            <CloseIcon size={16} />
          </button>
        </div>
        <label className="block text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--gb-text-muted)]">
          {label}
        </label>
        <input
          ref={focusInput}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={`mt-1 w-full rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] px-2.5 py-1.5 text-[13px] text-[var(--gb-text)] outline-none focus:border-[var(--gb-accent)] ${
            mono ? 'font-mono' : ''
          }`}
        />
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || value.trim().length === 0}
            className="rounded-md bg-[var(--gb-accent)] px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}

function ConfirmDialog({
  node,
  fileCount,
  onConfirm,
  onClose,
}: {
  node: TreeNode
  fileCount: number
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const folder = isFolder(node)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  async function confirm() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Delete ${folder ? 'folder' : 'file'}`}
      onClose={onClose}
      className="m-auto w-full max-w-sm bg-transparent p-0 text-[var(--gb-text)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="rounded-xl border border-[var(--gb-border)] bg-[var(--gb-surface)] p-4 shadow-2xl">
        <h2 className="font-display text-sm font-semibold text-[var(--gb-text)]">
          Delete {folder ? 'folder' : 'file'}
        </h2>
        <p className="mt-2 text-[13px] text-[var(--gb-text-muted)]">
          {folder ? (
            <>
              Delete <span className="font-mono text-[var(--gb-text)]">{node.path}/</span> and its{' '}
              {fileCount} {fileCount === 1 ? 'file' : 'files'}? This can’t be undone.
            </>
          ) : (
            <>
              Delete <span className="font-mono text-[var(--gb-text)]">{node.path}</span>? This
              can’t be undone.
            </>
          )}
        </p>
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy || fileCount === 0}
            className="rounded-md bg-red-500 px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
    </dialog>
  )
}
