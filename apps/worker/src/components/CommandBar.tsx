import { useState, useEffect, useRef, useMemo } from 'react'
import { ancestorFolderIds, baseName, liveEntries } from '../lib/tree.ts'
import { useUiActions, useUiState } from '../state/ui.ts'
import { useWorkspace } from '../state/workspace.tsx'
import { SearchIcon } from './icons.tsx'

export function CommandBar() {
  const { commandBarOpen, activeFileId } = useUiState()
  const { closeCommandBar, setActiveFile, openCommandBar } = useUiActions()
  const { tree } = useWorkspace()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const allFiles = useMemo(
    () =>
      liveEntries(tree).map((entry) => ({
        id: entry.fileId,
        name: baseName(entry.path),
        path: entry.path,
      })),
    [tree],
  )

  const filtered = useMemo(() => {
    if (!query) return allFiles
    const lower = query.toLowerCase()
    return allFiles.filter(
      (f) => f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower),
    )
  }, [allFiles, query])

  useEffect(() => {
    if (!commandBarOpen) return
    dialogRef.current?.showModal()
    setQuery('')
    setSelectedIndex(0)
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [commandBarOpen])

  // Backdrop clicks land on the <dialog> element itself — a mouse-only
  // dismiss convenience (keyboard users have native Escape), so it's wired
  // imperatively rather than declared as an interactive contract on the
  // dialog markup.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!commandBarOpen || !dialog) return
    const onBackdropClick = (event: MouseEvent) => {
      if (event.target === dialog) closeCommandBar()
    }
    dialog.addEventListener('click', onBackdropClick)
    return () => dialog.removeEventListener('click', onBackdropClick)
  }, [commandBarOpen, closeCommandBar])

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
  }, [commandBarOpen, closeCommandBar, openCommandBar])

  function selectFile(file: { id: string; path: string }) {
    setActiveFile(file.id, ancestorFolderIds(file.path))
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Escape is handled by the native <dialog> cancel behavior.
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => (filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const file = filtered[selectedIndex]
      if (file) {
        selectFile(file)
      }
    }
  }

  if (!commandBarOpen) return null

  return (
    <dialog
      ref={dialogRef}
      aria-label="Search files"
      onClose={closeCommandBar}
      className="cmd-dialog mx-auto mt-[20vh] mb-auto w-full max-w-lg bg-transparent p-0 text-[var(--gb-text)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="bg-[var(--gb-surface)] border border-[var(--gb-border)] rounded-xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-[var(--gb-border)]">
          <SearchIcon className="flex-shrink-0 text-[var(--gb-text-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search files…"
            aria-label="Search files"
            spellCheck={false}
            autoComplete="off"
            className="cmd-search flex-1 py-3 bg-transparent text-sm text-[var(--gb-text)] placeholder:text-[var(--gb-text-muted)]/50 outline-none"
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
                type="button"
                key={file.id}
                onClick={() => selectFile(file)}
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
    </dialog>
  )
}

function FileIcon({ active }: { active: boolean }) {
  return (
    <span
      className="inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded text-[9px] font-bold"
      style={{
        color: active ? 'var(--gb-accent)' : 'var(--grove-velocity-cyan)',
        background: active
          ? 'color-mix(in oklch, var(--gb-accent) 16%, transparent)'
          : 'color-mix(in oklch, var(--grove-velocity-cyan) 14%, transparent)',
      }}
    >
      M
    </span>
  )
}
