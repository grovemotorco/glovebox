import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../../src/commands/doctor.ts'
import { runMount } from '../../src/commands/mount.ts'
import { processStartToken } from '../../src/lib/lockfile.ts'
import { gloveboxPaths, type GloveboxPaths } from '../../src/lib/paths.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function fixture(): Promise<{
  paths: GloveboxPaths
  env: NodeJS.ProcessEnv
  mountDir: string
}> {
  const home = await tempDir('glovebox-doctor-home-')
  const mountDir = await tempDir('glovebox-doctor-mount-')
  // No network in tests: a fetch that rejects makes Reachability an `error`,
  // which is fine — these tests assert on the Locks check, not overall ok.
  return { paths: gloveboxPaths({ GLOVEBOX_HOME: home }), env: { GLOVEBOX_HOME: home }, mountDir }
}

const offlineFetch = (async () => {
  throw new Error('offline')
}) as unknown as typeof fetch

async function writeStaleLock(paths: GloveboxPaths, mountId: string): Promise<string> {
  const lockPath = paths.lockFile(mountId)
  await mkdir(dirname(lockPath), { recursive: true })
  // A pid that is (almost certainly) not alive → isProcessAlive() === false.
  const record = {
    version: 1,
    pid: 2_147_483_646,
    nonce: 'dead',
    startedAt: new Date(0).toISOString(),
  }
  await writeFile(lockPath, JSON.stringify(record) + '\n')
  return lockPath
}

describe('doctor', () => {
  it('reports missing credentials as a non-fatal warning', async () => {
    const { paths, env } = await fixture()
    const result = await runDoctor({ paths, env, fetch: offlineFetch })
    const creds = result.checks.find((c) => c.name === 'Credentials')!
    expect(creds.status).toBe('warn')
  })

  it('flags a stale daemon lock as fixable and clears it with --fix', async () => {
    const { paths, env, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    const lockPath = await writeStaleLock(paths, entry.mountId)

    const before = await runDoctor({ paths, env, fetch: offlineFetch })
    const locks = before.checks.find((c) => c.name === 'Locks')!
    expect(locks.status).toBe('warn')
    expect(typeof locks.fix).toBe('function')
    // Detection alone must not delete anything.
    expect((await stat(lockPath)).isFile()).toBe(true)

    const after = await runDoctor({ paths, env, fix: true, fetch: offlineFetch })
    const fixedLocks = after.checks.find((c) => c.name === 'Locks')!
    expect(fixedLocks.status).toBe('ok')
    expect(after.fixed).toBeGreaterThanOrEqual(1)
    await expect(stat(lockPath)).rejects.toThrow()
  })

  it('flags a recycled-pid lock (live pid, mismatched start token) as stale', async () => {
    const { paths, env, mountDir } = await fixture()
    const entry = await runMount(mountDir, { workspace: 'ws-1', paths })
    // What survives a reboot: the recorded pid is reassigned to an unrelated
    // live process, but the process-start token (boot_id/starttime) no longer
    // matches. `doctor` must judge this stale via the same token-aware
    // predicate as `acquireLock`/`unmount`, not bare isProcessAlive.
    const lockPath = paths.lockFile(entry.mountId)
    await mkdir(dirname(lockPath), { recursive: true })
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        nonce: 'recycled',
        startedAt: new Date(0).toISOString(),
        processStartToken: 'not-this-process',
      }) + '\n',
    )

    const result = await runDoctor({ paths, env, fetch: offlineFetch })
    const locks = result.checks.find((c) => c.name === 'Locks')!
    // On a host that cannot read a real start token, the predicate
    // conservatively treats the lock as live (don't break a maybe-live lock),
    // so doctor must NOT flag it. Assert whichever the host supports.
    if (processStartToken(process.pid) === null) {
      expect(locks.status).toBe('ok')
    } else {
      expect(locks.status).toBe('warn')
      expect(typeof locks.fix).toBe('function')
    }
  })

  it('reports no stale locks when none exist', async () => {
    const { paths, env } = await fixture()
    const result = await runDoctor({ paths, env, fetch: offlineFetch })
    const locks = result.checks.find((c) => c.name === 'Locks')!
    expect(locks.status).toBe('ok')
    expect(locks.fix).toBeUndefined()
  })
})
