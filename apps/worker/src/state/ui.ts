import { useCallback, useSyncExternalStore } from 'react'

export type EditorMode = 'editor' | 'preview' | 'combined'

interface UiState {
  sidebarOpen: boolean
  editorMode: EditorMode
  commandBarOpen: boolean
  settingsModalOpen: boolean
  activeFileId: string | null
  expandedFolders: ReadonlySet<string>
  autoSync: boolean
}

type Listener = () => void

const EDITOR_MODE_KEY = 'glovebox.editorMode'
const AUTO_SYNC_KEY = 'glovebox.autoSync'

const listeners = new Set<Listener>()

let state: UiState = {
  sidebarOpen: true,
  editorMode: readEditorModePreference(),
  commandBarOpen: false,
  settingsModalOpen: false,
  activeFileId: null,
  expandedFolders: new Set<string>(),
  autoSync: localStorage.getItem(AUTO_SYNC_KEY) !== 'false',
}

function readEditorModePreference(): EditorMode {
  const stored = localStorage.getItem(EDITOR_MODE_KEY)
  return stored === 'editor' || stored === 'preview' || stored === 'combined' ? stored : 'combined'
}

function emit() {
  for (const fn of listeners) fn()
}

function setState(partial: Partial<UiState>) {
  state = { ...state, ...partial }
  emit()
}

function getSnapshot() {
  return state
}

function subscribe(fn: Listener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useUiState(): UiState {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function useUiActions() {
  const setActiveFile = useCallback((id: string | null, ancestorFolderIds: string[] = []) => {
    const expanded = new Set(getSnapshot().expandedFolders)
    for (const folderId of ancestorFolderIds) expanded.add(folderId)
    setState({ activeFileId: id, commandBarOpen: false, expandedFolders: expanded })
  }, [])

  const toggleSidebar = useCallback(() => {
    setState({ sidebarOpen: !getSnapshot().sidebarOpen })
  }, [])

  const setEditorMode = useCallback((mode: EditorMode) => {
    localStorage.setItem(EDITOR_MODE_KEY, mode)
    setState({ editorMode: mode })
  }, [])

  const openCommandBar = useCallback(() => {
    setState({ commandBarOpen: true })
  }, [])

  const closeCommandBar = useCallback(() => {
    setState({ commandBarOpen: false })
  }, [])

  const toggleFolder = useCallback((id: string) => {
    const next = new Set(getSnapshot().expandedFolders)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setState({ expandedFolders: next })
  }, [])

  const openSettingsModal = useCallback(() => {
    setState({ settingsModalOpen: true })
  }, [])

  const closeSettingsModal = useCallback(() => {
    setState({ settingsModalOpen: false })
  }, [])

  const setAutoSync = useCallback((enabled: boolean) => {
    localStorage.setItem(AUTO_SYNC_KEY, String(enabled))
    setState({ autoSync: enabled })
  }, [])

  return {
    setActiveFile,
    toggleSidebar,
    setEditorMode,
    openCommandBar,
    closeCommandBar,
    toggleFolder,
    openSettingsModal,
    closeSettingsModal,
    setAutoSync,
  }
}
