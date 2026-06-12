import { and, eq, sql } from 'drizzle-orm'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { workspace, workspaceMember } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import { requirePrincipal } from './auth-context.ts'

export type WorkspaceApiKeyScope = 'workspace:read' | 'workspace:write' | 'workspace:admin'

export async function requireWorkspaceAccess(
  context: ORPCContext,
  workspaceId: string,
  requiredScope: WorkspaceApiKeyScope = 'workspace:read',
) {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  requireApiKeyWorkspaceScope(principal, workspaceId, requiredScope)
  const rows = await db
    .select({ workspace, member: workspaceMember })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.principalId, principal.id),
      ),
    )
    .limit(1)
  const row = rows[0]

  if (!row) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'workspace', id: workspaceId },
    })
  }
  if (row.workspace.deletedAt) {
    throw new ORPCError('WORKSPACE_DELETED', {
      status: 410,
      message: 'Workspace deleted',
      data: { workspaceId },
    })
  }
  return row
}

function requireOwner(owner: boolean): void {
  if (!owner) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'owner_required' },
    })
  }
}

export function requireCanComment(access: { member: { role: string; owner: boolean } }): void {
  if (!access.member.owner && access.member.role === 'viewer') {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'commenter_required' },
    })
  }
}

export function requireCanEdit(access: { member: { role: string; owner: boolean } }): void {
  if (!access.member.owner && access.member.role !== 'editor') {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'editor_required' },
    })
  }
}

export async function requireWorkspaceOwner(context: ORPCContext, workspaceId: string) {
  const access = await requireWorkspaceAccess(context, workspaceId, 'workspace:admin')
  requireOwner(access.member.owner)
  return access
}

export async function bumpWorkspaceAuthEpoch(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
): Promise<number> {
  await db
    .update(workspace)
    .set({
      authEpoch: sql`${workspace.authEpoch} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(workspace.id, workspaceId))
  const rows = await db.select().from(workspace).where(eq(workspace.id, workspaceId)).limit(1)
  return rows[0]?.authEpoch ?? 0
}

export async function bumpWorkspaceAuthEpochAndRecheck(
  context: ORPCContext,
  workspaceId: string,
  principalIds: readonly string[] = [],
): Promise<number> {
  const authEpoch = await bumpWorkspaceAuthEpoch(createDb(context.env.DB), workspaceId)
  await recheckWorkspacePrincipals(context, workspaceId, principalIds)
  return authEpoch
}

export async function markWorkspaceDeletedInDo(
  context: ORPCContext,
  workspaceId: string,
): Promise<void> {
  const response = await fetchWorkspaceDoAdmin(context, workspaceId, 'deleted')
  if (!response.ok) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      status: 500,
      message: 'Failed to mark workspace deleted',
      data: { workspaceId },
    })
  }
}

async function recheckWorkspacePrincipals(
  context: ORPCContext,
  workspaceId: string,
  principalIds: readonly string[],
): Promise<void> {
  const response = await fetchWorkspaceDoAdmin(context, workspaceId, 'recheck', {
    principalIds: [...new Set(principalIds)],
  })
  if (!response.ok) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      status: 500,
      message: 'Failed to recheck workspace access',
      data: { workspaceId },
    })
  }
}

function requireApiKeyWorkspaceScope(
  principal: Awaited<ReturnType<typeof requirePrincipal>>,
  workspaceId: string,
  requiredScope: WorkspaceApiKeyScope,
): void {
  const apiKey = principal.apiKey
  if (!apiKey) return

  if (!apiKey.workspaceIds.includes(workspaceId)) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'scope_missing' },
    })
  }

  if (!hasWorkspaceScope(apiKey.scopes, requiredScope)) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'scope_missing' },
    })
  }
}

export function hasWorkspaceScope(
  scopes: readonly string[],
  requiredScope: WorkspaceApiKeyScope,
): boolean {
  if (scopes.includes('workspace:admin')) return true
  if (requiredScope === 'workspace:admin') return false
  if (scopes.includes('workspace:write')) return true
  return requiredScope === 'workspace:read' && scopes.includes('workspace:read')
}

export function fetchWorkspaceDoAdmin(
  context: ORPCContext,
  workspaceId: string,
  action:
    | 'recheck'
    | 'deleted'
    | 'recovery/list'
    | 'recovery/acknowledge'
    | 'text/tree'
    | 'text/read'
    | 'text/push',
  body?: unknown,
): Promise<Response> {
  const id = context.env.WORKSPACE_DO.idFromName(workspaceId)
  return context.env.WORKSPACE_DO.get(id).fetch(
    new Request(
      `https://internal.glovebox/admin/workspaces/${encodeURIComponent(workspaceId)}/${action}`,
      {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    ),
  )
}
