import { readFile } from 'node:fs/promises'
import { writeFileSecure, type GloveboxPaths } from './paths.ts'
import { DEFAULT_SERVER_URL, normalizeServerUrl } from './url.ts'

/**
 * `~/.glovebox/config.json` — non-secret CLI preferences. Today it holds one
 * thing: `defaultServer`, the server a bare command targets when neither
 * `--server` nor `GLOVEBOX_SERVER_URL` is set. It is written by the first
 * successful `auth login`, so the common single-server workflow needs no flags
 * after sign-in. Tokens live in
 * `auth.json`; this file never holds secrets. A corrupt file degrades to "no
 * preferences", never a crash (loro-2 discipline, same as the registry).
 */

export interface GloveboxConfig {
  version: 1
  defaultServer?: string
}

/** Where a resolved server URL came from — surfaced by `doctor`/`auth status`. */
export type ServerSource = 'flag' | 'env' | 'config' | 'default'

export async function loadConfig(paths: GloveboxPaths): Promise<GloveboxConfig> {
  try {
    const parsed = JSON.parse(await readFile(paths.configFile, 'utf-8')) as Partial<GloveboxConfig>
    const config: GloveboxConfig = { version: 1 }
    if (typeof parsed.defaultServer === 'string' && parsed.defaultServer.trim()) {
      config.defaultServer = normalizeServerUrl(parsed.defaultServer)
    }
    return config
  } catch {
    return { version: 1 }
  }
}

export async function setDefaultServer(paths: GloveboxPaths, serverUrl: string): Promise<void> {
  const config = await loadConfig(paths)
  config.defaultServer = normalizeServerUrl(serverUrl)
  await writeFileSecure(paths.configFile, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Resolve the target server and where it came from. Precedence (highest
 * first): explicit `--server` → `GLOVEBOX_SERVER_URL` → config `defaultServer`
 * → the built-in production default.
 */
export async function resolveServer(
  explicit: string | undefined,
  paths: GloveboxPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ serverUrl: string; source: ServerSource }> {
  if (explicit?.trim()) {
    return { serverUrl: normalizeServerUrl(explicit), source: 'flag' }
  }
  const fromEnv = env.GLOVEBOX_SERVER_URL?.trim()
  if (fromEnv) {
    return { serverUrl: normalizeServerUrl(fromEnv), source: 'env' }
  }
  const config = await loadConfig(paths)
  if (config.defaultServer) {
    return { serverUrl: config.defaultServer, source: 'config' }
  }
  return { serverUrl: DEFAULT_SERVER_URL, source: 'default' }
}

/** The resolved server URL only (see `resolveServer` for the source too). */
export async function resolveServerUrl(
  explicit: string | undefined,
  paths: GloveboxPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return (await resolveServer(explicit, paths, env)).serverUrl
}
