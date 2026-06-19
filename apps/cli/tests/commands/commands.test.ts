import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyWorkspaceToken } from '@glovebox.md/sync/server'
import { LoroFileDoc, bytesToBase64 } from '@glovebox.md/sync/loro'
import {
  DELETE_RESOLUTION_ARTIFACT,
  NodeDaemonStorage,
  STATE_ARTIFACT,
  envelopeName,
  type DaemonWorkspaceState,
} from '@glovebox.md/sync/daemon'
import { gloveboxPaths } from '../../src/lib/paths.ts'
import { acquireLock } from '../../src/lib/lockfile.ts'
import { runMount } from '../../src/commands/mount.ts'
import { runList } from '../../src/commands/list.ts'
import { resolveWorkspaceSocketToken } from '../../src/commands/run.ts'
import { runStatus } from '../../src/commands/status.ts'
import { runSyncDeletes } from '../../src/commands/sync.ts'
import { runUnmount } from '../../src/commands/unmount.ts'
import authCommand, {
  runDeviceLoginWithClient,
  runLogin,
  runAuthToken,
  runLogout,
  runMintDev,
} from '../../src/commands/auth.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  // Canonicalize: macOS tmpdirs live behind the /var → /private/var symlink,
  // and the CLI stores realpaths.
  return realpath(dir)
}

async function fixture() {
  const home = await tempDir('glovebox-home-')
  const mountDir = await tempDir('glovebox-mount-')
  return { paths: gloveboxPaths({ GLOVEBOX_HOME: home }), mountDir }
}

describe('mount / list / unmount', () => {
  it('registers, lists, and unmounts a binding without touching user files', async () => {
    const { paths, mountDir } = await fixture()
    await writeFile(join(mountDir, 'precious.md'), 'user bytes\n')

    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    expect(entry.dir).toBe(mountDir)
    expect(entry.mountId).not.toBe(entry.deviceId)

    const listed = await runList({ paths })
    expect(listed.mounts).toHaveLength(1)
    expect(listed.mounts[0]).toMatchObject({ workspaceId: 'ws-1', daemon: 'stopped', pid: null })

    // Simulate daemon leftovers that unmount must clean up.
    const storage = new NodeDaemonStorage(paths.stateDir(entry.mountId))
    await storage.writeAtomic(STATE_ARTIFACT, new TextEncoder().encode('{}'))
    await writeFile(join(mountDir, '.glovebox.json'), '{"workspaceId":"ws-1"}\n')

    const removed = await runUnmount(mountDir, { paths })
    expect(removed.mountId).toBe(entry.mountId)
    expect((await runList({ paths })).mounts).toHaveLength(0)
    await expect(stat(paths.stateDir(entry.mountId))).rejects.toThrow()
    await expect(stat(join(mountDir, '.glovebox.json'))).rejects.toThrow()
    // User files survive.
    expect(await stat(join(mountDir, 'precious.md'))).toBeTruthy()
  })

  it('mount creates the directory and refuses overlapping bindings', async () => {
    const { paths, mountDir } = await fixture()
    const fresh = join(mountDir, 'new/deep/dir')
    const entry = await runMount(fresh, { workspace: 'ws-2', paths })
    expect((await stat(entry.dir)).isDirectory()).toBe(true)

    await expect(runMount(join(fresh, 'nested'), { workspace: 'ws-3', paths })).rejects.toThrow(
      /overlaps/,
    )
    await expect(runMount(fresh, { workspace: 'ws-3', paths })).rejects.toThrow(/already mounted/)
  })

  it('unmount refuses while a daemon holds the lock', async () => {
    const { paths, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    const lock = await acquireLock(paths, entry.mountId)

    await expect(runUnmount(mountDir, { paths })).rejects.toThrow(/running daemon/)
    await lock.release()
    await runUnmount(mountDir, { paths })
  })

  it('unmount honors a sentinelPath override (the daemon wrote it there)', async () => {
    const { paths, mountDir } = await fixture()
    await runMount(mountDir, { workspace: 'ws-1', paths })
    await writeFile(join(mountDir, '.custom-sentinel.json'), '{"workspaceId":"ws-1"}\n')

    await runUnmount(mountDir, {
      paths,
      env: { GLOVEBOX_SYNC_OVERRIDES: '{"deletePolicy":{"sentinelPath":".custom-sentinel.json"}}' },
    })
    await expect(stat(join(mountDir, '.custom-sentinel.json'))).rejects.toThrow()
  })
})

describe('status', () => {
  it('reports a registered-but-never-run mount as not adopted', async () => {
    const { paths, mountDir } = await fixture()
    await runMount(mountDir, { workspace: 'ws-1', paths })

    const result = await runStatus(mountDir, { paths, env: {} })
    expect(result.adopted).toBe(false)
    expect(result.daemon.running).toBe(false)
    expect(result.mountSuspect).toBe(false)
    expect(result.trackedFiles).toBeNull()
  })

  it('reads the state artifact directly: cursor, pending pushes, INV-3 stack', async () => {
    const { paths, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    await writeFile(join(mountDir, '.glovebox.json'), '{"workspaceId":"ws-1"}\n')

    const storage = new NodeDaemonStorage(paths.stateDir(entry.mountId))

    // f-synced: doc fully acked. f-pending: edits past the watermark.
    const syncedDoc = LoroFileDoc.empty('all acked\n')
    const pendingDoc = LoroFileDoc.empty('base\n')
    const pendingSyncedVV = pendingDoc.contentVersion()
    pendingDoc.setTextContent('base\nplus unacked\n')

    const T0 = 1_000_000
    const state: DaemonWorkspaceState = {
      workspaceId: 'ws-1',
      mountId: entry.mountId,
      deviceId: entry.deviceId,
      lastAckedSeq: 7,
      files: {
        'f-synced': {
          path: 'a.md',
          contentKind: 'markdown',
          nodeId: '0:1',
          syncedVVB64: bytesToBase64(syncedDoc.contentVersion()),
          lastWrittenHash: 'h1',
          sizeBytes: 10,
          savedAt: T0,
        },
        'f-pending': {
          path: 'b.md',
          contentKind: 'markdown',
          nodeId: '0:2',
          syncedVVB64: bytesToBase64(pendingSyncedVV),
          lastWrittenHash: 'h2',
          sizeBytes: 5,
          savedAt: T0,
        },
        'f-opaque': {
          path: 'pic.png',
          contentKind: 'opaque',
          nodeId: '0:3',
          syncedVVB64: '',
          lastWrittenHash: 'h3',
          sizeBytes: 99,
          opaqueHash: 'h3',
          savedAt: T0,
        },
      },
      pendingRenames: [
        { opId: 'r1', fileId: 'f-synced', fromPath: 'a.md', toPath: 'a2.md', baseSeq: 7 },
      ],
      pendingDeletes: [
        {
          opId: 'd1',
          fileId: 'f-doomed',
          path: 'doomed.md',
          baseSeq: 7,
          observedMissingAtMs: T0,
        },
        {
          opId: 'd2',
          fileId: 'f-held',
          path: 'held.md',
          baseSeq: 7,
          observedMissingAtMs: T0,
          held: 'bulk-window',
        },
      ],
    }
    const encoder = new TextEncoder()
    await storage.writeAtomic(STATE_ARTIFACT, encoder.encode(JSON.stringify(state)))
    await storage.writeAtomic(
      envelopeName('f-synced'),
      encoder.encode(
        JSON.stringify({
          fileId: 'f-synced',
          snapshotB64: bytesToBase64(syncedDoc.exportSnapshot()),
          syncedVVB64: bytesToBase64(syncedDoc.contentVersion()),
          savedAt: T0,
        }),
      ),
    )
    await storage.writeAtomic(
      envelopeName('f-pending'),
      encoder.encode(
        JSON.stringify({
          fileId: 'f-pending',
          snapshotB64: bytesToBase64(pendingDoc.exportSnapshot()),
          syncedVVB64: bytesToBase64(pendingSyncedVV),
          savedAt: T0,
        }),
      ),
    )

    // 10s after the absences were observed: 20s left on the 30s tombstone.
    const result = await runStatus(mountDir, { paths, env: {}, now: () => T0 + 10_000 })
    expect(result.adopted).toBe(true)
    expect(result.sentinelPresent).toBe(true)
    expect(result.mountSuspect).toBe(false)
    expect(result.lastAckedSeq).toBe(7)
    expect(result.trackedFiles).toBe(3)
    expect(result.pendingPushes).toBe(1)
    expect(result.pendingRenames).toBe(1)
    expect(result.heldDeleteIntents).toBe(1)
    expect(result.freeDeleteIntents).toBe(1)

    const byPath = new Map(result.deleteIntents.map((intent) => [intent.path, intent]))
    expect(byPath.get('doomed.md')).toMatchObject({
      held: null,
      msUntilPropagation: 20_000,
    })
    expect(byPath.get('held.md')).toMatchObject({
      held: 'bulk-window',
      msUntilPropagation: null,
    })

    // Tombstone override flows into the countdown (test/dev lever).
    const overridden = await runStatus(mountDir, {
      paths,
      env: { GLOVEBOX_SYNC_OVERRIDES: '{"deletePolicy":{"tombstoneDelayMs":12000}}' },
      now: () => T0 + 10_000,
    })
    expect(byPathOf(overridden).get('doomed.md')!.msUntilPropagation).toBe(2_000)

    // Sentinel gone on an adopted mount = suspect.
    await rm(join(mountDir, '.glovebox.json'))
    const suspect = await runStatus(mountDir, { paths, env: {}, now: () => T0 })
    expect(suspect.mountSuspect).toBe(true)
  })
})

describe('sync deletes', () => {
  it('lists held and free pending deletes', async () => {
    const { paths, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    const storage = new NodeDaemonStorage(paths.stateDir(entry.mountId))
    await storage.writeAtomic(
      STATE_ARTIFACT,
      new TextEncoder().encode(JSON.stringify(deleteState(entry.mountId, entry.deviceId))),
    )

    const result = await runSyncDeletes(mountDir, { paths, env: {} })

    expect(result.heldDeleteIntents).toBe(1)
    expect(result.freeDeleteIntents).toBe(1)
    expect(result.deleteIntents.map((intent) => [intent.path, intent.held])).toEqual([
      ['held.md', 'bulk-window'],
      ['free.md', null],
    ])
    expect(result.action).toBeNull()
  })

  it('confirms held deletes by clearing the hold and queuing a daemon wake command', async () => {
    const { paths, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    const storage = new NodeDaemonStorage(paths.stateDir(entry.mountId))
    await storage.writeAtomic(
      STATE_ARTIFACT,
      new TextEncoder().encode(JSON.stringify(deleteState(entry.mountId, entry.deviceId))),
    )

    const result = await runSyncDeletes(mountDir, {
      action: 'confirm',
      resolutionTarget: 'all',
      paths,
      env: {},
      signalDaemon: false,
      now: () => 123,
    })

    expect(result.action).toMatchObject({
      type: 'confirm',
      target: 'all',
      matched: 1,
      paths: ['held.md'],
      queued: true,
    })
    expect(result.heldDeleteIntents).toBe(0)
    expect(result.freeDeleteIntents).toBe(2)

    const state = JSON.parse(
      new TextDecoder().decode((await storage.read(STATE_ARTIFACT))!),
    ) as DaemonWorkspaceState
    const confirmed = state.pendingDeletes.find((intent) => intent.path === 'held.md')
    expect(confirmed?.held).toBeUndefined()
    expect(confirmed?.confirmedAtMs).toBe(123)

    const queue = JSON.parse(
      new TextDecoder().decode((await storage.read(DELETE_RESOLUTION_ARTIFACT))!),
    ) as { commands: { action: string; fileIds: string[]; createdAt: number }[] }
    expect(queue.commands).toEqual([
      { id: expect.any(String), action: 'confirm', fileIds: ['f-held'], createdAt: 123 },
    ])
  })

  it('restores held deletes by canceling the intent and authorizing checkout', async () => {
    const { paths, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    const storage = new NodeDaemonStorage(paths.stateDir(entry.mountId))
    await storage.writeAtomic(
      STATE_ARTIFACT,
      new TextEncoder().encode(JSON.stringify(deleteState(entry.mountId, entry.deviceId))),
    )

    const result = await runSyncDeletes(mountDir, {
      action: 'restore',
      resolutionTarget: 'all',
      paths,
      env: {},
      signalDaemon: false,
      now: () => 456,
    })

    expect(result.action).toMatchObject({
      type: 'restore',
      target: 'all',
      matched: 1,
      paths: ['held.md'],
      queued: true,
    })
    expect(result.deleteIntents.map((intent) => intent.path)).toEqual(['free.md'])

    const state = JSON.parse(
      new TextDecoder().decode((await storage.read(STATE_ARTIFACT))!),
    ) as DaemonWorkspaceState
    expect(state.pendingDeletes.map((intent) => intent.path)).toEqual(['free.md'])
    expect(state.files['f-held']!.lastWrittenHash).toBe('')

    const queue = JSON.parse(
      new TextDecoder().decode((await storage.read(DELETE_RESOLUTION_ARTIFACT))!),
    ) as { commands: { action: string; fileIds: string[]; createdAt: number }[] }
    expect(queue.commands).toEqual([
      { id: expect.any(String), action: 'restore', fileIds: ['f-held'], createdAt: 456 },
    ])
  })
})

function byPathOf(result: Awaited<ReturnType<typeof runStatus>>) {
  return new Map(result.deleteIntents.map((intent) => [intent.path, intent]))
}

function deleteState(mountId: string, deviceId: string): DaemonWorkspaceState {
  const T0 = 1_000_000
  return {
    workspaceId: 'ws-1',
    mountId,
    deviceId,
    lastAckedSeq: 7,
    files: {
      'f-held': {
        path: 'held.md',
        contentKind: 'markdown',
        nodeId: '0:1',
        syncedVVB64: '',
        lastWrittenHash: 'held-hash',
        sizeBytes: 10,
        savedAt: T0,
      },
      'f-free': {
        path: 'free.md',
        contentKind: 'markdown',
        nodeId: '0:2',
        syncedVVB64: '',
        lastWrittenHash: 'free-hash',
        sizeBytes: 10,
        savedAt: T0,
      },
    },
    pendingRenames: [],
    pendingDeletes: [
      {
        opId: 'd-held',
        fileId: 'f-held',
        path: 'held.md',
        baseSeq: 7,
        observedMissingAtMs: T0,
        held: 'bulk-window',
      },
      {
        opId: 'd-free',
        fileId: 'f-free',
        path: 'free.md',
        baseSeq: 7,
        observedMissingAtMs: T0,
      },
    ],
  }
}

describe('auth', () => {
  it('stores and forgets tokens per server; mint-dev signs verifiable claims', async () => {
    const { paths } = await fixture()

    const minted = await runMintDev({
      secret: 'dev-secret',
      workspace: 'ws-1',
      principal: 'tester',
      epoch: 2,
      server: 'https://api.glovebox.test',
      save: true,
      paths,
    })
    const verified = await verifyWorkspaceToken(minted.token, 'dev-secret', Date.now())
    expect(verified).toMatchObject({ workspaceId: 'ws-1', principalId: 'tester', epoch: 2 })

    // mint-dev --save stored the token for its target server.
    expect((await runAuthToken({ server: 'https://api.glovebox.test', paths })).token).toBe(
      minted.token,
    )

    await runLogin({ server: 'https://other.example', token: 'opaque-token', paths })
    expect((await runAuthToken({ server: 'https://other.example', paths })).token).toBe(
      'opaque-token',
    )

    expect((await runLogout({ server: 'https://other.example', paths })).removed).toBe(true)
    expect((await runAuthToken({ server: 'https://other.example', paths })).token).toBeNull()
  })

  it('runs device auth and stores the approved gbx_ API key', async () => {
    const { paths } = await fixture()
    const requested: unknown[] = []

    const result = await runDeviceLoginWithClient({
      paths,
      serverUrl: 'https://api.glovebox.test',
      workspaceIds: ['ws-1'],
      scopes: ['workspace:read'],
      timeoutMs: 100,
      client: {
        auth: {
          deviceStart: async (input) => {
            requested.push(input)
            return {
              deviceCode: 'device-1',
              userCode: 'ABCD-EFGH',
              verificationUri: 'https://api.glovebox.test/device',
              verificationUriComplete: 'https://api.glovebox.test/device?user_code=ABCD-EFGH',
              expiresAt: Date.now() + 5_000,
              intervalSec: 0.001,
            }
          },
          devicePoll: async (input) => {
            expect(input).toEqual({ deviceCode: 'device-1' })
            return { status: 'approved' as const, apiKey: 'gbx_device_key' }
          },
        },
      },
    })

    expect(requested).toEqual([
      {
        purpose: 'cli',
        scopes: ['workspace:read'],
        workspaceIds: ['ws-1'],
      },
    ])
    expect(result).toEqual({
      serverUrl: 'https://api.glovebox.test',
      apiKey: 'gbx_device_key',
      saved: true,
    })
    expect((await runAuthToken({ server: 'https://api.glovebox.test', paths })).token).toBe(
      'gbx_device_key',
    )
  })

  it('refreshes stored API keys into workspace socket tokens for the daemon', async () => {
    const { paths } = await fixture()
    await runLogin({ server: 'https://api.glovebox.test', token: 'legacy-ws-token', paths })
    await expect(
      resolveWorkspaceSocketToken({
        paths,
        serverUrl: 'https://api.glovebox.test',
        workspaceId: 'ws-1',
      }),
    ).resolves.toBe('legacy-ws-token')

    await runLogin({ server: 'https://api.glovebox.test', token: 'gbx_cli_key', paths })
    const minted = await resolveWorkspaceSocketToken({
      paths,
      serverUrl: 'https://api.glovebox.test',
      workspaceId: 'ws-1',
      mintSocketToken: async (apiKey) => {
        expect(apiKey).toBe('gbx_cli_key')
        return 'fresh-ws-token'
      },
    })

    expect(minted).toBe('fresh-ws-token')
  })

  it('shows subcommand help for `auth <sub> --help` instead of erroring', async () => {
    // Regression: the subcommand parsers are strict and don't declare --help,
    // so the dispatcher must intercept it before parseArgs throws.
    for (const sub of ['login', 'logout', 'token', 'mint-dev']) {
      const lines = await captureStdout(() =>
        authCommand([sub, '--help'], { json: false, human: false }),
      )
      const text = lines.join('\n')
      expect(text, `${sub} --help`).toContain(`glovebox auth ${sub}`)
      expect(text, `${sub} --help`).toContain('Show this help message')
    }
  })

  it('prints the stored token raw by default when stdout is piped', async () => {
    const { paths } = await fixture()
    await runLogin({ server: 'https://api.glovebox.test', token: 'opaque-token', paths })

    const stdout = await withEnv({ GLOVEBOX_HOME: paths.home }, () =>
      withStdoutIsTty(false, () =>
        captureStdout(() => authCommand(['token'], { json: false, human: false })),
      ),
    )

    expect(stdout).toEqual(['opaque-token'])
  })

  it('prints auth token JSON only when JSON output is explicit', async () => {
    const { paths } = await fixture()
    await runLogin({ server: 'https://api.glovebox.test', token: 'opaque-token', paths })

    const stdout = await withEnv({ GLOVEBOX_HOME: paths.home }, () =>
      withStdoutIsTty(false, () =>
        captureStdout(() => authCommand(['token'], { json: true, human: false })),
      ),
    )

    expect(stdout).toEqual([
      JSON.stringify({ serverUrl: 'https://api.glovebox.test', token: 'opaque-token' }, null, 2),
    ])
  })
})

async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    await fn()
    return lines
  } finally {
    console.log = original
  }
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function withStdoutIsTty<T>(isTTY: boolean, fn: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY })
  try {
    return await fn()
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor)
    else Reflect.deleteProperty(process.stdout, 'isTTY')
  }
}
