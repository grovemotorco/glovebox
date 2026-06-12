import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signWorkspaceToken } from '@glovebox/sync/server'
import { LoroFileDoc } from '@glovebox/sync/loro'
import { WsDaemonTransport, createNodeFS } from '@glovebox/sync/daemon'
import { MemoryClientStorage, WorkspaceSyncEngine } from '@glovebox/sync/client'
import { EDITOR_SAVE_PATTERNS, LiveWorkspaceHost } from '@glovebox/harness'

/**
 * M8 milestone gate (scope note "M8 gate"): the REAL WorkspaceServer core
 * behind a live WebSocket server; TWO real tmpdir mounts driven by the
 * REAL packed CLI as separate OS processes; one browser-engine client on
 * the same workspace. No protocol mocks anywhere. Covers: cross-mount +
 * browser convergence, the editor-save matrix on the real FS, INV-3
 * tombstone visibility through `glovebox status`, SIGKILL mid-cycle →
 * restart → reconvergence (INV-1/INV-2/INV-3), and revocation (4403)
 * stop/report + re-auth reconnect.
 *
 * Timing: daemons run with GLOVEBOX_SYNC_OVERRIDES shrinking the rescan
 * interval to ~250ms and the tombstone delay to 3s — the same policy
 * code, faster clock. `sed -i` stays out of this gate (its tempfile has
 * no litter-marker suffix, so a mid-save scan can transiently adopt it —
 * realistic but nondeterministic here; the pattern is covered on real
 * inodes by the conformance suite and at cycle level by the M4 harness).
 */

const REPO_ROOT = join(import.meta.dirname, '../../..')
const CLI = join(REPO_ROOT, 'apps/cli/dist/glovebox.mjs')
const SECRET = 'gate-secret'
const WORKSPACE_ID = 'ws-gate'
const TOMBSTONE_MS = 3_000

const OVERRIDES = JSON.stringify({
  deletePolicy: { tombstoneDelayMs: TOMBSTONE_MS, renameCorrectionWindowMs: 1_000 },
  rescanIntervalMs: 250,
  watchDebounceMs: 50,
  backoffInitialMs: 100,
})

let host: LiveWorkspaceHost
let home: string
let dirA: string
let dirB: string
let serverUrl: string
let cliEnv: Record<string, string>
let browser: { engine: WorkspaceSyncEngine; transport: WsDaemonTransport }
const daemons = new Set<DaemonProc>()

class DaemonProc {
  readonly proc: ChildProcess
  stdout = ''
  stderr = ''
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  constructor(dir: string) {
    this.proc = spawn(process.execPath, [CLI, 'run', dir], {
      env: { ...process.env, ...cliEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString()
    })
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString()
    })
    this.exited = new Promise((resolve) => {
      this.proc.on('exit', (code, signal) => resolve({ code, signal }))
    })
    daemons.add(this)
  }

  async waitReady(): Promise<void> {
    await until(() => this.stdout.includes('[glovebox] syncing'), 20_000)
  }

  kill(signal: NodeJS.Signals): void {
    this.proc.kill(signal)
  }
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await condition()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function cliJson<T>(args: string[]): T {
  const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
    env: { ...process.env, ...cliEnv },
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`cli ${args.join(' ')} failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout) as T
}

async function fileText(dir: string, rel: string): Promise<string | null> {
  return readFile(join(dir, rel), 'utf-8').catch(() => null)
}

/** fileId↔path map reconstructed from the server's own event log. */
async function serverPaths(): Promise<Map<string, string>> {
  const events = await browser.transport.eventsSince(0)
  const map = new Map<string, string>()
  if (!events.ok) {
    // The gate generates far fewer events than the replay window — a
    // snapshot-required here means the fixture broke. Returning an empty
    // map instead would make the delete-propagation and final-sweep
    // assertions pass vacuously.
    throw new Error(`server event log unavailable: ${events.reason}`)
  }
  for (const event of events.events) {
    const raw = event as { type: string; fileId: string; entry?: { path?: string } }
    if (raw.type === 'create' && raw.entry?.path) {
      map.set(raw.fileId, raw.entry.path)
    } else if (raw.type === 'delete') {
      map.delete(raw.fileId)
    }
  }
  return map
}

async function serverFileIdFor(path: string): Promise<string | null> {
  for (const [fileId, p] of await serverPaths()) {
    if (p === path) {
      return fileId
    }
  }
  return null
}

async function serverText(fileId: string): Promise<string> {
  const snapshot = await browser.transport.fetchSnapshot(fileId)
  return LoroFileDoc.fromSnapshot(snapshot).getTextContent()
}

beforeAll(async () => {
  // The gate drives the PACKED binary — build it (vp cache makes repeats cheap).
  execFileSync(join(REPO_ROOT, 'node_modules/.bin/vp'), ['pack'], {
    cwd: join(REPO_ROOT, 'apps/cli'),
    stdio: 'pipe',
  })

  host = await new LiveWorkspaceHost({ workspaceId: WORKSPACE_ID, authSecret: SECRET }).start()
  serverUrl = `http://127.0.0.1:${host.port}`

  home = await realpath(await mkdtemp(join(tmpdir(), 'glovebox-gate-home-')))
  dirA = await realpath(await mkdtemp(join(tmpdir(), 'glovebox-gate-a-')))
  dirB = await realpath(await mkdtemp(join(tmpdir(), 'glovebox-gate-b-')))
  cliEnv = {
    GLOVEBOX_HOME: home,
    GLOVEBOX_SYNC_OVERRIDES: OVERRIDES,
    NO_COLOR: '1',
  }

  cliJson(['mount', dirA, '--workspace', WORKSPACE_ID, '--server', serverUrl])
  cliJson(['mount', dirB, '--workspace', WORKSPACE_ID, '--server', serverUrl])
  cliJson([
    'auth',
    'mint-dev',
    '--secret',
    SECRET,
    '--workspace',
    WORKSPACE_ID,
    '--principal',
    'cli-dev',
    '--server',
    serverUrl,
    '--save',
  ])

  const browserToken = await signWorkspaceToken(
    {
      workspaceId: WORKSPACE_ID,
      principalId: 'browser',
      principalType: 'human',
      role: 'editor',
      owner: false,
      epoch: 0,
      exp: Date.now() + 3_600_000,
    },
    SECRET,
  )
  const transport = new WsDaemonTransport({
    url: () => host.wsUrl(browserToken),
    backoffInitialMs: 100,
  })
  const engine = new WorkspaceSyncEngine({
    workspaceId: WORKSPACE_ID,
    deviceId: 'browser-device',
    storage: new MemoryClientStorage(),
    transport,
  })
  await engine.start()
  browser = { engine, transport }
}, 180_000)

afterAll(async () => {
  for (const daemon of daemons) {
    daemon.kill('SIGKILL')
  }
  browser?.engine.stop()
  browser?.transport.stop()
  await host?.stop()
  for (const dir of [home, dirA, dirB]) {
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe.sequential('M8 gate', () => {
  let daemonA: DaemonProc
  let daemonB: DaemonProc
  let helloId: string

  it(
    'two real mounts adopt, converge, and serve a live browser client',
    { timeout: 90_000 },
    async () => {
      daemonA = new DaemonProc(dirA)
      daemonB = new DaemonProc(dirB)
      await daemonA.waitReady()
      await daemonB.waitReady()

      // Adoption: the ENGINE writes the in-mount sentinel on the first cycle.
      await until(async () => (await fileText(dirA, '.glovebox.json')) !== null)
      await until(async () => (await fileText(dirB, '.glovebox.json')) !== null)

      // A creates a file → B and the server see it.
      await mkdir(join(dirA, 'notes'), { recursive: true })
      await writeFile(join(dirA, 'notes/hello.md'), 'hello from A\n')
      await until(async () => (await fileText(dirB, 'notes/hello.md')) === 'hello from A\n')

      const fileId = await serverFileIdFor('notes/hello.md')
      expect(fileId).not.toBeNull()
      helloId = fileId!
      expect(await serverText(helloId)).toBe('hello from A\n')

      // Browser opens the same doc live and edits; both mounts converge.
      const client = await browser.engine.openFile(helloId, 'notes/hello.md')
      expect(browser.engine.getText(helloId)).toBe('hello from A\n')
      await client.setTextContent('hello from A\nbrowser line\n')
      await client.flush()
      await until(
        async () => (await fileText(dirA, 'notes/hello.md')) === 'hello from A\nbrowser line\n',
      )
      await until(
        async () => (await fileText(dirB, 'notes/hello.md')) === 'hello from A\nbrowser line\n',
      )

      // Concurrent edits: disk write on A racing a browser edit — both survive
      // everywhere (INV-1 convergence, INV-2 no silent byte drop).
      const base = 'hello from A\nbrowser line\n'
      await writeFile(join(dirA, 'notes/hello.md'), base + 'disk A2\n')
      await client.setTextContent(base + 'browser B2\n')
      await client.flush()
      await until(async () => {
        const a = await fileText(dirA, 'notes/hello.md')
        const b = await fileText(dirB, 'notes/hello.md')
        return (
          a !== null &&
          a === b &&
          a.includes('disk A2') &&
          a.includes('browser B2') &&
          a === (await serverText(helloId))
        )
      }, 30_000)
    },
  )

  it(
    'editor-save matrix on the real FS converges (vim modes + vscode atomic)',
    { timeout: 90_000 },
    async () => {
      const fsA = await createNodeFS(dirA)
      const patterns = EDITOR_SAVE_PATTERNS.filter((pattern) =>
        ['vim backupcopy=yes', 'vim backupcopy=auto', 'vscode atomic save'].includes(pattern.name),
      )
      expect(patterns).toHaveLength(3)

      for (const [index, pattern] of patterns.entries()) {
        const content = `saved by ${pattern.name}\nrevision ${index}\n`
        await pattern.run(fsA, 'notes/hello.md', content)
        await until(async () => (await fileText(dirB, 'notes/hello.md')) === content, 30_000)
        expect(await serverText(helloId)).toBe(content)
        // No litter ever syncs: backup/tmp paths never reach mount B.
        for (const transient of pattern.transientPaths('notes/hello.md')) {
          expect(await fileText(dirB, transient)).toBeNull()
        }
      }
    },
  )

  it(
    'a delete propagates only after the tombstone delay, visible in status',
    { timeout: 90_000 },
    async () => {
      await writeFile(join(dirA, 'doomed.md'), 'short-lived\n')
      await until(async () => (await fileText(dirB, 'doomed.md')) === 'short-lived\n')

      await unlink(join(dirA, 'doomed.md'))

      // INV-3 made visible: the intent shows up in `status` with a countdown.
      interface StatusJson {
        deleteIntents: { path: string; held: string | null; msUntilPropagation: number | null }[]
      }
      let observed: StatusJson['deleteIntents'][number] | undefined
      await until(() => {
        const status = cliJson<StatusJson>(['status', dirA])
        observed = status.deleteIntents.find((intent) => intent.path === 'doomed.md')
        return observed !== undefined
      }, 10_000)
      expect(observed!.held).toBeNull()
      expect(observed!.msUntilPropagation).toBeGreaterThan(0)
      expect(observed!.msUntilPropagation).toBeLessThanOrEqual(TOMBSTONE_MS)

      // While the tombstone runs, nothing has propagated.
      expect(await fileText(dirB, 'doomed.md')).toBe('short-lived\n')

      // After the delay it propagates to the server and mount B.
      await until(async () => (await fileText(dirB, 'doomed.md')) === null, 30_000)
      await until(async () => (await serverFileIdFor('doomed.md')) === null, 30_000)

      // ...and ONLY the deliberate delete propagated (INV-3).
      expect(await fileText(dirB, 'notes/hello.md')).not.toBeNull()
    },
  )

  it(
    'SIGKILL mid-cycle → restart → reconverge (INV-1/INV-2/INV-3)',
    { timeout: 90_000 },
    async () => {
      await writeFile(join(dirA, 'crash.md'), 'v1\n')
      await until(async () => (await fileText(dirB, 'crash.md')) === 'v1\n')

      // Race a fresh write against SIGKILL — the daemon dies mid-cycle with
      // the v2 bytes possibly unobserved. The two-artifact reconcile owns this.
      await writeFile(join(dirA, 'crash.md'), 'v2 survived the crash\n')
      daemonA.kill('SIGKILL')
      const exitA = await daemonA.exited
      expect(exitA.signal).toBe('SIGKILL')

      // Changes keep happening while A is down.
      await writeFile(join(dirB, 'from-b.md'), 'written while A was down\n')

      daemonA = new DaemonProc(dirA) // Stale-lock break happens for real here.
      await daemonA.waitReady()

      await until(
        async () => (await fileText(dirA, 'from-b.md')) === 'written while A was down\n',
        30_000,
      )
      await until(async () => {
        const a = await fileText(dirA, 'crash.md')
        const b = await fileText(dirB, 'crash.md')
        return a === 'v2 survived the crash\n' && b === a
      }, 30_000)

      const crashId = await serverFileIdFor('crash.md')
      expect(crashId).not.toBeNull()
      expect(await serverText(crashId!)).toBe('v2 survived the crash\n')

      // Final INV sweep: every server file matches both mounts byte-for-byte,
      // and no delete intent is open anywhere (INV-3: nothing pending that
      // was never deliberately deleted).
      for (const [fileId, path] of await serverPaths()) {
        const expected = await serverText(fileId)
        await until(async () => (await fileText(dirA, path)) === expected, 30_000)
        await until(async () => (await fileText(dirB, path)) === expected, 30_000)
      }
      for (const dir of [dirA, dirB]) {
        const status = cliJson<{ deleteIntents: unknown[] }>(['status', dir])
        expect(status.deleteIntents).toEqual([])
      }
    },
  )

  it(
    'revocation (4403) stops daemons with a report; re-auth reconnects',
    { timeout: 90_000 },
    async () => {
      await host.revoke(['cli-dev'])

      const [exitA, exitB] = await Promise.all([daemonA.exited, daemonB.exited])
      expect(exitA.code).toBe(1)
      expect(exitB.code).toBe(1)
      expect(daemonA.stderr).toContain('access-revoked')
      expect(daemonB.stderr).toContain('access-revoked')

      // Re-mint under the bumped epoch and reconnect.
      cliJson([
        'auth',
        'mint-dev',
        '--secret',
        SECRET,
        '--workspace',
        WORKSPACE_ID,
        '--principal',
        'cli-dev',
        '--epoch',
        '1',
        '--server',
        serverUrl,
        '--save',
      ])
      daemonA = new DaemonProc(dirA)
      await daemonA.waitReady()

      await writeFile(join(dirA, 'post-revoke.md'), 'back online\n')
      const fresh = new WsDaemonTransport({
        url: async () =>
          host.wsUrl(
            await signWorkspaceToken(
              {
                workspaceId: WORKSPACE_ID,
                principalId: 'verifier',
                principalType: 'human',
                role: 'editor',
                owner: false,
                epoch: 1,
                exp: Date.now() + 600_000,
              },
              SECRET,
            ),
          ),
      })
      try {
        await until(async () => {
          const events = await fresh.eventsSince(0)
          if (!events.ok) {
            return false
          }
          return events.events.some(
            (event) =>
              event.type === 'create' &&
              (event as { entry?: { path?: string } }).entry?.path === 'post-revoke.md',
          )
        }, 30_000)
      } finally {
        fresh.stop()
      }

      // Clean foreground stop: SIGTERM exits 0 and releases the lock.
      daemonA.kill('SIGTERM')
      const exit = await daemonA.exited
      expect(exit.code).toBe(0)
      const list = cliJson<{ mounts: { dir: string; daemon: string }[] }>(['list'])
      expect(list.mounts.find((m) => m.dir === dirA)?.daemon).toBe('stopped')
    },
  )
})
