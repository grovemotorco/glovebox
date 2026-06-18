import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { GloveboxClient } from '@glovebox.md/api'
import { normalizeEol, sha256Hex } from '@glovebox.md/sync'
import { gloveboxPaths, type GloveboxPaths } from './paths.ts'
import { getToken } from './auth-store.ts'
import { authedClient, missingCredentialsMessage } from './client.ts'
import { resolveServerUrl } from './config.ts'
import { DEFAULT_SERVER_URL, normalizeServerUrl } from './url.ts'

/**
 * Local bookkeeping for the D5 text-push tier (spec §5.3): id-keyed under
 * `.glovebox/<fileId>/` in the working directory — `base.md` is the
 * three-way merge base recorded at pull time (never edit it), `meta.json`
 * binds the fileId to its workspace, server, path, and base hash. The
 * server caches bases content-addressed with a TTL; when that cache
 * misses, push re-sends `base.md` automatically and resumes.
 */

export interface TextPushMeta {
  workspaceId: string
  fileId: string
  path: string
  serverUrl: string
  baseHashHex: string
  contentVersionB64: string
  pulledAt: number
}

export const TEXTPUSH_STATE_DIR = '.glovebox'

export function stateDirFor(cwd: string): string {
  return join(cwd, TEXTPUSH_STATE_DIR)
}

export async function writeBookkeeping(
  cwd: string,
  meta: TextPushMeta,
  baseText: string,
): Promise<void> {
  const dir = join(stateDirFor(cwd), encodeURIComponent(meta.fileId))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'base.md'), baseText, 'utf-8')
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
}

export async function readBookkeeping(
  cwd: string,
  fileId: string,
): Promise<{ meta: TextPushMeta; baseText: string } | null> {
  const dir = join(stateDirFor(cwd), encodeURIComponent(fileId))
  try {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')) as TextPushMeta
    const baseText = await readFile(join(dir, 'base.md'), 'utf-8')
    if (typeof meta.fileId !== 'string' || typeof meta.baseHashHex !== 'string') return null
    return { meta, baseText }
  } catch {
    return null
  }
}

/** Find the bookkeeping entry whose recorded workspace path matches. */
export async function findBookkeepingByPath(
  cwd: string,
  path: string,
): Promise<{ meta: TextPushMeta; baseText: string } | null> {
  let entries: string[]
  try {
    entries = await readdir(stateDirFor(cwd))
  } catch {
    return null
  }
  for (const entry of entries) {
    const record = await readBookkeeping(cwd, decodeURIComponent(entry))
    if (record && record.meta.path === path) return record
  }
  return null
}

/** The local file a workspace path materializes to, escape-checked. */
export function localFilePath(cwd: string, workspacePath: string): string {
  const target = resolve(cwd, workspacePath)
  if (target !== cwd && !target.startsWith(cwd + sep)) {
    throw new Error(`Workspace path escapes the working directory: ${workspacePath}`)
  }
  return target
}

export async function writeLocalFile(
  cwd: string,
  workspacePath: string,
  text: string,
): Promise<string> {
  const target = localFilePath(cwd, workspacePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text, 'utf-8')
  return target
}

/**
 * Deterministic replay key: the same logical push (same file, base, and
 * content) always presents the same key, so a lost-response retry — or an
 * agent re-running the identical command — replays the recorded result
 * instead of fuzzy-patching twice.
 */
export function stablePushKey(fileId: string, baseHashHex: string, newText: string): string {
  return sha256Hex(`${fileId}:${baseHashHex}:${sha256Hex(newText)}`)
}

export interface ResolvedTextPushClient {
  client: GloveboxClient
  serverUrl: string
}

export async function resolveTextPushClient(options: {
  serverUrl?: string
  paths?: GloveboxPaths
  client?: GloveboxClient
}): Promise<ResolvedTextPushClient> {
  // Injected client (tests): keep the server cosmetic, skip config/disk.
  if (options.client) {
    return {
      client: options.client,
      serverUrl: normalizeServerUrl(options.serverUrl ?? DEFAULT_SERVER_URL),
    }
  }
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = await resolveServerUrl(options.serverUrl, paths)
  const apiKey = await getToken(paths, serverUrl)
  if (!apiKey) {
    throw new Error(await missingCredentialsMessage(paths, serverUrl))
  }
  return { client: authedClient(serverUrl, apiKey), serverUrl }
}

export { normalizeEol, sha256Hex }
