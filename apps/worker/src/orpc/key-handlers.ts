import { and, eq } from 'drizzle-orm'
import type { ApiKeyCreateOutput, ApiKeyView, KeyPurpose } from '@glovebox.md/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { apiKey as authApiKey, apiKeyMetadata } from '../db/schema/index.ts'
import { createAuth } from '../lib/auth.ts'
import type { ORPCContext } from './index.ts'
import { requirePrincipal } from './auth-context.ts'
import { bumpWorkspaceAuthEpochAndRecheck, requireWorkspaceOwner } from './workspace-access.ts'

export async function createApiKey(
  input: {
    name: string
    purpose: KeyPurpose
    scopes: string[]
    workspaceIds: string[]
    expiresAt?: number | null
  },
  context: ORPCContext,
): Promise<ApiKeyCreateOutput> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  await requireWorkspaceOwners(context, input.workspaceIds)

  const expiresIn =
    input.expiresAt === null || input.expiresAt === undefined
      ? null
      : Math.max(1, Math.ceil((input.expiresAt - Date.now()) / 1000))
  const created = await apiKeyAuthApi(db, context).createApiKey({
    headers: context.request.headers,
    body: {
      name: input.name,
      prefix: 'gbx_',
      expiresIn,
    },
  })
  const key = normalizeCreatedApiKey(created)
  const now = new Date()

  await db.insert(apiKeyMetadata).values({
    apiKeyId: key.id,
    principalId: principal.id,
    purpose: input.purpose,
    scopesJson: JSON.stringify(input.scopes),
    workspaceIdsJson: JSON.stringify(input.workspaceIds),
    createdAt: now,
    updatedAt: now,
  })

  return {
    key: apiKeyView(key, {
      purpose: input.purpose,
      scopes: input.scopes,
      workspaceIds: input.workspaceIds,
    }),
    plaintext: key.plaintext,
  }
}

export async function listApiKeys(context: ORPCContext): Promise<{ keys: ApiKeyView[] }> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  const rows = await db
    .select({ key: authApiKey, metadata: apiKeyMetadata })
    .from(apiKeyMetadata)
    .innerJoin(authApiKey, eq(authApiKey.id, apiKeyMetadata.apiKeyId))
    .where(eq(apiKeyMetadata.principalId, principal.id))

  return {
    keys: rows.map((row) =>
      apiKeyView(row.key, {
        purpose: row.metadata.purpose,
        scopes: parseStringArray(row.metadata.scopesJson),
        workspaceIds: parseStringArray(row.metadata.workspaceIdsJson),
      }),
    ),
  }
}

export async function deleteApiKey(
  input: { keyId: string },
  context: ORPCContext,
): Promise<{ ok: true; authEpoch: number }> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  const rows = await db
    .select()
    .from(apiKeyMetadata)
    .where(
      and(eq(apiKeyMetadata.apiKeyId, input.keyId), eq(apiKeyMetadata.principalId, principal.id)),
    )
    .limit(1)
  const metadata = rows[0]

  if (!metadata) {
    throw new ORPCError('KEY_NOT_FOUND', {
      status: 404,
      message: 'API key not found',
      data: { keyId: input.keyId },
    })
  }

  const workspaceIds = parseStringArray(metadata.workspaceIdsJson)
  await requireWorkspaceOwners(context, workspaceIds)
  await apiKeyAuthApi(db, context).deleteApiKey({
    headers: context.request.headers,
    body: { keyId: input.keyId },
  })
  await db.delete(apiKeyMetadata).where(eq(apiKeyMetadata.apiKeyId, input.keyId))
  let authEpoch = 0
  for (const workspaceId of workspaceIds) {
    authEpoch = Math.max(
      authEpoch,
      await bumpWorkspaceAuthEpochAndRecheck(context, workspaceId, [metadata.principalId]),
    )
  }

  return { ok: true, authEpoch }
}

async function requireWorkspaceOwners(context: ORPCContext, workspaceIds: string[]): Promise<void> {
  for (const workspaceId of workspaceIds) {
    await requireWorkspaceOwner(context, workspaceId)
  }
}

function apiKeyView(
  row: typeof authApiKey.$inferSelect | CreatedApiKey,
  metadata: { purpose: KeyPurpose; scopes: string[]; workspaceIds: string[] },
): ApiKeyView {
  return {
    id: row.id,
    name: row.name ?? 'API key',
    prefix: row.prefix ?? 'gbx_',
    purpose: metadata.purpose,
    scopes: metadata.scopes,
    workspaceIds: metadata.workspaceIds,
    createdAt: toTime(row.createdAt),
    lastUsedAt: toNullableTime('lastRequest' in row ? row.lastRequest : null),
    expiresAt: toNullableTime(row.expiresAt),
  }
}

type CreatedApiKey = {
  id: string
  name: string | null
  prefix: string | null
  key: string
  plaintext: string
  createdAt: Date | string
  expiresAt: Date | string | null
}

function normalizeCreatedApiKey(value: unknown): CreatedApiKey {
  const data = value as {
    id?: unknown
    name?: unknown
    prefix?: unknown
    key?: unknown
    createdAt?: unknown
    expiresAt?: unknown
  }
  if (typeof data.id !== 'string' || typeof data.key !== 'string') {
    throw new Error('Better Auth did not return an API key')
  }
  return {
    id: data.id,
    name: typeof data.name === 'string' ? data.name : null,
    prefix: typeof data.prefix === 'string' ? data.prefix : 'gbx_',
    key: data.key,
    plaintext: data.key,
    createdAt:
      data.createdAt instanceof Date || typeof data.createdAt === 'string'
        ? data.createdAt
        : new Date(),
    expiresAt:
      data.expiresAt instanceof Date || typeof data.expiresAt === 'string' ? data.expiresAt : null,
  }
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function toNullableTime(value: Date | string | null | undefined): number | null {
  return value ? toTime(value) : null
}

function apiKeyAuthApi(db: ReturnType<typeof createDb>, context: ORPCContext): ApiKeyAuthApi {
  return createAuth(db, context.env).api as unknown as ApiKeyAuthApi
}

interface ApiKeyAuthApi {
  createApiKey(input: {
    headers: Headers
    body: {
      name: string
      prefix: string
      expiresIn: number | null
    }
  }): Promise<unknown>
  deleteApiKey(input: {
    headers: Headers
    body: {
      keyId: string
    }
  }): Promise<{ success: boolean }>
}
