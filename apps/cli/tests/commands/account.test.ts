import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GloveboxClient, WorkspaceSummary } from '@glovebox.md/api'
import { gloveboxPaths, type GloveboxPaths } from '../../src/lib/paths.ts'
import { runAuthStatus, runAuthUse, runLogin } from '../../src/commands/auth.ts'
import { runWhoami } from '../../src/commands/whoami.ts'
import { runWorkspaceCreate, runWorkspacesList } from '../../src/commands/workspaces.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempHome(): Promise<GloveboxPaths> {
  const dir = await mkdtemp(join(tmpdir(), 'glovebox-account-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return gloveboxPaths({ GLOVEBOX_HOME: dir })
}

function summary(id: string, name: string): WorkspaceSummary {
  return { id, name, deleted: false, authEpoch: 0, createdAt: 0, updatedAt: 0 }
}

function stubClient(): GloveboxClient {
  return {
    me: {
      get: async () => ({
        principal: { id: 'p1', type: 'human' as const, displayName: 'Tester' },
        activeWorkspaceId: 'ws-1',
        workspaces: [summary('ws-1', 'Demo')],
      }),
    },
    workspaces: {
      list: async () => ({ workspaces: [summary('ws-1', 'Demo')] }),
      create: async (input: { name: string; slug?: string }) => summary('ws-new', input.name),
    },
  } as unknown as GloveboxClient
}

describe('whoami', () => {
  it('returns the server identity via an injected client', async () => {
    const { me, workspaces } = await runWhoami({ client: stubClient(), serverUrl: 'https://x' })
    expect(me?.principal.id).toBe('p1')
    expect(me?.activeWorkspaceId).toBe('ws-1')
    expect(workspaces).toHaveLength(1)
  })

  it('falls back to workspaces.list when me.get is not implemented (501)', async () => {
    const notImplemented = Object.assign(new Error('me.get is not implemented yet'), {
      status: 501,
      code: 'NOT_IMPLEMENTED',
    })
    const client = {
      me: {
        get: async () => {
          throw notImplemented
        },
      },
      workspaces: { list: async () => ({ workspaces: [summary('ws-1', 'Demo')] }) },
    } as unknown as GloveboxClient

    const result = await runWhoami({ client, serverUrl: 'https://x' })
    expect(result.me).toBeNull()
    expect(result.workspaces.map((w) => w.id)).toEqual(['ws-1'])
  })
})

describe('workspaces', () => {
  it('lists and creates via an injected client', async () => {
    const listed = await runWorkspacesList({ client: stubClient() })
    expect(listed.workspaces.map((w) => w.id)).toEqual(['ws-1'])

    const created = await runWorkspaceCreate({ name: 'New WS', client: stubClient() })
    expect(created.workspace).toMatchObject({ id: 'ws-new', name: 'New WS' })
  })
})

describe('login records the default server', () => {
  it('sets the config default and flags it in auth status; auth use overrides it', async () => {
    const paths = await tempHome()
    await runLogin({ server: 'https://api.glovebox.md', token: 'gbx_fake', paths })

    const status = await runAuthStatus({ paths })
    expect(status.defaultServer).toBe('https://api.glovebox.md')
    expect(status.servers).toHaveLength(1)
    expect(status.servers[0]).toMatchObject({
      serverUrl: 'https://api.glovebox.md',
      isApiKey: true,
      isDefault: true,
    })

    await runAuthUse({ server: 'https://api.glovebox.test', paths })
    expect((await runAuthStatus({ paths })).defaultServer).toBe('https://api.glovebox.test')
  })
})
