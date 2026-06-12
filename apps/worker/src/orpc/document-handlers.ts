import { and, desc, eq } from 'drizzle-orm'
import type { DocumentMetadata, DocumentVersion } from '@glovebox/api'
import { ORPCError } from '@orpc/server'
import { createDb } from '../db/index.ts'
import { documentVersion, workspaceDocument } from '../db/schema/index.ts'
import type { ORPCContext } from './index.ts'
import { requireWorkspaceAccess } from './workspace-access.ts'

export async function getDocumentMetadata(
  input: { workspaceId: string; fileId: string },
  context: ORPCContext,
): Promise<DocumentMetadata> {
  await requireWorkspaceAccess(context, input.workspaceId)
  return documentMetadataView(await readDocumentOrThrow(context, input.workspaceId, input.fileId))
}

export async function getCurrentDocumentVersion(
  input: { workspaceId: string; fileId: string },
  context: ORPCContext,
): Promise<DocumentVersion> {
  await requireWorkspaceAccess(context, input.workspaceId)
  const doc = await readDocumentOrThrow(context, input.workspaceId, input.fileId)
  if (!doc.currentVersionId) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'documentVersion', id: input.fileId },
    })
  }
  return documentVersionView(
    await readVersionOrThrow(context, input.workspaceId, input.fileId, doc.currentVersionId),
  )
}

export async function listDocumentVersions(
  input: { workspaceId: string; fileId: string },
  context: ORPCContext,
): Promise<{ versions: DocumentVersion[] }> {
  const db = createDb(context.env.DB)
  await requireWorkspaceAccess(context, input.workspaceId)
  const rows = await db
    .select()
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.workspaceId, input.workspaceId),
        eq(documentVersion.fileId, input.fileId),
      ),
    )
    .orderBy(desc(documentVersion.createdAt))
  return { versions: rows.map(documentVersionView) }
}

export async function readDocumentText(
  input: { workspaceId: string; fileId: string; versionId?: string },
  context: ORPCContext,
): Promise<{
  document: DocumentMetadata
  version: DocumentVersion
  text: string
  contentVersionB64: string
}> {
  await requireWorkspaceAccess(context, input.workspaceId)
  const doc = await readDocumentOrThrow(context, input.workspaceId, input.fileId)
  const versionId = input.versionId ?? doc.currentVersionId
  if (!versionId) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'documentVersion', id: input.fileId },
    })
  }
  const version = await readVersionOrThrow(context, input.workspaceId, input.fileId, versionId)
  return {
    document: documentMetadataView(doc),
    version: documentVersionView(version),
    text: version.text,
    contentVersionB64: version.contentVersionB64,
  }
}

export async function readVersion(
  input: { workspaceId: string; fileId: string; versionId: string },
  context: ORPCContext,
): Promise<DocumentVersion> {
  await requireWorkspaceAccess(context, input.workspaceId)
  return documentVersionView(
    await readVersionOrThrow(context, input.workspaceId, input.fileId, input.versionId),
  )
}

export async function compareVersions(
  input: {
    workspaceId: string
    fileId: string
    baseVersionId: string
    targetVersionId: string
  },
  context: ORPCContext,
): Promise<{
  workspaceId: string
  fileId: string
  baseVersionId: string
  targetVersionId: string
  changed: boolean
  summary?: string
}> {
  await requireWorkspaceAccess(context, input.workspaceId)
  const base = await readVersionOrThrow(
    context,
    input.workspaceId,
    input.fileId,
    input.baseVersionId,
  )
  const target = await readVersionOrThrow(
    context,
    input.workspaceId,
    input.fileId,
    input.targetVersionId,
  )
  return {
    workspaceId: input.workspaceId,
    fileId: input.fileId,
    baseVersionId: input.baseVersionId,
    targetVersionId: input.targetVersionId,
    changed: base.contentVersionB64 !== target.contentVersionB64 || base.text !== target.text,
  }
}

export async function readDocumentOrThrow(
  context: ORPCContext,
  workspaceId: string,
  fileId: string,
): Promise<typeof workspaceDocument.$inferSelect> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select()
    .from(workspaceDocument)
    .where(
      and(eq(workspaceDocument.workspaceId, workspaceId), eq(workspaceDocument.fileId, fileId)),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'document', id: fileId },
    })
  }
  return row
}

export async function readVersionOrThrow(
  context: ORPCContext,
  workspaceId: string,
  fileId: string,
  versionId: string,
): Promise<typeof documentVersion.$inferSelect> {
  const db = createDb(context.env.DB)
  const rows = await db
    .select()
    .from(documentVersion)
    .where(
      and(
        eq(documentVersion.workspaceId, workspaceId),
        eq(documentVersion.fileId, fileId),
        eq(documentVersion.versionId, versionId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw new ORPCError('NOT_FOUND', {
      status: 404,
      message: 'Not found',
      data: { resource: 'documentVersion', id: versionId },
    })
  }
  return row
}

function documentMetadataView(row: typeof workspaceDocument.$inferSelect): DocumentMetadata {
  return {
    workspaceId: row.workspaceId,
    fileId: row.fileId,
    path: row.path,
    currentVersionId: row.currentVersionId ?? undefined,
    contentKind: row.contentKind,
    sizeBytes: row.sizeBytes,
    updatedAt: row.updatedAt.getTime(),
  }
}

function documentVersionView(row: typeof documentVersion.$inferSelect): DocumentVersion {
  return {
    workspaceId: row.workspaceId,
    fileId: row.fileId,
    versionId: row.versionId,
    seq: row.seq,
    contentVersionB64: row.contentVersionB64,
    createdBy: row.createdByPrincipalId,
    createdAt: row.createdAt.getTime(),
    label: row.label ?? undefined,
  }
}
