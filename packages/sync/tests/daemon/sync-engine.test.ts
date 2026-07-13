import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceTreeEntry } from '@glovebox.md/core'
import { createNodeFS } from '../../src/fs/node-fs.ts'
import { sha256Hex } from '../../src/fs/hash.ts'
import { LoroFileDoc } from '../../src/loro/file-doc.ts'
import { bytesToBase64 } from '../../src/loro/base64.ts'
import {
  DELETE_RESOLUTION_DIR,
  MemoryDaemonStorage,
  STATE_ARTIFACT,
  deleteResolutionName,
  envelopeName,
  type DaemonWorkspaceState,
  type PendingCreate,
  type PendingDelete,
} from '../../src/daemon/state.ts'
import {
  DaemonSyncEngine,
  type DaemonSyncEngineOptions,
  type DaemonSyncWarning,
  type DaemonTransport,
  type DaemonTreeState,
  type OpaqueFetchResult,
  type SubmitOpaqueInput,
  type SubmitOpaqueResult,
} from '../../src/daemon/sync-engine.ts'
import type { SubmitUpdateInput, SubmitUpdateResult } from '../../src/loro/room-client.ts'
import type { EventsSinceResult, WireWorkspaceEvent } from '../../src/client/sync-engine.ts'
import type { WorkspaceBatchWireOp } from '../../src/server/workspace-server.ts'

class FakeTransport implements DaemonTransport {
  readonly snapshotRequests: { fileId: string; initialContent?: string; observedPath?: string }[] =
    []
  readonly opaqueSubmits: SubmitOpaqueInput[] = []
  readonly batchSubmits: WorkspaceBatchWireOp[][] = []
  readonly submittedUpdates: string[] = []
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

  async submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    this.submittedUpdates.push(input.fileId)
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

class CreateReplayTransport extends FakeTransport {
  readonly #docs = new Map<string, LoroFileDoc>()

  constructor(
    readonly event: WireWorkspaceEvent,
    readonly canonicalSnapshot: Uint8Array,
  ) {
    super()
    this.#docs.set(event.fileId, LoroFileDoc.fromSnapshot(canonicalSnapshot))
  }

  override async fetchSnapshot(
    fileId: string,
    initialContent?: string,
    observedPath?: string,
  ): Promise<Uint8Array> {
    this.snapshotRequests.push({ fileId, initialContent, observedPath })
    let doc = this.#docs.get(fileId)
    if (!doc) {
      doc = LoroFileDoc.empty(initialContent)
      this.#docs.set(fileId, doc)
    }
    return doc.exportSnapshot()
  }

  override async submitUpdate(input: SubmitUpdateInput): Promise<SubmitUpdateResult> {
    this.submittedUpdates.push(input.fileId)
    const doc = this.#docs.get(input.fileId) ?? LoroFileDoc.empty()
    doc.importUpdate(input.loroUpdate)
    this.#docs.set(input.fileId, doc)
    return {
      type: 'ack',
      applied: true,
      contentVersionB64: bytesToBase64(doc.contentVersion()),
    }
  }

  override async eventsSince(afterSeq: number): Promise<EventsSinceResult> {
    const seq = this.event.seq ?? 1
    return {
      ok: true,
      currentSeq: seq,
      events: afterSeq < seq ? [this.event] : [],
    }
  }

  serverText(fileId: string): string | null {
    return this.#docs.get(fileId)?.getTextContent() ?? null
  }
}

/** Simulates a create whose event fell out of replay while its live tree row remains. */
class PrunedCreateTransport extends CreateReplayTransport {
  override async eventsSince(): Promise<EventsSinceResult> {
    return { ok: true, currentSeq: this.event.seq ?? 1, events: [] }
  }

  override async listTree(): Promise<DaemonTreeState> {
    return {
      currentSeq: this.event.seq ?? 1,
      entries: this.event.entry ? [this.event.entry as DaemonTreeState['entries'][number]] : [],
    }
  }
}

const textEncoder = new TextEncoder()

function pendingMarkdownCreate(
  fileId: string,
  path: string,
  baseText: string,
  nodeId: string | null,
  overrides: Partial<PendingCreate> = {},
): PendingCreate {
  return {
    fileId,
    path,
    contentKind: 'markdown',
    contentHash: sha256Hex(baseText),
    baseContentHash: sha256Hex(baseText),
    nodeId,
    sizeBytes: textEncoder.encode(baseText).byteLength,
    ...overrides,
  }
}

async function seedPendingState(
  storage: MemoryDaemonStorage,
  pendingCreates: PendingCreate[],
  overrides: Partial<DaemonWorkspaceState> = {},
): Promise<void> {
  await storage.writeAtomic(
    STATE_ARTIFACT,
    encodeJson({
      workspaceId: 'ws-test',
      mountId: 'mount-test',
      deviceId: 'device-test',
      lastAckedSeq: 0,
      adoptedAt: 1,
      files: {},
      pendingCreates,
      pendingRenames: [],
      pendingDeletes: [],
      ...overrides,
    }),
  )
}

function markdownTreeEntry(
  fileId: string,
  path: string,
  text: string,
  seq = 1,
  overrides: Partial<WorkspaceTreeEntry> = {},
): WorkspaceTreeEntry {
  return {
    fileId,
    path,
    contentKind: 'markdown',
    contentHash: sha256Hex(text),
    sizeBytes: textEncoder.encode(text).byteLength,
    version: 1,
    seq,
    modifiedBy: 'test-user',
    modifiedAt: 1,
    ...overrides,
  }
}

function markdownCreateEvent(
  fileId: string,
  path: string,
  entryText: string,
  options: {
    seq?: number
    contentVersionB64?: string
    entry?: Partial<WorkspaceTreeEntry>
  } = {},
): WireWorkspaceEvent {
  const seq = options.seq ?? 1
  return {
    type: 'create',
    fileId,
    path,
    seq,
    contentVersionB64: options.contentVersionB64,
    entry: markdownTreeEntry(fileId, path, entryText, seq, options.entry),
  }
}

function crashEngine(
  options: Omit<DaemonSyncEngineOptions, 'workspaceId' | 'mountId' | 'deviceId'>,
): DaemonSyncEngine {
  return new DaemonSyncEngine({
    workspaceId: 'ws-test',
    mountId: 'mount-test',
    deviceId: 'device-test',
    ...options,
  })
}

describe('DaemonSyncEngine create-response crash reconciliation', () => {
  it('persists intent before request and reuses the same fileId after a pre-effect failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'retry.md'), 'retry me')
      class FailFirstSnapshotTransport extends FakeTransport {
        attempts = 0

        override async fetchSnapshot(
          fileId: string,
          initialContent?: string,
          observedPath?: string,
        ): Promise<Uint8Array> {
          this.snapshotRequests.push({ fileId, initialContent, observedPath })
          this.attempts += 1
          if (this.attempts === 1) throw new Error('failed before server effect')
          return LoroFileDoc.empty(initialContent).exportSnapshot()
        }
      }
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [])
      const transport = new FailFirstSnapshotTransport()
      const localFs = await createNodeFS(root)
      let mintedIds = 0
      const options = {
        fs: localFs,
        storage,
        transport,
        newFileId: () => `file-${++mintedIds}`,
      }
      const first = crashEngine(options)

      await first.start()
      await first.runCycle()
      expect((await decodeState(storage)).pendingCreates).toMatchObject([
        { fileId: 'file-1', path: 'retry.md', contentKind: 'markdown' },
      ])
      expect(first.files()).toEqual([])
      first.stop()

      // A new process hydrates the intent and must not mint another identity.
      const restarted = crashEngine(options)
      await restarted.start()
      await restarted.runCycle()
      expect(transport.snapshotRequests.map((request) => request.fileId)).toEqual([
        'file-1',
        'file-1',
      ])
      expect(mintedIds).toBe(1)
      expect(restarted.files()).toEqual([
        { fileId: 'file-1', path: 'retry.md', contentKind: 'markdown' },
      ])
      const state = await decodeState(storage)
      expect(state.pendingCreates).toEqual([])
      expect(state.files['file-1']).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-binds a dirty pending create regardless of untrusted event origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      // The server accepted the initial create, but SIGKILL landed before the
      // daemon persisted the returned fileId. The user then appended while the
      // daemon was dead. Restart only has the durable create event + disk.
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'kill-one.md'), 'oneafter-kill')
      const localFs = await createNodeFS(root)
      const nodeId = (await localFs.stat('kill-one.md'))!.nodeId
      const created = LoroFileDoc.empty('one')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-kill-one', 'kill-one.md', 'one', nodeId),
      ])
      const event: WireWorkspaceEvent = {
        ...markdownCreateEvent('file-kill-one', 'kill-one.md', 'one', {
          contentVersionB64: bytesToBase64(created.contentVersion()),
        }),
        originDeviceId: 'foreign-or-spoofed-device',
      }
      const transport = new CreateReplayTransport(event, created.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'unexpected-suffix-file',
        newOpId: () => 'op-local-append',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'kill-one.md'), 'utf8')).toBe('oneafter-kill')
      await expect(readFile(join(root, 'kill-one-2.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(engine.files()).toEqual([
        { fileId: 'file-kill-one', path: 'kill-one.md', contentKind: 'markdown' },
      ])
      expect(engine.getText('file-kill-one')).toBe('oneafter-kill')
      expect(transport.submittedUpdates).toContain('file-kill-one')
      expect(transport.serverText('file-kill-one')).toBe('oneafter-kill')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('follows a server-suffixed own create when an earlier remote event moved the staged inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'shared.md'), 'oneafter-kill')
      const localFs = await createNodeFS(root)
      const stagedNodeId = (await localFs.stat('shared.md'))!.nodeId
      const ownCreated = LoroFileDoc.empty('one')
      const remote = LoroFileDoc.empty('remote-file')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-own', 'shared.md', 'one', stagedNodeId),
      ])
      const remoteEvent = markdownCreateEvent('file-remote', 'shared.md', 'remote-file')
      const ownEvent = markdownCreateEvent('file-own', 'shared-2.md', 'one', {
        seq: 2,
        contentVersionB64: bytesToBase64(ownCreated.contentVersion()),
        entry: { modifiedAt: 2 },
      })
      class OrderedCollisionTransport extends CreateReplayTransport {
        override async eventsSince(afterSeq: number): Promise<EventsSinceResult> {
          return {
            ok: true,
            currentSeq: 2,
            events: [remoteEvent, ownEvent].filter((event) => (event.seq ?? 0) > afterSeq),
          }
        }

        override async fetchSnapshot(
          fileId: string,
          initialContent?: string,
          observedPath?: string,
        ): Promise<Uint8Array> {
          if (fileId === 'file-remote') {
            this.snapshotRequests.push({ fileId, initialContent, observedPath })
            return remote.exportSnapshot()
          }
          return super.fetchSnapshot(fileId, initialContent, observedPath)
        }
      }
      const transport = new OrderedCollisionTransport(ownEvent, ownCreated.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'unexpected-third-file',
        newOpId: () => 'op-suffixed-append',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('remote-file')
      expect(await readFile(join(root, 'shared-2.md'), 'utf8')).toBe('oneafter-kill')
      await expect(readFile(join(root, 'shared-3.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(engine.files()).toEqual(
        expect.arrayContaining([
          { fileId: 'file-remote', path: 'shared.md', contentKind: 'markdown' },
          { fileId: 'file-own', path: 'shared-2.md', contentKind: 'markdown' },
        ]),
      )
      expect(transport.serverText('file-own')).toBe('oneafter-kill')
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('merges a concurrent canonical edit with the post-crash local append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'crash-race.md'), 'base\nlocal-marker\n')
      const localFs = await createNodeFS(root)
      const nodeId = (await localFs.stat('crash-race.md'))!.nodeId
      const canonical = LoroFileDoc.empty('base\n')
      const createVersion = canonical.contentVersion()
      canonical.setTextContent('base\nremote-marker\n')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-crash-race', 'crash-race.md', 'base\n', nodeId),
      ])
      const event: WireWorkspaceEvent = {
        ...markdownCreateEvent('file-crash-race', 'crash-race.md', 'base\n', {
          contentVersionB64: bytesToBase64(createVersion),
        }),
        originDeviceId: 'device-test',
      }
      const transport = new CreateReplayTransport(event, canonical.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'unexpected-suffix-file',
        newOpId: () => 'op-raced-append',
      })

      await engine.start()
      await engine.runCycle()

      const disk = await readFile(join(root, 'crash-race.md'), 'utf8')
      const server = transport.serverText('file-crash-race')!
      for (const text of [disk, server, engine.getText('file-crash-race')!]) {
        expect(text).toContain('remote-marker')
        expect(text).toContain('local-marker')
      }
      expect(disk).toBe(server)
      await expect(readFile(join(root, 'crash-race-2.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an empty create-time version as valid replay proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'empty.md'), 'written-after-kill')
      const localFs = await createNodeFS(root)
      const nodeId = (await localFs.stat('empty.md'))!.nodeId
      const created = LoroFileDoc.empty('')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [pendingMarkdownCreate('file-empty', 'empty.md', '', nodeId)])
      const event: WireWorkspaceEvent = {
        ...markdownCreateEvent('file-empty', 'empty.md', '', { contentVersionB64: '' }),
        originDeviceId: 'device-test',
      }
      const transport = new CreateReplayTransport(event, created.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'unexpected-suffix-file',
        newOpId: () => 'op-empty-edit',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'empty.md'), 'utf8')).toBe('written-after-kill')
      expect(transport.serverText('file-empty')).toBe('written-after-kill')
      await expect(readFile(join(root, 'empty-2.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses canonical bytes without inception merge when legacy proof is missing and disk is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'legacy.md'), 'base\n')
      const localFs = await createNodeFS(root)
      const nodeId = (await localFs.stat('legacy.md'))!.nodeId
      const canonical = LoroFileDoc.empty('base\n')
      canonical.setTextContent('base\nremote-marker\n')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-legacy', 'legacy.md', 'base\n', nodeId),
      ])
      // Legacy event: no create-time VV, while canonical has advanced.
      const event = markdownCreateEvent('file-legacy', 'legacy.md', 'base\n')
      const transport = new CreateReplayTransport(event, canonical.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'unexpected-suffix-file',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'legacy.md'), 'utf8')).toBe('base\nremote-marker\n')
      await expect(readFile(join(root, 'legacy-2.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(engine.getText('file-legacy')).toBe('base\nremote-marker\n')
      expect(transport.serverText('file-legacy')).toBe('base\nremote-marker\n')
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves an edit that lands during legacy create snapshot fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'fetch-race.md'), 'base\n')
      const localFs = await createNodeFS(root)
      const nodeId = (await localFs.stat('fetch-race.md'))!.nodeId
      const canonical = LoroFileDoc.empty('base\n')
      canonical.setTextContent('base\nremote-marker\n')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-fetch-race', 'fetch-race.md', 'base\n', nodeId),
      ])
      const event = markdownCreateEvent('file-fetch-race', 'fetch-race.md', 'base\n')
      class EditDuringFetchTransport extends CreateReplayTransport {
        edited = false

        override async fetchSnapshot(
          fileId: string,
          initialContent?: string,
          observedPath?: string,
        ): Promise<Uint8Array> {
          const snapshot = await super.fetchSnapshot(fileId, initialContent, observedPath)
          if (!this.edited && fileId === 'file-fetch-race') {
            this.edited = true
            await writeFile(join(root, 'fetch-race.md'), 'base\nlocal-marker\n')
          }
          return snapshot
        }
      }
      const transport = new EditDuringFetchTransport(event, canonical.exportShallowSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'file-fetch-race-local',
        newOpId: () => 'op-fetch-race',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'fetch-race.md'), 'utf8')).toBe('base\nremote-marker\n')
      expect(await readFile(join(root, 'fetch-race-2.md'), 'utf8')).toBe('base\nlocal-marker\n')
      expect(transport.serverText('file-fetch-race')).toBe('base\nremote-marker\n')
      expect(transport.serverText('file-fetch-race-local')).toBe('base\nlocal-marker\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleanly binds unchanged staged bytes when the create event was pruned and canonical advanced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'pruned-clean.md'), 'base\n')
      const localFs = await createNodeFS(root)
      const nodeId = (await localFs.stat('pruned-clean.md'))!.nodeId
      const canonical = LoroFileDoc.empty('base\n')
      canonical.setTextContent('base\nremote-marker\n')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-pruned-clean', 'pruned-clean.md', 'base\n', nodeId),
      ])
      const event = markdownCreateEvent(
        'file-pruned-clean',
        'pruned-clean.md',
        'base\nremote-marker\n',
        { seq: 8, entry: { version: 2, modifiedBy: 'other-user', modifiedAt: 2 } },
      )
      const transport = new PrunedCreateTransport(event, canonical.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'unexpected-suffix-file',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'pruned-clean.md'), 'utf8')).toBe('base\nremote-marker\n')
      await expect(readFile(join(root, 'pruned-clean-2.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(engine.files()).toEqual([
        {
          fileId: 'file-pruned-clean',
          path: 'pruned-clean.md',
          contentKind: 'markdown',
        },
      ])
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('suffixes conservatively when replay proof is legacy, malformed, or pruned', async () => {
    const full = LoroFileDoc.empty('server-base')
    const createVersion = full.contentVersion()
    full.setTextContent('server-new')
    const scenarios: {
      name: string
      contentVersionB64: string | undefined
      canonicalSnapshot: Uint8Array
      canonicalText: string
    }[] = [
      {
        name: 'legacy-missing',
        contentVersionB64: undefined,
        canonicalSnapshot: LoroFileDoc.empty('server-base').exportSnapshot(),
        canonicalText: 'server-base',
      },
      {
        name: 'malformed',
        contentVersionB64: '%%%not-base64%%%',
        canonicalSnapshot: LoroFileDoc.empty('server-base').exportSnapshot(),
        canonicalText: 'server-base',
      },
      {
        // Structurally valid and dominated, but it materializes empty text,
        // not the nonempty bytes stamped into the create entry.
        name: 'wrong-valid-version',
        contentVersionB64: '',
        canonicalSnapshot: LoroFileDoc.empty('server-base').exportSnapshot(),
        canonicalText: 'server-base',
      },
      {
        name: 'history-pruned',
        contentVersionB64: bytesToBase64(createVersion),
        canonicalSnapshot: full.exportShallowSnapshot(),
        canonicalText: 'server-new',
      },
    ]

    for (const scenario of scenarios) {
      const root = await mkdtemp(join(tmpdir(), `glovebox-sync-engine-${scenario.name}-`))
      try {
        await writeFile(join(root, '.glovebox.json'), '{}\n')
        await writeFile(join(root, 'shared.md'), 'local-unrelated')
        const localFs = await createNodeFS(root)
        const nodeId = (await localFs.stat('shared.md'))!.nodeId
        const storage = new MemoryDaemonStorage()
        await seedPendingState(storage, [
          pendingMarkdownCreate(`file-${scenario.name}`, 'shared.md', 'server-base', nodeId),
        ])
        const event: WireWorkspaceEvent = {
          ...markdownCreateEvent(`file-${scenario.name}`, 'shared.md', 'server-base', {
            contentVersionB64: scenario.contentVersionB64,
          }),
          originDeviceId: 'device-test',
        }
        const transport = new CreateReplayTransport(event, scenario.canonicalSnapshot)
        const engine = crashEngine({
          fs: localFs,
          storage,
          transport,
          newFileId: () => `local-${scenario.name}`,
          newOpId: () => `op-${scenario.name}`,
        })

        await engine.start()
        await engine.runCycle()

        expect(await readFile(join(root, 'shared.md'), 'utf8'), scenario.name).toBe(
          scenario.canonicalText,
        )
        expect(await readFile(join(root, 'shared-2.md'), 'utf8'), scenario.name).toBe(
          'local-unrelated',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('keeps suffix isolation for a spoofed same-device create without a local intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'shared.md'), 'local-unrelated')
      const remote = LoroFileDoc.empty('remote-file')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [])
      const event: WireWorkspaceEvent = {
        ...markdownCreateEvent('file-remote', 'shared.md', 'remote-file', {
          contentVersionB64: bytesToBase64(remote.contentVersion()),
          entry: { modifiedBy: 'other-user' },
        }),
        // Origin is client-controlled and therefore deliberately irrelevant.
        originDeviceId: 'device-test',
      }
      const transport = new CreateReplayTransport(event, remote.exportSnapshot())
      const engine = crashEngine({
        fs: await createNodeFS(root),
        storage,
        transport,
        newFileId: () => 'file-local-suffix',
        newOpId: () => 'op-local-suffix',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('remote-file')
      expect(await readFile(join(root, 'shared-2.md'), 'utf8')).toBe('local-unrelated')
      expect(engine.files()).toEqual(
        expect.arrayContaining([
          { fileId: 'file-remote', path: 'shared.md', contentKind: 'markdown' },
          { fileId: 'file-local-suffix', path: 'shared-2.md', contentKind: 'markdown' },
        ]),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('suffixes a same-path replacement whose inode differs from the staged create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'shared.md'), 'one')
      const localFs = await createNodeFS(root)
      const stagedNodeId = (await localFs.stat('shared.md'))!.nodeId
      await writeFile(join(root, 'replacement.tmp'), 'unrelated replacement')
      await rename(join(root, 'replacement.tmp'), join(root, 'shared.md'))
      expect((await localFs.stat('shared.md'))!.nodeId).not.toBe(stagedNodeId)

      const created = LoroFileDoc.empty('one')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-original', 'shared.md', 'one', stagedNodeId),
      ])
      const event: WireWorkspaceEvent = {
        ...markdownCreateEvent('file-original', 'shared.md', 'one', {
          contentVersionB64: bytesToBase64(created.contentVersion()),
        }),
        originDeviceId: 'device-test',
      }
      const transport = new CreateReplayTransport(event, created.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'file-replacement',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('one')
      expect(await readFile(join(root, 'shared-2.md'), 'utf8')).toBe('unrelated replacement')
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reconciles a pruned create with a replaced inode and tracks both preserved rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'shared.md'), 'one')
      const localFs = await createNodeFS(root)
      const stagedNodeId = (await localFs.stat('shared.md'))!.nodeId
      await writeFile(join(root, 'replacement.tmp'), 'unrelated replacement')
      await rename(join(root, 'replacement.tmp'), join(root, 'shared.md'))

      const created = LoroFileDoc.empty('one')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-original', 'shared.md', 'one', stagedNodeId),
      ])
      const event = markdownCreateEvent('file-original', 'shared.md', 'one', { seq: 9 })
      const transport = new PrunedCreateTransport(event, created.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'file-replacement',
      })

      await engine.start()
      await engine.runCycle()
      await engine.runCycle()

      expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('one')
      expect(await readFile(join(root, 'shared-2.md'), 'utf8')).toBe('unrelated replacement')
      expect(engine.files()).toEqual(
        expect.arrayContaining([
          { fileId: 'file-original', path: 'shared.md', contentKind: 'markdown' },
          {
            fileId: 'file-replacement',
            path: 'shared-2.md',
            contentKind: 'markdown',
          },
        ]),
      )
      expect(transport.serverText('file-original')).toBe('one')
      expect(transport.serverText('file-replacement')).toBe('unrelated replacement')
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finishes a journaled collision move when the create event replays after another crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'shared-2.md'), 'unrelated replacement')
      const localFs = await createNodeFS(root)
      const isolated = await localFs.stat('shared-2.md')
      const created = LoroFileDoc.empty('one')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-original', 'shared.md', 'one', 'staged-inode', {
          collision: {
            path: 'shared.md',
            isolatedPath: 'shared-2.md',
            contentHash: sha256Hex('unrelated replacement'),
            nodeId: isolated!.nodeId,
            sizeBytes: 21,
          },
        }),
      ])
      const event = markdownCreateEvent('file-original', 'shared.md', 'one', {
        contentVersionB64: bytesToBase64(created.contentVersion()),
      })
      const transport = new CreateReplayTransport(event, created.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'file-replacement',
      })

      await engine.start()
      await engine.runCycle()

      expect(await readFile(join(root, 'shared.md'), 'utf8')).toBe('one')
      expect(await readFile(join(root, 'shared-2.md'), 'utf8')).toBe('unrelated replacement')
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds an absent pruned create without resurrecting it and opens normal delete intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const canonical = LoroFileDoc.empty('base\n')
      canonical.setTextContent('base\nremote-marker\n')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-absent', 'absent.md', 'base\n', 'old-inode'),
      ])
      const event = markdownCreateEvent('file-absent', 'absent.md', 'base\nremote-marker\n', {
        seq: 5,
        entry: { version: 2, modifiedBy: 'other-user', modifiedAt: 2 },
      })
      const transport = new PrunedCreateTransport(event, canonical.exportSnapshot())
      const engine = crashEngine({
        fs: await createNodeFS(root),
        storage,
        transport,
        newOpId: () => 'delete-absent',
      })

      await engine.start()
      await engine.runCycle()

      await expect(readFile(join(root, 'absent.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(engine.files()).toContainEqual({
        fileId: 'file-absent',
        path: 'absent.md',
        contentKind: 'markdown',
      })
      const state = await decodeState(storage)
      expect(state.pendingCreates).toEqual([])
      expect(state.pendingDeletes).toMatchObject([{ fileId: 'file-absent', path: 'absent.md' }])
      expect(transport.serverText('file-absent')).toBe('base\nremote-marker\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a zero-view pending create frozen when the mount sentinel is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-mounted', 'mounted.md', 'mounted', 'volume-inode'),
      ])
      const engine = crashEngine({
        fs: await createNodeFS(root),
        storage,
        transport: new FakeTransport(),
      })

      await engine.start()
      await engine.runCycle()

      expect(engine.mountSuspect()).toBe(true)
      await expect(readFile(join(root, '.glovebox.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect((await decodeState(storage)).pendingCreates).toMatchObject([
        { fileId: 'file-mounted', path: 'mounted.md' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('suffixes divergent local bytes when the create event and exact base were pruned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'window-miss.md'), 'base\n')
      const localFs = await createNodeFS(root)
      const stagedNodeId = (await localFs.stat('window-miss.md'))!.nodeId
      await writeFile(join(root, 'window-miss.md'), 'base\nlocal-marker\n')

      const canonical = LoroFileDoc.empty('base\n')
      canonical.setTextContent('base\nremote-marker\n')
      const storage = new MemoryDaemonStorage()
      await seedPendingState(storage, [
        pendingMarkdownCreate('file-window-miss', 'window-miss.md', 'base\n', stagedNodeId),
      ])
      const event: WireWorkspaceEvent = {
        type: 'create',
        fileId: 'file-window-miss',
        path: 'window-miss.md',
        seq: 1,
      }
      class NoReplayTransport extends CreateReplayTransport {
        override async eventsSince(): Promise<EventsSinceResult> {
          return { ok: true, currentSeq: 1, events: [] }
        }
      }
      const transport = new NoReplayTransport(event, canonical.exportSnapshot())
      const engine = crashEngine({
        fs: localFs,
        storage,
        transport,
        newFileId: () => 'file-local-suffix',
      })

      await engine.start()
      await engine.runCycle()
      await engine.runCycle() // register the preserved suffix under a new identity

      const canonicalText = 'base\nremote-marker\n'
      const localText = 'base\nlocal-marker\n'
      expect(await readFile(join(root, 'window-miss.md'), 'utf8')).toBe(canonicalText)
      expect(await readFile(join(root, 'window-miss-2.md'), 'utf8')).toBe(localText)
      expect(transport.serverText('file-window-miss')).toBe(canonicalText)
      expect(transport.serverText('file-local-suffix')).toBe(localText)
      expect((await decodeState(storage)).pendingCreates).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

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

  it('isolates a failed rename and keeps it pending without losing the move (scan.rename)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, 'note.md'), 'hello')

      // Throw the first time the pending-rename record is persisted (its JSON
      // is the only state write carrying a `fromPath`), then heal.
      class FailRenamePersistOnce extends MemoryDaemonStorage {
        armed = false
        async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
          if (
            this.armed &&
            name === STATE_ARTIFACT &&
            new TextDecoder().decode(bytes).includes('"fromPath"')
          ) {
            this.armed = false
            throw new Error('pending-rename write failed')
          }
          await super.writeAtomic(name, bytes)
        }
      }
      const storage = new FailRenamePersistOnce()
      const transport = new FakeTransport()
      const warnings: DaemonSyncWarning[] = []
      const ids = ['file-note', 'file-asset']
      let op = 0
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport,
        newFileId: () => ids.shift() ?? `file-extra-${ids.length}`,
        newOpId: () => `op-${++op}`,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()
      await engine.runCycle() // adopt + create note.md

      // Move note.md and drop a new opaque file in the same cycle; poison the
      // rename record's persist so the rename op throws.
      await rename(join(root, 'note.md'), join(root, 'renamed.md'))
      await writeFile(join(root, 'asset.bin'), new Uint8Array([1, 2, 3]))
      storage.armed = true
      await engine.runCycle()

      // AC-A: the rename failure did not abort the cycle — the opaque file synced.
      expect(transport.opaqueSubmits.map((submit) => submit.observedPath)).toContain('asset.bin')
      // AC-B: the failure is logged once with path + reason.
      expect(warnings).toContainEqual({
        type: 'file-operation-failed',
        phase: 'scan.rename',
        fileId: 'file-note',
        path: 'renamed.md',
        reason: 'pending-rename write failed',
      })

      // The move is not lost: the in-memory rename op still propagates this
      // cycle and the view converges onto the new path; a follow-up cycle keeps
      // it there (the store catches up once the transient write heals).
      await engine.runCycle()
      expect(engine.files()).toContainEqual({
        fileId: 'file-note',
        path: 'renamed.md',
        contentKind: 'markdown',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates a failed content-change persist and never corrupts a later edit (scan.content-change)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, 'poisoned.md'), 'v1')
      await writeFile(join(root, 'healthy.md'), 'h1')

      // Throw the first time the poisoned file's Loro envelope is persisted
      // (persistMarkdownFile writes the per-file envelope before the shared
      // state blob), then heal — isolating the failure to one file.
      class FailEnvelopeOnce extends MemoryDaemonStorage {
        failEnvelope: string | null = null
        async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
          if (this.failEnvelope !== null && name === this.failEnvelope) {
            this.failEnvelope = null
            throw new Error('markdown persist failed')
          }
          await super.writeAtomic(name, bytes)
        }
      }
      const storage = new FailEnvelopeOnce()
      const transport = new FakeTransport()
      const warnings: DaemonSyncWarning[] = []
      let id = 0
      let op = 0
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport,
        newFileId: () => `file-${++id}`,
        newOpId: () => `op-${++op}`,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()
      await engine.runCycle() // create both markdown files

      const poisonedId = engine.files().find((file) => file.path === 'poisoned.md')!.fileId

      // Edit both files, add an opaque file, and poison the persist of one edit.
      await writeFile(join(root, 'poisoned.md'), 'v2')
      await writeFile(join(root, 'healthy.md'), 'h2')
      await writeFile(join(root, 'asset.bin'), new Uint8Array([9, 9, 9]))
      storage.failEnvelope = envelopeName(poisonedId)
      await engine.runCycle()

      // AC-A: the failed content-change did not abort the cycle — the healthy
      // markdown push and the opaque submit both completed.
      const healthyId = engine.files().find((file) => file.path === 'healthy.md')!.fileId
      expect(transport.submittedUpdates).toContain(healthyId)
      expect(transport.opaqueSubmits.map((submit) => submit.observedPath)).toContain('asset.bin')
      // AC-A: the failure is logged once with path + reason.
      expect(warnings).toContainEqual({
        type: 'file-operation-failed',
        phase: 'scan.content-change',
        fileId: poisonedId,
        path: 'poisoned.md',
        reason: 'markdown persist failed',
      })

      // The edit is not rolled back: its ops still flush to the server this
      // cycle and the durable watermark catches up on the same cycle's push.
      const hashV2 = sha256Hex(new TextEncoder().encode('v2'))
      expect(transport.submittedUpdates).toContain(poisonedId)
      expect((await decodeState(storage)).files[poisonedId]!.lastWrittenHash).toBe(hashV2)

      // Regression: a NEW edit after the failed persist must converge cleanly.
      // Rewinding the in-memory watermark on the persist failure would re-fork
      // this edit off the stale base and duplicate the text (e.g. "v23").
      await writeFile(join(root, 'poisoned.md'), 'v3')
      await engine.runCycle()
      expect(engine.getText(poisonedId)).toBe('v3')
      const hashV3 = sha256Hex(new TextEncoder().encode('v3'))
      expect((await decodeState(storage)).files[poisonedId]!.lastWrittenHash).toBe(hashV3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('isolates a failed opaque persist after a successful submit (push opaque)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, 'asset.bin'), new Uint8Array([1, 2, 3]))
      await writeFile(join(root, 'keep.md'), 'k1')

      // The new opaque hash only reaches the state blob via #pushOpaque's own
      // persist (the scan-time meta roll still carries the OLD hash), so throw
      // on the write that carries it — the post-submit, post-ack persist.
      const newHash = sha256Hex(new Uint8Array([4, 5, 6]))
      class FailOpaquePersistOnce extends MemoryDaemonStorage {
        armed = false
        async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
          if (
            this.armed &&
            name === STATE_ARTIFACT &&
            new TextDecoder().decode(bytes).includes(newHash)
          ) {
            this.armed = false
            throw new Error('opaque persist failed')
          }
          await super.writeAtomic(name, bytes)
        }
      }
      const storage = new FailOpaquePersistOnce()
      const transport = new FakeTransport()
      const warnings: DaemonSyncWarning[] = []
      let id = 0
      let op = 0
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport,
        newFileId: () => `file-${++id}`,
        newOpId: () => `op-${++op}`,
        onWarning: (warning) => warnings.push(warning),
      })

      await engine.start()
      await engine.runCycle() // create asset.bin + keep.md

      const assetId = engine.files().find((file) => file.path === 'asset.bin')!.fileId
      const keepId = engine.files().find((file) => file.path === 'keep.md')!.fileId

      // Change the opaque bytes (so #pushOpaque re-submits) and edit the
      // markdown sibling; poison only the opaque persist that follows the ack.
      await writeFile(join(root, 'asset.bin'), new Uint8Array([4, 5, 6]))
      await writeFile(join(root, 'keep.md'), 'k2')
      storage.armed = true

      // AC-A: the opaque persist failure must NOT abort the cycle.
      await expect(engine.runCycle()).resolves.toBeUndefined()
      expect(transport.opaqueSubmits.map((submit) => submit.observedPath)).toContain('asset.bin')
      expect(transport.submittedUpdates).toContain(keepId)
      expect(warnings).toContainEqual({
        type: 'opaque-submit-failed',
        fileId: assetId,
        path: 'asset.bin',
        reason: 'opaque persist failed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function decodeState(storage: MemoryDaemonStorage): Promise<DaemonWorkspaceState> {
  const bytes = await storage.read(STATE_ARTIFACT)
  return JSON.parse(new TextDecoder().decode(bytes!)) as DaemonWorkspaceState
}

describe('DaemonSyncEngine delete holds and resolution', () => {
  it('treats schema-invalid nested state as fresh on start instead of crashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      const storage = new MemoryDaemonStorage()
      // Top-level shape is valid, but the nested entries are invalid: a null
      // file value (would crash reconcile on fileState.contentKind), a file
      // missing its watermark fields (would hydrate a view with an undefined
      // lastWrittenHash), and a pending delete missing opId/baseSeq (would
      // build a submitBatch op with undefined identifiers). The deep gate makes
      // load() fall back to fresh instead.
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson({
          workspaceId: 'ws-test',
          mountId: 'mount-test',
          deviceId: 'device-test',
          lastAckedSeq: 0,
          files: {
            'f-null': null,
            'f-partial': { path: 'p.md', contentKind: 'markdown' },
          },
          pendingRenames: [],
          pendingDeletes: [{ fileId: 'f-x', path: 'x.md', observedMissingAtMs: 1 }],
        }),
      )
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage,
        transport: new FakeTransport(),
        now: () => 1_000_000,
      })

      await expect(engine.start()).resolves.toBeUndefined()
      expect(engine.files()).toEqual([])
      expect(engine.pendingDeletes()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-warns a genuinely new bulk hold of a file that was previously held then cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      // Sentinel present so the mount is never suspect (which would freeze
      // delete processing). Two opaque files so a low-threshold bulk-window
      // guard trips on their disappearance.
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      await writeFile(join(root, 'a.bin'), new Uint8Array([1, 2, 3]))
      await writeFile(join(root, 'b.bin'), new Uint8Array([4, 5, 6]))
      const T0 = 1_000_000
      const warnings: DaemonSyncWarning[] = []
      const engine = new DaemonSyncEngine({
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        fs: await createNodeFS(root),
        storage: new MemoryDaemonStorage(),
        transport: new FakeTransport(),
        now: () => T0,
        deletePolicy: { bulkMinCount: 2, bulkRatioFloor: 2, bulkRatio: 0.5 },
        onWarning: (warning) => warnings.push(warning),
      })
      const heldWarnings = () => warnings.filter((w) => w.type === 'delete-intents-held')

      await engine.start()
      await engine.runCycle() // register + opaque-submit both files
      await engine.runCycle() // settle (watermarks now non-empty)

      // First bulk delete → both held by the window guard → one warning.
      await rm(join(root, 'a.bin'))
      await rm(join(root, 'b.bin'))
      await engine.runCycle()
      expect(engine.pendingDeletes().map((i) => i.held)).toEqual(['bulk-window', 'bulk-window'])
      expect(heldWarnings()).toHaveLength(1)

      // Files reappear (transient absence) → intents canceled, dedup keys pruned.
      await writeFile(join(root, 'a.bin'), new Uint8Array([1, 2, 3]))
      await writeFile(join(root, 'b.bin'), new Uint8Array([4, 5, 6]))
      await engine.runCycle()
      expect(engine.pendingDeletes()).toEqual([])

      // A genuinely new bulk delete of the SAME files must warn AGAIN — before
      // the fix the stale `bulk-window:<fileId>` keys suppressed this.
      await rm(join(root, 'a.bin'))
      await rm(join(root, 'b.bin'))
      await engine.runCycle()
      expect(engine.pendingDeletes().map((i) => i.held)).toEqual(['bulk-window', 'bulk-window'])
      expect(heldWarnings()).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
        deleteResolutionName('cmd-1'),
        encodeJson({ id: 'cmd-1', action: 'confirm', fileIds: ['f-held'], createdAt: T0 }),
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
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([])
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
        deleteResolutionName('cmd-1'),
        encodeJson({ id: 'cmd-1', action: 'restore', fileIds: ['f-held'], createdAt: T0 }),
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

  it('does not schedule a wake for an already-ripe unheld delete (avoids the 1s busy-loop)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      // Unheld delete whose 30s tombstone is already well in the past.
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 60_000, held: undefined })),
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

      // A past-due delete must not pin the runner to its 1s wake floor.
      expect(engine.nextWakeMs(T0)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a restore command for a file that is not pending-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      const state: DaemonWorkspaceState = {
        workspaceId: 'ws-test',
        mountId: 'mount-test',
        deviceId: 'device-test',
        lastAckedSeq: 7,
        files: {
          'f-live': {
            path: 'live.md',
            contentKind: 'markdown',
            nodeId: '0:1',
            syncedVVB64: '',
            lastWrittenHash: 'live-hash',
            sizeBytes: 5,
            savedAt: T0,
          },
        },
        pendingRenames: [],
        pendingDeletes: [],
      }
      await storage.writeAtomic(STATE_ARTIFACT, encodeJson(state))
      await storage.writeAtomic(
        deleteResolutionName('cmd-1'),
        encodeJson({ id: 'cmd-1', action: 'restore', fileIds: ['f-live'], createdAt: T0 }),
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

      // A stale/duplicate restore for a live file must not wipe its watermark
      // (which would force a resurrect-checkout over it); the command is still
      // consumed.
      const after = JSON.parse(
        new TextDecoder().decode((await storage.read(STATE_ARTIFACT))!),
      ) as DaemonWorkspaceState
      expect(after.files['f-live']!.lastWrittenHash).toBe('live-hash')
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-applies a confirm command idempotently after a crash before the queue is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 31_000, held: 'bulk-window' })),
      )
      const command = encodeJson({
        id: 'cmd-1',
        action: 'confirm',
        fileIds: ['f-held'],
        createdAt: T0,
      })
      await storage.writeAtomic(deleteResolutionName('cmd-1'), command)
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
      // Simulate a crash that committed state but left the command file on
      // disk: it is re-read on the next cycle and must be a safe no-op.
      await storage.writeAtomic(deleteResolutionName('cmd-1'), command)
      await engine.runCycle()

      expect(engine.pendingDeletes()).toEqual([])
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a command pending when the resolution state commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      class FailOnceStateStorage extends MemoryDaemonStorage {
        failNextStateWrite = false
        async writeAtomic(name: string, bytes: Uint8Array): Promise<void> {
          if (this.failNextStateWrite && name === STATE_ARTIFACT) {
            this.failNextStateWrite = false
            throw new Error('state write failed')
          }
          await super.writeAtomic(name, bytes)
        }
      }
      const storage = new FailOnceStateStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 31_000, held: 'bulk-window' })),
      )
      await storage.writeAtomic(
        deleteResolutionName('cmd-1'),
        encodeJson({ id: 'cmd-1', action: 'restore', fileIds: ['f-held'], createdAt: T0 }),
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
      storage.failNextStateWrite = true
      await expect(engine.runCycle()).rejects.toThrow(/state write failed/)
      expect(engine.pendingDeletes()).toHaveLength(1)
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([deleteResolutionName('cmd-1')])

      await engine.runCycle()
      const after = JSON.parse(
        new TextDecoder().decode((await storage.read(STATE_ARTIFACT))!),
      ) as DaemonWorkspaceState
      expect(after.pendingDeletes).toEqual([])
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not drop a command enqueued during the daemon drain (race-safe)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      // Storage that injects a second command file the instant the daemon
      // snapshots the spool dir — i.e. a concurrent CLI enqueue landing
      // between the daemon's list() and its per-file deletes.
      class RacingStorage extends MemoryDaemonStorage {
        injection: { name: string; bytes: Uint8Array } | null = null
        async list(prefix?: string): Promise<string[]> {
          const names = await super.list(prefix)
          if (this.injection && prefix === DELETE_RESOLUTION_DIR) {
            await super.writeAtomic(this.injection.name, this.injection.bytes)
            this.injection = null
          }
          return names
        }
      }
      const storage = new RacingStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 31_000, held: 'bulk-window' })),
      )
      await storage.writeAtomic(
        deleteResolutionName('cmd-1'),
        encodeJson({ id: 'cmd-1', action: 'confirm', fileIds: ['f-held'], createdAt: T0 }),
      )
      storage.injection = {
        name: deleteResolutionName('cmd-2'),
        bytes: encodeJson({ id: 'cmd-2', action: 'confirm', fileIds: ['f-held'], createdAt: T0 }),
      }
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
      // cmd-1 was applied and its file removed; cmd-2 — written during the
      // drain — was NOT dropped and survives for the next cycle.
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([deleteResolutionName('cmd-2')])

      await engine.runCycle()
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops a resolution command with an unrecognized action and warns instead of silently consuming it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glovebox-sync-engine-'))
    try {
      await writeFile(join(root, '.glovebox.json'), '{}\n')
      const T0 = 1_000_000
      const storage = new MemoryDaemonStorage()
      await storage.writeAtomic(
        STATE_ARTIFACT,
        encodeJson(deleteState({ observedAt: T0 - 31_000, held: 'bulk-window' })),
      )
      // A schema-drifted command whose action we cannot apply, queued alongside
      // a valid one. The bad command must be surfaced, not silently consumed.
      await storage.writeAtomic(
        deleteResolutionName('cmd-bad'),
        encodeJson({ id: 'cmd-bad', action: 'purge', fileIds: ['f-held'], createdAt: T0 }),
      )
      await storage.writeAtomic(
        deleteResolutionName('cmd-ok'),
        encodeJson({ id: 'cmd-ok', action: 'restore', fileIds: ['f-held'], createdAt: T0 + 1 }),
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
      await engine.runCycle()

      // The unrecognized command surfaced a warning (not silently lost), and the
      // whole spool drained — the bad command did not wedge the queue.
      expect(warnings).toContainEqual({
        type: 'delete-resolution-invalid',
        name: deleteResolutionName('cmd-bad'),
      })
      expect(await storage.list(DELETE_RESOLUTION_DIR)).toEqual([])
      // The valid command still applied: restore removed the held intent.
      const after = JSON.parse(
        new TextDecoder().decode((await storage.read(STATE_ARTIFACT))!),
      ) as DaemonWorkspaceState
      expect(after.pendingDeletes).toEqual([])
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
