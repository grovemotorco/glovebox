import { normalizeWorkspaceRelativePath } from '@glovebox.md/core'
import * as z from 'zod'

export const idSchema = z.string().min(1).max(256)
export const emailSchema = z.string().email().max(320)
export const base64StringSchema = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Expected base64')
export const cursorSchema = z.string().min(1).max(512)

export const principalTypeSchema = z.enum(['human', 'agent'])
export const keyPurposeSchema = z.enum(['cli', 'agent', 'api'])
export const documentRoleSchema = z.enum(['viewer', 'commenter', 'editor'])

export const workspaceRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => normalizeWorkspaceRelativePath(value) !== null, 'Invalid workspace path')

export const paginationInputSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
})

export const principalSchema = z.object({
  id: idSchema,
  type: principalTypeSchema,
  displayName: z.string().min(1).max(200),
  email: emailSchema.optional(),
})

export const workspaceSummarySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(128).optional(),
  deleted: z.boolean(),
  authEpoch: z.number().int().nonnegative(),
  currentPrincipalRole: documentRoleSchema.optional(),
  currentPrincipalOwner: z.boolean().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const workspaceTreeEntrySchema = z.object({
  fileId: idSchema,
  path: workspaceRelativePathSchema,
  contentKind: z.enum(['markdown', 'opaque']).optional(),
  contentHash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  versionVectorB64: base64StringSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  tombstone: z.boolean().optional(),
  modifiedBy: idSchema,
  modifiedAt: z.number().int().nonnegative(),
})

export const documentVersionSchema = z.object({
  workspaceId: idSchema,
  fileId: idSchema,
  versionId: idSchema,
  seq: z.number().int().nonnegative(),
  contentVersionB64: base64StringSchema,
  createdBy: idSchema,
  createdAt: z.number().int().nonnegative(),
  label: z.string().max(200).optional(),
})

export const documentMetadataSchema = z.object({
  workspaceId: idSchema,
  fileId: idSchema,
  path: workspaceRelativePathSchema,
  currentVersionId: idSchema.optional(),
  contentKind: z.enum(['markdown', 'opaque']),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const rangeAnchorSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  stale: z.boolean().default(false),
})

export type PrincipalType = z.infer<typeof principalTypeSchema>
export type KeyPurpose = z.infer<typeof keyPurposeSchema>
export type DocumentRole = z.infer<typeof documentRoleSchema>
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>
export type WorkspaceTreeEntry = z.infer<typeof workspaceTreeEntrySchema>
export type DocumentVersion = z.infer<typeof documentVersionSchema>
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>
