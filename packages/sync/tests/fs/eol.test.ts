import { describe, expect, it } from 'vitest'
import { normalizeEol } from '../../src/fs/eol.ts'

describe('normalizeEol', () => {
  it('passes LF-only text through unchanged', () => {
    expect(normalizeEol('a\nb\n')).toBe('a\nb\n')
    expect(normalizeEol('')).toBe('')
  })

  it('converts CRLF to LF', () => {
    expect(normalizeEol('a\r\nb\r\n')).toBe('a\nb\n')
  })

  it('converts bare CR to LF', () => {
    expect(normalizeEol('a\rb\r')).toBe('a\nb\n')
  })

  it('handles mixed endings', () => {
    expect(normalizeEol('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('does not merge a CR that precedes a non-newline', () => {
    expect(normalizeEol('a\r\r\nb')).toBe('a\n\nb')
  })
})
