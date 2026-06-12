/**
 * Pure sliding-window logic for submit rate limiting, ported from glyphdown
 * (`.vendor/glyphdown/packages/sync/src/ratelimit.ts`). The WorkspaceServer
 * records every attempt as a row in its `submit_attempts(identity, ts)`
 * table, loads that identity's timestamps, and delegates the allow/deny +
 * pruning decision here so the window math stays unit-testable without a
 * Durable Object.
 */

export interface SubmitWindowDecision {
  allowed: boolean
  /** Attempts counted inside the window, including the current one. */
  countInWindow: number
  /** Rows with `ts <= pruneBefore` are outside every future window — delete them. */
  pruneBefore: number
  /** When denied: whole seconds until enough of the window expires to admit one submit. */
  retryAfterSec: number
}

/**
 * Decide whether a submit attempted at `now` is allowed.
 *
 * `timestamps` are the identity's recorded attempts INCLUDING the current
 * one (the server inserts first, then decides — denied attempts keep
 * consuming the window, so hammering past the limit never drains it).
 * A timestamp is inside the window when `now - windowMs < ts` (strict: an
 * attempt exactly `windowMs` old has expired).
 */
export function decideSubmitWindow(
  timestamps: readonly number[],
  now: number,
  limit: number,
  windowMs: number,
): SubmitWindowDecision {
  const pruneBefore = now - windowMs
  const inWindow: number[] = []
  for (const ts of timestamps) {
    if (ts > pruneBefore) inWindow.push(ts)
  }
  const allowed = inWindow.length <= limit
  let retryAfterSec = 0
  if (!allowed) {
    // A retry at time T (which records its own row) passes when at most
    // limit-1 of the current entries remain in its window — i.e. once the
    // (count - limit) oldest entries have aged out.
    inWindow.sort((a, b) => a - b)
    const gate = inWindow[inWindow.length - limit] ?? inWindow[0]!
    retryAfterSec = Math.max(1, Math.ceil((gate + windowMs - now) / 1000))
  }
  return { allowed, countInWindow: inWindow.length, pruneBefore, retryAfterSec }
}
