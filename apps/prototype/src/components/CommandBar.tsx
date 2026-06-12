import { useState, useEffect, useRef, useMemo } from 'react'
import { useAppState, useActions } from '../data/store.ts'

export function CommandBar() {
  const { commandBarOpen, workspace, activeFileId } = useAppState()
  const { closeCommandBar, setActiveFile, openCommandBar } = useActions()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const allFiles = useMemo(() => {
    return Array.from(workspace.files.values())
  }, [workspace.files])

  const filtered = useMemo(() => {
    if (!query) return allFiles
    const lower = query.toLowerCase()
    return allFiles.filter(
      (f) => f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower),
    )
  }, [allFiles, query])

  useEffect(() => {
    if (commandBarOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [commandBarOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (commandBarOpen) {
          closeCommandBar()
        } else {
          openCommandBar()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [commandBarOpen, closeCommandBar])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      closeCommandBar()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const file = filtered[selectedIndex]
      if (file) {
        setActiveFile(file.id)
      }
    }
  }

  if (!commandBarOpen) return null

  return (
    <div
      className="cmd-backdrop fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeCommandBar()
      }}
    >
      <div className="cmd-dialog w-full max-w-lg bg-[var(--gb-surface)] border border-[var(--gb-border)] rounded-xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-[var(--gb-border)]">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            className="flex-shrink-0 text-[var(--gb-text-muted)]"
          >
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files..."
            className="flex-1 py-3 bg-transparent text-sm text-[var(--gb-text)] placeholder:text-[var(--gb-text-muted)]/50 outline-none"
          />
          <kbd className="px-1.5 py-0.5 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] font-mono text-[var(--gb-text-muted)]">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-[var(--gb-text-muted)]">
              No files found
            </div>
          ) : (
            filtered.map((file, idx) => (
              <button
                key={file.id}
                onClick={() => setActiveFile(file.id)}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`flex items-center gap-3 w-full px-4 py-2 text-left transition-colors ${
                  idx === selectedIndex
                    ? 'bg-[var(--gb-accent)]/10 text-[var(--gb-text)]'
                    : 'text-[var(--gb-text)] hover:bg-[var(--gb-hover)]'
                }`}
              >
                <FileIcon active={file.id === activeFileId} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{file.name}</div>
                  <div className="text-xs text-[var(--gb-text-muted)] truncate">{file.path}</div>
                </div>
                {idx === selectedIndex && (
                  <kbd className="px-1.5 py-0.5 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)] text-[10px] font-mono text-[var(--gb-text-muted)]">
                    ↵
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--gb-border)] text-[10px] text-[var(--gb-text-muted)]">
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)]">
              ↑↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)]">↵</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 rounded bg-[var(--gb-bg)] border border-[var(--gb-border)]">
              esc
            </kbd>
            close
          </span>
        </div>
      </div>
    </div>
  )
}

function FileIcon({ active }: { active: boolean }) {
  return (
    <span
      className="inline-flex items-center justify-center w-[18px] h-[18px] flex-shrink-0 text-[9px] font-bold rounded"
      style={{
        color: active ? 'var(--gb-accent)' : '#3b82f6',
        background: active ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.1)',
      }}
    >
      M
    </span>
  )
}
