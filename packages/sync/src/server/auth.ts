/**
 * Signed workspace connection tokens. The worker verifies a token on WS
 * upgrade (signature, expiry, workspaceId match) and forwards the claims to
 * the DO as a trusted header; the DO additionally gates on its durable auth
 * epoch, so bumping the epoch invalidates every previously minted token
 * without the worker keeping state (glyphdown's trusted-header model).
 */

export interface WorkspaceTokenClaims {
  workspaceId: string
  principalId: string
  principalType: 'human' | 'agent'
  role: 'viewer' | 'commenter' | 'editor'
  owner: boolean
  /** Auth epoch the token was minted under; stale epochs are rejected. */
  epoch: number
  /** Expiry, milliseconds since Unix epoch. */
  exp: number
}

export async function signWorkspaceToken(
  claims: WorkspaceTokenClaims,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = bytesToBase64Url(await hmac(secret, payload))
  return `${payload}.${signature}`
}

/**
 * Returns the claims when the token is authentic and unexpired, else null.
 * Callers still must check `workspaceId` and the DO-side epoch.
 */
export async function verifyWorkspaceToken(
  token: string,
  secret: string,
  now: number,
): Promise<WorkspaceTokenClaims | null> {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  const expected = await hmac(secret, payload)
  const provided = base64UrlToBytes(signature)
  if (provided === null || !timingSafeEqual(expected, provided)) return null

  const payloadBytes = base64UrlToBytes(payload)
  if (payloadBytes === null) return null
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
  if (!isClaims(claims)) return null
  if (claims.exp <= now) return null
  return claims
}

function isClaims(value: unknown): value is WorkspaceTokenClaims {
  if (typeof value !== 'object' || value === null) return false
  const claims = value as Record<string, unknown>
  return (
    typeof claims.workspaceId === 'string' &&
    typeof claims.principalId === 'string' &&
    (claims.principalType === 'human' || claims.principalType === 'agent') &&
    (claims.role === 'viewer' || claims.role === 'commenter' || claims.role === 'editor') &&
    typeof claims.owner === 'boolean' &&
    typeof claims.epoch === 'number' &&
    typeof claims.exp === 'number'
  )
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let diff = 0
  for (let i = 0; i < left.byteLength; i += 1) {
    diff |= left[i]! ^ right[i]!
  }
  return diff === 0
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const b64 = typeof btoa === 'function' ? btoa(binary) : nodeB64(bytes)
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(b64url: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) return null
  const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/')
  try {
    if (typeof atob === 'function') {
      const binary = atob(b64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return bytes
    }
    return nodeB64Decode(b64)
  } catch {
    return null
  }
}

interface RuntimeBuffer {
  from(input: Uint8Array): { toString(encoding: 'base64'): string }
  from(input: string, encoding: 'base64'): Uint8Array
}

function nodeB64(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer
  if (!buffer) throw new Error('No base64 encoder available')
  return buffer.from(bytes).toString('base64')
}

function nodeB64Decode(b64: string): Uint8Array {
  const buffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer
  if (!buffer) throw new Error('No base64 decoder available')
  return new Uint8Array(buffer.from(b64, 'base64'))
}
