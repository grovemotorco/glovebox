import { describe, expect, it } from 'vitest'
import { createGloveboxClient, type GloveboxClient } from '@glovebox/api'
import { signWorkspaceToken } from '@glovebox/sync/server'
import { CLAIMS_HEADER, worker } from '../src/dispatcher.ts'

type WorkerEnv = Parameters<NonNullable<typeof worker.fetch>>[1]
type WorkerExecutionContext = Parameters<NonNullable<typeof worker.fetch>>[2]
type WorkerD1Database = WorkerEnv['DB']

describe('worker dispatcher', () => {
  it('serves health before fallback routing', async () => {
    const response = await dispatch(new Request('https://api.glovebox.test/healthz'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('handles API CORS preflight before API placeholders', async () => {
    const response = await dispatch(
      new Request('https://api.glovebox.test/api/rpc/workspaces.list', { method: 'OPTIONS' }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS')
  })

  it('routes Better Auth requests before RPC and fallback routing', async () => {
    const response = await dispatch(new Request('https://api.glovebox.test/api/auth/get-session'))

    expect(response.status).not.toBe(501)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('serves the health procedure over RPC', async () => {
    const client = createTestClient()

    await expect(client.health.check()).resolves.toMatchObject({
      ok: true,
      apiVersion: 'v1',
    })
  })

  it('requires auth for workspace APIs instead of returning placeholders', async () => {
    const client = createTestClient()

    await expect(client.workspaces.list()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })

  it('serves OpenAPI metadata and docs from the REST surface', async () => {
    const spec = await dispatch(new Request('https://api.glovebox.test/openapi.json'))
    const docs = await dispatch(new Request('https://api.glovebox.test/docs'))

    expect(spec.status).toBe(200)
    await expect(spec.json()).resolves.toMatchObject({
      info: { title: 'Glovebox API', version: 'v1' },
    })
    expect(docs.status).toBe(200)
    expect(docs.headers.get('content-type')).toContain('text/html')
  })

  it('routes workspace upgrades to the workspace durable object without client claims', async () => {
    const calls: Request[] = []
    const response = await dispatch(
      new Request('https://api.glovebox.test/ws/acme%20docs', {
        headers: { Upgrade: 'websocket', [CLAIMS_HEADER]: '{"principalId":"spoofed","epoch":99}' },
      }),
      createEnv({
        fetch: (request) => {
          calls.push(request)
          return new Response('durable object')
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers.get(CLAIMS_HEADER)).toBeNull()
  })

  it('verifies workspace tokens and forwards full trusted claims', async () => {
    const calls: Request[] = []
    const token = await signWorkspaceToken(
      {
        workspaceId: 'ws-1',
        principalId: 'agent-1',
        principalType: 'agent',
        role: 'commenter',
        owner: true,
        epoch: 7,
        exp: Date.now() + 60_000,
      },
      'test-secret',
    )

    const response = await dispatch(
      new Request(`https://api.glovebox.test/ws/ws-1?token=${encodeURIComponent(token)}`, {
        headers: { Upgrade: 'websocket' },
      }),
      createEnv({
        secret: 'test-secret',
        fetch: (request) => {
          calls.push(request)
          return new Response('durable object')
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(JSON.parse(calls[0]?.headers.get(CLAIMS_HEADER) ?? '{}')).toEqual({
      principalId: 'agent-1',
      principalType: 'agent',
      role: 'commenter',
      owner: true,
      epoch: 7,
    })
  })

  it('rejects non-upgrade workspace requests before durable object dispatch', async () => {
    const response = await dispatch(new Request('https://api.glovebox.test/ws/acme'))

    expect(response.status).toBe(426)
    await expect(response.text()).resolves.toBe('Expected WebSocket')
  })

  it('forwards authorized admin lifecycle calls to the workspace durable object', async () => {
    const calls: Request[] = []
    const env = createEnv({
      secret: 'test-secret',
      fetch: (request) => {
        calls.push(request)
        return Response.json({ ok: true })
      },
    })
    const recheck = await dispatch(
      adminRequest('https://api.glovebox.test/admin/workspaces/ws-1/recheck'),
      env,
    )
    const deleted = await dispatch(
      adminRequest('https://api.glovebox.test/admin/workspaces/ws-1/deleted'),
      env,
    )

    expect(recheck.status).toBe(200)
    expect(deleted.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/admin/workspaces/ws-1/recheck')
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/admin/workspaces/ws-1/deleted')
  })

  it('renders the TanStack collab editor for app routes', async () => {
    const response = await dispatch(new Request('https://api.glovebox.test/'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('Glovebox')
    expect(body).toContain('docs/demo.md')
    expect(body).toContain('Markdown content')
  })
})

function dispatch(request: Request, env = createEnv()): Promise<Response> {
  const fetch = worker.fetch
  if (!fetch) {
    throw new Error('worker has no fetch handler')
  }
  return fetch(request, env, createExecutionContext())
}

function createEnv(
  options: {
    secret?: string
    fetch?: (request: Request) => Response
  } = {},
): WorkerEnv {
  const durableObjectNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: options.fetch ?? (() => new Response('durable object')),
    }),
  }

  return {
    DB: createFakeD1(),
    WORKSPACE_DO: durableObjectNamespace,
    WS_AUTH_SECRET: options.secret,
    BETTER_AUTH_SECRET: 'test-auth-secret',
    BETTER_AUTH_URL: 'https://api.glovebox.test',
    BETTER_AUTH_TRUSTED_ORIGIN: 'https://api.glovebox.test',
    BETTER_AUTH_COOKIE_DOMAIN: '.glovebox.test',
    BETTER_AUTH_DEV_PASSWORD: 'true',
  } as WorkerEnv
}

function createExecutionContext(): WorkerExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  }
}

function adminRequest(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-secret' },
  })
}

function createTestClient(env = createEnv()): GloveboxClient {
  return createGloveboxClient({
    baseUrl: 'https://api.glovebox.test',
    fetch: (request, init) => dispatch(new Request(request, init), env),
  })
}

function createFakeD1(): WorkerD1Database {
  const emptyResult = {
    results: [],
    success: true,
    meta: {},
  }
  return {
    prepare: () => ({
      bind() {
        return this
      },
      first: async () => null,
      all: async () => emptyResult,
      raw: async () => [],
      run: async () => emptyResult,
    }),
    batch: async () => [],
    dump: async () => new ArrayBuffer(0),
    exec: async () => emptyResult,
  } as WorkerD1Database
}
