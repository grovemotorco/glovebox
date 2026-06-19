import { describe, expect, it } from 'vitest'
import { CliError, withNextActions } from '../src/cli/envelope.ts'

describe('withNextActions', () => {
  it('merges a non-empty array as a sibling key', () => {
    expect(
      withNextActions({ fileId: 'f1' }, [{ command: 'glovebox push f.md', description: 'push' }]),
    ).toEqual({
      fileId: 'f1',
      nextActions: [{ command: 'glovebox push f.md', description: 'push' }],
    })
  })

  it('leaves the object untouched when there are no actions', () => {
    expect(withNextActions({ fileId: 'f1' })).toEqual({ fileId: 'f1' })
    expect(withNextActions({ fileId: 'f1' }, [])).toEqual({ fileId: 'f1' })
  })
})

describe('CliError', () => {
  it('is an Error carrying code/fix/nextActions', () => {
    const err = new CliError('bad usage', {
      code: 'USAGE',
      fix: 'Run `glovebox mount --help`',
      nextActions: [{ command: 'glovebox mount', description: 'retry' }],
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('CliError')
    expect(err.message).toBe('bad usage')
    expect(err.code).toBe('USAGE')
    expect(err.fix).toBe('Run `glovebox mount --help`')
    expect(err.nextActions).toEqual([{ command: 'glovebox mount', description: 'retry' }])
  })

  it('defaults code/fix/nextActions to undefined', () => {
    const err = new CliError('plain')
    expect(err.code).toBeUndefined()
    expect(err.fix).toBeUndefined()
    expect(err.nextActions).toBeUndefined()
  })
})
