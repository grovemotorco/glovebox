import { and, eq } from 'drizzle-orm'
import type { DocumentRole, InviteView } from '@glovebox.md/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { workspace, workspaceInvite, workspaceMember } from '../db/schema/index.ts'
import {
  DEFAULT_INVITATION_ACCEPT_URL,
  invitationEmailMessage,
  sendInvitationEmail,
} from '../lib/auth-email.ts'
import { generateInviteToken, hashInviteToken } from '../lib/invite-token.ts'
import type { ORPCContext } from './index.ts'
import { requirePrincipal } from './auth-context.ts'
import { bumpWorkspaceAuthEpochAndRecheck, requireWorkspaceOwner } from './workspace-access.ts'

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 14

export async function createInvite(
  input: { workspaceId: string; email: string; role: DocumentRole; owner: boolean },
  context: ORPCContext,
): Promise<InviteView> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceOwner(context, input.workspaceId)
  const now = new Date()
  const token = generateInviteToken()
  const row = {
    id: `inv_${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    email: input.email,
    role: input.role,
    owner: input.owner,
    tokenHash: await hashInviteToken(token),
    status: 'pending' as const,
    invitedByPrincipalId: access.member.principalId,
    acceptedByPrincipalId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    acceptedAt: null,
  }

  await db.insert(workspaceInvite).values(row)
  await sendInvitationEmail(
    context.env,
    invitationEmailMessage({
      to: input.email,
      workspaceName: access.workspace.name,
      inviteToken: token,
      acceptUrl: context.env.INVITATION_ACCEPT_URL ?? DEFAULT_INVITATION_ACCEPT_URL,
    }),
  )

  return inviteView(row)
}

export async function listInvites(
  input: { workspaceId: string },
  context: ORPCContext,
): Promise<{ invites: InviteView[] }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceOwner(context, input.workspaceId)
  const rows = await db
    .select()
    .from(workspaceInvite)
    .where(eq(workspaceInvite.workspaceId, input.workspaceId))

  return { invites: rows.map(inviteView) }
}

export async function resendInvite(
  input: { workspaceId: string; inviteId: string },
  context: ORPCContext,
): Promise<{ ok: true; sentAt: number }> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceOwner(context, input.workspaceId)
  const invite = await readInviteOrThrow(context, input.workspaceId, input.inviteId)
  const token = generateInviteToken()
  const sentAt = new Date()

  await db
    .update(workspaceInvite)
    .set({
      tokenHash: await hashInviteToken(token),
      status: 'pending',
      updatedAt: sentAt,
      expiresAt: new Date(sentAt.getTime() + INVITE_TTL_MS),
    })
    .where(eq(workspaceInvite.id, input.inviteId))

  await sendInvitationEmail(
    context.env,
    invitationEmailMessage({
      to: invite.email,
      workspaceName: access.workspace.name,
      inviteToken: token,
      acceptUrl: context.env.INVITATION_ACCEPT_URL ?? DEFAULT_INVITATION_ACCEPT_URL,
    }),
  )

  return { ok: true, sentAt: sentAt.getTime() }
}

export async function cancelInvite(
  input: { workspaceId: string; inviteId: string },
  context: ORPCContext,
): Promise<{ ok: true; authEpoch: number }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceOwner(context, input.workspaceId)
  await readInviteOrThrow(context, input.workspaceId, input.inviteId)
  const now = new Date()

  await db
    .update(workspaceInvite)
    .set({ status: 'canceled', updatedAt: now })
    .where(eq(workspaceInvite.id, input.inviteId))
  const authEpoch = await bumpWorkspaceAuthEpochAndRecheck(context, input.workspaceId)

  return { ok: true, authEpoch }
}

export async function acceptInvite(
  input: { inviteToken: string },
  context: ORPCContext,
): Promise<InviteView> {
  const db = createDb(context.env.DB)
  const acceptingPrincipal = await requirePrincipal(context)
  const tokenHash = await hashInviteToken(input.inviteToken)
  const rows = await db
    .select({ invite: workspaceInvite, workspace })
    .from(workspaceInvite)
    .innerJoin(workspace, eq(workspace.id, workspaceInvite.workspaceId))
    .where(eq(workspaceInvite.tokenHash, tokenHash))
    .limit(1)
  const row = rows[0]

  if (!row || row.invite.status !== 'pending' || row.invite.expiresAt.getTime() <= Date.now()) {
    throw new ORPCError('INVITE_NOT_FOUND', {
      status: 404,
      message: 'Invite not found',
      data: { inviteId: 'unknown' },
    })
  }
  if (row.workspace.deletedAt) {
    throw new ORPCError('WORKSPACE_DELETED', {
      status: 410,
      message: 'Workspace deleted',
      data: { workspaceId: row.workspace.id },
    })
  }

  const now = new Date()
  await db
    .insert(workspaceMember)
    .values({
      workspaceId: row.invite.workspaceId,
      principalId: acceptingPrincipal.id,
      role: row.invite.role,
      owner: row.invite.owner,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceMember.workspaceId, workspaceMember.principalId],
      set: { role: row.invite.role, owner: row.invite.owner, updatedAt: now },
    })
  await db
    .update(workspaceInvite)
    .set({
      status: 'accepted',
      acceptedByPrincipalId: acceptingPrincipal.id,
      acceptedAt: now,
      updatedAt: now,
    })
    .where(eq(workspaceInvite.id, row.invite.id))
  await bumpWorkspaceAuthEpochAndRecheck(context, row.invite.workspaceId, [acceptingPrincipal.id])

  return inviteView({
    ...row.invite,
    status: 'accepted',
    acceptedByPrincipalId: acceptingPrincipal.id,
    acceptedAt: now,
    updatedAt: now,
  })
}

async function readInviteOrThrow(
  context: ORPCContext,
  workspaceId: string,
  inviteId: string,
): Promise<typeof workspaceInvite.$inferSelect> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select()
    .from(workspaceInvite)
    .where(and(eq(workspaceInvite.workspaceId, workspaceId), eq(workspaceInvite.id, inviteId)))
    .limit(1)
  const invite = rows[0]
  if (!invite) {
    throw new ORPCError('INVITE_NOT_FOUND', {
      status: 404,
      message: 'Invite not found',
      data: { inviteId },
    })
  }
  return invite
}

function inviteView(row: typeof workspaceInvite.$inferSelect): InviteView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role,
    owner: row.owner,
    status: row.status,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    acceptedAt: row.acceptedAt?.getTime(),
  }
}
