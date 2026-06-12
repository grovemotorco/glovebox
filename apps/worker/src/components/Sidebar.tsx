import { useEffect, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { authClient, errorMessage } from '../lib/api.ts'
import { useUiActions, useUiState } from '../state/ui.ts'
import { useWorkspace } from '../state/workspace.tsx'
import { FileTree } from './FileTree.tsx'
import { CheckIcon, ChevronDownIcon, PlusIcon, SettingsIcon, SignOutIcon } from './icons.tsx'

export function Sidebar() {
  const { sidebarOpen } = useUiState()
  const { openSettingsModal, setActiveFile } = useUiActions()
  const { workspaces, workspaceId, selectWorkspace, createWorkspace, user } = useWorkspace()
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useDismiss(switcherOpen, switcherRef, setSwitcherOpen)
  useDismiss(settingsMenuOpen, menuRef, setSettingsMenuOpen)

  const activeWorkspace = workspaces.find((ws) => ws.id === workspaceId)

  function selectExisting(id: string) {
    setSwitcherOpen(false)
    if (id === workspaceId) return
    selectWorkspace(id)
    setActiveFile(null)
  }

  async function createNewWorkspace() {
    setSwitcherOpen(false)
    const name = window.prompt('Workspace name')
    if (!name?.trim()) return
    setCreatingWorkspace(true)
    try {
      await createWorkspace(name.trim())
      setActiveFile(null)
    } catch (error) {
      window.alert(errorMessage(error))
    } finally {
      setCreatingWorkspace(false)
    }
  }

  if (!sidebarOpen) return null

  return (
    <aside className="flex w-72 flex-shrink-0 flex-col overflow-hidden border-r border-[var(--gb-border)] bg-[var(--gb-sidebar-bg)]">
      <div className="border-b border-[var(--gb-border)] p-2" ref={switcherRef}>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSwitcherOpen((open) => !open)}
            disabled={creatingWorkspace}
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
            aria-label="Switch workspace"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--gb-hover)] disabled:opacity-60"
          >
            <div className="min-w-0 flex-1">
              <div className="font-display text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--gb-text-muted)]">
                Workspace
              </div>
              <div className="truncate text-sm font-semibold text-[var(--gb-text)]">
                {activeWorkspace?.name ?? 'Select workspace'}
              </div>
            </div>
            <ChevronDownIcon
              size={16}
              className="flex-shrink-0 text-[var(--gb-text-muted)] transition-transform duration-150"
              style={{ transform: switcherOpen ? 'rotate(180deg)' : undefined }}
            />
          </button>

          {switcherOpen && (
            <div
              role="listbox"
              aria-label="Workspaces"
              className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-[var(--gb-border)] bg-[var(--gb-surface)] py-1 shadow-2xl"
            >
              {workspaces.map((ws) => {
                const isActive = ws.id === workspaceId
                return (
                  <button
                    type="button"
                    key={ws.id}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => selectExisting(ws.id)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--gb-hover)] ${
                      isActive ? 'text-[var(--gb-text)]' : 'text-[var(--gb-text-muted)]'
                    }`}
                  >
                    <span className={`min-w-0 flex-1 truncate ${isActive ? 'font-medium' : ''}`}>
                      {ws.name}
                    </span>
                    {isActive && (
                      <CheckIcon size={14} className="flex-shrink-0 text-[var(--gb-accent)]" />
                    )}
                  </button>
                )
              })}
              <div className="my-1 border-t border-[var(--gb-border)]" />
              <button
                type="button"
                onClick={() => void createNewWorkspace()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--gb-text-muted)] transition-colors hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]"
              >
                <PlusIcon size={14} className="flex-shrink-0" />
                New workspace…
              </button>
            </div>
          )}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        <FileTree />
      </nav>

      <div className="relative border-t border-[var(--gb-border)] p-2" ref={menuRef}>
        {settingsMenuOpen && (
          <div className="absolute bottom-12 left-2 right-2 overflow-hidden rounded-lg border border-[var(--gb-border)] bg-[var(--gb-surface)] shadow-2xl">
            <div className="border-b border-[var(--gb-border)] px-3 py-2">
              <div className="truncate text-sm font-medium text-[var(--gb-text)]">
                {user.name || user.email}
              </div>
              <div className="truncate text-xs text-[var(--gb-text-muted)]">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSettingsMenuOpen(false)
                openSettingsModal()
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--gb-text)] transition-colors hover:bg-[var(--gb-hover)]"
            >
              <SettingsIcon />
              Workspace settings
            </button>
            <button
              type="button"
              onClick={() => void authClient.signOut()}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--gb-text)] transition-colors hover:bg-[var(--gb-hover)]"
            >
              <SignOutIcon />
              Sign out
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setSettingsMenuOpen((open) => !open)}
          aria-expanded={settingsMenuOpen}
          aria-haspopup="menu"
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--gb-text)] transition-colors hover:bg-[var(--gb-hover)]"
        >
          <SettingsIcon />
          <span className="flex-1 text-left">Settings</span>
        </button>
      </div>
    </aside>
  )
}

/** Close a popover on outside pointer-down or Escape while it is open. */
function useDismiss(
  open: boolean,
  ref: RefObject<HTMLDivElement | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, ref, setOpen])
}
