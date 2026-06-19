import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNodeFS } from '../../src/fs/node-fs.ts'
import { sha256Hex } from '../../src/fs/hash.ts'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { bytesToBase64 } from '../../src/loro/base64.ts'
import { MemoryDaemonStorage } from '../../src/daemon/state.ts'
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
    _ops: WorkspaceBatchWireOp[],
  ): Promise<Awaited<ReturnType<DaemonTransport['submitBatch']>>> {
    return { type: 'ack', currentSeq: 0, acceptedOps: [], deferredOps: [] }
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
