import { describe, it, expect } from 'vitest'
import { sha256Hex } from '../../src/fs/hash.ts'

describe('sha256Hex', () => {
  it('hashes a string', () => {
    const hash = sha256Hex('hello')
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('returns consistent results', () => {
    expect(sha256Hex('test')).toBe(sha256Hex('test'))
  })

  it('returns different hashes for different inputs', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})
