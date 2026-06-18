import { and, eq } from 'drizzle-orm'
import type { DocumentRole, MemberView } from '@glovebox.md/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { principal, workspaceMember } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import { bumpWorkspaceAuthEpochAndRecheck, requireWorkspaceOwner } from './workspace-access.ts'
import { createInvite } from './invite-handlers.ts'

export async function listMembers(
  input: { workspaceId: string },
  context: ORPCContext,
): Promise<{ members: MemberView[] }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceOwner(context, input.workspaceId)
  const rows = await db
    .select({ member: workspaceMember, principal })
    .from(workspaceMember)
    .innerJoin(principal, eq(principal.id, workspaceMember.principalId))
    .where(eq(workspaceMember.workspaceId, input.workspaceId))

  return { members: rows.map((row) => memberView(row.member, row.principal)) }
}

export async function inviteMember(
  input: { workspaceId: string; email: string; role: DocumentRole; owner: boolean },
  context: ORPCContext,
): Promise<{ inviteId: string }> {
  const invite = await createInvite(input, context)
  return { inviteId: invite.id }
}

export async function removeMember(
  input: { workspaceId: string; principalId: string },
  context: ORPCContext,
): Promise<{ ok: true; authEpoch: number }> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceOwner(context, input.workspaceId)

  if (access.member.principalId === input.principalId) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'owner_required' },
    })
  }

  await db
    .delete(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, input.workspaceId),
        eq(workspaceMember.principalId, input.principalId),
      ),
    )
  const authEpoch = await bumpWorkspaceAuthEpochAndRecheck(context, input.workspaceId, [
    input.principalId,
  ])
  return { ok: true, authEpoch }
}

export async function setMemberDocumentRole(
  input: { workspaceId: string; principalId: string; role: DocumentRole },
  context: ORPCContext,
): Promise<MemberView> {
  const db = createDb(context.env.DB)
  await requireWorkspaceOwner(context, input.workspaceId)
  await db
    .update(workspaceMember)
    .set({ role: input.role, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceMember.workspaceId, input.workspaceId),
        eq(workspaceMember.principalId, input.principalId),
      ),
    )
  await bumpWorkspaceAuthEpochAndRecheck(context, input.workspaceId, [input.principalId])
  return readMemberOrThrow(context, input.workspaceId, input.principalId)
}

export async function setMemberOwner(
  input: { workspaceId: string; principalId: string; owner: boolean },
  context: ORPCContext,
): Promise<MemberView> {
  const db = createDb(context.env.DB)
  await requireWorkspaceOwner(context, input.workspaceId)
  await db
    .update(workspaceMember)
    .set({ owner: input.owner, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceMember.workspaceId, input.workspaceId),
        eq(workspaceMember.principalId, input.principalId),
      ),
    )
  await bumpWorkspaceAuthEpochAndRecheck(context, input.workspaceId, [input.principalId])
  return readMemberOrThrow(context, input.workspaceId, input.principalId)
}

async function readMemberOrThrow(
  context: ORPCContext,
  workspaceId: string,
  principalId: string,
): Promise<MemberView> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select({ member: workspaceMember, principal })
    .from(workspaceMember)
    .innerJoin(principal, eq(principal.id, workspaceMember.principalId))
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        eq(workspaceMember.principalId, principalId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'member', id: principalId },
    })
  }
  return memberView(row.member, row.principal)
}

function memberView(
  member: typeof workspaceMember.$inferSelect,
  principalRow: typeof principal.$inferSelect,
): MemberView {
  return {
    workspaceId: member.workspaceId,
    principal: {
      id: principalRow.id,
      type: principalRow.type,
      displayName: principalRow.displayName,
      email: principalRow.email ?? undefined,
    },
    role: member.role,
    owner: member.owner,
    createdAt: member.createdAt.getTime(),
    updatedAt: member.updatedAt.getTime(),
  }
}
