import { and, desc, eq } from 'drizzle-orm'
import type { DocumentMetadata, TextPushInput, TextPushResult } from '@glovebox/api'
import type { WorkspaceTreeEntry } from '@glovebox/core'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { documentVersion, workspaceDocument } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import {
  fetchWorkspaceDoAdmin,
  requireCanEdit,
  requireWorkspaceAccess,
} from './workspace-access.ts'

/**
 * D5 text-push tier (spec §5.3) over LIVE WorkspaceDO state. These handlers
 * replace the A6 D1-only placeholder: the DO performs the three-way merge
 * under a server-owned peer ID, and the D1 document/version tables become
 * post-merge METADATA carrying the real Loro version vector — this is also
 * the production ingestion path for the A6 metadata layer.
 */

interface DoTextReadFile {
  status: 'ok' | 'not-found'
  fileId: string
  path: string
  text: string
  hashHex: string
  contentVersionB64: string
  sizeBytes: number
  seq?: number
  modifiedBy?: string
  modifiedAt?: number
}

type DoTextPushResult =
  | {
      status: 'applied'
      changed: boolean
      failedHunks: string[]
      path: string
      text: string
      hashHex: string
      contentVersionB64: string
    }
  | { status: 'base-missing' }
  | { status: 'degenerate-rewrite'; deletedRatio: number }
  | { status: 'not-found' }
  | { status: 'too-large' }

export async function getWorkspaceTree(
  input: { workspaceId: string },
  context: ORPCContext,
): Promise<{ entries: WorkspaceTreeEntry[]; seq: number }> {
  await requireWorkspaceAccess(context, input.workspaceId)
  const body = await bridgeText(context, input.workspaceId, 'text/tree', {})
  const entries = (Array.isArray(body.entries) ? body.entries : []) as WorkspaceTreeEntry[]
  return {
    entries: entries.map(treeEntryView),
    seq: typeof body.currentSeq === 'number' ? body.currentSeq : 0,
  }
}

export async function readWorkspaceText(
  input: { workspaceId: string; path?: string; fileId?: string },
  context: ORPCContext,
): Promise<{
  document: DocumentMetadata
  text: string
  hashHex: string
  contentVersionB64: string
  role: 'viewer' | 'commenter' | 'editor'
}> {
  const access = await requireWorkspaceAccess(context, input.workspaceId)
  const fileId = input.fileId ?? (await resolveFileIdByPath(context, input.workspaceId, input.path))
  const body = await bridgeText(context, input.workspaceId, 'text/read', { fileId })
  const file = body.file as DoTextReadFile | undefined
  if (!file || file.status !== 'ok') {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'document', id: fileId },
    })
  }
  return {
    document: await documentMetadataFromLive(context, input.workspaceId, file),
    text: file.text,
    hashHex: file.hashHex,
    contentVersionB64: file.contentVersionB64,
    role: access.member.role,
  }
}

export async function pushWorkspaceText(
  input: TextPushInput,
  context: ORPCContext,
): Promise<TextPushResult> {
  const access = await requireWorkspaceAccess(context, input.workspaceId, 'workspace:write')
  requireCanEdit(access)
  return pushTextLive(context, {
    workspaceId: input.workspaceId,
    fileId: input.fileId,
    newText: input.newText,
    baseHashHex: input.baseHashHex,
    baseText: input.baseText,
    force: input.force,
    idempotencyKey: input.idempotencyKey,
    principalId: access.member.principalId,
    label: `push:${input.idempotencyKey}`,
  })
}

/**
 * Shared live-push core: bridge the merge to the DO, then record the
 * post-merge D1 version row with the REAL Loro version vector. Used by
 * `workspaces.textPush` and `suggestions.accept` (its sync-safety becomes
 * real here — the merge happens against live state, not the D1 shadow).
 */
export async function pushTextLive(
  context: ORPCContext,
  input: {
    workspaceId: string
    fileId: string
    newText: string
    baseHashHex: string
    baseText?: string
    force?: boolean
    idempotencyKey: string
    principalId: string
    label: string
  },
): Promise<TextPushResult> {
  const body = await bridgeText(context, input.workspaceId, 'text/push', {
    fileId: input.fileId,
    newText: input.newText,
    baseHashHex: input.baseHashHex,
    baseText: input.baseText,
    force: input.force === true,
    idempotencyKey: input.idempotencyKey,
    modifiedBy: input.principalId,
  })
  const result = body.result as DoTextPushResult | undefined
  if (!result) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      status: 500,
      message: 'Workspace text bridge failed',
      data: { workspaceId: input.workspaceId },
    })
  }

  switch (result.status) {
    case 'not-found':
      throw new ORPCError('NOT_FOUND', {
        status: 404,
        message: 'Not found',
        data: { resource: 'document', id: input.fileId },
      })
    case 'too-large':
      throw new ORPCError('PAYLOAD_TOO_LARGE', {
        status: 413,
        message: 'Text exceeds the size limit',
        data: { fileId: input.fileId },
      })
    case 'base-missing':
      return { status: 'base-missing', fileId: input.fileId }
    case 'degenerate-rewrite':
      return {
        status: 'degenerate-rewrite',
        fileId: input.fileId,
        deletedRatio: result.deletedRatio,
      }
    case 'applied': {
      // A no-op merge (idempotent replay, equal text, or every hunk
      // failed) mints no version row — versions record actual change.
      const version = result.changed
        ? await recordTextVersion(context, {
            workspaceId: input.workspaceId,
            fileId: input.fileId,
            path: result.path,
            text: result.text,
            contentVersionB64: result.contentVersionB64,
            createdByPrincipalId: input.principalId,
            label: input.label,
          })
        : await latestVersionOrRecord(context, input, result)
      return {
        status: 'applied',
        fileId: input.fileId,
        versionId: version.versionId,
        changed: result.changed,
        failedHunks: result.failedHunks,
        text: result.text,
        hashHex: result.hashHex,
        contentVersionB64: result.contentVersionB64,
      }
    }
  }
}

/**
 * Post-merge metadata writer (replaces the A6 `appendTextVersion`
 * placeholder): a `documentVersion` row whose `contentVersionB64` is the
 * REAL post-merge Loro version vector, plus the `workspaceDocument` upsert
 * that gives the A6 layer its production writer. Idempotent per label —
 * a replayed push returns the recorded version row.
 */
export async function recordTextVersion(
  context: ORPCContext,
  input: {
    workspaceId: string
    fileId: string
    path: string
    text: string
    contentVersionB64: string
    createdByPrincipalId: string
    label: string
  },
): Promise<typeof documentVersion.$inferSelect> {
  const db = createDb(context.env.DB)
  const existing = await db
    .select()
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.workspaceId, input.workspaceId),
        eq(documentVersion.fileId, input.fileId),
        eq(documentVersion.label, input.label),
      ),
    )
    .limit(1)
  if (existing[0]) return existing[0]

  const latest = await db
    .select({ seq: documentVersion.seq })
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.workspaceId, input.workspaceId),
        eq(documentVersion.fileId, input.fileId),
      ),
    )
    .orderBy(desc(documentVersion.seq))
    .limit(1)

  const now = new Date()
  const sizeBytes = new TextEncoder().encode(input.text).byteLength
  const row = {
    workspaceId: input.workspaceId,
    fileId: input.fileId,
    versionId: `ver_${crypto.randomUUID()}`,
    seq: (latest[0]?.seq ?? 0) + 1,
    contentVersionB64: input.contentVersionB64,
    text: input.text,
    createdByPrincipalId: input.createdByPrincipalId,
    createdAt: now,
    label: input.label,
  }
  await db.insert(documentVersion).values(row)

  const doc = await db
    .select({ fileId: workspaceDocument.fileId })
    .from(workspaceDocument)
    .where(
      and(
        eq(workspaceDocument.workspaceId, input.workspaceId),
        eq(workspaceDocument.fileId, input.fileId),
      ),
    )
    .limit(1)
  if (doc[0]) {
    await db
      .update(workspaceDocument)
      .set({ path: input.path, currentVersionId: row.versionId, sizeBytes, updatedAt: now })
      .where(
        and(
          eq(workspaceDocument.workspaceId, input.workspaceId),
          eq(workspaceDocument.fileId, input.fileId),
        ),
      )
  } else {
    await db.insert(workspaceDocument).values({
      workspaceId: input.workspaceId,
      fileId: input.fileId,
      path: input.path,
      contentKind: 'markdown',
      sizeBytes,
      currentVersionId: row.versionId,
      updatedAt: now,
    })
  }
  return row
}

/** The newest recorded version, or a first row if none exists yet. */
async function latestVersionOrRecord(
  context: ORPCContext,
  input: { workspaceId: string; fileId: string; principalId: string; label: string },
  result: Extract<DoTextPushResult, { status: 'applied' }>,
): Promise<{ versionId: string }> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select({ versionId: documentVersion.versionId })
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.workspaceId, input.workspaceId),
        eq(documentVersion.fileId, input.fileId),
      ),
    )
    .orderBy(desc(documentVersion.seq))
    .limit(1)
  if (rows[0]) return rows[0]
  return recordTextVersion(context, {
    workspaceId: input.workspaceId,
    fileId: input.fileId,
    path: result.path,
    text: result.text,
    contentVersionB64: result.contentVersionB64,
    createdByPrincipalId: input.principalId,
    label: input.label,
  })
}

async function resolveFileIdByPath(
  context: ORPCContext,
  workspaceId: string,
  path: string | undefined,
): Promise<string> {
  if (!path) {
    throw new ORPCError('BAD_REQUEST', {
      status: 400,
      message: 'Provide fileId or path',
      data: { workspaceId },
    })
  }
  const body = await bridgeText(context, workspaceId, 'text/tree', {})
  const entries = (Array.isArray(body.entries) ? body.entries : []) as WorkspaceTreeEntry[]
  const entry = entries.find((candidate) => candidate.path === path && !candidate.tombstone)
  if (!entry) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'document', id: path },
    })
  }
  return entry.fileId
}

async function documentMetadataFromLive(
  context: ORPCContext,
  workspaceId: string,
  file: DoTextReadFile,
): Promise<DocumentMetadata> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select({ currentVersionId: workspaceDocument.currentVersionId })
    .from(workspaceDocument)
    .where(
      and(
        eq(workspaceDocument.workspaceId, workspaceId),
        eq(workspaceDocument.fileId, file.fileId),
      ),
    )
    .limit(1)
  return {
    workspaceId,
    fileId: file.fileId,
    path: file.path,
    currentVersionId: rows[0]?.currentVersionId ?? undefined,
    contentKind: 'markdown',
    sizeBytes: file.sizeBytes,
    updatedAt: file.modifiedAt ?? Date.now(),
  }
}

function treeEntryView(entry: WorkspaceTreeEntry): WorkspaceTreeEntry {
  return {
    fileId: entry.fileId,
    path: entry.path,
    contentKind: entry.contentKind,
    contentHash: entry.contentHash,
    sizeBytes: entry.sizeBytes,
    version: entry.version,
    seq: entry.seq,
    tombstone: entry.tombstone,
    modifiedBy: entry.modifiedBy,
    modifiedAt: entry.modifiedAt,
  }
}

async function bridgeText(
  context: ORPCContext,
  workspaceId: string,
  action: 'text/tree' | 'text/read' | 'text/push',
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetchWorkspaceDoAdmin(context, workspaceId, action, body)
  const parsed = response.ok
    ? ((await response.json().catch(() => null)) as Record<string, unknown> | null)
    : null
  if (!parsed || parsed.ok !== true) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', {
      status: 500,
      message: 'Workspace text bridge failed',
      data: { workspaceId },
    })
  }
  return parsed
}
