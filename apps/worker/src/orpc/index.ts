import { implement, ORPCError } from '@orpc/server'
import { contract } from '@glovebox/api'

export interface ORPCContext {
  request: Request
  env: import('../dispatcher.ts').Env
  executionCtx: ExecutionContext
}

export const os = implement(contract).$context<ORPCContext>()

export function notImplemented(procedure: string): never {
  throw new ORPCError('NOT_IMPLEMENTED', {
    status: 501,
    message: `${procedure} is not implemented yet`,
    data: { procedure },
  })
}
