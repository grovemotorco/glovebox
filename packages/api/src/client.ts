import {
  createORPCClient,
  isDefinedError,
  ORPCError,
  safe,
  type ClientContext,
  type InferClientErrorUnion,
} from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'
import type { Contract } from './index.ts'

/**
 * Typed RPC client for the Glovebox contract. Procedure calls throw on failure:
 * an {@link ORPCError} for contract-declared errors (`error.defined === true`,
 * with a typed `code`/`data`), or a transport/network error otherwise. Catch
 * once at the call site and narrow with {@link isGloveboxError}.
 */
export type GloveboxClient = ContractRouterClient<Contract>

/** Union of every error a {@link GloveboxClient} call can reject with. */
export type GloveboxClientError = InferClientErrorUnion<GloveboxClient>

/**
 * The contract-defined subset of {@link GloveboxClientError} — the errors
 * declared via `oc.errors(commonErrors)`, reconstructed client-side with a
 * typed `code` and `data`. {@link isGloveboxError} narrows an `unknown` catch to
 * this so `error.code` and `error.data` are fully typed.
 */
export type GloveboxDefinedError = Extract<GloveboxClientError, ORPCError<string, unknown>>

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

/**
 * Base factory: an idiomatic oRPC client over {@link RPCLink}. Defaults to
 * `credentials: 'omit'`; use {@link createGloveboxWebClient} for cookie auth or
 * {@link createGloveboxCliClient} for `gbx_` API-key Bearer auth.
 */
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

/** Browser factory: sends the session cookie (`credentials: 'include'`). */
export function createGloveboxWebClient(
  options: Omit<GloveboxClientOptions, 'credentials'>,
): GloveboxClient {
  return createGloveboxClient({ ...options, credentials: 'include' })
}

/** CLI factory: attaches a `gbx_` API key as a Bearer token. */
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

/**
 * Narrow an `unknown` thrown value to a contract-defined Glovebox error so its
 * `code` and `data` are typed. Returns `false` for transport/network errors and
 * any non-oRPC throwable (handle those as opaque failures).
 */
export function isGloveboxError(error: unknown): error is GloveboxDefinedError {
  return isDefinedError(error as GloveboxClientError)
}

export { isDefinedError, ORPCError, safe }
