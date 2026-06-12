import * as z from 'zod'
import { ocBase } from './base.ts'
import { idSchema, rangeAnchorSchema } from './schemas.ts'

export const commentThreadSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  fileId: idSchema,
  baseVersionId: idSchema,
  range: rangeAnchorSchema,
  status: z.enum(['open', 'resolved']),
  body: z.string().min(1),
  authorPrincipalId: idSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().optional(),
})

export const comments = {
  create: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        fileId: idSchema,
        baseVersionId: idSchema,
        range: rangeAnchorSchema,
        body: z.string().min(1),
      }),
    )
    .output(commentThreadSchema),
  list: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema }))
    .output(z.object({ threads: z.array(commentThreadSchema) })),
  resolve: ocBase
    .input(z.object({ workspaceId: idSchema, threadId: idSchema }))
    .output(commentThreadSchema),
  reopen: ocBase
    .input(z.object({ workspaceId: idSchema, threadId: idSchema }))
    .output(commentThreadSchema),
  delete: ocBase
    .input(z.object({ workspaceId: idSchema, threadId: idSchema }))
    .output(z.object({ ok: z.literal(true) })),
}

export type CommentThread = z.infer<typeof commentThreadSchema>
