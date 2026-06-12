import { readFile } from 'node:fs/promises'
import { writeFileSecure, type GloveboxPaths } from './paths.ts'
import { normalizeServerUrl } from './url.ts'

/**
 * `~/.glovebox/auth.json` (0600): one stored token per server URL. The CLI
 * only STORES tokens — minting is overlook's boundary (auth/sessions); the
 * sole exception is the clearly-labeled `auth mint-dev` helper for local
 * workers. Tokens are `payload.signature` (base64url JSON + HMAC); the
 * payload is decodable without the secret, which `auth status` uses for
 * display — never for trust.
 */

export interface AuthRecord {
  token: string
  savedAt: number
}

export interface AuthFile {
  version: 1
  servers: Record<string, AuthRecord>
}

export interface DecodedTokenClaims {
  workspaceId: string
  principalId: string
  principalType: 'human' | 'agent'
  role: 'viewer' | 'commenter' | 'editor'
  owner: boolean
  epoch: number
  exp: number
}

export async function loadAuth(paths: GloveboxPaths): Promise<AuthFile> {
  try {
    const raw = await readFile(paths.authFile, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AuthFile>
    if (parsed.version !== 1 || typeof parsed.servers !== 'object' || parsed.servers === null) {
      return { version: 1, servers: {} }
    }
    const servers: Record<string, AuthRecord> = {}
    for (const [serverUrl, record] of Object.entries(parsed.servers)) {
      if (
        record &&
        typeof record === 'object' &&
        typeof (record as AuthRecord).token === 'string' &&
        typeof (record as AuthRecord).savedAt === 'number'
      ) {
        servers[serverUrl] = {
          token: (record as AuthRecord).token,
          savedAt: (record as AuthRecord).savedAt,
        }
      }
    }
    return { version: 1, servers }
  } catch {
    return { version: 1, servers: {} }
  }
}

async function saveAuth(paths: GloveboxPaths, auth: AuthFile): Promise<void> {
  await writeFileSecure(paths.authFile, JSON.stringify(auth, null, 2) + '\n')
}

export async function saveToken(
  paths: GloveboxPaths,
  serverUrl: string,
  token: string,
): Promise<void> {
  const auth = await loadAuth(paths)
  auth.servers[normalizeServerUrl(serverUrl)] = { token, savedAt: Date.now() }
  await saveAuth(paths, auth)
}

export async function removeToken(paths: GloveboxPaths, serverUrl: string): Promise<boolean> {
  const auth = await loadAuth(paths)
  const key = normalizeServerUrl(serverUrl)
  if (!(key in auth.servers)) {
    return false
  }
  delete auth.servers[key]
  await saveAuth(paths, auth)
  return true
}

export async function getToken(paths: GloveboxPaths, serverUrl: string): Promise<string | null> {
  const auth = await loadAuth(paths)
  return auth.servers[normalizeServerUrl(serverUrl)]?.token ?? null
}

/** Display-only decode of the token payload — NOT a verification. */
export function decodeTokenClaims(token: string): DecodedTokenClaims | null {
  const dot = token.indexOf('.')
  if (dot <= 0) {
    return null
  }
  try {
    const payload = token.slice(0, dot).replaceAll('-', '+').replaceAll('_', '/')
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as Record<
      string,
      unknown
    >
    if (
      typeof claims.workspaceId === 'string' &&
      typeof claims.principalId === 'string' &&
      (claims.principalType === 'human' || claims.principalType === 'agent') &&
      (claims.role === 'viewer' || claims.role === 'commenter' || claims.role === 'editor') &&
      typeof claims.owner === 'boolean' &&
      typeof claims.epoch === 'number' &&
      typeof claims.exp === 'number'
    ) {
      return {
        workspaceId: claims.workspaceId,
        principalId: claims.principalId,
        principalType: claims.principalType,
        role: claims.role,
        owner: claims.owner,
        epoch: claims.epoch,
        exp: claims.exp,
      }
    }
    return null
  } catch {
    return null
  }
}
