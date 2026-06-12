import type { WorkspaceChangeEvent, WorkspaceTreeEntry } from './types.ts'

export function indexWorkspaceEntries(
  entries: Iterable<WorkspaceTreeEntry>,
): Map<string, WorkspaceTreeEntry> {
  return new Map(Array.from(entries, (entry) => [entry.path, entry]))
}

export function applyWorkspaceChangeEvent(
  currentEntries: ReadonlyMap<string, WorkspaceTreeEntry>,
  event: WorkspaceChangeEvent,
): Map<string, WorkspaceTreeEntry> {
  switch (event.type) {
    case 'snapshot':
      return indexWorkspaceEntries(event.entries)
    case 'create':
    case 'update': {
      const nextEntries = new Map(currentEntries)
      nextEntries.set(event.entry.path, event.entry)
      return nextEntries
    }
    case 'delete': {
      const nextEntries = new Map(currentEntries)
      nextEntries.delete(event.path)
      return nextEntries
    }
    case 'rename': {
      const nextEntries = new Map(currentEntries)
      nextEntries.delete(event.oldPath)
      nextEntries.set(event.entry.path, event.entry)
      return nextEntries
    }
    case 'content.loroUpdate':
    case 'content.opaqueUpdate':
      // Pure-content event — does not change tree structure or metadata that
      // tree consumers track. Pass the existing map through unchanged.
      return currentEntries as Map<string, WorkspaceTreeEntry>
  }
}
