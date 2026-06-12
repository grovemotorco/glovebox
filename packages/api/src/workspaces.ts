import * as z from 'zod'
import { ocBase } from './base.ts'
import {
  base64StringSchema,
  documentMetadataSchema,
  documentRoleSchema,
  idSchema,
  paginationInputSchema,
  workspaceRelativePathSchema,
  workspaceSummarySchema,
  workspaceTreeEntrySchema,
} from './schemas.ts'

export const workspaceCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(128).optional(),
})

export const workspaceUpdateInputSchema = z.object({
  workspaceId: idSchema,
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(128).optional(),
})

/**
 * D5 text push (spec §5.3): the client names its base by content hash; the
 * server merges base→newText onto the LIVE document and lands minimal Loro
 * ops under a server-owned peer. `baseVersionId` (the old A6 placeholder
 * shape) is gone — the spec's `baseHash` wins.
 */
export const textPushInputSchema = z.object({
  workspaceId: idSchema,
  fileId: idSchema,
  newText: z.string(),
  /** sha256 hex of the base text this edit was derived from. */
  baseHashHex: z.string().regex(/^[0-9a-f]{64}$/, 'Expected sha256 hex'),
  /** Re-sent base after a `base-missing` response; verified by hash. */
  baseText: z.string().optional(),
  /** Apply even a degenerate rewrite. Explicit only, never a default. */
  force: z.boolean().optional(),
  /** Replay key: lost-response retries return the original result. */
  idempotencyKey: z.string().min(1).max(256),
})

export const textPushResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    fileId: idSchema,
    versionId: idSchema,
    /** False when the merge was a no-op (idempotent retry, equal text). */
    changed: z.boolean(),
    /** Unplaceable hunks, verbatim — do not advance the local base. */
    failedHunks: z.array(z.string()),
    text: z.string(),
    hashHex: z.string(),
    contentVersionB64: base64StringSchema,
  }),
  /** The named base is not cached server-side; re-send it as `baseText`. */
  z.object({ status: z.literal('base-missing'), fileId: idSchema }),
  /** Drifted base + the diff deletes most of it (>60%); use force to override. */
  z.object({
    status: z.literal('degenerate-rewrite'),
    fileId: idSchema,
    deletedRatio: z.number(),
  }),
])

export const workspaces = {
  create: ocBase.input(workspaceCreateInputSchema).output(workspaceSummarySchema),
  list: ocBase.input(paginationInputSchema.optional()).output(
    z.object({
      workspaces: z.array(workspaceSummarySchema),
      nextCursor: z.string().optional(),
    }),
  ),
  get: ocBase.input(z.object({ workspaceId: idSchema })).output(workspaceSummarySchema),
  update: ocBase.input(workspaceUpdateInputSchema).output(workspaceSummarySchema),
  delete: ocBase
    .input(z.object({ workspaceId: idSchema }))
    .output(z.object({ ok: z.literal(true) })),
  tree: ocBase.input(z.object({ workspaceId: idSchema })).output(
    z.object({
      entries: z.array(workspaceTreeEntrySchema),
      seq: z.number().int().nonnegative(),
    }),
  ),
  readText: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        path: workspaceRelativePathSchema.optional(),
        fileId: idSchema.optional(),
      }),
    )
    .output(
      z.object({
        document: documentMetadataSchema,
        text: z.string(),
        /** sha256 hex of `text` — the base hash for a later textPush. */
        hashHex: z.string(),
        contentVersionB64: base64StringSchema,
        role: documentRoleSchema,
      }),
    ),
  textPush: ocBase.input(textPushInputSchema).output(textPushResultSchema),
}

export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>
export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateInputSchema>
export type TextPushInput = z.infer<typeof textPushInputSchema>
export type TextPushResult = z.infer<typeof textPushResultSchema>
