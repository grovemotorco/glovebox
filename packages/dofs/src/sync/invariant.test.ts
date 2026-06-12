import { describe, expect, it } from 'vitest'

import { assertAppliedPushRev } from './invariant.js'

describe('assertAppliedPushRev', () => {
  it('passes when applied >= pushed', () => {
    expect(() => assertAppliedPushRev(10, 10)).not.toThrow()
    expect(() => assertAppliedPushRev(11, 10)).not.toThrow()
  })

  it('passes at zero', () => {
    expect(() => assertAppliedPushRev(0, 0)).not.toThrow()
  })

  it("throws when the container is behind the DO's push watermark", () => {
    expect(() => assertAppliedPushRev(5, 10)).toThrowError(/appliedPushRev.*5.*pushRev.*10/i)
  })
})
