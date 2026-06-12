import { useAppState, useActions } from '../data/store.ts'
import type { EditorMode } from '../data/store.ts'
import { CodeEditor } from './Editor.tsx'
import { Preview } from './Preview.tsx'
import { CollaborationPanel } from './CollaborationPanel.tsx'

const modes: { key: EditorMode; label: string }[] = [
  { key: 'editor', label: 'Editor' },
  { key: 'preview', label: 'Preview' },
  { key: 'combined', label: 'Split' },
]

export function EditorView() {
  const { activeFileId, editorMode, workspace, sidebarOpen } = useAppState()
  const { setEditorMode, toggleSidebar, openCommandBar } = useActions()

  const activeFile = activeFileId ? workspace.files.get(activeFileId) : null

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-[var(--gb-bg)]">
      {/* Toolbar */}
      <header className="flex items-center justify-between h-11 px-3 border-b border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className="p-1.5 rounded-md text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
              title="Open sidebar"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M6 4l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          {activeFile ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[13px] text-[var(--gb-text-muted)] truncate">
                {activeFile.path}
              </span>
            </div>
          ) : (
            <span className="text-[13px] text-[var(--gb-text-muted)]">No file selected</span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Cmd+K hint */}
          <button
            onClick={openCommandBar}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors mr-2"
          >
            <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] font-mono font-medium">
              ⌘K
            </kbd>
            <span>Search files</span>
          </button>

          {/* Mode toggle */}
          <div className="flex rounded-md border border-[var(--gb-border)] overflow-hidden">
            {modes.map((m) => (
              <button
                key={m.key}
                onClick={() => setEditorMode(m.key)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  editorMode === m.key
                    ? 'bg-[var(--gb-accent)] text-white'
                    : 'text-[var(--gb-text-muted)] hover:text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Editor content */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex min-h-0 min-w-0">
          {!activeFileId ? (
            <EmptyState onOpen={openCommandBar} />
          ) : editorMode === 'editor' ? (
            <div className="flex-1 min-h-0">
              <CodeEditor />
            </div>
          ) : editorMode === 'preview' ? (
            <div className="flex-1 min-h-0">
              <Preview />
            </div>
          ) : (
            <>
              <div className="flex-1 min-h-0 border-r border-[var(--gb-border)]">
                <CodeEditor />
              </div>
              <div className="flex-1 min-h-0">
                <Preview />
              </div>
            </>
          )}
        </div>
        <CollaborationPanel />
      </div>

      {/* Status bar */}
      {activeFile && (
        <footer className="flex items-center justify-between h-7 px-3 border-t border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)] text-[11px] text-[var(--gb-text-muted)] flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Saved
            </span>
            <span>Markdown</span>
          </div>
          <div className="flex items-center gap-3">
            <span>UTF-8</span>
            <span>LF</span>
          </div>
        </footer>
      )}
    </main>
  )
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center">
        <div className="text-4xl mb-4 opacity-20">📝</div>
        <p className="text-[var(--gb-text-muted)] text-sm mb-3">No file open</p>
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--gb-surface)] border border-[var(--gb-border)] text-sm text-[var(--gb-text)] hover:bg-[var(--gb-hover)] transition-colors"
        >
          <kbd className="px-1.5 py-0.5 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] font-mono">
            ⌘K
          </kbd>
          Open a file
        </button>
      </div>
    </div>
  )
}
