import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GloveboxClient, WorkspaceSummary } from '@glovebox.md/api'
import workspaces from '../../src/commands/workspaces.ts'
import { resolveAuthedClient } from '../../src/lib/client.ts'

vi.mock('../../src/lib/client.ts', () => ({
  resolveAuthedClient: vi.fn(),
}))

const resolveAuthedClientMock = vi.mocked(resolveAuthedClient)

function summary(id: string, name: string, slug?: string): WorkspaceSummary {
  return { id, name, slug, deleted: false, authEpoch: 0, createdAt: 0, updatedAt: 0 }
}

function stubClient(calls: {
  list: number
  creates: { name: string; slug?: string }[]
}): GloveboxClient {
  return {
    workspaces: {
      list: async () => {
        calls.list += 1
        return { workspaces: [summary('ws-1', 'Demo', 'demo')] }
      },
      create: async (input: { name: string; slug?: string }) => {
        calls.creates.push(input)
        return summary('ws-new', input.name, input.slug)
      },
    },
  } as unknown as GloveboxClient
}

describe('workspaces command parser', () => {
  beforeEach(() => {
    resolveAuthedClientMock.mockReset()
    process.exitCode = undefined
  })

  it('recognizes create after leading flags', async () => {
    const calls = { list: 0, creates: [] }
    resolveAuthedClientMock.mockResolvedValue({
      client: stubClient(calls),
      serverUrl: 'https://api.glovebox.test',
      source: 'flag',
      token: 'gbx_test',
    })

    const stdout = await captureStdout(() =>
      workspaces(['--server', 'https://api.glovebox.test', 'create', 'Demo', '--slug', 'demo'], {
        json: true,
        human: false,
      }),
    )

    expect(calls.list).toBe(0)
    expect(calls.creates).toEqual([{ name: 'Demo', slug: 'demo' }])
    expect(resolveAuthedClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'https://api.glovebox.test' }),
    )
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      serverUrl: 'https://api.glovebox.test',
      workspace: { id: 'ws-new', name: 'Demo', slug: 'demo' },
    })
  })

  it('recognizes explicit list after leading flags', async () => {
    const calls = { list: 0, creates: [] }
    resolveAuthedClientMock.mockResolvedValue({
      client: stubClient(calls),
      serverUrl: 'https://api.glovebox.test',
      source: 'flag',
      token: 'gbx_test',
    })

    const stdout = await captureStdout(() =>
      workspaces(['--server', 'https://api.glovebox.test', 'list'], { json: true, human: false }),
    )

    expect(calls.list).toBe(1)
    expect(calls.creates).toEqual([])
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      serverUrl: 'https://api.glovebox.test',
      workspaces: [{ id: 'ws-1', name: 'Demo', slug: 'demo' }],
    })
  })
})

async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    await fn()
    return lines
  } finally {
    console.log = original
  }
}
