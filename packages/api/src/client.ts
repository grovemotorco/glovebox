import {
  createORPCClient,
  createSafeClient,
  type SafeClient,
  type ClientContext,
} from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { Contract } from './index.ts'

export type GloveboxClient = ContractRouterClient<Contract>
export type SafeGloveboxClient = SafeClient<GloveboxClient>

export interface GloveboxClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  headers?:
    | Headers
    | Record<string, string>
    | (() => Headers | Record<string, string> | Promise<Headers | Record<string, string>>)
  credentials?: RequestCredentials
}

export interface GloveboxApiKeyClientOptions extends Omit<GloveboxClientOptions, 'headers'> {
  apiKey: string
}

export function rpcUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/rpc`
}

export function createGloveboxClient(options: GloveboxClientOptions): GloveboxClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const credentials = options.credentials ?? 'omit'
  const link = new RPCLink<ClientContext>({
    url: rpcUrl(options.baseUrl),
    headers: options.headers,
    fetch: (request, init) => fetchImpl(request, { ...init, credentials }),
  })
  return createORPCClient(link) as GloveboxClient
}

export function createGloveboxWebClient(
  options: Omit<GloveboxClientOptions, 'credentials'>,
): SafeGloveboxClient {
  return maskThen(createSafeClient(createGloveboxClient({ ...options, credentials: 'include' })))
}

export function createGloveboxCliClient(options: GloveboxApiKeyClientOptions): GloveboxClient {
  assertApiKey(options.apiKey)
  return createGloveboxClient({
    ...options,
    credentials: 'omit',
    headers: () => ({ Authorization: `Bearer ${options.apiKey}` }),
  })
}

export function assertApiKey(apiKey: string): void {
  if (!apiKey.startsWith('gbx_')) {
    throw new Error('Glovebox API keys must start with gbx_')
  }
}

function maskThen<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'then') return undefined
      return Reflect.get(target, prop, receiver)
    },
  })
}
