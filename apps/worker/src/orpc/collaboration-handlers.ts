import { and, eq } from 'drizzle-orm'
import type { CommentThread, Suggestion } from '@glovebox/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { commentThread, suggestion } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import { requirePrincipal } from './auth-context.ts'
import { requireCanComment, requireCanEdit, requireWorkspaceAccess } from './workspace-access.ts'
import { readDocumentOrThrow, readVersionOrThrow } from './document-handlers.ts'
import { pushTextLive } from './text-handlers.ts'
import { sha256Hex } from '@glovebox/sync'

type RangeInput = { start: number; end: number; stale?: boolean }

export async function createComment(
  input: {
    workspaceId: string
    fileId: string
    baseVersionId: string
    range: RangeInput
    body: string
  },
  context: ORPCContext,
): Promise<CommentThread> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  requireCanComment(access)
  const principal = await requirePrincipal(context)
  await readDocumentOrThrow(context, input.workspaceId, input.fileId)
  await readVersionOrThrow(context, input.workspaceId, input.fileId, input.baseVersionId)
  const now = new Date()
  const row = {
    id: `com_${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    fileId: input.fileId,
    baseVersionId: input.baseVersionId,
    rangeStart: input.range.start,
    rangeEnd: input.range.end,
    rangeStale: input.range.stale ?? false,
    status: 'open' as const,
    body: input.body,
    authorPrincipalId: principal.id,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  }
  await db.insert(commentThread).values(row)
  return commentThreadView(row)
}

export async function listComments(
  input: { workspaceId: string; fileId: string },
  context: ORPCContext,
): Promise<{ threads: CommentThread[] }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceAccess(context, input.workspaceId)
  const rows = await db
    .select()
    .from(commentThread)
    .where(
      and(eq(commentThread.workspaceId, input.workspaceId), eq(commentThread.fileId, input.fileId)),
    )
  return { threads: rows.map(commentThreadView) }
}

export async function resolveComment(
  input: { workspaceId: string; threadId: string },
  context: ORPCContext,
): Promise<CommentThread> {
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  requireCanComment(access)
  return updateCommentStatus(context, input.workspaceId, input.threadId, 'resolved')
}

export async function reopenComment(
  input: { workspaceId: string; threadId: string },
  context: ORPCContext,
): Promise<CommentThread> {
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  requireCanComment(access)
  return updateCommentStatus(context, input.workspaceId, input.threadId, 'open')
}

export async function deleteComment(
  input: { workspaceId: string; threadId: string },
  context: ORPCContext,
): Promise<{ ok: true }> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  const row = await readCommentOrThrow(context, input.workspaceId, input.threadId)
  const principal = await requirePrincipal(context)
  if (!access.member.owner && row.authorPrincipalId !== principal.id) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'owner_or_author_required' },
    })
  }
  await db.delete(commentThread).where(eq(commentThread.id, input.threadId))
  return { ok: true }
}

export async function proposeSuggestion(
  input: {
    workspaceId: string
    fileId: string
    baseVersionId: string
    range: RangeInput
    replacementText: string
  },
  context: ORPCContext,
): Promise<Suggestion> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  requireCanComment(access)
  const principal = await requirePrincipal(context)
  await readDocumentOrThrow(context, input.workspaceId, input.fileId)
  await readVersionOrThrow(context, input.workspaceId, input.fileId, input.baseVersionId)
  const now = new Date()
  const row = {
    id: `sug_${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    fileId: input.fileId,
    baseVersionId: input.baseVersionId,
    rangeStart: input.range.start,
    rangeEnd: input.range.end,
    rangeStale: input.range.stale ?? false,
    replacementText: input.replacementText,
    status: 'open' as const,
    authorPrincipalId: principal.id,
    createdAt: now,
    decidedByPrincipalId: null,
    decidedAt: null,
  }
  await db.insert(suggestion).values(row)
  return suggestionView(row)
}

export async function listSuggestions(
  input: { workspaceId: string; fileId: string },
  context: ORPCContext,
): Promise<{ suggestions: Suggestion[] }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceAccess(context, input.workspaceId)
  const rows = await db
    .select()
    .from(suggestion)
    .where(and(eq(suggestion.workspaceId, input.workspaceId), eq(suggestion.fileId, input.fileId)))
  return { suggestions: rows.map(suggestionView) }
}

export async function acceptSuggestion(
  input: { workspaceId: string; suggestionId: string },
  context: ORPCContext,
): Promise<Suggestion> {
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  requireCanEdit(access)
  return applySuggestion(context, input.workspaceId, input.suggestionId, access.member.principalId)
}

export async function rejectSuggestion(
  input: { workspaceId: string; suggestionId: string },
  context: ORPCContext,
): Promise<Suggestion> {
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  requireCanEdit(access)
  return decideSuggestion(context, input.workspaceId, input.suggestionId, 'rejected')
}

export async function deleteSuggestion(
  input: { workspaceId: string; suggestionId: string },
  context: ORPCContext,
): Promise<{ ok: true }> {
  const db = createDb(context.env.DB)
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  const row = await readSuggestionOrThrow(context, input.workspaceId, input.suggestionId)
  const principal = await requirePrincipal(context)
  if (!access.member.owner && row.authorPrincipalId !== principal.id) {
    throw new ORPCError('FORBIDDEN', {
      status: 403,
      message: 'Forbidden',
      data: { reason: 'owner_or_author_required' },
    })
  }
  await db.delete(suggestion).where(eq(suggestion.id, input.suggestionId))
  return { ok: true }
}

async function updateCommentStatus(
  context: ORPCContext,
  workspaceId: string,
  threadId: string,
  status: 'open' | 'resolved',
): Promise<CommentThread> {
  const db = createDb(context.env.DB)
  await readCommentOrThrow(context, workspaceId, threadId)
  const now = new Date()
  await db
    .update(commentThread)
    .set({
      status,
      updatedAt: now,
      resolvedAt: status === 'resolved' ? now : null,
    })
    .where(and(eq(commentThread.workspaceId, workspaceId), eq(commentThread.id, threadId)))
  return commentThreadView(await readCommentOrThrow(context, workspaceId, threadId))
}

async function decideSuggestion(
  context: ORPCContext,
  workspaceId: string,
  suggestionId: string,
  status: 'accepted' | 'rejected',
): Promise<Suggestion> {
  const db = createDb(context.env.DB)
  await readSuggestionOrThrow(context, workspaceId, suggestionId)
  const principal = await requirePrincipal(context)
  const now = new Date()
  await db
    .update(suggestion)
    .set({ status, decidedByPrincipalId: principal.id, decidedAt: now })
    .where(and(eq(suggestion.workspaceId, workspaceId), eq(suggestion.id, suggestionId)))
  return suggestionView(await readSuggestionOrThrow(context, workspaceId, suggestionId))
}

async function applySuggestion(
  context: ORPCContext,
  workspaceId: string,
  suggestionId: string,
  principalId: string,
): Promise<Suggestion> {
  const db = createDb(context.env.DB)
  const row = await readSuggestionOrThrow(context, workspaceId, suggestionId)
  if (row.status !== 'open') {
    return suggestionView(row)
  }

  const document = await readDocumentOrThrow(context, workspaceId, row.fileId)
  const base = await readVersionOrThrow(context, workspaceId, row.fileId, row.baseVersionId)
  if (
    document.currentVersionId !== row.baseVersionId ||
    row.rangeStart > row.rangeEnd ||
    row.rangeEnd > base.text.length
  ) {
    await db
      .update(suggestion)
      .set({ rangeStale: true })
      .where(and(eq(suggestion.workspaceId, workspaceId), eq(suggestion.id, suggestionId)))
    throw new ORPCError('STALE_VERSION', {
      status: 409,
      message: 'Document version is stale',
      data: { fileId: row.fileId, expectedVersionId: document.currentVersionId ?? undefined },
    })
  }

  const nextText =
    base.text.slice(0, row.rangeStart) + row.replacementText + base.text.slice(row.rangeEnd)
  // Land the acceptance through the live DO merge (D5): the replacement
  // anchors at the suggestion's base text and merges with concurrent live
  // edits. `baseText` is always supplied, so `base-missing` cannot occur.
  const pushed = await pushTextLive(context, {
    workspaceId,
    fileId: row.fileId,
    newText: nextText,
    baseHashHex: sha256Hex(base.text),
    baseText: base.text,
    idempotencyKey: `suggestion:${row.id}`,
    principalId,
    label: `suggestion:${row.id}`,
  })
  if (pushed.status !== 'applied' || pushed.failedHunks.length > 0) {
    // The live document drifted past where the suggestion can apply
    // cleanly — honest refusal, range marked stale, nothing recorded.
    await db
      .update(suggestion)
      .set({ rangeStale: true })
      .where(and(eq(suggestion.workspaceId, workspaceId), eq(suggestion.id, suggestionId)))
    throw new ORPCError('STALE_VERSION', {
      status: 409,
      message: 'Document version is stale',
      data: { fileId: row.fileId, expectedVersionId: document.currentVersionId ?? undefined },
    })
  }

  const now = new Date()
  await db
    .update(suggestion)
    .set({ status: 'accepted', decidedByPrincipalId: principalId, decidedAt: now })
    .where(and(eq(suggestion.workspaceId, workspaceId), eq(suggestion.id, suggestionId)))
  return suggestionView(await readSuggestionOrThrow(context, workspaceId, suggestionId))
}

async function readCommentOrThrow(
  context: ORPCContext,
  workspaceId: string,
  threadId: string,
): Promise<typeof commentThread.$inferSelect> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select()
    .from(commentThread)
    .where(and(eq(commentThread.workspaceId, workspaceId), eq(commentThread.id, threadId)))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'comment', id: threadId },
    })
  }
  return row
}

async function readSuggestionOrThrow(
  context: ORPCContext,
  workspaceId: string,
  suggestionId: string,
): Promise<typeof suggestion.$inferSelect> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select()
    .from(suggestion)
    .where(and(eq(suggestion.workspaceId, workspaceId), eq(suggestion.id, suggestionId)))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'suggestion', id: suggestionId },
    })
  }
  return row
}

function commentThreadView(row: typeof commentThread.$inferSelect): CommentThread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    fileId: row.fileId,
    baseVersionId: row.baseVersionId,
    range: { start: row.rangeStart, end: row.rangeEnd, stale: row.rangeStale },
    status: row.status,
    body: row.body,
    authorPrincipalId: row.authorPrincipalId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    resolvedAt: row.resolvedAt?.getTime(),
  }
}

function suggestionView(row: typeof suggestion.$inferSelect): Suggestion {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    fileId: row.fileId,
    baseVersionId: row.baseVersionId,
    range: { start: row.rangeStart, end: row.rangeEnd, stale: row.rangeStale },
    replacementText: row.replacementText,
    status: row.status,
    authorPrincipalId: row.authorPrincipalId,
    createdAt: row.createdAt.getTime(),
    decidedBy: row.decidedByPrincipalId ?? undefined,
    decidedAt: row.decidedAt?.getTime(),
  }
}
