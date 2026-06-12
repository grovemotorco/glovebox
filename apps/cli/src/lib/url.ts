/** Dev default — the portless route for the local worker (`vp run dev:worker`).
 * A production default is blocked on the deployment story (scope note §open-4). */
export const DEFAULT_SERVER_URL = 'https://api.glovebox.test'

const LOCALHOST_PATTERNS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return LOCALHOST_PATTERNS.test(parsed.hostname + (parsed.port ? `:${parsed.port}` : ''))
  } catch {
    return LOCALHOST_PATTERNS.test(url.replace(/^https?:\/\//, ''))
  }
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '')
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    const isLocal = isLocalhostUrl(`http://${trimmed}`)
    return `${isLocal ? 'http' : 'https'}://${trimmed}`
  }
  if (trimmed.startsWith('http://') && !isLocalhostUrl(trimmed)) {
    console.warn(
      '[glovebox] WARNING: Using unencrypted HTTP for a non-localhost server. ' +
        'Auth tokens and file content will be transmitted in plaintext. ' +
        'Use https:// in production.',
    )
  }
  return trimmed
}

/** `https://host` + workspace → `wss://host/ws/<id>?token=…` (worker route). */
export function workspaceWsUrl(serverUrl: string, workspaceId: string, token?: string): string {
  const base = normalizeServerUrl(serverUrl).replace(/^http/, 'ws')
  const url = `${base}/ws/${encodeURIComponent(workspaceId)}`
  return token ? `${url}?token=${encodeURIComponent(token)}` : url
}
