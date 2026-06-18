import {
  createGloveboxWebClient,
  isGloveboxError,
  safe,
  type GloveboxClient,
} from '@glovebox.md/api'
import { magicLinkClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { randomUuid } from './random.ts'

/**
 * Client-side singletons for the app shell. This module lives behind the
 * `#app-shell` alias boundary, so it is only ever evaluated in the browser
 * bundle — window access at module scope is safe here.
 */

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [magicLinkClient()],
})

export const api: GloveboxClient = createGloveboxWebClient({
  baseUrl: window.location.origin,
})

/**
 * oRPC's typed try/catch: `const { data, error } = await safe(api.x.y(...))`.
 * Re-exported here so call sites get the client, the result helper, and the
 * formatter from one module. `error` is the contract's typed error union;
 * narrow it with {@link errorMessage} (or `isGloveboxError` from the package).
 */
export { safe }

/** Human-readable message from an oRPC/fetch error for inline display. */
export function errorMessage(error: unknown): string {
  // Contract-defined errors carry a typed `code`/`data`; their `message` is the
  // server-authored copy, so prefer it before falling back to opaque failures.
  if (isGloveboxError(error)) return error.message
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'Something went wrong'
}

export function getOrCreateDeviceId(): string {
  const key = 'glovebox.deviceId'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const next = randomUuid()
  localStorage.setItem(key, next)
  return next
}
