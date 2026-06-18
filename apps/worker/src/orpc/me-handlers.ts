import { desc, eq } from 'drizzle-orm'
import type { MeView, SessionView, WorkspaceSummary } from '@glovebox.md/api'
import { createDb } from '../db/index.ts'
import { session, user } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import { requirePrincipal } from './auth-context.ts'
import { requireWorkspaceAccess } from './workspace-access.ts'
import { listWorkspaces } from './workspace-handlers.ts'

export async function getMe(context: ORPCContext): Promise<MeView> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  // Reuse the membership query so the workspace list (and its API-key scoping)
  // stays identical to workspaces.list.
  const { workspaces } = await listWorkspaces(context)
  const activeWorkspaceId = await resolveActiveWorkspaceId(db, principal.userId, workspaces)

  return {
    principal: {
      id: principal.id,
      type: principal.type,
      displayName: principal.displayName,
      ...(principal.email ? { email: principal.email } : {}),
    },
    activeWorkspaceId,
    workspaces,
  }
}

export async function listSessions(context: ORPCContext): Promise<{ sessions: SessionView[] }> {
  const db = createDb(context.env.DB)
  const principal = await requirePrincipal(context)
  const rows = await db
    .select()
    .from(session)
    .where(eq(session.userId, principal.userId))
    .orderBy(desc(session.createdAt))
    .limit(100)

  return {
    sessions: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      ...(row.userAgent ? { userAgent: row.userAgent.slice(0, 500) } : {}),
      ...(row.ipAddress ? { ipHint: row.ipAddress.slice(0, 128) } : {}),
    })),
  }
}

export async function setActiveWorkspace(
  input: { workspaceId: string },
  context: ORPCContext,
): Promise<{ activeWorkspaceId: string }> {
  const db = createDb(context.env.DB)
  // Membership + API-key scope gate: you may only activate a workspace you can read.
  await requireWorkspaceAccess(context, input.workspaceId)
  const principal = await requirePrincipal(context)

  await db
    .update(user)
    .set({ activeWorkspaceId: input.workspaceId, updatedAt: new Date() })
    .where(eq(user.id, principal.userId))

  return { activeWorkspaceId: input.workspaceId }
}

async function resolveActiveWorkspaceId(
  db: ReturnType<typeof createDb>,
  userId: string,
  workspaces: WorkspaceSummary[],
): Promise<string | null> {
  const rows = await db
    .select({ activeWorkspaceId: user.activeWorkspaceId })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  const stored = rows[0]?.activeWorkspaceId ?? null
  if (!stored) return null
  // Only surface an active workspace the caller can actually see, so the response
  // stays coherent with the (possibly scope-filtered) workspaces list.
  return workspaces.some((workspace) => workspace.id === stored) ? stored : null
}
