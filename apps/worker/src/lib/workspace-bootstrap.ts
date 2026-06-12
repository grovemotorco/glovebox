import { eq } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { principal, user as authUser, workspace, workspaceMember } from '../db/schema/index.ts'

export interface AuthCreatedUser {
  id: string
  name: string
  email?: string | null
}

export interface PersonalWorkspaceBootstrapRows {
  principal: typeof principal.$inferInsert
  workspace: typeof workspace.$inferInsert
  member: typeof workspaceMember.$inferInsert
}

export async function bootstrapPersonalWorkspaceForUser(
  db: Database,
  user: AuthCreatedUser,
): Promise<PersonalWorkspaceBootstrapRows> {
  const rows = personalWorkspaceBootstrapRows(user, Date.now())

  await db.insert(principal).values(rows.principal).onConflictDoNothing()
  await db.insert(workspace).values(rows.workspace).onConflictDoNothing()
  await db.insert(workspaceMember).values(rows.member).onConflictDoNothing()
  await db
    .update(authUser)
    .set({ activeWorkspaceId: rows.workspace.id, updatedAt: new Date(rows.workspace.updatedAt) })
    .where(eq(authUser.id, user.id))

  return rows
}

export function personalWorkspaceBootstrapRows(
  user: AuthCreatedUser,
  now: number,
): PersonalWorkspaceBootstrapRows {
  const principalId = humanPrincipalId(user.id)
  const workspaceId = personalWorkspaceId(user.id)
  const displayName = user.name.trim() || user.email?.split('@')[0]?.trim() || 'Glovebox User'

  return {
    principal: {
      id: principalId,
      type: 'human',
      userId: user.id,
      displayName,
      email: user.email ?? null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    workspace: {
      id: workspaceId,
      name: `${displayName}'s Workspace`,
      slug: personalWorkspaceSlug(displayName, user.id),
      authEpoch: 0,
      createdByPrincipalId: principalId,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
    member: {
      workspaceId,
      principalId,
      role: 'editor',
      owner: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  }
}

export function humanPrincipalId(userId: string): string {
  return `human_${stableIdPart(userId)}`
}

export function personalWorkspaceId(userId: string): string {
  return `ws_${stableIdPart(userId)}`
}

export function personalWorkspaceSlug(displayName: string, userId: string): string {
  const base = displayName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 80)
  const safeBase = base || 'workspace'
  return `${safeBase}-${stableIdPart(userId).slice(0, 12)}`
}

function stableIdPart(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'unknown'
}
