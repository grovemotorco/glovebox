import { verifyWorkspaceToken } from '@glovebox/sync/server'
import { handleAppFallback } from './app-fallback.ts'
import { createDb } from './db/index.ts'
import { createAuth } from './lib/auth.ts'
import { dispatchOrpc } from './orpc/handlers.ts'

export type Env = {
  DB: D1Database
  EMAIL?: {
    send(message: {
      to: string
      from: { email: string; name?: string }
      subject: string
      text: string
      html: string
    }): Promise<unknown>
  }
  WORKSPACE_DO: DurableObjectNamespace
  AUTH_EMAIL_FROM?: string
  AUTH_EMAIL_FROM_NAME?: string
  AUTH_EMAIL_MODE?: 'send' | 'fake' | 'none'
  BETTER_AUTH_URL?: string
  BETTER_AUTH_TRUSTED_ORIGIN?: string
  BETTER_AUTH_COOKIE_DOMAIN?: string
  BETTER_AUTH_DEV_PASSWORD?: string
  BETTER_AUTH_SECRET?: string
  INVITATION_ACCEPT_URL?: string
  INVITATION_EMAIL_FROM?: string
  INVITATION_EMAIL_FROM_NAME?: string
  FAKE_AUTH_EMAILS?: AuthEmailMessage[]
  /**
   * HMAC secret for connection tokens and the internal admin bearer key.
   * Unset = dev mode: connections are anonymous and admin routes are disabled.
   */
  WS_AUTH_SECRET?: string
}

type AuthEmailMessage = {
  to: string
  subject: string
  text: string
  html: string
}

type WorkerHandler = ExportedHandler<Env>

export const CLAIMS_HEADER = 'x-glovebox-claims'

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Max-Age': '86400',
}

export const worker: WorkerHandler = {
  async fetch(request, env, executionCtx) {
    const url = new URL(request.url)

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true })
    }

    if (request.method === 'OPTIONS' && isApiPath(url.pathname)) {
      return new Response(null, { status: 204, headers: API_CORS_HEADERS })
    }

    if (url.pathname.startsWith('/api/auth/')) {
      return createAuth(createDb(env.DB), env).handler(request)
    }

    if (url.pathname.startsWith('/api/rpc/')) {
      return (
        (await dispatchOrpc(request, { request, env, executionCtx })) ??
        new Response('RPC route not found', { status: 404 })
      )
    }

    if (
      url.pathname.startsWith('/api/v1/') ||
      url.pathname === '/openapi.json' ||
      url.pathname === '/docs'
    ) {
      return (
        (await dispatchOrpc(request, { request, env, executionCtx })) ??
        new Response('REST route not found', { status: 404 })
      )
    }

    const workspaceId = matchWorkspaceSocketPath(url.pathname)
    if (workspaceId) {
      return handleWorkspaceSocket(request, env, workspaceId)
    }

    const adminRoute = matchAdminPath(url.pathname)
    if (adminRoute) {
      return handleWorkspaceAdmin(request, env, adminRoute.workspaceId)
    }

    return handleAppFallback(request)
  },
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/openapi.json' || pathname === '/docs'
}

function matchWorkspaceSocketPath(pathname: string): string | null {
  const match = /^\/ws\/([^/]+)$/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function matchAdminPath(pathname: string): { workspaceId: string } | null {
  const match = /^\/admin\/workspaces\/([^/]+)\/(?:recheck|deleted)$/.exec(pathname)
  return match?.[1] ? { workspaceId: decodeURIComponent(match[1]) } : null
}

async function handleWorkspaceSocket(
  request: Request,
  env: Env,
  workspaceId: string,
): Promise<Response> {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 })
  }

  const secret = env.WS_AUTH_SECRET
  const forwarded = new Request(request)
  forwarded.headers.delete(CLAIMS_HEADER)

  // The worker owns token verification (signature, expiry, workspaceId); the
  // DO gates on what only durable state knows (auth epoch, deletion).
  if (secret) {
    const token = new URL(request.url).searchParams.get('token')
    const claims = token ? await verifyWorkspaceToken(token, secret, Date.now()) : null
    if (!claims || claims.workspaceId !== workspaceId) {
      return new Response('unauthenticated', { status: 401 })
    }
    forwarded.headers.set(
      CLAIMS_HEADER,
      JSON.stringify({
        principalId: claims.principalId,
        principalType: claims.principalType,
        role: claims.role,
        owner: claims.owner,
        epoch: claims.epoch,
      }),
    )
  }

  const id = env.WORKSPACE_DO.idFromName(workspaceId)
  return env.WORKSPACE_DO.get(id).fetch(forwarded)
}

function handleWorkspaceAdmin(
  request: Request,
  env: Env,
  workspaceId: string,
): Response | Promise<Response> {
  const secret = env.WS_AUTH_SECRET
  if (
    request.method !== 'POST' ||
    !secret ||
    request.headers.get('Authorization') !== `Bearer ${secret}`
  ) {
    return new Response('forbidden', { status: 403 })
  }

  const id = env.WORKSPACE_DO.idFromName(workspaceId)
  return env.WORKSPACE_DO.get(id).fetch(request)
}
