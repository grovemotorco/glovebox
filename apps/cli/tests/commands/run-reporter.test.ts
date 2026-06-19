import { describe, expect, it } from 'vitest'
import { createRunReporter } from '../../src/commands/run.ts'

const ctx = {
  dir: '/d',
  workspaceId: 'ws-1',
  mountId: 'm-1',
  serverUrl: 'https://api.glovebox.test',
}

function captureStdout(fn: () => void): string[] {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    fn()
    return lines
  } finally {
    console.log = original
  }
}

describe('createRunReporter (json)', () => {
  it('emits typed start / connected / log lines, each valid JSON with a ts', () => {
    const reporter = createRunReporter(true, ctx)
    const events = captureStdout(() => {
      reporter.start()
      reporter.connected()
      reporter.log('warn', 'no credentials')
    }).map((line) => JSON.parse(line))

    expect(events[0]).toMatchObject({
      type: 'start',
      command: 'glovebox run',
      dir: '/d',
      workspaceId: 'ws-1',
      mountId: 'm-1',
    })
    expect(events[0].ts).toEqual(expect.any(String))
    expect(events[1]).toMatchObject({ type: 'connected', serverUrl: 'https://api.glovebox.test' })
    expect(events[2]).toMatchObject({ type: 'log', level: 'warn', message: 'no credentials' })
  })

  it('terminal(0) is a result envelope with nextActions (the HATEOAS terminal line)', () => {
    const reporter = createRunReporter(true, ctx)
    const [line] = captureStdout(() => reporter.terminal(0))
    const event = JSON.parse(line!)
    expect(event).toMatchObject({
      type: 'result',
      ok: true,
      command: 'glovebox run',
      result: { dir: '/d', workspaceId: 'ws-1', mountId: 'm-1', reason: 'stopped' },
    })
    expect(event.nextActions[0].command).toContain('glovebox status')
  })

  it('terminal(1, payload) is an error envelope with fix + nextActions', () => {
    const reporter = createRunReporter(true, ctx)
    const [line] = captureStdout(() =>
      reporter.terminal(1, {
        message: 'server closed this mount',
        code: 'SERVER_CLOSED',
        fix: 'check `glovebox whoami`',
        nextActions: [{ command: 'glovebox whoami', description: 'check access' }],
      }),
    )
    const event = JSON.parse(line!)
    expect(event).toMatchObject({
      type: 'error',
      ok: false,
      command: 'glovebox run',
      error: { message: 'server closed this mount', code: 'SERVER_CLOSED' },
      fix: 'check `glovebox whoami`',
    })
    expect(event.nextActions[0].command).toBe('glovebox whoami')
  })
})

describe('createRunReporter (human)', () => {
  it('prints [glovebox] banner lines, not JSON', () => {
    const reporter = createRunReporter(false, ctx)
    const lines = captureStdout(() => reporter.start())
    expect(lines.join('\n')).toContain('[glovebox] syncing /d ↔ workspace ws-1')
    expect(() => JSON.parse(lines[0]!)).toThrow()
  })
})
