import { describe, expect, test } from 'vitest'
import { applyWorkspaceChangeEvent, indexWorkspaceEntries } from '../src/index.ts'
import type { WorkspaceChangeEvent, WorkspaceTreeEntry } from '../src/index.ts'

function makeEntry(overrides: Partial<WorkspaceTreeEntry> = {}): WorkspaceTreeEntry {
  return {
    fileId: overrides.fileId ?? 'file-1',
    path: overrides.path ?? 'docs/readme.md',
    contentHash: overrides.contentHash ?? 'hash-1',
    sizeBytes: overrides.sizeBytes ?? 12,
    version: overrides.version ?? 1,
    modifiedBy: overrides.modifiedBy ?? 'user-1',
    modifiedAt: overrides.modifiedAt ?? 123,
  }
}

describe('workspace event helpers', () => {
  test('indexes entries by normalized path', () => {
    const entries = indexWorkspaceEntries([
      makeEntry({ path: 'docs/readme.md', fileId: 'file-a' }),
      makeEntry({ path: 'docs/notes.md', fileId: 'file-b' }),
    ])

    expect(Array.from(entries.keys())).toEqual(['docs/readme.md', 'docs/notes.md'])
    expect(entries.get('docs/notes.md')?.fileId).toBe('file-b')
  })

  test('applies snapshot and incremental events', () => {
    const first = makeEntry({ path: 'docs/readme.md', fileId: 'file-a' })
    const second = makeEntry({ path: 'docs/notes.md', fileId: 'file-b' })
    const renamed = makeEntry({ path: 'docs/archive/readme.md', fileId: 'file-a', version: 2 })

    let entries = new Map<string, WorkspaceTreeEntry>()
    const events: WorkspaceChangeEvent[] = [
      { type: 'snapshot', entries: [first] },
      { type: 'create', path: second.path, entry: second },
      {
        type: 'rename',
        oldPath: first.path,
        newPath: renamed.path,
        entry: renamed,
      },
      { type: 'delete', path: second.path, fileId: second.fileId },
    ]

    for (const event of events) {
      entries = applyWorkspaceChangeEvent(entries, event)
    }

    expect(Array.from(entries.keys())).toEqual([renamed.path])
    expect(entries.get(renamed.path)?.version).toBe(2)
  })
})
