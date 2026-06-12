// Cross-side invariant: every fetchChanges and push response carries
// the container's current appliedPushRev. The DO asserts
// appliedPushRev >= pushRev on every response.
//
// The two sides never share a single clock, but echoing the largest
// applied DO rev makes the "container is caught up with the DO's
// pushes" invariant inspectable on the wire instead of load-bearing
// in-process state. A regression in the suppress-dirty-tracking
// apply path trips the assertion immediately rather than corrupting
// data silently.
//
// Throwing an Error is the right escalation: a violation means the
// protocol is broken; the connection should tear down and rebuild
// rather than soldiering on with stale state.

export function assertAppliedPushRev(appliedPushRev: number, pushRev: number): void {
  if (appliedPushRev < pushRev) {
    throw new Error(
      `cross-side invariant violated: appliedPushRev (${appliedPushRev}) < pushRev (${pushRev})`,
    )
  }
}
