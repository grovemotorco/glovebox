import { describe, expect, it } from 'vitest'
import { DaemonRunner, type DaemonCycleHost } from '../../src/daemon/runner.ts'

/** Manual timer fake: the test fires timers explicitly. */
class FakeTimers {
  readonly scheduled: { callback: () => void; delayMs: number; cleared: boolean }[] = []

  set = (callback: () => void, delayMs: number): unknown => {
    const entry = { callback, delayMs, cleared: false }
    this.scheduled.push(entry)
    return entry
  }

  clear = (handle: unknown): void => {
    ;(handle as { cleared: boolean }).cleared = true
  }

  /** Fire (and consume) the most recently scheduled live timer. */
  async fireLast(): Promise<void> {
    const entry = [...this.scheduled].reverse().find((candidate) => !candidate.cleared)
    expect(entry).toBeDefined()
    entry!.cleared = true
    entry!.callback()
    // Let the cycle promise chain settle.
    await new Promise((resolve) => setImmediate(resolve))
  }

  pending(): number {
    return this.scheduled.filter((entry) => !entry.cleared).length
  }
}

class FakeEngine implements DaemonCycleHost {
  started = 0
  stopped = 0
  cycles = 0
  inFlight = 0
  maxInFlight = 0
  failNext = false
  wakeAt: number | null = null
  /** Resolved by the test to release a blocked cycle. */
  gate: Promise<void> | null = null

  async start(): Promise<void> {
    this.started += 1
  }

  async runCycle(): Promise<void> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.gate) await this.gate
      if (this.failNext) {
        this.failNext = false
        throw new Error('transient transport failure')
      }
      this.cycles += 1
    } finally {
      this.inFlight -= 1
    }
  }

  stop(): void {
    this.stopped += 1
  }

  nextWakeMs(): number | null {
    return this.wakeAt
  }
}

describe('DaemonRunner (INV-8: jittered rescan + restart scan)', () => {
  it('runs the restart scan immediately on start, before any timer fires', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      random: () => 0.5,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    await runner.start()
    expect(engine.started).toBe(1)
    expect(engine.cycles).toBe(1) // the restart scan
    expect(timers.pending()).toBe(1) // and the loop is armed
    runner.stop()
  })

  it('schedules each cycle with a fresh jitter draw inside [min, max] × interval', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    const draws = [0, 1, 0.5]
    let drawIndex = 0
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      jitterMin: 0.75,
      jitterMax: 1.25,
      random: () => draws[drawIndex++ % draws.length]!,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    await runner.start()
    expect(timers.scheduled[0]!.delayMs).toBe(7_500) // draw 0 → min
    await timers.fireLast()
    expect(engine.cycles).toBe(2)
    expect(timers.scheduled[1]!.delayMs).toBe(12_500) // draw 1 → max
    await timers.fireLast()
    expect(engine.cycles).toBe(3)
    expect(timers.scheduled[2]!.delayMs).toBe(10_000) // draw 0.5 → midpoint
    runner.stop()
  })

  it('stop cancels the pending timer, stops the engine, and ignores late kicks', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      random: () => 0.5,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    await runner.start()
    runner.stop()
    expect(engine.stopped).toBe(1)
    expect(timers.pending()).toBe(0)

    await runner.kick()
    expect(engine.cycles).toBe(1) // only the restart scan ever ran
  })

  it('a failing cycle is reported and the loop keeps rescheduling', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    const errors: unknown[] = []
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      random: () => 0.5,
      setTimer: timers.set,
      clearTimer: timers.clear,
      onCycleError: (error) => errors.push(error),
    })

    await runner.start()
    engine.failNext = true
    await timers.fireLast()
    expect(errors).toHaveLength(1)
    expect(timers.pending()).toBe(1) // still armed after the failure
    await timers.fireLast()
    expect(engine.cycles).toBe(2)
    runner.stop()
  })

  it('clamps the scheduled cycle to the engine next-wake hint', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    let now = 100_000
    engine.wakeAt = 102_500
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      jitterMin: 1,
      jitterMax: 1,
      random: () => 0,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    await runner.start()
    expect(timers.scheduled[0]!.delayMs).toBe(2_500)

    now = 102_500
    engine.wakeAt = null
    await timers.fireLast()
    expect(engine.cycles).toBe(2)
    expect(timers.scheduled[1]!.delayMs).toBe(10_000)
    runner.stop()
  })

  it('floors a past-due next-wake hint instead of busy-looping', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    engine.wakeAt = 99_000
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      jitterMin: 1,
      jitterMax: 1,
      random: () => 0,
      now: () => 100_000,
      wakeFloorMs: 1_000,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    await runner.start()
    expect(timers.scheduled[0]!.delayMs).toBe(1_000)
    runner.stop()
  })

  it('re-arms the wake timer after a kicked cycle so a freshly observed delete is not delayed', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    const now = 100_000
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      jitterMin: 1,
      jitterMax: 1,
      random: () => 0,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    await runner.start()
    // No pending delete yet → the long periodic timer is armed.
    expect(timers.scheduled[0]!.delayMs).toBe(10_000)

    // A delete is observed off the timer path (watcher/SIGUSR2 → kick); its
    // tombstone expires in 2.5s. The kick must re-arm against that hint
    // rather than leaving the 10s periodic timer to fire first.
    engine.wakeAt = 102_500
    await runner.kick()

    expect(engine.cycles).toBe(2)
    expect(timers.pending()).toBe(1)
    expect(timers.scheduled.find((entry) => !entry.cleared)!.delayMs).toBe(2_500)
    runner.stop()
  })

  it('kicks serialize behind an in-flight cycle — cycles never overlap', async () => {
    const timers = new FakeTimers()
    const engine = new FakeEngine()
    const runner = new DaemonRunner({
      engine,
      intervalMs: 10_000,
      random: () => 0.5,
      setTimer: timers.set,
      clearTimer: timers.clear,
    })

    let release!: () => void
    engine.gate = new Promise((resolve) => {
      release = resolve
    })
    const startPromise = runner.start() // restart scan blocks on the gate
    const kickPromise = runner.kick()
    release()
    engine.gate = null
    await startPromise
    await kickPromise

    expect(engine.maxInFlight).toBe(1)
    expect(engine.cycles).toBe(2)
    runner.stop()
  })
})
