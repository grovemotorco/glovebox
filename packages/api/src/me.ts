import * as z from 'zod'
import { ocBase } from './base.ts'
import { idSchema, principalSchema, workspaceSummarySchema } from './schemas.ts'

export const sessionViewSchema = z.object({
  id: idSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  userAgent: z.string().max(500).optional(),
  ipHint: z.string().max(128).optional(),
})

export const meViewSchema = z.object({
  principal: principalSchema,
  activeWorkspaceId: idSchema.nullable(),
  workspaces: z.array(workspaceSummarySchema),
})

export const me = {
  get: ocBase.output(meViewSchema),
  sessions: ocBase.output(z.object({ sessions: z.array(sessionViewSchema) })),
  setActiveWorkspace: ocBase
    .input(z.object({ workspaceId: idSchema }))
    .output(z.object({ activeWorkspaceId: idSchema })),
}

export type SessionView = z.infer<typeof sessionViewSchema>
export type MeView = z.infer<typeof meViewSchema>
