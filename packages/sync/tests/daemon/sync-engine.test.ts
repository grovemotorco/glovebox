import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNodeFS } from '../../src/fs/node-fs.ts'
import { sha256Hex } from '../../src/fs/hash.ts'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { bytesToBase64 } from '../../src/loro/base64.ts'
import {
  DELETE_RESOLUTION_ARTIFACT,
  MemoryDaemonStorage,
  STATE_ARTIFACT,
  type DaemonWorkspaceState,
  type DeleteResolutionQueue,
  type PendingDelete,
} from '../../src/daemon/state.ts'
import {
  DaemonSyncEngine,
  type DaemonSyncWarning,
  type DaemonTransport,
  type DaemonTreeState,
  type OpaqueFetchResult,
  type SubmitOpaqueInput,
  type SubmitOpaqueResult,
} from '../../src/daemon/sync-engine.ts'
import type { SubmitUpdateInput, SubmitUpdateResult } from '../../src/loro/room-client.ts'
import type { EventsSinceResult } from '../../src/client/sync-engine.ts'
import type { WorkspaceBatchWireOp } from '../../src/server/workspace-server.ts'

class FakeTransport implements DaemonTransport {
  readonly snapshotRequests: { fileId: string; initialContent?: string; observedPath?: string }[] =
    []
  readonly opaqueSubmits: SubmitOpaqueInput[] = []
  readonly batchSubmits: WorkspaceBatchWireOp[][] = []
  opaqueError: Error | null = null
  opaqueResult: SubmitOpaqueResult | null = null

  async fetchSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    this.snapshotRequests.push({ fileId, initialContent, observedPath })
    if (fileId === 'file-bad') {
      throw new Error('server error: rejected test file')
    }
    return LoroFileDoc.empty(initialContent).exportSnapshot()
  }

  async eventsSince(_afterSeq: number): Promise<EventsSinceResult> {
    return { ok: true, currentSeq: 0, events: [] }
  }

  async submitUpdate(_input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    return { type: 'ack', applied: true, contentVersionB64: bytesToBase64(new Uint8Array()) }
  }

  async submitOpaque(input: SubmitOpaqueInput): Promise<SubmitOpaqueResult> {
    this.opaqueSubmits.push(input)
    if (this.opaqueError) throw this.opaqueError
    return (
      this.opaqueResult ?? {
        type: 'ack',
        hashHex: sha256Hex(input.bytes),
        sizeBytes: input.bytes.byteLength,
        manifest: { chunks: [] },
        conflict: false,
        path: input.observedPath,
      }
    )
  }

  async fetchOpaque(_fileId: string): Promise<OpaqueFetchResult> {
    return { found: false }
  }

  async listTree(): Promise<DaemonTreeState> {
    return { currentSeq: 0, entries: [] }
  }

  async submitBatch(
    ops: WorkspaceBatchWireOp[],
  ): Promise<Awaited<ReturnType<DaemonTransport['submitBatch']>>> {
    this.batchSubmits.push(ops)
    return {
      type: 'ack',
      currentSeq: 0,
      acceptedOps: ops.map((op) => ({ opId: op.opId })),
      deferredOps: [],
    }
  }
}

describe('DaemonSyncEngine cycle isolation and opaque observability (ISSUE-0053)', () => {
  it('continues to opaque submit when one markdown create is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, 'bad.md'), '')
      await writeFile(join(root, 'good.bin'), new Uint8Array([1, 2, 3]))

      const transport = new FakeTransport()
      const warnings: DaemonSyncWarning[] = []
      const ids = ['file-bad', 'file-good']
      let op = 0
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage: new MemoryDaemonStorage(),
        transport,
        newFileId: () => ids.shift() ?? `file-extra-${ids.length}`,
        newOpId: () => `op-${++op}`,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()
      await engine.runCycle()

      expect(transport.snapshotRequests).toEqual([
        { fileId: 'file-bad', initialContent: '', observedPath: 'bad.md' },
      ])
      expect(transport.opaqueSubmits).toHaveLength(1)
      expect(transport.opaqueSubmits[0]).toMatchObject({
        fileId: 'file-good',
        observedPath: 'good.bin',
        opId: 'op-1',
        baseHashHex: '',
      })
      expect([...transport.opaqueSubmits[0]!.bytes]).toEqual([1, 2, 3])
      expect(engine.files()).toEqual([
        { fileId: 'file-good', path: 'good.bin', contentKind: 'opaque' },
      ])
      expect(warnings).toContainEqual({
        type: 'file-operation-failed',
        phase: 'scan.create',
        fileId: 'file-bad',
        path: 'bad.md',
        reason: 'server error: rejected test file',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('logs permanent opaque rejections once for the refused bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, 'asset.bin'), new Uint8Array([4, 5, 6]))

      const transport = new FakeTransport()
      transport.opaqueResult = { type: 'rejected', reason: 'too-large' }
      const warnings: DaemonSyncWarning[] = []
      let op = 0
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage: new MemoryDaemonStorage(),
        transport,
        newFileId: () => 'file-asset',
        newOpId: () => `op-${++op}`,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()
      await engine.runCycle()
      await engine.runCycle()

      expect(transport.opaqueSubmits).toHaveLength(1)
      expect(warnings).toEqual([
        {
          type: 'opaque-submit-rejected',
          fileId: 'file-asset',
          path: 'asset.bin',
          reason: 'too-large',
          retryAfterSec: undefined,
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('logs opaque transport errors and retries the same in-flight op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, 'asset.bin'), new Uint8Array([7, 8, 9]))

      const transport = new FakeTransport()
      transport.opaqueError = new Error('network down')
      const warnings: DaemonSyncWarning[] = []
      let op = 0
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage: new MemoryDaemonStorage(),
        transport,
        newFileId: () => 'file-asset',
        newOpId: () => `op-${++op}`,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()
      await engine.runCycle()
      await engine.runCycle()

      expect(transport.opaqueSubmits.map((submit) => submit.opId)).toEqual(['op-1', 'op-1'])
      expect(warnings).toEqual([
        {
          type: 'opaque-submit-failed',
          fileId: 'file-asset',
          path: 'asset.bin',
          reason: 'network down',
        },
        {
          type: 'opaque-submit-failed',
          fileId: 'file-asset',
          path: 'asset.bin',
          reason: 'network down',
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('DaemonSyncEngine delete holds and resolution', () => {
  it('surfaces persisted held deletes on start and skips them in nextWakeMs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0, held: 'bulk-window' })),
      )
      const warnings: DaemonSyncWarning[] = []
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport: new FakeTransport(),
        now: () => T0,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()

      expect(engine.nextWakeMs(T0)).toBeNull()
      expect(warnings).toEqual([
        {
          type: 'delete-intents-held',
          held: 'bulk-window',
          count: 1,
          paths: ['held.md'],
          totalHeld: 1,
        },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the earliest unheld pending-delete tombstone expiry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      const state = deleteState({ observedAt: T0, held: undefined })
      state.pendingDeletes.push({
        opId: 'd-held',
        fileId: 'f-held-2',
        path: 'held-2.md',
        baseSeq: 7,
        observedMissingAtMs: T0 - 20_000,
        held: 'bulk-window',
      })
      state.files['f-held-2'] = {
        path: 'held-2.md',
        contentKind: 'markdown',
        nodeId: '0:2',
        syncedVVB64: '',
        lastWrittenHash: 'hash-2',
        sizeBytes: 4,
        savedAt: T0,
      }
      await storage.writeAtomic(STATE_ARTIFACT, encodeJson(state))
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport: new FakeTransport(),
        now: () => T0,
      })

      await engine.start()

      expect(engine.nextWakeMs(T0 + 1_000)).toBe(T0 + 30_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies queued confirm commands before delete propagation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 31_000, held: 'bulk-window' })),
      )
      await storage.writeAtomic(
        DELETE_RESOLUTION_ARTIFACT,
        encodeJson({
          commands: [{ id: 'cmd-1', action: 'confirm', fileIds: ['f-held'], createdAt: T0 }],
        } satisfies DeleteResolutionQueue),
      )
      const transport = new FakeTransport()
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport,
        now: () => T0,
      })

      await engine.start()
      await engine.runCycle()

      expect(transport.batchSubmits.flat()).toContainEqual({
        type: 'file.deleteIntent',
        opId: 'd-held',
        fileId: 'f-held',
        baseSeq: 7,
        path: 'held.md',
      })
      expect(engine.pendingDeletes()).toEqual([])
      expect(await storage.read(DELETE_RESOLUTION_ARTIFACT)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies queued restore commands by canceling the intent and materializing from server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 31_000, held: 'bulk-window' })),
      )
      await storage.writeAtomic(
        DELETE_RESOLUTION_ARTIFACT,
        encodeJson({
          commands: [{ id: 'cmd-1', action: 'restore', fileIds: ['f-held'], createdAt: T0 }],
        } satisfies DeleteResolutionQueue),
      )
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport: new FakeTransport(),
        now: () => T0,
      })

      await engine.start()
      await engine.runCycle()

      expect(engine.pendingDeletes()).toEqual([])
      await expect(readFile(join(root, 'held.md'), 'utf-8')).resolves.toBe('')
      const state = JSON.parse(
        new TextDecoder().decode((await storage.read(STATE_ARTIFACT))!),
      ) as DaemonWorkspaceState
      expect(state.pendingDeletes).toEqual([])
      expect(state.files['f-held']!.lastWrittenHash).not.toBe('held-hash')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function deleteState(options: {
  observedAt: number
  held: PendingDelete['held'] | undefined
}): DaemonWorkspaceState {
  const intent: PendingDelete = {
    opId: 'd-held',
    fileId: 'f-held',
    path: 'held.md',
    baseSeq: 7,
    observedMissingAtMs: options.observedAt,
  }
  if (options.held !== undefined) {
    intent.held = options.held
  }
  return {
    workspaceId: 'ws-test',
    mountId: 'mount-test',
    deviceId: 'device-test',
    lastAckedSeq: 7,
    files: {
      'f-held': {
        path: 'held.md',
        contentKind: 'markdown',
        nodeId: '0:1',
        syncedVVB64: '',
        lastWrittenHash: 'held-hash',
        sizeBytes: 4,
        savedAt: options.observedAt,
      },
    },
    pendingRenames: [],
    pendingDeletes: [intent],
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}
