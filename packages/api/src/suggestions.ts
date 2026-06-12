import * as z from 'zod'
import { ocBase } from './base.ts'
import { idSchema, rangeAnchorSchema } from './schemas.ts'

export const suggestionSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  fileId: idSchema,
  baseVersionId: idSchema,
  range: rangeAnchorSchema,
  replacementText: z.string(),
  status: z.enum(['open', 'accepted', 'rejected']),
  authorPrincipalId: idSchema,
  createdAt: z.number().int().nonnegative(),
  decidedBy: idSchema.optional(),
  decidedAt: z.number().int().nonnegative().optional(),
})

export const suggestions = {
  propose: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        fileId: idSchema,
        baseVersionId: idSchema,
        range: rangeAnchorSchema,
        replacementText: z.string(),
      }),
    )
    .output(suggestionSchema),
  list: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema }))
    .output(z.object({ suggestions: z.array(suggestionSchema) })),
  accept: ocBase
    .input(z.object({ workspaceId: idSchema, suggestionId: idSchema }))
    .output(suggestionSchema),
  reject: ocBase
    .input(z.object({ workspaceId: idSchema, suggestionId: idSchema }))
    .output(suggestionSchema),
  delete: ocBase
    .input(z.object({ workspaceId: idSchema, suggestionId: idSchema }))
    .output(z.object({ ok: z.literal(true) })),
}

export type Suggestion = z.infer<typeof suggestionSchema>
