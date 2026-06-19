import { SYNC } from '@glovebox.md/core'

/**
 * Daemon cycle loop (INV-8: rescan is correctness, not optimization). The
 * V2 daemon has no kernel watcher — every cycle performs a full mount scan
 * — so the runner is the rescan machinery itself: an immediate cycle on
 * start (the RESTART SCAN, reconciling everything that changed while the
 * process was down, in both directions) and a periodic cycle whose delay
 * is jittered per schedule so a fleet of daemons never thunders in sync.
 * When a watcher lands later, its events become `kick()` hints; the
 * jittered loop stays as the correctness backstop.
 */

export interface DaemonCycleHost {
  start(): Promise<void>
  runCycle(): Promise<void>
  stop(): void
  nextWakeMs?(now?: number): number | null
}

export interface DaemonRunnerOptions {
  engine: DaemonCycleHost
  /** Base delay between scheduled cycles; each schedule multiplies it by a
   *  jitter factor drawn uniformly from [jitterMin, jitterMax]. */
  intervalMs?: number
  jitterMin?: number
  jitterMax?: number
  /** Uniform [0,1) source for the jitter draw (seeded in tests). */
  random?: () => number
  now?: () => number
  wakeFloorMs?: number
  /** Timer injection for tests. */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** A failed cycle is reported here and the loop keeps going — transient
   *  transport failures must never kill the daemon. */
  onCycleError?: (error: unknown) => void
}

export class DaemonRunner {
  readonly #engine: DaemonCycleHost
  readonly #intervalMs: number
  readonly #jitterMin: number
  readonly #jitterMax: number
  readonly #random: () => number
  readonly #now: () => number
  readonly #wakeFloorMs: number
  readonly #setTimer: (callback: () => void, delayMs: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #onCycleError: (error: unknown) => void
  #timer: unknown = null
  #stopped = true
  /** Cycles never overlap — the engine is not reentrant. */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: DaemonRunnerOptions) {
    this.#engine = options.engine
    this.#intervalMs = options.intervalMs ?? SYNC.periodicRescanMs
    this.#jitterMin = options.jitterMin ?? SYNC.periodicRescanJitterMin
    this.#jitterMax = options.jitterMax ?? SYNC.periodicRescanJitterMax
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? (() => Date.now())
    this.#wakeFloorMs = options.wakeFloorMs ?? 1_000
    this.#setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number))
    this.#onCycleError = options.onCycleError ?? (() => {})
  }

  /** Engine start + the restart scan, then the jittered loop. */
  async start(): Promise<void> {
    if (!this.#stopped) return
    this.#stopped = false
    await this.#engine.start()
    await this.#enqueueCycle()
    this.#schedule()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer)
      this.#timer = null
    }
    this.#engine.stop()
  }

  /**
   * Resolves when the in-flight cycle (if any) has finished. `stop()` is
   * synchronous and does not interrupt a running cycle — callers that are
   * about to exit the process should stop, then await this, so a mid-cycle
   * persistence write isn't cut down by `process.exit` (the crash reconcile
   * would survive it, but a clean shutdown shouldn't need it).
   */
  settle(): Promise<void> {
    return this.#queue
  }

  /**
   * Run a cycle now (watcher hint, reconnect, test). Serialized behind any
   * in-flight cycle; resolves when this cycle finishes.
   */
  kick(): Promise<void> {
    return this.#enqueueCycle()
  }

  #schedule(): void {
    if (this.#stopped) return
    const jitter = this.#jitterMin + this.#random() * (this.#jitterMax - this.#jitterMin)
    const periodicDelayMs = Math.round(this.#intervalMs * jitter)
    const now = this.#now()
    const nextWakeMs = this.#engine.nextWakeMs?.(now) ?? null
    const delayMs =
      nextWakeMs === null
        ? periodicDelayMs
        : Math.min(periodicDelayMs, Math.max(this.#wakeFloorMs, nextWakeMs - now))
    this.#timer = this.#setTimer(() => {
      this.#timer = null
      void this.#enqueueCycle().then(() => this.#schedule())
    }, delayMs)
  }

  #enqueueCycle(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped) return
      try {
        await this.#engine.runCycle()
      } catch (error) {
        this.#onCycleError(error)
      }
    })
    this.#queue = run
    return run
  }
}
