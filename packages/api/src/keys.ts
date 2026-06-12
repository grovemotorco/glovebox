import * as z from 'zod'
import { ocBase } from './base.ts'
import { idSchema, keyPurposeSchema } from './schemas.ts'

export const apiKeyViewSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  prefix: z.string().startsWith('gbx_'),
  purpose: keyPurposeSchema,
  scopes: z.array(z.string().min(1).max(128)),
  workspaceIds: z.array(idSchema),
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
})

export const apiKeyCreateOutputSchema = z.object({
  key: apiKeyViewSchema,
  plaintext: z.string().startsWith('gbx_'),
})

export const keys = {
  create: ocBase
    .input(
      z.object({
        name: z.string().min(1).max(200),
        purpose: keyPurposeSchema,
        scopes: z.array(z.string().min(1).max(128)).default([]),
        workspaceIds: z.array(idSchema).default([]),
        expiresAt: z.number().int().nonnegative().nullable().optional(),
      }),
    )
    .output(apiKeyCreateOutputSchema),
  list: ocBase.output(z.object({ keys: z.array(apiKeyViewSchema) })),
  delete: ocBase
    .input(z.object({ keyId: idSchema }))
    .output(z.object({ ok: z.literal(true), authEpoch: z.number().int().nonnegative() })),
}

export type ApiKeyView = z.infer<typeof apiKeyViewSchema>
export type ApiKeyCreateOutput = z.infer<typeof apiKeyCreateOutputSchema>
