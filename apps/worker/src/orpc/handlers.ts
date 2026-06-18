import { apiVersion } from '@glovebox.md/api'
import { SmartCoercionPlugin } from '@orpc/json-schema'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { OpenAPIReferencePlugin } from '@orpc/openapi/plugins'
import { RPCHandler } from '@orpc/server/fetch'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import type { ORPCContext } from './index.ts'
import { router } from './router.ts'

const schemaConverter = new ZodToJsonSchemaConverter()

const rpcHandler = new RPCHandler(router)

const openApiHandler = new OpenAPIHandler(router, {
  plugins: [
    new SmartCoercionPlugin({ schemaConverters: [schemaConverter] }),
    new OpenAPIReferencePlugin({
      docsProvider: 'scalar',
      docsPath: '/docs',
      specPath: '/openapi.json',
      schemaConverters: [schemaConverter],
      specGenerateOptions: {
        info: {
          title: 'Glovebox API',
          version: apiVersion,
        },
        servers: [{ url: '/api/v1' }],
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
      },
    }),
  ],
})

export async function dispatchOrpc(
  request: Request,
  context: ORPCContext,
): Promise<Response | null> {
  const rpc = await rpcHandler.handle(request, { prefix: '/api/rpc', context })
  if (rpc.matched) return rpc.response

  const url = new URL(request.url)
  if (url.pathname === '/openapi.json' || url.pathname === '/docs') {
    const rootOpenApi = await openApiHandler.handle(request, { prefix: '/', context })
    if (rootOpenApi.matched) return rootOpenApi.response
  }

  const openApi = await openApiHandler.handle(request, { prefix: '/api/v1', context })
  if (openApi.matched) return openApi.response

  return null
}
