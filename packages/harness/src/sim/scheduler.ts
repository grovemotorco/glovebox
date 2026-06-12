/**
 * Deterministic simulation core (spec §6): a seeded scheduler drives every
 * async hop — watcher events, WS delivery, persistence writes — so any
 * failing interleaving replays exactly from its seed. Every fatal bug across
 * five architecture eras was an interleaving or crash-window bug invisible
 * to unit tests; this is the bar a change must pass.
 */

/** mulberry32 — tiny, fast, good-enough PRNG with full 32-bit seed. */
export class SeededRandom {
  #state: number

  constructor(seed: number) {
    this.#state = seed >>> 0
  }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list')
    return items[this.int(items.length)]!
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }
}

interface SimTask {
  label: string
  run: () => void | Promise<void>
}

/**
 * Seeded task scheduler. Tasks scheduled during a run join the pool; each
 * step the scheduler picks the NEXT task pseudo-randomly, exploring a
 * different (but seed-reproducible) interleaving per seed. The executed
 * label sequence is kept in `trace` — print `seed` + `trace` on failure and
 * the run replays exactly.
 */
export class SimScheduler {
  readonly seed: number
  readonly random: SeededRandom
  readonly trace: string[] = []
  #pool: SimTask[] = []

  constructor(seed: number) {
    this.seed = seed
    this.random = new SeededRandom(seed)
  }

  schedule(label: string, run: () => void | Promise<void>): void {
    this.#pool.push({ label, run })
  }

  get pending(): number {
    return this.#pool.length
  }

  /**
   * Run until the pool is empty (tasks may schedule more tasks). Each step
   * also drains the microtask queue so promise chains settle before the
   * next pick — the scheduler, not the JS event loop, owns ordering.
   */
  async run(maxSteps = 100_000): Promise<void> {
    let steps = 0
    while (this.#pool.length > 0) {
      if (++steps > maxSteps) {
        throw new Error(`SimScheduler exceeded ${maxSteps} steps (seed ${this.seed})`)
      }
      const index = this.random.int(this.#pool.length)
      const [task] = this.#pool.splice(index, 1)
      this.trace.push(task!.label)
      await task!.run()
      await drainMicrotasks()
    }
  }
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 32; i += 1) {
    await Promise.resolve()
  }
}

export interface ChannelPolicy {
  /** Probability a message is silently dropped. */
  dropRate?: number
  /** Probability a delivered message is delivered twice. */
  duplicateRate?: number
}

/**
 * Lossy, reordering message channel. Delivery happens as scheduler tasks,
 * so cross-channel interleaving (and per-policy drop/duplication) is
 * seed-deterministic. Reordering comes for free: each pending delivery is
 * its own task and the scheduler picks among them randomly.
 */
export class SimChannel<T> {
  readonly #scheduler: SimScheduler
  readonly #label: string
  readonly #policy: ChannelPolicy
  #deliver: ((message: T) => void | Promise<void>) | null = null

  constructor(scheduler: SimScheduler, label: string, policy: ChannelPolicy = {}) {
    this.#scheduler = scheduler
    this.#label = label
    this.#policy = policy
  }

  onDeliver(handler: (message: T) => void | Promise<void>): void {
    this.#deliver = handler
  }

  send(message: T): void {
    if (this.#policy.dropRate && this.#scheduler.random.chance(this.#policy.dropRate)) {
      this.#scheduler.trace.push(`${this.#label}:drop`)
      return
    }
    const copies =
      this.#policy.duplicateRate && this.#scheduler.random.chance(this.#policy.duplicateRate)
        ? 2
        : 1
    for (let i = 0; i < copies; i += 1) {
      this.#scheduler.schedule(`${this.#label}:deliver`, async () => {
        await this.#deliver?.(message)
      })
    }
  }
}

/** Thrown by a tripped CrashFuse; scenarios catch it and "reboot". */
export class SimCrash extends Error {
  constructor(label: string) {
    super(`Simulated crash: ${label}`)
    this.name = 'SimCrash'
  }
}

/**
 * Crash injection between any two persistence writes: arm with the write
 * ordinal to die on; `checkpoint()` is called by instrumented storage
 * before each write. Once tripped, every later checkpoint throws too —
 * a crashed process never writes again until the scenario reboots it.
 */
export class CrashFuse {
  readonly #label: string
  #remaining: number | null
  #tripped = false

  constructor(label: string, crashOnWrite: number | null = null) {
    this.#label = label
    this.#remaining = crashOnWrite
  }

  get tripped(): boolean {
    return this.#tripped
  }

  checkpoint(): void {
    if (this.#tripped) throw new SimCrash(this.#label)
    if (this.#remaining === null) return
    this.#remaining -= 1
    if (this.#remaining <= 0) {
      this.#tripped = true
      throw new SimCrash(this.#label)
    }
  }
}
