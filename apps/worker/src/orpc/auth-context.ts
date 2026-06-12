import { eq } from 'drizzle-orm'
import type { KeyPurpose } from '@glovebox/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { apiKeyMetadata, principal } from '../db/schema/index.ts'
import { createAuth } from '../lib/auth.ts'
import { bootstrapPersonalWorkspaceForUser } from '../lib/workspace-bootstrap.ts'
import type { ORPCContext } from './index.ts'

export interface AuthPrincipal {
  id: string
  userId: string
  type: 'human' | 'agent'
  displayName: string
  email: string | null
  apiKey?: AuthApiKeyPrincipal
}

export interface AuthApiKeyPrincipal {
  id: string
  purpose: KeyPurpose
  scopes: string[]
  workspaceIds: string[]
}

export async function requirePrincipal(context: ORPCContext): Promise<AuthPrincipal> {
  const db = createDb(context.env.DB)
  const session = await createAuth(db, context.env).api.getSession({
    headers: context.request.headers,
  })

  if (!session?.user) {
    throw new ORPCError('UNAUTHENTICATED', {
      status: 401,
      message: 'Sign in required',
    })
  }

  const existing = await db
    .select()
    .from(principal)
    .where(eq(principal.userId, session.user.id))
    .limit(1)

  const row =
    existing[0] ??
    (await bootstrapPersonalWorkspaceForUser(db, {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    }).then((rows) => rows.principal))

  const apiKey = await readApiKeyPrincipal(db, session)

  return {
    id: row.id,
    userId: session.user.id,
    type: row.type,
    displayName: row.displayName,
    email: row.email ?? null,
    ...(apiKey ? { apiKey } : {}),
  }
}

async function readApiKeyPrincipal(
  db: ReturnType<typeof createDb>,
  session: { session?: { id?: unknown; token?: unknown } },
): Promise<AuthApiKeyPrincipal | undefined> {
  if (
    typeof session.session?.id !== 'string' ||
    typeof session.session.token !== 'string' ||
    !session.session.token.startsWith('gbx_')
  ) {
    return undefined
  }

  const rows = await db
    .select()
    .from(apiKeyMetadata)
    .where(eq(apiKeyMetadata.apiKeyId, session.session.id))
    .limit(1)
  const row = rows[0]
  if (!row) return undefined

  return {
    id: row.apiKeyId,
    purpose: row.purpose,
    scopes: parseStringArray(row.scopesJson),
    workspaceIds: parseStringArray(row.workspaceIdsJson),
  }
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}
