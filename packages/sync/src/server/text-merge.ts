import {
  DIFF_DELETE,
  type Diff,
  applyPatches,
  cleanupSemantic,
  makeDiff,
  makePatches,
  stringifyPatch,
} from '@sanity/diff-match-patch'
import type { WorkspaceSqlStorage } from './workspace-server.ts'

/**
 * Text-push merge computation (D5, spec §5.3). Ported from glyphdown
 * `packages/core/src/merge.ts` — the reference implementation — minus the
 * Yjs landing: here the caller lands `target` as Loro ops (the doc's
 * native text diff plays diff-match-patch's role on the way in).
 */

/** Fraction of the base document that may be deleted before a drifted push is refused. */
export const DEGENERATE_DELETE_RATIO = 0.6

export interface MergeComputation {
  /** What the document should become after merging base→next into current. */
  target: string
  /** Stringified patches that could not be placed against current content. */
  failedHunks: string[]
  /** Fraction of the base text the push deletes (degenerate-guard input). */
  deletedRatio: number
  /** Whether the document had drifted from the pushed base. */
  drifted: boolean
}

/**
 * Compute the merged result of a base→next edit against the current text
 * without touching the document: exact when current == base, fuzzy patch
 * application when drifted. Hunks that cannot be placed are returned
 * verbatim (git-`.rej` style), never silently dropped.
 */
export function computeMergedTarget(
  current: string,
  baseText: string,
  newText: string,
): MergeComputation {
  const drifted = current !== baseText
  if (baseText === newText) return { target: current, failedHunks: [], deletedRatio: 0, drifted }

  const diffs = cleanupSemantic(makeDiff(baseText, newText))
  const deletedRatio = deletedChars(diffs) / Math.max(baseText.length, 1)
  if (!drifted) return { target: newText, failedHunks: [], deletedRatio, drifted }

  const patches = makePatches(diffs)
  const [merged, results] = applyPatches(patches, current)
  const failedHunks = patches.filter((_, i) => !results[i]).map((patch) => stringifyPatch(patch))
  return { target: merged, failedHunks, deletedRatio, drifted }
}

function deletedChars(diffs: Diff[]): number {
  let total = 0
  for (const [op, chunk] of diffs) if (op === DIFF_DELETE) total += chunk.length
  return total
}

const BASE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Content-addressed cache of pulled base texts (spec §5.3): every served
 * read and every applied push caches `sha256(text) → text`, so a later
 * push can name its base by hash alone. A miss is not an error — the
 * client re-sends its base file and the protocol resumes without the
 * server retaining history.
 */
export class TextBaseCache {
  readonly #sql: WorkspaceSqlStorage
  readonly #now: () => number

  constructor(sql: WorkspaceSqlStorage, now: () => number) {
    this.#sql = sql
    this.#now = now
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS text_base_cache (hash_hex TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL)',
    )
  }

  get(hashHex: string): string | null {
    const rows = this.#sql
      .exec('SELECT text, created_at FROM text_base_cache WHERE hash_hex = ?', hashHex)
      .toArray()
    const row = rows[0]
    if (!row || typeof row.text !== 'string') return null
    if (Number(row.created_at) + BASE_CACHE_TTL_MS <= this.#now()) return null
    return row.text
  }

  put(hashHex: string, text: string): void {
    this.#sql.exec(
      'INSERT INTO text_base_cache (hash_hex, text, created_at) VALUES (?, ?, ?) ON CONFLICT(hash_hex) DO UPDATE SET created_at = excluded.created_at',
      hashHex,
      text,
      this.#now(),
    )
  }

  prune(): number {
    return this.#sql
      .exec(
        'DELETE FROM text_base_cache WHERE created_at + ? <= ? RETURNING hash_hex',
        BASE_CACHE_TTL_MS,
        this.#now(),
      )
      .toArray().length
  }
}
