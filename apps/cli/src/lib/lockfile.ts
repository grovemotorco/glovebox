import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { link, mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir, type GloveboxPaths } from './paths.ts'

/**
 * Per-mount lockfile — MANDATORY, not advisory (M8 scope note §4): two
 * daemons on one directory corrupt watermark bookkeeping.
 *
 * Acquisition is `link(2)`-based: the record is written COMPLETE to a
 * private tmp file and published with an atomic hard link that fails on an
 * existing target — there is never a moment where the lock exists empty or
 * partially written (an `open('wx')`-then-write scheme has exactly that
 * window, and a concurrent acquirer reads it as corrupt and breaks it).
 *
 * Breaking a stale lock (holder pid no longer alive) is serialized through
 * a mkdir mutex: judge-then-delete is a TOCTOU otherwise — two racers can
 * both judge the old record stale and the slower `rm` deletes the faster
 * racer's BRAND-NEW lock, yielding two holders. Inside the mutex the
 * record is re-read and re-judged before deletion. A mutex orphaned by a
 * crash is taken over by age.
 *
 * Release verifies the nonce so a stale process can't delete a successor's
 * lock. Liveness is `kill(pid, 0)` with EPERM counted as alive — a recycled
 * pid owned by another user therefore holds the lock until removed by hand;
 * the error message carries the path and age so that case is actionable.
 */

export interface LockRecord {
  version: 1
  pid: number
  nonce: string
  startedAt: string
  processStartToken?: string
}

export class LockHeldError extends Error {
  readonly pid: number

  constructor(mountId: string, record: LockRecord, lockPath: string) {
    super(
      `mount ${mountId} is locked by a running daemon (pid ${record.pid}, since ${record.startedAt}). ` +
        `If that process is truly gone, remove ${lockPath}`,
    )
    this.name = 'LockHeldError'
    this.pid = record.pid
  }
}

export interface MountLock {
  record: LockRecord
  release(): Promise<void>
}

const BREAK_MUTEX_SUFFIX = '.breaking'
/** A break mutex older than this was orphaned by a crash — take it over. */
const BREAK_MUTEX_STALE_MS = 10_000

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = exists but not ours; only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readLockRecord(
  paths: GloveboxPaths,
  mountId: string,
): Promise<LockRecord | null> {
  return readLockRecordAt(paths.lockFile(mountId))
}

async function readLockRecordAt(lockPath: string): Promise<LockRecord | null> {
  try {
    return parseLockRecord(await readFile(lockPath, 'utf-8'))
  } catch {
    return null
  }
}

function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>
    if (
      parsed.version !== 1 ||
      typeof parsed.pid !== 'number' ||
      !Number.isFinite(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.nonce !== 'string' ||
      parsed.nonce.length === 0 ||
      typeof parsed.startedAt !== 'string' ||
      (parsed.processStartToken !== undefined && typeof parsed.processStartToken !== 'string')
    ) {
      return null
    }
    return {
      version: 1,
      pid: parsed.pid,
      nonce: parsed.nonce,
      startedAt: parsed.startedAt,
      processStartToken: parsed.processStartToken,
    }
  } catch {
    return null
  }
}

export function processStartToken(pid: number): string | null {
  return linuxProcessStartToken(pid) ?? psProcessStartToken(pid)
}

export function lockRecordMatchesProcess(
  record: LockRecord,
  startTokenOf: (pid: number) => string | null = processStartToken,
): boolean {
  if (!isProcessAlive(record.pid)) return false
  if (record.processStartToken === undefined) return true
  const current = startTokenOf(record.pid)
  return current === null || current === record.processStartToken
}

/** Live holder's pid, or null (no lock, stale lock, corrupt lock). */
export async function lockHolderPid(paths: GloveboxPaths, mountId: string): Promise<number | null> {
  const record = await readLockRecord(paths, mountId)
  if (!record || !lockRecordMatchesProcess(record)) {
    return null
  }
  return record.pid
}

export async function acquireLock(
  paths: GloveboxPaths,
  mountId: string,
  pid = process.pid,
): Promise<MountLock> {
  const lockPath = paths.lockFile(mountId)
  await ensureDir(dirname(lockPath))

  // Bounded retries: each loop either acquires, throws LockHeldError, or
  // has made progress (a stale lock or orphaned mutex was removed).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record: LockRecord = {
      version: 1,
      pid,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
    }
    const token = processStartToken(pid)
    if (token !== null) record.processStartToken = token

    // Publish atomically: full record first, then link into place.
    const tmpPath = `${lockPath}.${record.nonce}.tmp`
    await writeFile(tmpPath, JSON.stringify(record) + '\n', { mode: 0o600 })
    try {
      await link(tmpPath, lockPath)
      return {
        record,
        release: async () => {
          // Only the holder may remove the lock — verify the nonce so a
          // late release can't delete a successor's lock.
          const current = await readLockRecord(paths, mountId)
          if (current?.nonce === record.nonce) {
            await rm(lockPath, { force: true })
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    } finally {
      await rm(tmpPath, { force: true })
    }

    const existing = await readLockRecord(paths, mountId)
    if (existing && lockRecordMatchesProcess(existing)) {
      throw new LockHeldError(mountId, existing, lockPath)
    }
    // Stale (dead holder) or corrupt: break it under the mutex, then retry.
    await breakStaleLock(lockPath)
  }
  throw new Error(`could not acquire lock for mount ${mountId}`)
}

/**
 * Serialized stale-lock removal. Only the mkdir winner may delete, and it
 * re-judges the CURRENT record first — between a racer's read and its
 * delete, the lock may have been broken and re-acquired by a live process.
 */
async function breakStaleLock(lockPath: string): Promise<void> {
  const mutexPath = `${lockPath}${BREAK_MUTEX_SUFFIX}`
  try {
    await mkdir(mutexPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    // Another breaker holds the mutex — if it crashed mid-break, take over.
    const age = await stat(mutexPath).then(
      (s) => Date.now() - s.mtimeMs,
      () => null,
    )
    if (age !== null && age > BREAK_MUTEX_STALE_MS) {
      await rmdir(mutexPath).catch(() => {})
    }
    // Either way, let the caller's retry loop re-evaluate from scratch.
    return
  }

  try {
    // Re-judge from the RAW file. Absent vs corrupt matters: an ABSENT
    // lock means there is nothing to break — falling through to unlink
    // would race a fresh winner's link into the just-freed slot and delete
    // it (the double-holder interleaving the race test caught). A present
    // slot, by contrast, can only be freed by mutex-held code, so judging
    // its CONTENT and unlinking is atomic enough.
    let raw: string
    try {
      raw = await readFile(lockPath, 'utf-8')
    } catch {
      return // Absent — a previous breaker already handled it.
    }
    const current = parseLockRecord(raw)
    if (current && lockRecordMatchesProcess(current)) {
      return // A live holder took over since we judged — nothing to break.
    }
    await unlink(lockPath).catch(() => {})
  } finally {
    await rmdir(mutexPath).catch(() => {})
  }
}

function linuxProcessStartToken(pid: number): string | null {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim()
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const endComm = stat.lastIndexOf(')')
    if (endComm === -1) return null
    const fields = stat
      .slice(endComm + 2)
      .trim()
      .split(/\s+/)
    const startTicks = fields[19]
    if (!bootId || !startTicks) return null
    return `linux:${bootId}:${startTicks}`
  } catch {
    return null
  }
}

function psProcessStartToken(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out === '') return null
    const ms = Date.parse(out)
    return Number.isNaN(ms) ? null : `ps-lstart:${ms}`
  } catch {
    return null
  }
}
