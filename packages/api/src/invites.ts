import * as z from 'zod'
import { ocBase } from './base.ts'
import { documentRoleSchema, emailSchema, idSchema } from './schemas.ts'

export const inviteViewSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  email: emailSchema,
  role: documentRoleSchema,
  owner: z.boolean(),
  status: z.enum(['pending', 'accepted', 'canceled', 'expired']),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  acceptedAt: z.number().int().nonnegative().optional(),
})

export const invites = {
  create: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        email: emailSchema,
        role: documentRoleSchema.default('viewer'),
        owner: z.boolean().default(false),
      }),
    )
    .output(inviteViewSchema),
  list: ocBase
    .input(z.object({ workspaceId: idSchema }))
    .output(z.object({ invites: z.array(inviteViewSchema) })),
  resend: ocBase
    .input(z.object({ workspaceId: idSchema, inviteId: idSchema }))
    .output(z.object({ ok: z.literal(true), sentAt: z.number().int().nonnegative() })),
  cancel: ocBase
    .input(z.object({ workspaceId: idSchema, inviteId: idSchema }))
    .output(z.object({ ok: z.literal(true), authEpoch: z.number().int().nonnegative() })),
  accept: ocBase.input(z.object({ inviteToken: z.string().min(1) })).output(inviteViewSchema),
}

export type InviteView = z.infer<typeof inviteViewSchema>
