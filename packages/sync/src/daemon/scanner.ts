import { isMarkdownFile, isSyncableFile } from '../fs/file-kind.ts'
import { sha256Hex } from '../fs/hash.ts'
import type { LocalFS } from '../fs/local-fs.ts'

/**
 * V2 daemon scan (spec-loro-sync-refactor.md): disk → diff against the
 * daemon's per-file state. Rename detection is the loro-2 scanner's logic
 * ported verbatim — nodeId match first, greedy (hash, sizeBytes) fallback.
 * Unlike loro-2, scan emits a pure diff: no pending-op queue, no Loro
 * mutation here; the cycle applies the diff to docs directly (INV-6).
 */

export interface DaemonFileView {
  fileId: string
  path: string
  contentKind: 'markdown' | 'opaque'
  /** Inode identity from the last checkout/scan, for rename detection. */
  nodeId: string | null
  /** sha256 of the last bytes the daemon wrote/confirmed on disk (INV-4). */
  lastWrittenHash: string
  sizeBytes: number
}

export interface DiskEntry {
  path: string
  text?: string
  bytes: Uint8Array
  contentKind: 'markdown' | 'opaque'
  contentHash: string
  sizeBytes: number
  nodeId: string | null
}

export interface ScanDiff {
  /** fileId keeps its identity and Loro history across the move. */
  renames: { fileId: string; fromPath: string; toPath: string; entry: DiskEntry }[]
  /** Missing from disk with no rename match — candidate delete INTENTS only
   *  (the INV-3 stack decides whether they propagate). */
  deletes: { fileId: string; path: string }[]
  /** On disk, unknown to the daemon state. */
  creates: DiskEntry[]
  /** Known path whose bytes differ from the lastWrittenHash watermark. */
  contentChanges: { fileId: string; entry: DiskEntry }[]
}

export interface ScanInput {
  fs: LocalFS
  files: Iterable<DaemonFileView>
}

export async function scanMount(input: ScanInput): Promise<ScanDiff> {
  const diskEntries = await readDiskEntries(input.fs)
  const diskByPath = new Map(diskEntries.map((entry) => [entry.path, entry]))

  const known = [...input.files]
  const knownByPath = new Map(known.map((file) => [file.path, file]))

  const missingFromDisk = known.filter((file) => !diskByPath.has(file.path))
  const newPaths = diskEntries.filter((entry) => !knownByPath.has(entry.path))

  // Rename candidates: a known path missing from disk where a new path has
  // the same inode, or failing that identical content. Greedy on
  // (hash, sizeBytes) — ported verbatim from the loro-2 scanner.
  const renames: ScanDiff['renames'] = []
  const usedNewPaths = new Set<string>()
  const renamedFileIds = new Set<string>()
  for (const stale of missingFromDisk) {
    const match = newPaths.find(
      (candidate) =>
        !usedNewPaths.has(candidate.path) &&
        ((stale.nodeId && candidate.nodeId && candidate.nodeId === stale.nodeId) ||
          (candidate.contentHash === stale.lastWrittenHash &&
            candidate.sizeBytes === stale.sizeBytes)),
    )
    if (match) {
      renames.push({ fileId: stale.fileId, fromPath: stale.path, toPath: match.path, entry: match })
      usedNewPaths.add(match.path)
      renamedFileIds.add(stale.fileId)
    }
  }

  const deletes: ScanDiff['deletes'] = []
  for (const stale of missingFromDisk) {
    if (renamedFileIds.has(stale.fileId)) continue
    deletes.push({ fileId: stale.fileId, path: stale.path })
  }

  const creates = newPaths.filter((entry) => !usedNewPaths.has(entry.path))

  const contentChanges: ScanDiff['contentChanges'] = []
  for (const disk of diskEntries) {
    const file = knownByPath.get(disk.path)
    if (!file) continue
    if (disk.contentHash === file.lastWrittenHash) continue
    contentChanges.push({ fileId: file.fileId, entry: disk })
  }
  // A rename whose target bytes also changed counts as a content change for
  // the SAME fileId, observed at the new path.
  for (const rename of renames) {
    const stale = known.find((file) => file.fileId === rename.fileId)
    if (stale && rename.entry.contentHash !== stale.lastWrittenHash) {
      contentChanges.push({ fileId: rename.fileId, entry: rename.entry })
    }
  }

  return { renames, deletes, creates, contentChanges }
}

/**
 * What the daemon scans: markdown per the era-2 rule, plus opaque files —
 * excluding dotfiles and recognizable editor/save litter. Mid-save temp
 * files that do not match these heuristics surface as creates and are
 * coalesced away by the cycle's debounce, never silently special-cased.
 */
export function isScannableFile(name: string): boolean {
  if (isSyncableFile(name)) return true
  const basename = name.split('/').pop() ?? name
  if (basename.startsWith('.')) return false
  if (basename.endsWith('~')) return false
  if (basename.includes('.tmp.')) return false
  return true
}

export async function readDiskEntries(fs: LocalFS): Promise<DiskEntry[]> {
  const scanned = await fs.scan(isScannableFile)
  const entries: DiskEntry[] = []
  for (const result of scanned) {
    const bytes = await fs.readFileBytes(result.relativePath)
    const contentKind = isMarkdownFile(result.relativePath) ? 'markdown' : 'opaque'
    const text = contentKind === 'markdown' ? new TextDecoder().decode(bytes) : undefined
    entries.push({
      path: result.relativePath,
      text,
      bytes,
      contentKind,
      contentHash: sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
      nodeId: result.nodeId,
    })
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}
