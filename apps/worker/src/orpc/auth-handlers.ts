import { signWorkspaceToken, verifyWorkspaceToken } from '@glovebox/sync/server'
import type { DeviceAuthorizationStartInput, DeviceAuthorizationStartOutput } from '@glovebox/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { createAuth } from '../lib/auth.ts'
import type { ORPCContext } from './index.ts'
import { requireWorkspaceAccess } from './workspace-access.ts'
import { createApiKey } from './key-handlers.ts'

const WORKSPACE_SOCKET_TOKEN_TTL_MS = 1000 * 60 * 5
const DEVICE_CLIENT_ID = 'glovebox-cli'
const PURPOSE_SCOPE_PREFIX = 'glovebox:purpose:'
const WORKSPACE_SCOPE_PREFIX = 'glovebox:workspace:'

export async function startDeviceAuthorization(
  input: DeviceAuthorizationStartInput,
  context: ORPCContext,
): Promise<DeviceAuthorizationStartOutput> {
  const response = await fetchAuth(context, '/device/code', {
    method: 'POST',
    body: {
      client_id: DEVICE_CLIENT_ID,
      scope: encodeDeviceScope(input.purpose, input.scopes, input.workspaceIds),
    },
  })
  const body = await jsonObject(response)
  if (!response.ok) {
    throw authEndpointError(response, body, 'Unable to start device authorization')
  }

  return {
    deviceCode: stringField(body, 'device_code'),
    userCode: stringField(body, 'user_code'),
    verificationUri: stringField(body, 'verification_uri'),
    verificationUriComplete: stringField(body, 'verification_uri_complete'),
    expiresAt: Date.now() + numberField(body, 'expires_in') * 1000,
    intervalSec: numberField(body, 'interval'),
  }
}

export async function pollDeviceAuthorization(
  input: { deviceCode: string },
  context: ORPCContext,
): Promise<{
  status: 'pending' | 'approved' | 'denied' | 'expired'
  apiKey?: string
  expiresAt?: number
}> {
  const response = await fetchAuth(context, '/device/token', {
    method: 'POST',
    body: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: input.deviceCode,
      client_id: DEVICE_CLIENT_ID,
    },
  })
  const body = await jsonObject(response)

  if (!response.ok) {
    const error = typeof body.error === 'string' ? body.error : ''
    if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' }
    if (error === 'expired_token') return { status: 'expired' }
    if (error === 'access_denied') return { status: 'denied' }
    throw authEndpointError(response, body, 'Unable to poll device authorization')
  }

  const accessToken = stringField(body, 'access_token')
  const scope = typeof body.scope === 'string' ? body.scope : ''
  const parsed = parseDeviceScope(scope)
  const apiKey = await createApiKey(
    {
      name: 'Glovebox CLI device key',
      purpose: parsed.purpose,
      scopes: parsed.scopes,
      workspaceIds: parsed.workspaceIds,
      expiresAt: null,
    },
    {
      ...context,
      request: new Request(context.request.url, {
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    },
  )

  return {
    status: 'approved',
    apiKey: apiKey.plaintext,
    expiresAt: apiKey.key.expiresAt ?? undefined,
  }
}

export async function approveDeviceAuthorization(
  input: { userCode: string },
  context: ORPCContext,
): Promise<{ ok: true }> {
  const claimed = await fetchAuth(
    context,
    `/device?user_code=${encodeURIComponent(input.userCode)}`,
    {
      method: 'GET',
      headers: context.request.headers,
    },
  )
  const claimedBody = await jsonObject(claimed)
  if (!claimed.ok) {
    throw authEndpointError(claimed, claimedBody, 'Unable to claim device authorization')
  }

  const response = await fetchAuth(context, '/device/approve', {
    method: 'POST',
    headers: context.request.headers,
    body: { userCode: input.userCode },
  })
  const body = await jsonObject(response)
  if (!response.ok) {
    throw authEndpointError(response, body, 'Unable to approve device authorization')
  }
  return { ok: true }
}

export async function mintWorkspaceSocketToken(
  input: { workspaceId: string },
  context: ORPCContext,
) {
  // Membership is checked even when minting no-ops, so a non-member still
  // gets a 403 rather than a quiet null.
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  if (!context.env.WS_AUTH_SECRET) {
    // Socket auth not configured (dev): the workspace socket accepts
    // tokenless connections, so report "no token needed" instead of
    // erroring — a 403 here logged on every (re)connect.
    return { token: null, claims: null }
  }
  const secret = workspaceSecret(context)
  const claims = {
    workspaceId: input.workspaceId,
    principalId: access.member.principalId,
    principalType: 'human' as const,
    role: access.member.role,
    owner: access.member.owner,
    epoch: access.workspace.authEpoch,
    exp: Date.now() + WORKSPACE_SOCKET_TOKEN_TTL_MS,
  }

  return {
    token: await signWorkspaceToken(claims, secret),
    claims,
  }
}

export async function verifyWorkspaceSocketToken(
  input: { workspaceId: string; tokenPayloadB64: string },
  context: ORPCContext,
): Promise<{ valid: boolean }> {
  const secret = workspaceSecret(context)
  const token = base64ToString(input.tokenPayloadB64)
  if (!token) {
    return { valid: false }
  }

  const claims = await verifyWorkspaceToken(token, secret, Date.now())
  return { valid: Boolean(claims && claims.workspaceId === input.workspaceId) }
}

function workspaceSecret(context: ORPCContext): string {
  const secret = context.env.WS_AUTH_SECRET
  if (!secret) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Workspace socket auth is not configured',
      data: { reason: 'scope_missing' },
    })
  }
  return secret
}

function base64ToString(value: string): string | null {
  try {
    if (typeof atob === 'function') {
      return atob(value)
    }
    const buffer = (
      globalThis as {
        Buffer?: { from(input: string, encoding: 'base64'): Uint8Array }
      }
    ).Buffer
    const decoded = buffer?.from(value, 'base64')
    return decoded ? new TextDecoder().decode(decoded) : null
  } catch {
    return null
  }
}

function fetchAuth(
  context: ORPCContext,
  path: string,
  init: { method: 'GET'; headers?: Headers } | { method: 'POST'; body: unknown; headers?: Headers },
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.method === 'POST') {
    headers.set('content-type', 'application/json')
  }
  const baseUrl = context.env.BETTER_AUTH_URL ?? new URL(context.request.url).origin
  return createAuth(createDb(context.env.DB), context.env).handler(
    new Request(`${baseUrl.replace(/\/$/, '')}/api/auth${path}`, {
      method: init.method,
      headers,
      body: init.method === 'POST' ? JSON.stringify(init.body) : undefined,
    }),
  )
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => ({}))
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') {
    throw new Error(`Auth endpoint did not return ${field}`)
  }
  return value
}

function numberField(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number') {
    throw new Error(`Auth endpoint did not return ${field}`)
  }
  return value
}

function authEndpointError(
  response: Response,
  body: Record<string, unknown>,
  fallback: string,
): ORPCError<string, unknown> {
  return new ORPCError(response.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', {
    status: response.status,
    message: typeof body.error === 'string' ? body.error : fallback,
  })
}

function encodeDeviceScope(
  purpose: DeviceAuthorizationStartInput['purpose'],
  scopes: string[],
  workspaceIds: string[],
): string {
  return [
    scopeToken(`${PURPOSE_SCOPE_PREFIX}${purpose}`),
    ...workspaceIds.map((workspaceId) => scopeToken(`${WORKSPACE_SCOPE_PREFIX}${workspaceId}`)),
    ...scopes.map(scopeToken),
  ].join(' ')
}

function parseDeviceScope(scope: string): {
  purpose: DeviceAuthorizationStartInput['purpose']
  scopes: string[]
  workspaceIds: string[]
} {
  let purpose: DeviceAuthorizationStartInput['purpose'] = 'cli'
  const scopes: string[] = []
  const workspaceIds: string[] = []
  for (const item of scope.split(/\s+/).filter(Boolean)) {
    const token = decodeURIComponent(item)
    if (token.startsWith(PURPOSE_SCOPE_PREFIX)) {
      const value = token.slice(PURPOSE_SCOPE_PREFIX.length)
      if (value === 'cli' || value === 'agent' || value === 'api') {
        purpose = value
      }
    } else if (token.startsWith(WORKSPACE_SCOPE_PREFIX)) {
      workspaceIds.push(token.slice(WORKSPACE_SCOPE_PREFIX.length))
    } else {
      scopes.push(token)
    }
  }
  return { purpose, scopes, workspaceIds }
}

function scopeToken(value: string): string {
  return encodeURIComponent(value)
}
