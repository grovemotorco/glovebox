import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gloveboxPaths } from '../../src/lib/paths.ts'
import {
  LockHeldError,
  acquireLock,
  lockHolderPid,
  readLockRecord,
} from '../../src/lib/lockfile.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function tempPaths() {
  const home = await mkdtemp(join(tmpdir(), 'glovebox-home-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return gloveboxPaths({ GLOVEBOX_HOME: home })
}

/** A pid that cannot be alive (beyond pid_max on every platform we run). */
const DEAD_PID = 2 ** 30

describe('per-mount lockfile', () => {
  it('acquires, reports the holder, and releases', async () => {
    const paths = await tempPaths()
    const lock = await acquireLock(paths, 'm-1')
    expect(lock.record.pid).toBe(process.pid)
    expect(await lockHolderPid(paths, 'm-1')).toBe(process.pid)

    await lock.release()
    expect(await lockHolderPid(paths, 'm-1')).toBeNull()
    expect(await readLockRecord(paths, 'm-1')).toBeNull()
  })

  it('refuses while a live holder exists', async () => {
    const paths = await tempPaths()
    const lock = await acquireLock(paths, 'm-1')
    await expect(acquireLock(paths, 'm-1')).rejects.toBeInstanceOf(LockHeldError)
    await lock.release()
  })

  it('breaks a stale lock (dead pid) exactly once and acquires', async () => {
    const paths = await tempPaths()
    const stale = await acquireLock(paths, 'm-1', DEAD_PID)
    expect(stale.record.pid).toBe(DEAD_PID)

    const lock = await acquireLock(paths, 'm-1')
    expect(lock.record.pid).toBe(process.pid)
    expect(await lockHolderPid(paths, 'm-1')).toBe(process.pid)
    await lock.release()
  })

  it('breaks a corrupt lock and acquires', async () => {
    const paths = await tempPaths()
    const first = await acquireLock(paths, 'm-1')
    await first.release()
    await writeFile(paths.lockFile('m-1'), 'not json at all')

    const lock = await acquireLock(paths, 'm-1')
    expect(await lockHolderPid(paths, 'm-1')).toBe(process.pid)
    await lock.release()
  })

  it('a stale release cannot delete a successor lock (nonce check)', async () => {
    const paths = await tempPaths()
    const first = await acquireLock(paths, 'm-1', DEAD_PID)
    // Successor breaks the stale lock and takes over.
    const second = await acquireLock(paths, 'm-1')

    await first.release()
    const surviving = await readLockRecord(paths, 'm-1')
    expect(surviving?.nonce).toBe(second.record.nonce)
    await second.release()
  })

  it('lock files are private and well-formed JSON', async () => {
    const paths = await tempPaths()
    const lock = await acquireLock(paths, 'm-1')
    const raw = await readFile(paths.lockFile('m-1'), 'utf-8')
    const parsed = JSON.parse(raw) as { version: number; pid: number }
    expect(parsed.version).toBe(1)
    expect(parsed.pid).toBe(process.pid)
    await lock.release()
  })
})

describe('stale-break race hardening (review findings)', () => {
  it('concurrent acquirers over a stale lock: never two holders', async () => {
    const paths = await tempPaths()
    for (let round = 0; round < 50; round += 1) {
      const stale = await acquireLock(paths, 'm-race', DEAD_PID)
      void stale // dead-pid record on disk; its release is never called

      const results = await Promise.allSettled([
        acquireLock(paths, 'm-race'),
        acquireLock(paths, 'm-race'),
      ])
      const winners = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>> =>
          r.status === 'fulfilled',
      )
      // The invariant is AT MOST one holder — the loser must see
      // LockHeldError (or, pathologically, retry exhaustion), never a lock.
      expect(winners.length).toBe(1)
      const loser = results.find((r) => r.status === 'rejected')
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(Error)
      expect(await lockHolderPid(paths, 'm-race')).toBe(process.pid)
      await winners[0]!.value.release()
    }
  })

  it('the lock file never exists without its full record (link-published)', async () => {
    const paths = await tempPaths()
    // 20 sequential acquires, each immediately read back: a torn or empty
    // lock would parse as null (the exact window the old open('wx')+write
    // scheme exposed to concurrent breakers).
    for (let i = 0; i < 20; i += 1) {
      const lock = await acquireLock(paths, 'm-atomic')
      const record = await readLockRecord(paths, 'm-atomic')
      expect(record?.nonce).toBe(lock.record.nonce)
      await lock.release()
    }
  })

  it('an orphaned break mutex is taken over by age', async () => {
    const paths = await tempPaths()
    const stale = await acquireLock(paths, 'm-mutex', DEAD_PID)
    void stale
    // Simulate a breaker that crashed mid-break: mutex dir with an old mtime.
    const mutexPath = `${paths.lockFile('m-mutex')}.breaking`
    const { mkdir, utimes } = await import('node:fs/promises')
    await mkdir(mutexPath)
    const past = new Date(Date.now() - 60_000)
    await utimes(mutexPath, past, past)

    const lock = await acquireLock(paths, 'm-mutex')
    expect(lock.record.pid).toBe(process.pid)
    await lock.release()
  })
})
