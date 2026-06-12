import * as z from 'zod'
import { ocBase } from './base.ts'
import {
  base64StringSchema,
  documentMetadataSchema,
  documentVersionSchema,
  idSchema,
} from './schemas.ts'

/**
 * A server-side recovery record (ISSUE-0041): a client intent the server
 * refused (delete-vs-edit, rename collision, …) or a conflict loser,
 * preserved instead of dropped (INV-2). `payload` is the refused intent as
 * JSON with base64-encoded byte fields — display data for the trash UX and
 * raw material for manual recovery.
 */
export const recoveryRecordSchema = z.object({
  recordId: idSchema,
  fileId: idSchema.nullable(),
  opId: z.string().min(1).max(256),
  reason: z.string().min(1).max(256),
  deviceId: z.string().min(1).max(256),
  observedPath: z.string().max(1024).nullable(),
  payload: z.string(),
  createdAt: z.number(),
  acknowledgedAt: z.number().nullable(),
})

export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>

export const documents = {
  metadata: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema }))
    .output(documentMetadataSchema),
  currentVersion: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema }))
    .output(documentVersionSchema),
  versions: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema }))
    .output(z.object({ versions: z.array(documentVersionSchema) })),
  readText: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        fileId: idSchema,
        versionId: idSchema.optional(),
      }),
    )
    .output(
      z.object({
        document: documentMetadataSchema,
        version: documentVersionSchema,
        text: z.string(),
        contentVersionB64: base64StringSchema,
      }),
    ),
  /** Pending recovery records for one file (ISSUE-0041 server-side trash). */
  recovery: ocBase.input(z.object({ workspaceId: idSchema, fileId: idSchema })).output(
    z.object({
      fileId: idSchema,
      available: z.boolean(),
      records: z.array(recoveryRecordSchema),
    }),
  ),
  /** All recovery records in the workspace (the trash panel). */
  recoveryList: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        includeAcknowledged: z.boolean().optional(),
      }),
    )
    .output(z.object({ records: z.array(recoveryRecordSchema) })),
  /** Dismiss a record from the pending view. */
  recoveryAcknowledge: ocBase
    .input(z.object({ workspaceId: idSchema, recordId: idSchema }))
    .output(z.object({ acknowledged: z.boolean() })),
}
