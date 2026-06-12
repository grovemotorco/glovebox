import * as z from 'zod'
import { ocBase } from './base.ts'
import { documentRoleSchema, emailSchema, idSchema, principalSchema } from './schemas.ts'

export const memberViewSchema = z.object({
  workspaceId: idSchema,
  principal: principalSchema,
  role: documentRoleSchema,
  owner: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

export const members = {
  list: ocBase
    .input(z.object({ workspaceId: idSchema }))
    .output(z.object({ members: z.array(memberViewSchema) })),
  invite: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        email: emailSchema,
        role: documentRoleSchema.default('viewer'),
        owner: z.boolean().default(false),
      }),
    )
    .output(z.object({ inviteId: idSchema })),
  remove: ocBase
    .input(z.object({ workspaceId: idSchema, principalId: idSchema }))
    .output(z.object({ ok: z.literal(true), authEpoch: z.number().int().nonnegative() })),
  setDocumentRole: ocBase
    .input(z.object({ workspaceId: idSchema, principalId: idSchema, role: documentRoleSchema }))
    .output(memberViewSchema),
  setOwner: ocBase
    .input(z.object({ workspaceId: idSchema, principalId: idSchema, owner: z.boolean() }))
    .output(memberViewSchema),
}

export type MemberView = z.infer<typeof memberViewSchema>
