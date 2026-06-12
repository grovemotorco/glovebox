import { LoroDoc, VersionVector } from 'loro-crdt'
import {
  TEXT_CONTAINER_ID,
  type LoroContentVersion,
  type LoroFileState,
  type LoroSnapshot,
  type LoroUpdate,
} from './types.ts'

const encoder = new TextEncoder()

export interface LoroFileDocOptions {
  /** Optional peer ID. The server typically pins a stable peer per workspace
   *  origin; clients use whatever they want. Defaults to a doc-side default. */
  peerId?: bigint
}

/**
 * A markdown file backed by a single Loro document. Owns the conventions:
 * - the text lives at root container `content`
 * - exporting "an update since version X" or "a snapshot" yields bytes that
 *   any other LoroFileDoc can `importUpdate(...)` to converge.
 *
 * This class is intentionally thin: callers (the WorkspaceDO, the daemon) own
 * persistence, sequencing, and the workspace event log around it.
 */
export class LoroFileDoc {
  readonly #doc: LoroDoc

  constructor(doc: LoroDoc) {
    this.#doc = doc
  }

  /** Empty doc, optionally pre-populated with initial text. */
  static empty(initialContent?: string, options: LoroFileDocOptions = {}): LoroFileDoc {
    const doc = new LoroDoc()
    if (options.peerId !== undefined) {
      doc.setPeerId(options.peerId)
    }

    if (initialContent !== undefined && initialContent.length > 0) {
      doc.getText(TEXT_CONTAINER_ID).update(initialContent)
      doc.commit()
    }

    return new LoroFileDoc(doc)
  }

  /** Materialize from a stored state (snapshot + queued updates). */
  static fromState(state: LoroFileState, options: LoroFileDocOptions = {}): LoroFileDoc {
    const doc = new LoroDoc()
    if (state.snapshot) {
      doc.import(state.snapshot)
    }

    for (const update of state.updates) {
      doc.import(update)
    }

    if (options.peerId !== undefined) {
      doc.setPeerId(options.peerId)
    }

    return new LoroFileDoc(doc)
  }

  /** Materialize from a single snapshot. */
  static fromSnapshot(snapshot: LoroSnapshot, options: LoroFileDocOptions = {}): LoroFileDoc {
    const doc = new LoroDoc()
    doc.import(snapshot)
    if (options.peerId !== undefined) {
      doc.setPeerId(options.peerId)
    }

    return new LoroFileDoc(doc)
  }

  /**
   * Import a single update batch (bytes produced by `exportUpdateSince` or
   * `exportSnapshot` on another doc). Returns true if the underlying doc
   * version advanced.
   */
  importUpdate(update: LoroUpdate | LoroSnapshot): boolean {
    const before = this.contentVersion()
    this.#doc.import(update)
    const after = this.contentVersion()
    return !bytesEqual(before, after)
  }

  /** Import a batch of updates atomically, in order. */
  importBatch(updates: readonly (LoroUpdate | LoroSnapshot)[]): boolean {
    return this.importBatchWithStatus(updates).changed
  }

  /**
   * Import a batch and surface Loro's `ImportStatus.pending`: true when some
   * updates could not apply because their causal dependencies are missing.
   * Callers MUST treat pending as a repair trigger (fetch a fresh snapshot)
   * before advancing any durable cursor — required behavior, not an
   * optimization (spec §2, importBatch trap).
   */
  importBatchWithStatus(updates: readonly (LoroUpdate | LoroSnapshot)[]): {
    changed: boolean
    pending: boolean
  } {
    if (updates.length === 0) {
      return { changed: false, pending: false }
    }

    const before = this.contentVersion()
    const status = this.#doc.importBatch(Array.from(updates))
    const after = this.contentVersion()
    return {
      changed: !bytesEqual(before, after),
      pending: status.pending !== null && status.pending.size > 0,
    }
  }

  /**
   * Export the bytes a remote peer needs to catch up from `since`. Pass `null`
   * to get a full snapshot-equivalent update from doc inception.
   */
  exportUpdateSince(since: LoroContentVersion | null): LoroUpdate {
    if (since === null) {
      return this.#doc.export({ mode: 'update', from: undefined })
    }

    return this.#doc.export({ mode: 'update', from: VersionVector.decode(since) })
  }

  /** Export a full snapshot (all history baked in, no shallowness). */
  exportSnapshot(): LoroSnapshot {
    return this.#doc.export({ mode: 'snapshot' })
  }

  /** Compaction artifact: discard everything before current frontiers. */
  exportShallowSnapshot(): LoroSnapshot {
    return this.#doc.export({ mode: 'shallow-snapshot', frontiers: this.#doc.oplogFrontiers() })
  }

  /**
   * Replace the content of the text container with the given string.
   * Loro computes the minimal diff against the existing text and emits the
   * corresponding ops; concurrent edits from other peers are preserved. */
  setTextContent(content: string): void {
    this.#doc.getText(TEXT_CONTAINER_ID).update(content)
    this.#doc.commit()
  }

  /**
   * Apply `content` as an edit anchored at `base`, not at the doc's current
   * state: fork at the base version, diff there, and merge the resulting
   * ops back in. Required whenever the new text was derived from an older
   * materialization (a disk file derived from the last checkout) — diffing
   * against the CURRENT text would emit deletions of every op imported
   * since that base and push them as deliberate edits (era-4 / INV-5
   * data-loss class). Returns the version that materializes exactly
   * `content` (base + the new ops), for watermark bookkeeping.
   *
   * The fork gets a fresh random peer ID: it shares this doc's history, so
   * inheriting the peer would mint (peer, counter) pairs that collide with
   * ops this doc created after `base`.
   */
  applyTextAtBase(base: LoroContentVersion, content: string): LoroContentVersion {
    const baseVV = decodeVersion(base)
    const fork = this.#doc.forkAt(this.#doc.vvToFrontiers(baseVV))
    fork.setPeerId(randomPeerId())
    fork.getText(TEXT_CONTAINER_ID).update(content)
    fork.commit()
    const update = fork.export({
      mode: 'update',
      from: baseVV.length() === 0 ? undefined : baseVV,
    })
    this.#doc.import(update)
    return fork.oplogVersion().encode()
  }

  /**
   * Pin the peer ID used for subsequent local ops. The server pins a
   * durable, never-reused peer here before minting text-push ops (D5:
   * this client tier never owns a peer, so it cannot violate INV-7).
   */
  setPeerId(peerId: bigint): void {
    this.#doc.setPeerId(peerId)
  }

  getTextContent(): string {
    return this.#doc.getText(TEXT_CONTAINER_ID).toString()
  }

  getTextContentSizeBytes(): number {
    return encoder.encode(this.getTextContent()).byteLength
  }

  contentVersion(): LoroContentVersion {
    return this.#doc.oplogVersion().encode()
  }

  /**
   * History floor of a shallow doc: the version before which ops have been
   * trimmed away. Empty for docs with full history. Updates whose base does
   * not dominate this floor cannot be imported (loro raises an import error)
   * and must go through the `history-pruned` repair path.
   */
  shallowSinceVersion(): LoroContentVersion {
    return this.#doc.shallowSinceVV().encode()
  }

  /** Underlying doc, escape hatch. Avoid unless you need a Loro feature this
   *  wrapper does not expose. */
  unwrap(): LoroDoc {
    return this.#doc
  }
}

/**
 * Whether `candidate` includes everything up to `floor` (i.e. is at or after
 * it). False when older than or concurrent with the floor — both mean the
 * candidate's history may reference trimmed ops.
 */
export function versionDominates(
  candidate: LoroContentVersion,
  floor: LoroContentVersion,
): boolean {
  const floorVV = decodeVersion(floor)
  if (floorVV.length() === 0) return true
  const comparison = decodeVersion(candidate).compare(floorVV)
  return comparison !== undefined && comparison >= 0
}

function decodeVersion(bytes: LoroContentVersion): VersionVector {
  if (bytes.byteLength === 0) return new VersionVector(null)
  return VersionVector.decode(bytes)
}

function randomPeerId(): bigint {
  const buf = new BigUint64Array(1)
  crypto.getRandomValues(buf)
  return buf[0]!
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}
