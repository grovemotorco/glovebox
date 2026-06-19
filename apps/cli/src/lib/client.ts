import {
  createGloveboxCliClient,
  createGloveboxClient,
  type GloveboxClient,
} from '@glovebox.md/api'
import { getToken, loadAuth } from './auth-store.ts'
import { resolveServer, type ServerSource } from './config.ts'
import { gloveboxPaths, type GloveboxPaths } from './paths.ts'

/**
 * Build a Bearer client for a stored credential. A `gbx_` API key (the device
 * flow's output) goes through the typed CLI client; a legacy workspace token
 * (`payload.signature`, e.g. from `auth login`/`mint-dev`) is attached as a
 * raw Bearer so account-level reads still work. Mirrors the dual handling in
 * `run`'s `resolveWorkspaceSocketToken`.
 */
export function authedClient(serverUrl: string, token: string): GloveboxClient {
  return token.startsWith('gbx_')
    ? createGloveboxCliClient({ baseUrl: serverUrl, apiKey: token })
    : createGloveboxClient({
        baseUrl: serverUrl,
        headers: () => ({ Authorization: `Bearer ${token}` }),
      })
}

export interface ResolvedClient {
  client: GloveboxClient
  serverUrl: string
  source: ServerSource
  token: string
}

/**
 * Resolve the target server (flag/env/config/default), load its token, and
 * build an authed client — or throw an actionable error that names the server
 * and any *other* servers you do have credentials for (the #1 confusion: a
 * token saved under one server while a command defaults to another).
 */
export async function resolveAuthedClient(options: {
  server?: string
  paths?: GloveboxPaths
  env?: NodeJS.ProcessEnv
}): Promise<ResolvedClient> {
  const env = options.env ?? process.env
  const paths = options.paths ?? gloveboxPaths(env)
  const { serverUrl, source } = await resolveServer(options.server, paths, env)
  const token = await getToken(paths, serverUrl)
  if (!token) {
    throw new Error(await missingCredentialsMessage(paths, serverUrl))
  }
  return { client: authedClient(serverUrl, token), serverUrl, source, token }
}

/** "Not logged in" guidance that points at the right server and lists creds you DO have. */
export async function missingCredentialsMessage(
  paths: GloveboxPaths,
  serverUrl: string,
): Promise<string> {
  const others = Object.keys((await loadAuth(paths)).servers).filter((url) => url !== serverUrl)
  let message =
    `Not logged in to ${serverUrl}.\n` +
    `  Sign in with: glovebox auth login --server ${serverUrl} --workspace <id>`
  if (others.length > 0) {
    message +=
      `\n  You do have credentials for: ${others.join(', ')}.` +
      `\n  Target one with --server <url>, set GLOVEBOX_SERVER_URL, or run \`glovebox auth use <url>\`.`
  }
  return message
}
