import { useSyncExternalStore, useCallback } from 'react'
import { mockWorkspace } from './mock.ts'
import type { CommentThread, Suggestion, Workspace } from './mock.ts'

export type EditorMode = 'editor' | 'preview' | 'combined'

interface AppState {
  workspace: Workspace
  activeFileId: string | null
  sidebarOpen: boolean
  editorMode: EditorMode
  commandBarOpen: boolean
  settingsModalOpen: boolean
  expandedFolders: Set<string>
  fileContents: Map<string, string>
}

type Listener = () => void

const listeners = new Set<Listener>()

const initialContents = new Map<string, string>()
for (const [id, file] of mockWorkspace.files) {
  initialContents.set(id, file.content)
}

let localIdCounter = 0

let state: AppState = {
  workspace: mockWorkspace,
  activeFileId: 'f1',
  sidebarOpen: true,
  editorMode: 'combined',
  commandBarOpen: false,
  settingsModalOpen: false,
  expandedFolders: new Set(['d1', 'd2']),
  fileContents: initialContents,
}

function emit() {
  for (const fn of listeners) fn()
}

function setState(partial: Partial<AppState>) {
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

export function useAppState() {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export function useActions() {
  const setActiveFile = useCallback((id: string) => {
    setState({ activeFileId: id, commandBarOpen: false })
  }, [])

  const toggleSidebar = useCallback(() => {
    setState({ sidebarOpen: !getSnapshot().sidebarOpen })
  }, [])

  const setEditorMode = useCallback((mode: EditorMode) => {
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

  const updateFileContent = useCallback((fileId: string, content: string) => {
    const next = new Map(getSnapshot().fileContents)
    next.set(fileId, content)
    setState({ fileContents: next })
  }, [])

  const createComment = useCallback(
    (input: { fileId: string; body: string; start: number; end: number }) => {
      const snapshot = getSnapshot()
      const comment: CommentThread = {
        id: nextId('com'),
        fileId: input.fileId,
        body: input.body,
        authorId: 'm1',
        status: 'open',
        range: normalizedRange(
          input.start,
          input.end,
          snapshot.fileContents.get(input.fileId) ?? '',
        ),
        createdAt: new Date().toISOString(),
      }
      setState({
        workspace: {
          ...snapshot.workspace,
          comments: [comment, ...snapshot.workspace.comments],
        },
      })
    },
    [],
  )

  const setCommentStatus = useCallback((commentId: string, status: CommentThread['status']) => {
    const snapshot = getSnapshot()
    setState({
      workspace: {
        ...snapshot.workspace,
        comments: snapshot.workspace.comments.map((comment) =>
          comment.id === commentId ? { ...comment, status } : comment,
        ),
      },
    })
  }, [])

  const createSuggestion = useCallback(
    (input: { fileId: string; replacementText: string; start: number; end: number }) => {
      const snapshot = getSnapshot()
      const latestVersion = latestVersionForFile(snapshot.workspace, input.fileId)
      const suggestion: Suggestion = {
        id: nextId('sug'),
        fileId: input.fileId,
        replacementText: input.replacementText,
        authorId: 'm1',
        status: 'open',
        range: normalizedRange(
          input.start,
          input.end,
          snapshot.fileContents.get(input.fileId) ?? '',
        ),
        baseVersionId: latestVersion?.id ?? nextId('ver'),
        createdAt: new Date().toISOString(),
      }
      setState({
        workspace: {
          ...snapshot.workspace,
          suggestions: [suggestion, ...snapshot.workspace.suggestions],
        },
      })
    },
    [],
  )

  const acceptSuggestion = useCallback((suggestionId: string) => {
    const snapshot = getSnapshot()
    const suggestion = snapshot.workspace.suggestions.find((item) => item.id === suggestionId)
    if (!suggestion || suggestion.status !== 'open') return

    const content = snapshot.fileContents.get(suggestion.fileId) ?? ''
    const range = normalizedRange(suggestion.range.start, suggestion.range.end, content)
    const nextContent =
      content.slice(0, range.start) + suggestion.replacementText + content.slice(range.end)
    const versionId = nextId('ver')
    const nextContents = new Map(snapshot.fileContents)
    nextContents.set(suggestion.fileId, nextContent)

    setState({
      fileContents: nextContents,
      workspace: {
        ...snapshot.workspace,
        versions: [
          {
            id: versionId,
            fileId: suggestion.fileId,
            label: `Accepted ${suggestion.id}`,
            authorId: 'm1',
            createdAt: new Date().toISOString(),
          },
          ...snapshot.workspace.versions,
        ],
        suggestions: snapshot.workspace.suggestions.map((item) =>
          item.id === suggestionId ? { ...item, status: 'accepted' } : item,
        ),
      },
    })
  }, [])

  const rejectSuggestion = useCallback((suggestionId: string) => {
    const snapshot = getSnapshot()
    setState({
      workspace: {
        ...snapshot.workspace,
        suggestions: snapshot.workspace.suggestions.map((item) =>
          item.id === suggestionId ? { ...item, status: 'rejected' } : item,
        ),
      },
    })
  }, [])

  const openSettingsModal = useCallback(() => {
    setState({ settingsModalOpen: true })
  }, [])

  const closeSettingsModal = useCallback(() => {
    setState({ settingsModalOpen: false })
  }, [])

  return {
    setActiveFile,
    toggleSidebar,
    setEditorMode,
    openCommandBar,
    closeCommandBar,
    toggleFolder,
    updateFileContent,
    createComment,
    setCommentStatus,
    createSuggestion,
    acceptSuggestion,
    rejectSuggestion,
    openSettingsModal,
    closeSettingsModal,
  }
}

function nextId(prefix: string): string {
  localIdCounter += 1
  return `${prefix}_local_${localIdCounter}`
}

function normalizedRange(
  start: number,
  end: number,
  content: string,
): { start: number; end: number } {
  const safeStart = Math.max(0, Math.min(start, content.length))
  const safeEnd = Math.max(safeStart, Math.min(end, content.length))
  return { start: safeStart, end: safeEnd }
}

function latestVersionForFile(workspace: Workspace, fileId: string) {
  return workspace.versions.find((version) => version.fileId === fileId)
}
