import type { VersionVector, WorkspaceChangeEvent } from '@glovebox/core'
import { LoroFileDoc } from '../loro/file-doc.ts'
import { bytesToBase64 } from '../loro/base64.ts'
import { isMarkdownFile } from '../fs/file-kind.ts'
import { WorkspaceFileTooLargeError, type WorkspaceStore } from './workspace-store.ts'
import { WorkspaceIdempotencyStore } from './batch-idempotency-store.ts'

/**
 * The Loro-store surface the applier needs, extracted structurally so the
 * wire integration can back it with the live `SqliteLoroFileStore` tables
 * (only `delete` is reachable for the structural ops batch.submit carries)
 * while the ported `WorkspaceLoroStore` keeps satisfying it for the loro-2
 * test corpus.
 */
export interface BatchApplierLoroStore {
  importUpdate(fileId: string, update: Uint8Array): { doc: LoroFileDoc; changed: boolean } | null
  initialize(fileId: string, initialContent?: string): LoroFileDoc
  replaceWithSnapshot(fileId: string, snapshot: Uint8Array): void
  readSnapshot(fileId: string): Uint8Array | null
  delete(fileId: string): void
}

export type LocalSyncOp =
  | {
      type: 'content.update'
      opId: string
      fileId: string
      baseContentVersion: Uint8Array
      loroUpdate: Uint8Array
      observedPath: string
      observedContentHash?: string
      observedAt: number
    }
  | {
      type: 'content.opaqueUpdate'
      opId: string
      fileId: string
      contentB64: string
      observedPath: string
      observedContentHash?: string
      observedAt: number
    }
  | {
      type: 'file.create'
      opId: string
      localFileId: string
      path: string
      observedContentHash?: string
      initialContent?:
        | { kind?: 'markdown'; loroSnapshot: Uint8Array }
        | { kind: 'opaque'; contentB64: string }
      observedAt: number
    }
  | {
      type: 'file.rename'
      opId: string
      fileId: string
      baseSeq: number
      expectedVersionVector?: VersionVector
      fromPath: string
      toPath: string
      observedAt: number
    }
  | {
      type: 'file.deleteIntent'
      opId: string
      fileId: string
      baseSeq: number
      path: string
      observedAt: number
    }

export interface ApplyLocalBatchInput {
  workspaceId: string
  mountId: string
  deviceId: string
  baseSeq: number
  ops: readonly LocalSyncOp[]
}

export interface BatchAcceptedOp {
  opId: string
  /**
   * For ops that promote a localFileId / suffix a path, the canonical server
   * binding. Daemon uses this to remap its in-flight pending state.
   */
  binding?: {
    localFileId?: string
    fileId: string
    path: string
  }
}

export interface BatchDeferredOp {
  opId: string
  reason:
    | 'remote-edit-wins'
    | 'rename-target-occupied'
    | 'file-not-found'
    | 'invalid-update'
    | 'file-too-large'
    | 'unsupported-op'
}

interface BatchSnapshot {
  fileId: string
  contentVersion: Uint8Array<ArrayBuffer>
  loroSnapshot: Uint8Array<ArrayBuffer>
  textContent: string
}

interface BatchOpaqueContent {
  fileId: string
  contentBytes: Uint8Array<ArrayBuffer>
  contentHash: string
}

export interface ApplyLocalBatchResult {
  acceptedOps: BatchAcceptedOp[]
  deferredOps: BatchDeferredOp[]
  currentSeq: number
  events: WorkspaceChangeEvent[]
  snapshots: BatchSnapshot[]
  opaqueContents: BatchOpaqueContent[]
}

interface BatchApplierOptions {
  /** Caller userId; used as `modifiedBy` for canonical writes. */
  userId: string
  /** Caller deviceId; used for echo suppression in content broadcasts. */
  deviceId: string
}

/**
 * Server-authoritative batch processor. Owns the policy decisions:
 * - path collision suffixing for create
 * - rename tie-break (delegated to WorkspaceStore)
 * - delete-vs-edit defer (compares baseSeq with current file seq)
 * - file size limits (rejects oversize content updates)
 *
 * The applier is sync because the underlying stores are sync. Caller wraps it
 * in `transactionSync` if it wants the whole batch atomic per-DO.
 */
export class WorkspaceBatchApplier {
  readonly #workspace: WorkspaceStore
  readonly #loro: BatchApplierLoroStore
  readonly #idempotency: WorkspaceIdempotencyStore

  constructor(
    workspace: WorkspaceStore,
    loro: BatchApplierLoroStore,
    idempotency: WorkspaceIdempotencyStore,
  ) {
    this.#workspace = workspace
    this.#loro = loro
    this.#idempotency = idempotency
  }

  apply(input: ApplyLocalBatchInput, options: BatchApplierOptions): ApplyLocalBatchResult {
    const result: ApplyLocalBatchResult = {
      acceptedOps: [],
      deferredOps: [],
      currentSeq: this.#workspace.currentSequence(),
      events: [],
      snapshots: [],
      opaqueContents: [],
    }

    for (const op of input.ops) {
      const cached = this.#idempotency.lookup(op.opId)
      if (cached) {
        result.acceptedOps.push(cached.acceptedOp ?? { opId: op.opId })
        result.snapshots.push(...cached.snapshots)
        result.opaqueContents.push(...(cached.opaqueContents ?? []))
        continue
      }

      const opOutcome = this.#applyOp(op, options)
      if (opOutcome.deferred) {
        result.deferredOps.push({ opId: op.opId, reason: opOutcome.reason })
        continue
      }

      const broadcastEvents = this.#buildLoroBroadcastEvents(op, opOutcome, input.deviceId)
      const eventsToRecord = [...opOutcome.events, ...broadcastEvents]
      const acceptedOp = opOutcome.binding
        ? { opId: op.opId, binding: opOutcome.binding }
        : { opId: op.opId }

      this.#idempotency.record(op.opId, input.deviceId, {
        events: eventsToRecord,
        acceptedOp,
        snapshots: opOutcome.snapshot ? [opOutcome.snapshot] : [],
        opaqueContents: opOutcome.opaqueContent ? [opOutcome.opaqueContent] : [],
      })
      result.acceptedOps.push(acceptedOp)
      result.events.push(...eventsToRecord)
      if (opOutcome.snapshot) {
        result.snapshots.push(opOutcome.snapshot)
      }
      if (opOutcome.opaqueContent) {
        result.opaqueContents.push(opOutcome.opaqueContent)
      }
    }

    result.currentSeq = this.#workspace.currentSequence()
    return result
  }

  /**
   * Derive the per-file `content.loroUpdate` event(s) that go alongside the
   * tree-level events. For `content.update` the broadcast carries the original
   * client update bytes — any other peer sharing the same baseline can apply
   * them directly. For `file.create` we broadcast the initial snapshot so
   * fresh clients can hydrate without an extra fetch.
   */
  #buildLoroBroadcastEvents(
    op: LocalSyncOp,
    outcome: {
      events: WorkspaceChangeEvent[]
      snapshot?: BatchSnapshot
      opaqueContent?: BatchOpaqueContent
      binding?: BatchAcceptedOp['binding']
    } & { deferred: false },
    originDeviceId: string,
  ): WorkspaceChangeEvent[] {
    if (op.type === 'content.update') {
      const snapshot = outcome.snapshot
      if (!snapshot) return []
      return [
        {
          type: 'content.loroUpdate',
          fileId: op.fileId,
          loroUpdateB64: bytesToBase64(op.loroUpdate),
          contentVersionB64: bytesToBase64(snapshot.contentVersion),
          originDeviceId,
          seq: outcome.events[0]?.seq,
        },
      ]
    }

    if (op.type === 'file.create' && outcome.binding && outcome.snapshot) {
      return [
        {
          type: 'content.loroUpdate',
          fileId: outcome.binding.fileId,
          loroUpdateB64: bytesToBase64(outcome.snapshot.loroSnapshot),
          contentVersionB64: bytesToBase64(outcome.snapshot.contentVersion),
          originDeviceId,
          seq: outcome.events[0]?.seq,
        },
      ]
    }

    return []
  }

  #applyOp(op: LocalSyncOp, options: BatchApplierOptions): OpOutcome {
    switch (op.type) {
      case 'content.update':
        return this.#applyContentUpdate(op, options.userId)
      case 'content.opaqueUpdate':
        return this.#applyOpaqueUpdate(op, options.userId, options.deviceId)
      case 'file.create':
        return this.#applyCreate(op, options.userId)
      case 'file.rename':
        return this.#applyRename(op, options.userId)
      case 'file.deleteIntent':
        return this.#applyDeleteIntent(op, options.userId)
    }
  }

  #applyContentUpdate(
    op: Extract<LocalSyncOp, { type: 'content.update' }>,
    userId: string,
  ): OpOutcome {
    const file = this.#workspace.getByFileId(op.fileId)
    if (!file) {
      return { deferred: true, reason: 'file-not-found' }
    }

    let imported: { doc: LoroFileDoc; changed: boolean } | null
    try {
      imported = this.#loro.importUpdate(op.fileId, op.loroUpdate)
    } catch {
      return { deferred: true, reason: 'invalid-update' }
    }

    if (!imported) {
      // No existing Loro state — initialize from current text projection.
      const currentText = this.#workspace.readFileById(op.fileId) ?? ''
      this.#loro.initialize(op.fileId, currentText)
      try {
        imported = this.#loro.importUpdate(op.fileId, op.loroUpdate)
      } catch {
        return { deferred: true, reason: 'invalid-update' }
      }

      if (!imported) {
        return { deferred: true, reason: 'invalid-update' }
      }
    }

    const { doc, changed } = imported
    if (!changed) {
      return { deferred: false, events: [] }
    }

    const text = doc.getTextContent()

    let writeResult
    try {
      writeResult = this.#workspace.writeFileById(op.fileId, text, { modifiedBy: userId })
    } catch (error) {
      if (error instanceof WorkspaceFileTooLargeError) {
        return { deferred: true, reason: 'file-too-large' }
      }
      throw error
    }

    if (!writeResult) {
      return { deferred: true, reason: 'file-not-found' }
    }

    const entry = this.#workspace.getTreeEntryByFileId(op.fileId)
    const events: WorkspaceChangeEvent[] = entry
      ? [{ type: 'update', path: entry.path, entry, seq: entry.seq }]
      : []

    return {
      deferred: false,
      events,
      snapshot: {
        fileId: op.fileId,
        contentVersion: new Uint8Array(doc.contentVersion()),
        loroSnapshot: new Uint8Array(doc.exportSnapshot()),
        textContent: text,
      },
    }
  }

  #applyCreate(op: Extract<LocalSyncOp, { type: 'file.create' }>, userId: string): OpOutcome {
    if (op.initialContent && 'contentB64' in op.initialContent) {
      const contentBytes = base64ToBytes(op.initialContent.contentB64)
      let created
      try {
        created = this.#workspace.createOpaqueFileOrSuffix(op.path, contentBytes, {
          modifiedBy: userId,
        })
      } catch {
        return { deferred: true, reason: 'file-too-large' }
      }

      const entry = this.#workspace.getTreeEntryByFileId(created.fileId)
      const events: WorkspaceChangeEvent[] = entry
        ? [{ type: 'create', path: entry.path, entry, seq: entry.seq }]
        : []

      return {
        deferred: false,
        events,
        binding: {
          localFileId: op.localFileId,
          fileId: created.fileId,
          path: created.path,
        },
        opaqueContent: {
          fileId: created.fileId,
          contentBytes: new Uint8Array(contentBytes),
          contentHash: created.contentHash,
        },
      }
    }

    let initialText = ''
    if (op.initialContent) {
      try {
        const seedDoc = LoroFileDoc.fromSnapshot(op.initialContent.loroSnapshot)
        initialText = seedDoc.getTextContent()
      } catch {
        return { deferred: true, reason: 'invalid-update' }
      }
    }

    let created
    try {
      created = this.#workspace.createFileOrSuffix(op.path, initialText, { modifiedBy: userId })
    } catch (error) {
      if (error instanceof WorkspaceFileTooLargeError) {
        return { deferred: true, reason: 'file-too-large' }
      }
      throw error
    }

    // Mirror into Loro storage so future content.update ops have a baseline.
    if (op.initialContent) {
      this.#loro.replaceWithSnapshot(created.fileId, op.initialContent.loroSnapshot)
    } else {
      this.#loro.initialize(created.fileId, initialText)
    }

    const entry = this.#workspace.getTreeEntryByFileId(created.fileId)
    const events: WorkspaceChangeEvent[] = entry
      ? [{ type: 'create', path: entry.path, entry, seq: entry.seq }]
      : []

    const snapshot = this.#loro.readSnapshot(created.fileId)
    const doc = snapshot ? LoroFileDoc.fromSnapshot(snapshot) : null

    return {
      deferred: false,
      events,
      binding: {
        localFileId: op.localFileId,
        fileId: created.fileId,
        path: created.path,
      },
      snapshot:
        doc && snapshot
          ? {
              fileId: created.fileId,
              contentVersion: new Uint8Array(doc.contentVersion()),
              loroSnapshot: new Uint8Array(snapshot),
              textContent: doc.getTextContent(),
            }
          : undefined,
    }
  }

  #applyOpaqueUpdate(
    op: Extract<LocalSyncOp, { type: 'content.opaqueUpdate' }>,
    userId: string,
    originDeviceId: string,
  ): OpOutcome {
    const file = this.#workspace.getByFileId(op.fileId)
    if (!file) {
      return { deferred: true, reason: 'file-not-found' }
    }

    const contentBytes = base64ToBytes(op.contentB64)
    const updated = this.#workspace.writeFileBytesById(op.fileId, contentBytes, {
      modifiedBy: userId,
    })
    if (!updated) {
      return { deferred: true, reason: 'file-not-found' }
    }

    const entry = this.#workspace.getTreeEntryByFileId(op.fileId)
    const events: WorkspaceChangeEvent[] = entry
      ? [
          { type: 'update', path: entry.path, entry, seq: entry.seq },
          {
            type: 'content.opaqueUpdate',
            fileId: op.fileId,
            bytesB64: op.contentB64,
            originDeviceId,
            seq: entry.seq,
          },
        ]
      : []

    return {
      deferred: false,
      events,
      opaqueContent: {
        fileId: op.fileId,
        contentBytes: new Uint8Array(contentBytes),
        contentHash: updated.contentHash,
      },
    }
  }

  #applyRename(op: Extract<LocalSyncOp, { type: 'file.rename' }>, userId: string): OpOutcome {
    const currentEntry = this.#workspace.getTreeEntryByFileId(op.fileId)
    if (!currentEntry) {
      return { deferred: true, reason: 'file-not-found' }
    }

    const fileSeq = currentEntry.seq ?? 0
    if (fileSeq > op.baseSeq) {
      return { deferred: true, reason: 'remote-edit-wins' }
    }

    const target = this.#workspace.getFileByPath(op.toPath)
    if (target && target.id !== op.fileId) {
      return { deferred: true, reason: 'rename-target-occupied' }
    }

    const renamed = op.expectedVersionVector
      ? this.#workspace.renameFileByIdWithTiebreak(
          op.fileId,
          op.toPath,
          {
            modifiedBy: userId,
          },
          op.expectedVersionVector,
        )
      : this.#workspace.renameFileById(op.fileId, op.toPath, {
          modifiedBy: userId,
        })

    if (!renamed) {
      return { deferred: true, reason: 'file-not-found' }
    }

    if ('applied' in renamed && !renamed.applied) {
      return { deferred: true, reason: 'rename-target-occupied' }
    }

    // A rename across the md↔opaque boundary re-derives the row's content
    // kind (ISSUE-0043): kind is path-derived everywhere else, so a .png
    // row claiming 'markdown' is an invariant violation that misroutes the
    // next content op. md→opaque drops the Loro doc — the row's bytes are
    // canonical and the dofs LWW path owns content from here; opaque→md
    // leaves Loro lazy (the next snapshot.get seeds it from the row text).
    if (
      renamed.oldPath !== renamed.newPath &&
      isMarkdownFile(renamed.oldPath) !== isMarkdownFile(renamed.newPath)
    ) {
      const kind = isMarkdownFile(renamed.newPath) ? 'markdown' : 'opaque'
      this.#workspace.transitionContentKind(op.fileId, kind)
      if (kind === 'opaque') {
        this.#loro.delete(op.fileId)
      }
    }

    const entry = this.#workspace.getTreeEntryByFileId(op.fileId)
    const events: WorkspaceChangeEvent[] =
      entry && renamed.oldPath !== renamed.newPath
        ? [
            {
              type: 'rename',
              oldPath: renamed.oldPath,
              newPath: entry.path,
              entry,
              seq: entry.seq,
            },
          ]
        : []

    return {
      deferred: false,
      events,
      binding: {
        fileId: op.fileId,
        path: renamed.newPath,
      },
    }
  }

  #applyDeleteIntent(
    op: Extract<LocalSyncOp, { type: 'file.deleteIntent' }>,
    userId: string,
  ): OpOutcome {
    const entry = this.#workspace.getTreeEntryByFileId(op.fileId)
    if (!entry) {
      // Already deleted server-side — treat as accepted with no event.
      return { deferred: false, events: [] }
    }

    const fileSeq = entry.seq ?? 0
    if (fileSeq > op.baseSeq) {
      // Remote edited the file after the daemon observed it; edit wins.
      return { deferred: true, reason: 'remote-edit-wins' }
    }

    const deleted = this.#workspace.deleteFileById(op.fileId, { modifiedBy: userId })
    if (!deleted) {
      return { deferred: true, reason: 'file-not-found' }
    }

    this.#loro.delete(op.fileId)

    const events: WorkspaceChangeEvent[] = [
      {
        type: 'delete',
        path: deleted.path,
        fileId: deleted.fileId,
        versionVector: deleted.versionVector,
        remoteRev: deleted.remoteRev,
        tombstone: true,
        seq: deleted.seq,
      },
    ]

    return { deferred: false, events }
  }
}

type OpOutcome =
  | {
      deferred: false
      events: WorkspaceChangeEvent[]
      binding?: BatchAcceptedOp['binding']
      snapshot?: BatchSnapshot
      opaqueContent?: BatchOpaqueContent
    }
  | { deferred: true; reason: BatchDeferredOp['reason'] }

function base64ToBytes(value: string): Uint8Array {
  if (!value) return new Uint8Array()
  return new Uint8Array(Buffer.from(value, 'base64'))
}
