import * as z from 'zod'
import { ocPublic } from './base.ts'

export const health = {
  check: ocPublic.input(z.void()).output(
    z.object({
      ok: z.literal(true),
      apiVersion: z.literal('v1'),
      ts: z.number().int().nonnegative(),
    }),
  ),
}
