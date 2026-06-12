import { createGloveboxClient, type GloveboxClient } from '@glovebox/api'
import { magicLinkClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Client-side singletons for the app shell. This module lives behind the
 * `#app-shell` alias boundary, so it is only ever evaluated in the browser
 * bundle — window access at module scope is safe here.
 */

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  plugins: [magicLinkClient()],
})

export const api: GloveboxClient = createGloveboxClient({
  baseUrl: window.location.origin,
  credentials: 'include',
})

/** Human-readable message from an oRPC/fetch error for inline display. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'Something went wrong'
}

export function getOrCreateDeviceId(): string {
  const key = 'glovebox.deviceId'
  const existing = localStorage.getItem(key)
  if (existing) return existing
  const next = crypto.randomUUID()
  localStorage.setItem(key, next)
  return next
}
