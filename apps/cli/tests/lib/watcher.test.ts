import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHintDebouncer, startWatchHints } from '../../src/lib/watcher.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('watcher hints', () => {
  it('debouncer coalesces a burst into one fire', async () => {
    let fires = 0
    const debouncer = createHintDebouncer(() => {
      fires += 1
    }, 20)
    debouncer.poke()
    debouncer.poke()
    debouncer.poke()
    await until(() => fires === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fires).toBe(1)

    debouncer.poke()
    debouncer.cancel()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fires).toBe(1)
  })

  it('a real file change produces a debounced kick (hints only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'glovebox-watch-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))

    let kicks = 0
    const debouncer = createHintDebouncer(() => {
      kicks += 1
    }, 30)
    const watcher = startWatchHints(dir, () => debouncer.poke())
    cleanups.push(() => {
      watcher.close()
      debouncer.cancel()
    })

    // The watcher needs a beat to arm on macOS FSEvents.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await writeFile(join(dir, 'note.md'), 'hello\n')
    await until(() => kicks >= 1)
  })

  // NOTE: no exact-count assertion against real FS events — FSEvents batches
  // with its own latency and may deliver after our debounce window, so an
  // "exactly one kick" check is inherently flaky. The coalescing property is
  // covered deterministically by the pure-debouncer test above; over-kicking
  // is harmless by design (no-op cycle on the watermark, INV-4).
})
