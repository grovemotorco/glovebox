import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { WorkspacePresencePeer } from '@glovebox.md/sync/client'
import type { AwarenessUser } from '@glovebox.md/core'
import { useUiActions, useUiState } from '../state/ui.ts'
import type { EditorMode } from '../state/ui.ts'
import { useRoom, useWorkspace } from '../state/workspace.tsx'
import { CodeEditor } from './Editor.tsx'
import { Preview } from './Preview.tsx'
import {
  EditIcon,
  FileTextIcon,
  PreviewIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  SplitIcon,
} from './icons.tsx'

const modes: { key: EditorMode; label: string; icon: ReactNode }[] = [
  { key: 'editor', label: 'Edit', icon: <EditIcon /> },
  { key: 'preview', label: 'Preview', icon: <PreviewIcon /> },
  { key: 'combined', label: 'Split', icon: <SplitIcon /> },
]

export function EditorView() {
  const { activeFileId, editorMode, sidebarOpen } = useUiState()
  const { setActiveFile, setEditorMode, openCommandBar, toggleSidebar } = useUiActions()
  const { tree, treeLoaded, openFile, connectionStatus, peers } = useWorkspace()

  const activeEntry = useMemo(
    () => tree.find((entry) => entry.fileId === activeFileId && !entry.tombstone) ?? null,
    [tree, activeFileId],
  )

  // Open (or re-open after reconnect/workspace switch) the active file's room.
  useEffect(() => {
    if (!activeFileId || !activeEntry || connectionStatus === 'disconnected') return
    openFile(activeFileId, activeEntry.path)
  }, [activeFileId, activeEntry, connectionStatus, openFile])

  useEffect(() => {
    if (treeLoaded && activeFileId && !activeEntry) setActiveFile(null)
  }, [treeLoaded, activeFileId, activeEntry, setActiveFile])

  const handle = useRoom(activeFileId)

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-[var(--gb-bg)]">
      <header className="relative grid h-12 flex-shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)] px-3">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={toggleSidebar}
            className="-ml-1 flex-shrink-0 rounded-md p-1.5 text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? <SidebarCollapseIcon /> : <SidebarExpandIcon />}
          </button>
          {activeEntry ? (
            <span className="truncate text-[13px] text-[var(--gb-text-muted)]">
              {activeEntry.path}
            </span>
          ) : (
            <span className="text-[13px] text-[var(--gb-text-muted)]">No file selected</span>
          )}
        </div>

        <div
          className="flex rounded-md border border-[var(--gb-border)] bg-[var(--gb-bg)] p-0.5"
          aria-label="Markdown pane mode"
        >
          {modes.map((m) => (
            <button
              type="button"
              key={m.key}
              onClick={() => setEditorMode(m.key)}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-[5px] transition-colors ${
                editorMode === m.key
                  ? 'bg-[var(--gb-accent)] text-white'
                  : 'text-[var(--gb-text-muted)] hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]'
              }`}
              title={m.label}
              aria-label={m.label}
              aria-pressed={editorMode === m.key}
            >
              {m.icon}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1">
          <PresenceBar peers={peers} />
          <button
            type="button"
            onClick={openCommandBar}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
          >
            <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] font-mono font-medium">
              ⌘K
            </kbd>
            <span>Search files</span>
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {!activeFileId ? (
          <EmptyState onOpen={openCommandBar} />
        ) : editorMode === 'editor' ? (
          <div className="min-h-0 flex-1">
            <CodeEditor handle={handle} />
          </div>
        ) : editorMode === 'preview' ? (
          <div className="min-h-0 flex-1">
            <Preview key={activeFileId} handle={handle} hasFile={!!activeFileId} showToc />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 border-r border-[var(--gb-border)]">
              <CodeEditor handle={handle} />
            </div>
            <div className="min-h-0 flex-1">
              <Preview key={activeFileId} handle={handle} hasFile={!!activeFileId} showToc />
            </div>
          </>
        )}
      </div>
    </main>
  )
}

function PresenceBar({ peers }: { peers: WorkspacePresencePeer[] }) {
  if (peers.length === 0) return null
  return (
    <div className="flex items-center mr-2" aria-label={`${peers.length} connected`}>
      {peers.slice(0, 5).map((peer, idx) => {
        const user = presenceUser(peer)
        const label = user?.name ?? peer.principalId
        const initials = label
          .split(/\s+/)
          .map((part) => part[0]?.toUpperCase() ?? '')
          .slice(0, 2)
          .join('')
        return (
          <span
            key={peer.key}
            title={`${label} (${peer.principalType})`}
            className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[9px] font-bold border-2 border-[var(--gb-sidebar-bg)]"
            style={{
              background: `${user?.color ?? '#9aa4b2'}33`,
              color: user?.color ?? '#9aa4b2',
              marginLeft: idx === 0 ? 0 : -6,
            }}
          >
            {initials || '·'}
          </span>
        )
      })}
      {peers.length > 5 && (
        <span className="ml-1 text-[10px] text-[var(--gb-text-muted)]">+{peers.length - 5}</span>
      )}
    </div>
  )
}

/** Presence state is publisher-supplied display data — never trust shape. */
function presenceUser(peer: WorkspacePresencePeer): AwarenessUser | null {
  const state = peer.state as { user?: Partial<AwarenessUser> } | null
  const user = state?.user
  if (!user || typeof user.name !== 'string' || typeof user.color !== 'string') return null
  return {
    id: typeof user.id === 'string' ? user.id : peer.key,
    name: user.name,
    color: user.color,
    type: user.type === 'agent' ? 'agent' : 'browser',
  }
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl border border-[var(--gb-border)] bg-[var(--gb-surface)] text-[var(--gb-text-muted)]">
          <FileTextIcon size={22} />
        </div>
        <p className="mb-1 text-sm font-medium text-[var(--gb-text)]">No file open</p>
        <p className="mb-4 text-xs text-[var(--gb-text-muted)]">
          Pick a file from the sidebar or search to get started.
        </p>
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--gb-border)] bg-[var(--gb-surface)] px-4 py-2 text-sm text-[var(--gb-text)] transition-colors hover:bg-[var(--gb-hover)]"
        >
          <kbd className="rounded border border-[var(--gb-border)] bg-[var(--gb-bg)] px-1.5 py-0.5 font-mono text-[10px]">
            ⌘&#8239;K
          </kbd>
          Open a file
        </button>
      </div>
    </div>
  )
}
