import { describe, expect, it } from 'vitest'
import {
  CrashFuse,
  SeededRandom,
  SimChannel,
  SimCrash,
  SimScheduler,
} from '../src/sim/scheduler.ts'

describe('SeededRandom', () => {
  it('is reproducible from its seed', () => {
    const a = new SeededRandom(42)
    const b = new SeededRandom(42)
    const seqA = Array.from({ length: 50 }, () => a.next())
    const seqB = Array.from({ length: 50 }, () => b.next())
    expect(seqA).toEqual(seqB)

    const c = new SeededRandom(43)
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(seqA)
  })
})

describe('SimScheduler', () => {
  it('replays the identical interleaving for the same seed', async () => {
    async function runScenario(seed: number): Promise<string[]> {
      const scheduler = new SimScheduler(seed)
      const log: string[] = []
      for (const actor of ['a', 'b', 'c']) {
        for (let i = 0; i < 4; i += 1) {
          scheduler.schedule(`${actor}${i}`, () => {
            log.push(`${actor}${i}`)
            if (i === 1) {
              scheduler.schedule(`${actor}${i}:followup`, () => {
                log.push(`${actor}${i}:followup`)
              })
            }
          })
        }
      }
      await scheduler.run()
      return log
    }

    const first = await runScenario(7)
    const second = await runScenario(7)
    expect(second).toEqual(first)
    expect(first).toHaveLength(15)

    const other = await runScenario(8)
    expect(other).not.toEqual(first)
  })

  it('aborts runaway scenarios with the seed in the error', async () => {
    const scheduler = new SimScheduler(5)
    const refill = (): void => {
      scheduler.schedule('again', refill)
    }
    scheduler.schedule('again', refill)
    await expect(scheduler.run(100)).rejects.toThrow(/100 steps \(seed 5\)/)
  })
})

describe('SimChannel', () => {
  it('drops and reorders deterministically by seed', async () => {
    async function runScenario(seed: number): Promise<string[]> {
      const scheduler = new SimScheduler(seed)
      const received: string[] = []
      const channel = new SimChannel<string>(scheduler, 'ws', { dropRate: 0.3 })
      channel.onDeliver((message) => {
        received.push(message)
      })
      for (let i = 0; i < 10; i += 1) channel.send(`m${i}`)
      await scheduler.run()
      return received
    }

    const first = await runScenario(1234)
    expect(await runScenario(1234)).toEqual(first)
    expect(first.length).toBeLessThan(10)
    expect(first.length).toBeGreaterThan(0)
    // Reordering: with this seed the arrival order differs from send order.
    expect(first).not.toEqual([...first].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))))
  })

  it('can duplicate deliveries', async () => {
    const scheduler = new SimScheduler(99)
    const received: string[] = []
    const channel = new SimChannel<string>(scheduler, 'ws', { duplicateRate: 1 })
    channel.onDeliver((message) => {
      received.push(message)
    })
    channel.send('only')
    await scheduler.run()
    expect(received).toEqual(['only', 'only'])
  })
})

describe('CrashFuse', () => {
  it('trips on the armed write ordinal and stays dead', () => {
    const fuse = new CrashFuse('client-a', 3)
    fuse.checkpoint()
    fuse.checkpoint()
    expect(() => fuse.checkpoint()).toThrow(SimCrash)
    expect(fuse.tripped).toBe(true)
    expect(() => fuse.checkpoint()).toThrow(SimCrash)
  })

  it('is inert when unarmed', () => {
    const fuse = new CrashFuse('client-a')
    for (let i = 0; i < 100; i += 1) fuse.checkpoint()
    expect(fuse.tripped).toBe(false)
  })
})
