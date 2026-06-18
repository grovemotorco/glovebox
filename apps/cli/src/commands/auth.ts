import { parseArgs } from 'node:util'
import {
  createGloveboxClient,
  type DeviceAuthorizationStartOutput,
  type GloveboxClient,
  type KeyPurpose,
} from '@glovebox.md/api'
import { signWorkspaceToken } from '@glovebox.md/sync/server'
import type { GlobalFlags } from '../cli/index.ts'
import { printError, printJson, printSuccess, printWarn, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import {
  decodeTokenClaims,
  loadAuth,
  removeToken,
  saveToken,
  type DecodedTokenClaims,
} from '../lib/auth-store.ts'
import { gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { DEFAULT_SERVER_URL, normalizeServerUrl } from '../lib/url.ts'

/**
 * Token STORAGE only — minting belongs to overlook (the auth/sessions
 * boundary). `mint-dev` is the one labeled exception: it signs with a
 * locally supplied `WS_AUTH_SECRET` for dev workers and tests.
 */

interface CommandOptions {
  paths?: GloveboxPaths
}

interface DeviceLoginClient {
  auth: Pick<GloveboxClient['auth'], 'deviceStart' | 'devicePoll'>
}

export interface LoginResult {
  serverUrl: string
  claims: DecodedTokenClaims | null
}

export async function runLogin(
  options: { server?: string; token: string } & CommandOptions,
): Promise<LoginResult> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = normalizeServerUrl(options.server ?? DEFAULT_SERVER_URL)
  const token = options.token.trim()
  if (!token) {
    throw new Error('empty token')
  }
  await saveToken(paths, serverUrl, token)
  return { serverUrl, claims: decodeTokenClaims(token) }
}

export interface AuthStatusEntry {
  serverUrl: string
  savedAt: number
  claims: DecodedTokenClaims | null
  expired: boolean | null
}

export async function runAuthStatus(options: CommandOptions = {}): Promise<{
  servers: AuthStatusEntry[]
}> {
  const paths = options.paths ?? gloveboxPaths()
  const auth = await loadAuth(paths)
  const servers = Object.entries(auth.servers).map(([serverUrl, record]) => {
    const claims = decodeTokenClaims(record.token)
    return {
      serverUrl,
      savedAt: record.savedAt,
      claims,
      expired: claims ? claims.exp <= Date.now() : null,
    }
  })
  return { servers }
}

export async function runLogout(
  options: { server?: string } & CommandOptions,
): Promise<{ serverUrl: string; removed: boolean }> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = normalizeServerUrl(options.server ?? DEFAULT_SERVER_URL)
  return { serverUrl, removed: await removeToken(paths, serverUrl) }
}

export interface DeviceLoginResult {
  serverUrl: string
  apiKey: string
  saved: true
}

export async function runDeviceLogin(
  options: {
    server?: string
    workspaceIds: string[]
    scopes?: string[]
    purpose?: KeyPurpose
    timeoutMs?: number
    fetch?: typeof fetch
    onVerification?: (device: DeviceAuthorizationStartOutput) => void
  } & CommandOptions,
): Promise<DeviceLoginResult> {
  const serverUrl = normalizeServerUrl(options.server ?? DEFAULT_SERVER_URL)
  return runDeviceLoginWithClient({
    ...options,
    serverUrl,
    client: createGloveboxClient({
      baseUrl: serverUrl,
      fetch: options.fetch,
    }),
  })
}

export async function runDeviceLoginWithClient(
  options: {
    serverUrl: string
    client: DeviceLoginClient
    workspaceIds: string[]
    scopes?: string[]
    purpose?: KeyPurpose
    timeoutMs?: number
    onVerification?: (device: DeviceAuthorizationStartOutput) => void
  } & CommandOptions,
): Promise<DeviceLoginResult> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = normalizeServerUrl(options.serverUrl)
  const started = await options.client.auth.deviceStart({
    purpose: options.purpose ?? 'cli',
    scopes: options.scopes ?? ['workspace:read', 'workspace:write'],
    workspaceIds: options.workspaceIds,
  })
  options.onVerification?.(started)

  const deadline = Date.now() + (options.timeoutMs ?? started.expiresAt - Date.now())
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('device authorization timed out')
    }
    await delay(started.intervalSec * 1000)
    const polled = await options.client.auth.devicePoll({ deviceCode: started.deviceCode })
    if (polled.status === 'pending') continue
    if (polled.status === 'approved' && polled.apiKey) {
      await saveToken(paths, serverUrl, polled.apiKey)
      return { serverUrl, apiKey: polled.apiKey, saved: true }
    }
    throw new Error(`device authorization ${polled.status}`)
  }
}

export interface MintDevResult {
  serverUrl: string
  token: string
  saved: boolean
}

export async function runMintDev(
  options: {
    secret: string
    workspace: string
    principal?: string
    principalType?: 'human' | 'agent'
    role?: 'viewer' | 'commenter' | 'editor'
    owner?: boolean
    epoch?: number
    ttlHours?: number
    server?: string
    save?: boolean
  } & CommandOptions,
): Promise<MintDevResult> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = normalizeServerUrl(options.server ?? DEFAULT_SERVER_URL)
  const token = await signWorkspaceToken(
    {
      workspaceId: options.workspace,
      principalId: options.principal ?? 'dev-cli',
      principalType: options.principalType ?? 'human',
      role: options.role ?? 'editor',
      owner: options.owner ?? true,
      epoch: options.epoch ?? 0,
      exp: Date.now() + (options.ttlHours ?? 12) * 3_600_000,
    },
    options.secret,
  )
  if (options.save) {
    await saveToken(paths, serverUrl, token)
  }
  return { serverUrl, token, saved: options.save ?? false }
}

/** Token to store: --token flag, else piped stdin (never echoed prompts). */
async function resolveTokenInput(flagValue: string | undefined): Promise<string> {
  if (flagValue) {
    return flagValue
  }
  if (process.stdin.isTTY) {
    throw new Error('pass --token <t> or pipe the token on stdin')
  }
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
  }
  const token = data.trim()
  if (!token) {
    throw new Error('no token on stdin')
  }
  return token
}

const HELP = `glovebox auth — manage server tokens (storage only; servers mint)

Usage:
  glovebox auth login [--server <url>] [--token <t>]   store a token (or pipe it on stdin)
  glovebox auth device --workspace <id> [--server <url>] [--scope <scope>...]
                                                       browser device login; stores a gbx_ key
  glovebox auth status                                 list stored tokens (decoded, not verified)
  glovebox auth logout [--server <url>]                forget a token
  glovebox auth mint-dev --secret <s> --workspace <id> [--principal <p>]
                [--principal-type human|agent] [--role viewer|commenter|editor]
                [--owner false] [--epoch <n>] [--ttl-hours <n>] [--server <url>] [--save]
                                                       DEV ONLY: sign a token locally

Notes:
  Tokens are minted by the product server (overlook); this CLI never mints
  except via the clearly-labeled mint-dev helper for local dev workers.
  Default server: ${DEFAULT_SERVER_URL}`

export default async function auth(args: string[], globals: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  const mode = resolveOutputMode(globals)

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP)
    return
  }

  switch (sub) {
    case 'login': {
      const { values } = parseArgs({
        args: rest,
        options: {
          server: { type: 'string', short: 's' },
          token: { type: 'string', short: 't' },
        },
        strict: true,
      })
      const token = await resolveTokenInput(values.token)
      const result = await runLogin({ server: values.server, token })
      if (mode === 'json') {
        printJson(result)
      } else {
        printSuccess(`Token stored for ${result.serverUrl}`)
        if (result.claims) {
          console.log(`  Principal: ${result.claims.principalId}`)
          console.log(`  Workspace: ${result.claims.workspaceId}`)
          console.log(`  Expires:   ${new Date(result.claims.exp).toISOString()}`)
        }
      }
      return
    }
    case 'device': {
      const { values } = parseArgs({
        args: rest,
        options: {
          server: { type: 'string', short: 's' },
          workspace: { type: 'string', short: 'w', multiple: true },
          scope: { type: 'string', multiple: true },
          purpose: { type: 'string' },
          'timeout-ms': { type: 'string' },
        },
        strict: true,
      })
      const workspaceIds = values.workspace ?? []
      if (workspaceIds.length === 0) {
        printError('device requires --workspace <id>')
        process.exitCode = 1
        return
      }
      const result = await runDeviceLogin({
        server: values.server,
        workspaceIds,
        scopes: values.scope,
        purpose: parseKeyPurpose(values.purpose),
        timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
        onVerification: (device) => {
          if (mode === 'json') return
          console.log(`Open: ${device.verificationUriComplete}`)
          console.log(`Code: ${device.userCode}`)
        },
      })
      if (mode === 'json') {
        printJson(result)
      } else {
        printSuccess(`API key stored for ${result.serverUrl}`)
      }
      return
    }
    case 'status': {
      const result = await runAuthStatus()
      if (mode === 'json') {
        printJson(result)
        return
      }
      if (result.servers.length === 0) {
        console.log(`${colors.dim}No stored tokens. Run \`glovebox auth login\`.${colors.reset}`)
        return
      }
      for (const entry of result.servers) {
        const state = entry.expired === null ? 'opaque' : entry.expired ? 'EXPIRED' : 'valid'
        console.log(`${colors.bold}${entry.serverUrl}${colors.reset} (${state})`)
        if (entry.claims) {
          console.log(`  Principal: ${entry.claims.principalId}`)
          console.log(`  Workspace: ${entry.claims.workspaceId}`)
          console.log(`  Epoch:     ${entry.claims.epoch}`)
          console.log(`  Expires:   ${new Date(entry.claims.exp).toISOString()}`)
        }
      }
      return
    }
    case 'logout': {
      const { values } = parseArgs({
        args: rest,
        options: { server: { type: 'string', short: 's' } },
        strict: true,
      })
      const result = await runLogout({ server: values.server })
      if (mode === 'json') {
        printJson(result)
      } else if (result.removed) {
        printSuccess(`Forgot token for ${result.serverUrl}`)
      } else {
        console.log(`No token stored for ${result.serverUrl}`)
      }
      return
    }
    case 'mint-dev': {
      const { values } = parseArgs({
        args: rest,
        options: {
          secret: { type: 'string' },
          workspace: { type: 'string', short: 'w' },
          principal: { type: 'string' },
          'principal-type': { type: 'string' },
          role: { type: 'string' },
          owner: { type: 'string' },
          epoch: { type: 'string' },
          'ttl-hours': { type: 'string' },
          server: { type: 'string', short: 's' },
          save: { type: 'boolean', default: false },
        },
        strict: true,
      })
      if (!values.secret || !values.workspace) {
        printError('mint-dev requires --secret and --workspace')
        process.exitCode = 1
        return
      }
      const result = await runMintDev({
        secret: values.secret,
        workspace: values.workspace,
        principal: values.principal,
        principalType: parsePrincipalType(values['principal-type']),
        role: parseDocumentRole(values.role),
        owner: values.owner === undefined ? undefined : values.owner !== 'false',
        epoch: values.epoch ? Number(values.epoch) : undefined,
        ttlHours: values['ttl-hours'] ? Number(values['ttl-hours']) : undefined,
        server: values.server,
        save: values.save,
      })
      if (mode === 'json') {
        printJson(result)
      } else {
        printWarn('dev-only token signed locally — production tokens come from the server')
        console.log(result.token)
        if (result.saved) {
          printSuccess(`Stored for ${result.serverUrl}`)
        }
      }
      return
    }
    default:
      printError(`Unknown auth subcommand: ${sub}`)
      console.log(HELP)
      process.exitCode = 1
  }
}

function parseKeyPurpose(value: string | undefined): KeyPurpose | undefined {
  if (value === undefined) return undefined
  if (value === 'cli' || value === 'agent' || value === 'api') return value
  throw new Error('--purpose must be cli, agent, or api')
}

function parsePrincipalType(value: string | undefined): 'human' | 'agent' | undefined {
  if (value === undefined) return undefined
  if (value === 'human' || value === 'agent') return value
  throw new Error('--principal-type must be human or agent')
}

function parseDocumentRole(
  value: string | undefined,
): 'viewer' | 'commenter' | 'editor' | undefined {
  if (value === undefined) return undefined
  if (value === 'viewer' || value === 'commenter' || value === 'editor') return value
  throw new Error('--role must be viewer, commenter, or editor')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
