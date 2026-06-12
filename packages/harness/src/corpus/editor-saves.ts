import type { MemoryFS } from '../fs/memory-fs.ts'

/**
 * ISSUE-0026 editor-save syscall matrix as executable fixtures: each pattern
 * replays the exact operation sequence the named tool performs on a real
 * filesystem. The M4 daemon's watcher/scan loop is driven with these — the
 * differences that matter are which path the bytes land on first, whether
 * the target's nodeId survives (in-place write) or changes (tmp+rename),
 * and what litter exists mid-save.
 */

/**
 * The FS surface the save patterns drive — satisfied by MemoryFS and by
 * NodeFS on a real tmpdir (M8 conformance), so the same matrix runs on
 * simulated and real inodes. `writeInPlace` vs `writeFile` is the
 * load-bearing distinction: in-place savers must keep the inode, and
 * `writeFile` is allowed to be atomic-replace (NodeFS is).
 */
export interface EditorFS {
  readFile(relativePath: string): Promise<string>
  writeFile(relativePath: string, content: string): Promise<string>
  /** Truncate + write on the SAME node — never tmp+rename. */
  writeInPlace(relativePath: string, content: string): Promise<string>
  deletePath(relativePath: string): Promise<void>
  /** POSIX rename(2): identity travels, an existing target is replaced. */
  rename(fromPath: string, toPath: string): Promise<void>
}

export interface SavePattern {
  name: string
  /**
   * True when the save replaces the target via rename, so the target's
   * nodeId CHANGES across the save. In-place writers keep the nodeId.
   * Rename detection (nodeId-first) must not misread either as a delete.
   */
  replacesNode: boolean
  /** Paths that exist transiently during the save (watcher noise). */
  transientPaths(target: string): string[]
  /** Replay the save against the fs, step by step. */
  run(fs: EditorFS, target: string, content: string): Promise<void>
}

export const EDITOR_SAVE_PATTERNS: SavePattern[] = [
  {
    // write(target~ copy), write(target) in place, unlink(target~)
    name: 'vim backupcopy=yes',
    replacesNode: false,
    transientPaths: (target) => [`${target}~`],
    async run(fs, target, content) {
      const previous = await fs.readFile(target)
      await fs.writeFile(`${target}~`, previous)
      await fs.writeInPlace(target, content)
      await fs.deletePath(`${target}~`)
    },
  },
  {
    // rename(target, target~), write fresh target, unlink(target~)
    name: 'vim backupcopy=auto',
    replacesNode: true,
    transientPaths: (target) => [`${target}~`],
    async run(fs, target, content) {
      await fs.rename(target, `${target}~`)
      await fs.writeFile(target, content)
      await fs.deletePath(`${target}~`)
    },
  },
  {
    // write(.tmp), fsync, rename(.tmp, target) — VS Code atomic save and
    // Obsidian share this shape.
    name: 'vscode atomic save',
    replacesNode: true,
    transientPaths: (target) => [`${target}.tmp.1234`],
    async run(fs, target, content) {
      await fs.writeFile(`${target}.tmp.1234`, content)
      await fs.rename(`${target}.tmp.1234`, target)
    },
  },
  {
    // sed -i: tempfile in the same directory, rename over the target.
    name: 'sed -i',
    replacesNode: true,
    transientPaths: (target) => [`${dirOf(target)}sedAB12cd`],
    async run(fs, target, content) {
      const temp = `${dirOf(target)}sedAB12cd`
      await fs.writeFile(temp, content)
      await fs.rename(temp, target)
    },
  },
  {
    // echo > file: truncate then write, same node throughout. The watcher
    // can observe the empty intermediate state.
    name: 'truncate + write',
    replacesNode: false,
    transientPaths: () => [],
    async run(fs, target, content) {
      await fs.writeInPlace(target, '')
      await fs.writeInPlace(target, content)
    },
  },
  {
    // Stream-append: the file is rebuilt in chunks, each partial state
    // observable by the watcher mid-save.
    name: 'stream-append',
    replacesNode: false,
    transientPaths: () => [],
    async run(fs, target, content) {
      let written = ''
      await fs.writeInPlace(target, written)
      const chunkSize = Math.max(1, Math.ceil(content.length / 4))
      for (let i = 0; i < content.length; i += chunkSize) {
        written += content.slice(i, i + chunkSize)
        await fs.writeInPlace(target, written)
      }
    },
  },
]

function dirOf(target: string): string {
  const slash = target.lastIndexOf('/')
  return slash === -1 ? '' : target.slice(0, slash + 1)
}

/**
 * ISSUE-0013/0023/0031 deletion-safety and ISSUE-0034 YAOS-amplifier
 * scenario scripts. The FS choreography is executable now; the daemon
 * policy each scenario exercises is asserted in M4 when the scan/checkout
 * loop exists — `expectation` names the policy the daemon must apply.
 */
export interface DeletionScenario {
  name: string
  issue: string
  /** The daemon policy under test (M4 assertions attach to this). */
  expectation:
    | 'tombstone-delay'
    | 'rename-correction-window'
    | 'bulk-delete-guard'
    | 'sentinel-check'
    | 'no-recovery-amplification'
  run(fs: MemoryFS): Promise<void>
}

export const DELETION_SCENARIOS: DeletionScenario[] = [
  {
    // The baseline: one deliberate deletion. It must propagate — but only
    // after the tombstone delay has run out.
    name: 'single deliberate delete',
    issue: 'ISSUE-0013',
    expectation: 'tombstone-delay',
    async run(fs) {
      await fs.deletePath('notes/a.md')
    },
  },
  {
    // A file vanishes and reappears within the rename-correction window —
    // the editor was doing tmp+rename; no delete may propagate.
    name: 'delete immediately followed by recreate (atomic save seen as rm+create)',
    issue: 'ISSUE-0023',
    expectation: 'rename-correction-window',
    async run(fs) {
      await fs.deletePath('notes/a.md')
      await fs.writeFile('notes/a.md', 'recreated by rename\n')
    },
  },
  {
    // Many files disappear at once (unmounted volume, git checkout) — the
    // bulk-delete guard must hold deletes rather than propagate a wipe.
    name: 'bulk disappearance',
    issue: 'ISSUE-0013',
    expectation: 'bulk-delete-guard',
    async run(fs) {
      const results = await fs.scan(() => true)
      for (const entry of results) {
        await fs.deletePath(entry.relativePath)
      }
    },
  },
  {
    // The workspace sentinel is gone — the mount is suspect; nothing may
    // be treated as deleted.
    name: 'sentinel missing during scan',
    issue: 'ISSUE-0031',
    expectation: 'sentinel-check',
    async run(fs) {
      await fs.deletePath('.glovebox.json')
    },
  },
  {
    // YAOS amplifier (2026-04-09 incident class): a health pass that takes
    // disk as authority must not re-apply editor-buffer content in the
    // same cycle (INV-11) — the scenario alternates disk truncation with
    // a stale buffered write.
    name: 'disk truncation followed by stale buffer write',
    issue: 'ISSUE-0034',
    expectation: 'no-recovery-amplification',
    async run(fs) {
      await fs.writeFile('notes/a.md', '')
      await fs.writeFile('notes/a.md', 'stale buffer contents replayed\n')
    },
  },
]
