import { describe, expect, it } from 'vitest'
import { renderHelp } from '../src/cli/help.ts'
import { parseDurationSeconds } from '../src/commands/run.ts'

describe('renderHelp', () => {
  it('renders the standard sections and always appends the help row', () => {
    const out = renderHelp({
      name: 'glovebox push',
      summary: 'merge local edits into the live document',
      usage: 'glovebox push <path> [options]',
      description: 'Merges your edits into the live document.',
      args: [['path', 'the file to push']],
      options: [['--force', 'apply even a degenerate rewrite']],
      examples: ['glovebox push docs/note.md'],
    })

    expect(out).toContain('glovebox push — merge local edits into the live document')
    expect(out).toContain('Usage: glovebox push <path> [options]')
    expect(out).toContain('Merges your edits into the live document.')
    expect(out).toContain('Arguments:')
    expect(out).toContain('Options:')
    // The help row is appended automatically — callers never repeat it.
    expect(out).toContain('-h, --help')
    expect(out).toContain('Show this help message')
    expect(out).toContain('Examples:')
    expect(out).toContain('  glovebox push docs/note.md')
  })

  it('renders multiple usage lines under a Usage: block', () => {
    const out = renderHelp({
      name: 'glovebox pull',
      summary: 'fetch a file',
      usage: [
        'glovebox pull <path> --workspace <id>',
        'glovebox pull --file-id <id> --workspace <id>',
      ],
    })
    expect(out).toContain('Usage:\n  glovebox pull <path> --workspace <id>')
    expect(out).toContain('  glovebox pull --file-id <id> --workspace <id>')
  })

  it('omits the Arguments block when there are no positional args', () => {
    const out = renderHelp({
      name: 'glovebox list',
      summary: 'list mounts',
      usage: 'glovebox list',
    })
    expect(out).not.toContain('Arguments:')
    expect(out).toContain('Options:')
  })
})

describe('parseDurationSeconds', () => {
  it('accepts a bare number as seconds (the historical form)', () => {
    expect(parseDurationSeconds('30')).toBe(30)
    expect(parseDurationSeconds('1800')).toBe(1800)
  })

  it('accepts s/m/h suffixes', () => {
    expect(parseDurationSeconds('30s')).toBe(30)
    expect(parseDurationSeconds('10m')).toBe(600)
    expect(parseDurationSeconds('1h')).toBe(3600)
    expect(parseDurationSeconds('1.5m')).toBe(90)
  })

  it('rejects non-positive or malformed values', () => {
    expect(parseDurationSeconds('0')).toBeNull()
    expect(parseDurationSeconds('-5')).toBeNull()
    expect(parseDurationSeconds('abc')).toBeNull()
    expect(parseDurationSeconds('10x')).toBeNull()
    expect(parseDurationSeconds('')).toBeNull()
  })
})
