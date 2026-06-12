import { and, desc, eq, isNull } from 'drizzle-orm'
import type { WorkspaceCreateInput, WorkspaceSummary, WorkspaceUpdateInput } from '@glovebox/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { workspace, workspaceMember } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import { requirePrincipal } from './auth-context.ts'
import {
  bumpWorkspaceAuthEpoch,
  hasWorkspaceScope,
  markWorkspaceDeletedInDo,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from './workspace-access.ts'

export async function createWorkspace(
  input: WorkspaceCreateInput,
  context: ORPCContext,
): Promise<WorkspaceSummary> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  const now = new Date()
  const workspaceId = `ws_${crypto.randomUUID()}`
  const slug = input.slug ?? workspaceSlug(input.name, workspaceId)

  const workspaceRow = {
    id: workspaceId,
    name: input.name,
    slug,
    authEpoch: 0,
    deletedAt: null,
    createdByPrincipalId: principal.id,
    createdAt: now,
    updatedAt: now,
  }

  await db.insert(workspace).values(workspaceRow)
  await db.insert(workspaceMember).values({
    workspaceId,
    principalId: principal.id,
    role: 'editor',
    owner: true,
    createdAt: now,
    updatedAt: now,
  })

  return workspaceSummary(workspaceRow, { role: 'editor', owner: true })
}

export async function listWorkspaces(context: ORPCContext): Promise<{
  workspaces: WorkspaceSummary[]
  nextCursor?: string
}> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  const allowedWorkspaceIds = principal.apiKey
    ? new Set(assertApiKeyCanListWorkspaces(principal.apiKey))
    : null
  const rows = await db
    .select({ workspace, member: workspaceMember })
    .from(workspaceMember)
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .where(and(eq(workspaceMember.principalId, principal.id), isNull(workspace.deletedAt)))
    .orderBy(desc(workspace.updatedAt))
    .limit(100)

  return {
    workspaces: rows.flatMap((row) =>
      !allowedWorkspaceIds || allowedWorkspaceIds.has(row.workspace.id)
        ? [
            workspaceSummary(row.workspace, {
              role: row.member.role,
              owner: row.member.owner,
            }),
          ]
        : [],
    ),
  }
}

export async function getWorkspace(
  input: { workspaceId: string },
  context: ORPCContext,
): Promise<WorkspaceSummary> {
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  return workspaceSummary(access.workspace, {
    role: access.member.role,
    owner: access.member.owner,
  })
}

export async function updateWorkspace(
  input: WorkspaceUpdateInput,
  context: ORPCContext,
): Promise<WorkspaceSummary> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceOwner(context, input.workspaceId)

  const updated = {
    name: input.name ?? access.workspace.name,
    slug: input.slug ?? access.workspace.slug,
    updatedAt: new Date(),
  }

  await db.update(workspace).set(updated).where(eq(workspace.id, input.workspaceId))

  return workspaceSummary(
    {
      ...access.workspace,
      ...updated,
    },
    { role: access.member.role, owner: access.member.owner },
  )
}

export async function deleteWorkspace(
  input: { workspaceId: string },
  context: ORPCContext,
): Promise<{ ok: true }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceOwner(context, input.workspaceId)

  await db
    .update(workspace)
    .set({
      deletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(workspace.id, input.workspaceId))
  await bumpWorkspaceAuthEpoch(db, input.workspaceId)
  await markWorkspaceDeletedInDo(context, input.workspaceId)

  return { ok: true }
}

function workspaceSummary(
  row: typeof workspace.$inferSelect,
  access: Pick<typeof workspaceMember.$inferSelect, 'role' | 'owner'>,
): WorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug ?? undefined,
    deleted: Boolean(row.deletedAt),
    authEpoch: row.authEpoch,
    currentPrincipalRole: access.role,
    currentPrincipalOwner: access.owner,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }
}

function workspaceSlug(name: string, workspaceId: string): string {
  const base = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 96)
  return `${base || 'workspace'}-${workspaceId.slice(3, 15)}`
}

function assertApiKeyCanListWorkspaces(apiKey: {
  scopes: readonly string[]
  workspaceIds: readonly string[]
}): readonly string[] {
  if (!hasWorkspaceScope(apiKey.scopes, 'workspace:read')) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'scope_missing' },
    })
  }
  return apiKey.workspaceIds
}
