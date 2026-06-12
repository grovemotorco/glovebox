import { watch, type FSWatcher } from 'node:fs'

/**
 * Watcher hints (M8.5): a recursive `node:fs.watch` whose only output is a
 * debounced `runner.kick()`. Hints carry ZERO correctness weight (INV-8 —
 * the jittered rescan loop is the backstop), so this is deliberately dumb:
 * no event parsing, no path bookkeeping, no chokidar/native-addon
 * dependency; a kick runs a full cycle and the scanner is the truth.
 * Platforms or paths where recursive watch fails degrade to no watcher at
 * all — correct, just slower.
 */

export interface WatchHandle {
  close(): void
}

export interface HintDebouncer {
  poke(): void
  cancel(): void
}

export function createHintDebouncer(fire: () => void, delayMs: number): HintDebouncer {
  let timer: NodeJS.Timeout | null = null
  return {
    poke() {
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = null
        fire()
      }, delayMs)
    },
    cancel() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

export function startWatchHints(dir: string, onHint: () => void): WatchHandle {
  let watcher: FSWatcher | null = null
  try {
    // Deliberately NO event filtering — even our own checkout writes hint
    // (the resulting cycle no-ops on the watermark, INV-4, and the runner
    // serializes cycles). Filtering can only lose hints, never gain.
    watcher = watch(dir, { recursive: true }, () => {
      onHint()
    })
    watcher.on('error', () => {
      // Hints only — a dying watcher must never take the daemon with it.
    })
  } catch {
    return { close() {} }
  }
  return {
    close() {
      watcher?.close()
    },
  }
}
