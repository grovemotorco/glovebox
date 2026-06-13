import { describe, expect, it } from 'vitest'
import type { WorkspaceTreeEntry } from '@glovebox/api'
import {
  applyTreeWireEvent,
  type TreeSnapshot,
  type TreeWireEvent,
} from '../src/lib/tree-events.ts'

describe('tree event reducer', () => {
  it('upserts creates by fileId', () => {
    const created = applyTreeWireEvent(emptyTree(), {
      type: 'create',
      fileId: 'file-1',
      path: 'docs/a.md',
      entry: entry('file-1', 'docs/a.md', 1),
      seq: 1,
    })

    const recreated = applyTreeWireEvent(created, {
      type: 'create',
      fileId: 'file-1',
      path: 'docs/b.md',
      entry: entry('file-1', 'docs/b.md', 2),
      seq: 2,
    })

    expect(recreated.seq).toBe(2)
    expect(recreated.entries).toHaveLength(1)
    expect(recreated.entries[0]?.path).toBe('docs/b.md')
  })

  it('replaces renamed entries by fileId', () => {
    const current: TreeSnapshot = {
      seq: 1,
      entries: [entry('file-1', 'docs/a.md', 1), entry('file-2', 'docs/other.md', 1)],
    }

    const renamed = applyTreeWireEvent(current, {
      type: 'rename',
      fileId: 'file-1',
      oldPath: 'docs/a.md',
      newPath: 'archive/a.md',
      entry: entry('file-1', 'archive/a.md', 2),
      seq: 2,
    })

    expect(renamed.seq).toBe(2)
    expect(renamed.entries.map((item) => item.path).sort()).toEqual([
      'archive/a.md',
      'docs/other.md',
    ])
  })

  it('removes deleted entries by fileId', () => {
    const current: TreeSnapshot = {
      seq: 1,
      entries: [entry('file-1', 'docs/a.md', 1), entry('file-2', 'docs/other.md', 1)],
    }

    const deleted = applyTreeWireEvent(current, {
      type: 'delete',
      fileId: 'file-1',
      path: 'docs/a.md',
      seq: 2,
      tombstone: true,
    })

    expect(deleted.seq).toBe(2)
    expect(deleted.entries.map((item) => item.fileId)).toEqual(['file-2'])
  })

  it('ignores duplicate or stale events', () => {
    const current: TreeSnapshot = {
      seq: 2,
      entries: [entry('file-1', 'docs/current.md', 2)],
    }

    const duplicate = applyTreeWireEvent(current, renameEvent(2, 'docs/duplicate.md'))
    const stale = applyTreeWireEvent(current, renameEvent(1, 'docs/stale.md'))

    expect(duplicate).toBe(current)
    expect(stale).toBe(current)
  })

  it('applies newer out-of-order events and advances the watermark', () => {
    const current: TreeSnapshot = {
      seq: 1,
      entries: [entry('file-1', 'docs/a.md', 1)],
    }

    const renamed = applyTreeWireEvent(current, renameEvent(4, 'docs/latest.md'))

    expect(renamed.seq).toBe(4)
    expect(renamed.entries).toEqual([entry('file-1', 'docs/latest.md', 4)])
  })
})

function emptyTree(): TreeSnapshot {
  return { seq: 0, entries: [] }
}

function renameEvent(seq: number, path: string): TreeWireEvent {
  return {
    type: 'rename',
    fileId: 'file-1',
    oldPath: 'docs/a.md',
    newPath: path,
    entry: entry('file-1', path, seq),
    seq,
  }
}

function entry(fileId: string, path: string, seq: number): WorkspaceTreeEntry {
  return {
    fileId,
    path,
    contentHash: `hash-${fileId}-${seq}`,
    sizeBytes: 1,
    version: seq,
    seq,
    modifiedBy: 'tester',
    modifiedAt: seq,
  }
}
