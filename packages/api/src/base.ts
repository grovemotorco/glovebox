import { oc } from '@orpc/contract'
import * as z from 'zod'

const validationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).optional(),
  message: z.string(),
})

export const commonErrors = {
  VALIDATION: {
    status: 400,
    message: 'Validation failed',
    data: z.object({ issues: z.array(validationIssueSchema).optional() }).optional(),
  },
  UNAUTHENTICATED: {
    status: 401,
    message: 'Sign in required',
    data: z.object({}).optional(),
  },
  FORBIDDEN: {
    status: 403,
    message: 'Forbidden',
    data: z
      .object({
        reason: z
          .enum(['not_a_member', 'insufficient_role', 'owner_required', 'scope_missing'])
          .optional(),
      })
      .optional(),
  },
  NOT_FOUND: {
    status: 404,
    message: 'Not found',
    data: z.object({ resource: z.string(), id: z.string().optional() }).optional(),
  },
  INVITE_NOT_FOUND: {
    status: 404,
    message: 'Invite not found',
    data: z.object({ inviteId: z.string() }),
  },
  KEY_NOT_FOUND: {
    status: 404,
    message: 'API key not found',
    data: z.object({ keyId: z.string() }),
  },
  STALE_VERSION: {
    status: 409,
    message: 'Document version is stale',
    data: z.object({ fileId: z.string(), expectedVersionId: z.string().optional() }),
  },
  WORKSPACE_DELETED: {
    status: 410,
    message: 'Workspace deleted',
    data: z.object({ workspaceId: z.string() }),
  },
  TOO_MANY_REQUESTS: {
    status: 429,
    message: 'Too many requests',
    data: z.object({ retryAfterMs: z.number().int().nonnegative().optional() }).optional(),
  },
  NOT_IMPLEMENTED: {
    status: 501,
    message: 'Not implemented',
    data: z.object({ procedure: z.string() }),
  },
} as const

export const ocBase = oc.errors(commonErrors)
export const ocPublic = ocBase.route({
  spec: (operation) => ({ ...operation, security: [] }),
})

export type CommonErrorMap = typeof commonErrors
