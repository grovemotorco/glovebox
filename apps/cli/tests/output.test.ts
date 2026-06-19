import { describe, expect, it, vi } from 'vitest'
import { ORPCError } from '@glovebox.md/api'
import { CliError } from '../src/cli/envelope.ts'
import { printCommandError, toErrorEnvelope } from '../src/cli/output.ts'

/**
 * The CLI's top-level error path (`main().catch`) routes every thrown error
 * through these helpers. The contract guarantee: a contract-defined oRPC error
 * keeps its `code`/`status`/`data` across the RPC boundary and out to `--json`
 * consumers, while anything else degrades to a message — never a crash.
 */
describe('toErrorEnvelope', () => {
  it('extracts code/status/data from a contract-defined ORPCError', () => {
    const error = new ORPCError('FORBIDDEN', {
      defined: true,
      status: 403,
      message: 'Forbidden',
      data: { reason: 'editor_required' },
    })
    expect(toErrorEnvelope(error)).toEqual({
      code: 'FORBIDDEN',
      status: 403,
      message: 'Forbidden',
      data: { reason: 'editor_required' },
    })
  })

  it('collapses a plain Error to a message-only envelope', () => {
    expect(toErrorEnvelope(new Error('boom'))).toEqual({
      code: null,
      status: null,
      message: 'boom',
    })
  })

  it('stringifies a non-Error throwable', () => {
    expect(toErrorEnvelope('nope')).toEqual({ code: null, status: null, message: 'nope' })
  })

  it('keeps a CliError code (or null) and message', () => {
    expect(toErrorEnvelope(new CliError('m', { code: 'USAGE' }))).toEqual({
      code: 'USAGE',
      status: null,
      message: 'm',
    })
    expect(toErrorEnvelope(new CliError('m'))).toEqual({ code: null, status: null, message: 'm' })
  })
})

describe('printCommandError with a CliError', () => {
  it('surfaces fix and nextActions in the json envelope', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCommandError(
      new CliError('bad usage', {
        fix: 'Run `glovebox mount --help` for usage.',
        nextActions: [{ command: 'glovebox mount', description: 'retry' }],
      }),
      'json',
    )
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toEqual({
      error: { code: null, status: null, message: 'bad usage' },
      fix: 'Run `glovebox mount --help` for usage.',
      nextActions: [{ command: 'glovebox mount', description: 'retry' }],
    })
    err.mockRestore()
  })

  it('prints the fix as a dim hint in human mode', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCommandError(new CliError('bad usage', { fix: 'Run `glovebox mount --help`' }), 'human')
    const lines = err.mock.calls.map((call) => call[0] as string)
    expect(lines.some((line) => line.includes('bad usage'))).toBe(true)
    expect(lines.some((line) => line.includes('Run `glovebox mount --help`'))).toBe(true)
    err.mockRestore()
  })
})

describe('printCommandError', () => {
  it('emits a structured { error } envelope on stderr — never stdout — in json mode', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCommandError(
      new ORPCError('NOT_FOUND', {
        defined: true,
        status: 404,
        message: 'Not found',
        data: { resource: 'workspace' },
      }),
      'json',
    )
    // stdout is the data channel: a failing `$(glovebox …)` must not capture it.
    expect(log).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledTimes(1)
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toEqual({
      error: {
        code: 'NOT_FOUND',
        status: 404,
        message: 'Not found',
        data: { resource: 'workspace' },
      },
    })
    err.mockRestore()
    log.mockRestore()
  })

  it('appends the oRPC code to the human line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    printCommandError(
      new ORPCError('NOT_IMPLEMENTED', {
        defined: true,
        status: 501,
        message: 'Not implemented',
        data: { procedure: 'me.get' },
      }),
      'human',
    )
    expect(err).toHaveBeenCalledTimes(1)
    const line = err.mock.calls[0]![0] as string
    expect(line).toContain('Not implemented')
    expect(line).toContain('NOT_IMPLEMENTED')
    err.mockRestore()
  })
})
