import * as z from 'zod'
import { ocBase } from './base.ts'
import {
  base64StringSchema,
  documentRoleSchema,
  idSchema,
  keyPurposeSchema,
  principalTypeSchema,
} from './schemas.ts'

export const deviceAuthorizationStartInputSchema = z.object({
  purpose: keyPurposeSchema.default('cli'),
  scopes: z.array(z.string().min(1).max(128)).default([]),
  workspaceIds: z.array(idSchema).default([]),
})

export const deviceAuthorizationStartOutputSchema = z.object({
  deviceCode: idSchema,
  userCode: z.string().min(4).max(32),
  verificationUri: z.string().url(),
  verificationUriComplete: z.string().url(),
  expiresAt: z.number().int().nonnegative(),
  intervalSec: z.number().int().positive(),
})

export const workspaceSocketTokenOutputSchema = z.union([
  z.object({
    token: z.string().min(1),
    claims: z.object({
      workspaceId: idSchema,
      principalId: idSchema,
      principalType: principalTypeSchema,
      role: documentRoleSchema,
      owner: z.boolean(),
      epoch: z.number().int().nonnegative(),
      exp: z.number().int().nonnegative(),
    }),
  }),
  /**
   * Socket auth is not configured (dev without WS_AUTH_SECRET): minting is a
   * structured no-op — the client connects tokenless. A thrown 403 here would
   * log an error on every (re)connect in every dev console.
   */
  z.object({ token: z.null(), claims: z.null() }),
])

export const auth = {
  deviceStart: ocBase
    .input(deviceAuthorizationStartInputSchema)
    .output(deviceAuthorizationStartOutputSchema),
  devicePoll: ocBase.input(z.object({ deviceCode: idSchema })).output(
    z.object({
      status: z.enum(['pending', 'approved', 'denied', 'expired']),
      apiKey: z.string().startsWith('gbx_').optional(),
      expiresAt: z.number().int().nonnegative().optional(),
    }),
  ),
  deviceApprove: ocBase
    .input(z.object({ userCode: z.string().min(4).max(32) }))
    .output(z.object({ ok: z.literal(true) })),
  mintWorkspaceSocketToken: ocBase
    .input(z.object({ workspaceId: idSchema }))
    .output(workspaceSocketTokenOutputSchema),
  verifyWorkspaceSocketToken: ocBase
    .input(
      z.object({
        workspaceId: idSchema,
        tokenPayloadB64: base64StringSchema,
      }),
    )
    .output(z.object({ valid: z.boolean() })),
}

export type DeviceAuthorizationStartInput = z.infer<typeof deviceAuthorizationStartInputSchema>
export type DeviceAuthorizationStartOutput = z.infer<typeof deviceAuthorizationStartOutputSchema>
export type WorkspaceSocketTokenOutput = z.infer<typeof workspaceSocketTokenOutputSchema>
