import * as z from 'zod'
import { ocBase } from './base.ts'
import { documentVersionSchema, idSchema } from './schemas.ts'

export const versions = {
  list: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema }))
    .output(z.object({ versions: z.array(documentVersionSchema) })),
  read: ocBase
    .input(z.object({ workspaceId: idSchema, fileId: idSchema, versionId: idSchema }))
    .output(documentVersionSchema),
  compare: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        fileId: idSchema,
        baseVersionId: idSchema,
        targetVersionId: idSchema,
      }),
    )
    .output(
      z.object({
        workspaceId: idSchema,
        fileId: idSchema,
        baseVersionId: idSchema,
        targetVersionId: idSchema,
        changed: z.boolean(),
        summary: z.string().optional(),
      }),
    ),
}
