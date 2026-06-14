import type { WorkspaceTreeEntry } from '@glovebox/api'
import type { WorkspaceServerMessage } from '@glovebox/sync/server'

export type TreeWireEvent = Extract<
  WorkspaceServerMessage,
  { type: 'create' | 'rename' | 'delete' }
>

export interface TreeSnapshot {
  seq: number
  entries: WorkspaceTreeEntry[]
}

export function isTreeWireEvent(message: { type: string }): message is TreeWireEvent {
  return message.type === 'create' || message.type === 'rename' || message.type === 'delete'
}

export function applyTreeWireEvent(snapshot: TreeSnapshot, event: TreeWireEvent): TreeSnapshot {
  if (event.seq <= snapshot.seq) return snapshot

  switch (event.type) {
    case 'create':
      return upsertEntry(snapshot, event.seq, event.entry)
    case 'rename':
      return upsertEntry(snapshot, event.seq, event.entry)
    case 'delete':
      return {
        seq: event.seq,
        entries: snapshot.entries.filter((entry) => entry.fileId !== event.fileId),
      }
  }
}

function upsertEntry(snapshot: TreeSnapshot, seq: number, entry: WorkspaceTreeEntry): TreeSnapshot {
  const entries = snapshot.entries.filter((candidate) => candidate.fileId !== entry.fileId)
  if (!entry.tombstone) entries.push(entry)
  return { seq, entries }
}
