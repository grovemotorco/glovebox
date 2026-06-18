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
import { colors, stderrColors } from '../cli/colors.ts'
import {
  decodeTokenClaims,
  getToken,
  loadAuth,
  removeToken,
  saveToken,
  type DecodedTokenClaims,
} from '../lib/auth-store.ts'
import { loadConfig, resolveServerUrl, setDefaultServer } from '../lib/config.ts'
import { gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { normalizeServerUrl } from '../lib/url.ts'
import whoamiCommand from './whoami.ts'

/**
 * Token STORAGE + the default-server preference. Minting belongs to the
 * product server (overlook, the auth/sessions boundary); `auth device` runs
 * the browser device flow and stores the returned `gbx_` key, while the
 * labeled `mint-dev` helper signs locally with a supplied `WS_AUTH_SECRET`
 * for dev workers and tests. A successful login also records the server as
 * the default so later commands need no `--server` (see `lib/config.ts`).
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
  const serverUrl = await resolveServerUrl(options.server, paths)
  const token = options.token.trim()
  if (!token) {
    throw new Error('empty token')
  }
  await saveToken(paths, serverUrl, token)
  await setDefaultServer(paths, serverUrl)
  return { serverUrl, claims: decodeTokenClaims(token) }
}

export interface AuthStatusEntry {
  serverUrl: string
  savedAt: number
  isApiKey: boolean
  isDefault: boolean
  claims: DecodedTokenClaims | null
  expired: boolean | null
}

export async function runAuthStatus(options: CommandOptions = {}): Promise<{
  defaultServer: string | null
  servers: AuthStatusEntry[]
}> {
  const paths = options.paths ?? gloveboxPaths()
  const auth = await loadAuth(paths)
  const defaultServer = (await loadConfig(paths)).defaultServer ?? null
  const servers = Object.entries(auth.servers).map(([serverUrl, record]) => {
    const claims = decodeTokenClaims(record.token)
    return {
      serverUrl,
      savedAt: record.savedAt,
      isApiKey: record.token.startsWith('gbx_'),
      isDefault: serverUrl === defaultServer,
      claims,
      expired: claims ? claims.exp <= Date.now() : null,
    }
  })
  return { defaultServer, servers }
}

export async function runLogout(
  options: { server?: string } & CommandOptions,
): Promise<{ serverUrl: string; removed: boolean }> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = await resolveServerUrl(options.server, paths)
  return { serverUrl, removed: await removeToken(paths, serverUrl) }
}

export async function runAuthUse(
  options: { server: string } & CommandOptions,
): Promise<{ serverUrl: string }> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = normalizeServerUrl(options.server)
  await setDefaultServer(paths, serverUrl)
  return { serverUrl }
}

export async function runAuthToken(
  options: { server?: string } & CommandOptions,
): Promise<{ serverUrl: string; token: string | null }> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = await resolveServerUrl(options.server, paths)
  return { serverUrl, token: await getToken(paths, serverUrl) }
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
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = await resolveServerUrl(options.server, paths)
  return runDeviceLoginWithClient({
    ...options,
    paths,
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
      await setDefaultServer(paths, serverUrl)
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
  const serverUrl = await resolveServerUrl(options.server, paths)
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
    await setDefaultServer(paths, serverUrl)
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

const HELP = `glovebox auth — manage credentials and the default server

Usage:
  glovebox auth device [--workspace <id>...] [--server <url>] [--scope <s>...]
                                          browser device login; stores a gbx_ key
  glovebox whoami [--server <url>]        show your identity and workspaces
  glovebox auth status                    list stored credentials (decoded, not verified)
  glovebox auth use <url>                 set the default server for later commands
  glovebox auth token [--server <url>]    print the stored token (for scripting)
  glovebox auth login [--server <url>] [--token <t>]
                                          store a pre-minted token (or pipe on stdin)
  glovebox auth logout [--server <url>]   forget a token

The server is chosen by: --server flag → GLOVEBOX_SERVER_URL → the default
set at login (config) → the built-in default. A successful login records the
default, so most commands afterward need no --server.

Dev:
  glovebox auth mint-dev --secret <s> --workspace <id> [--save] [...]
                                          sign a token locally (dev workers/tests only)`

export default async function auth(args: string[], globals: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  const mode = resolveOutputMode(globals)

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP)
    return
  }

  switch (sub) {
    case 'whoami':
      return whoamiCommand(rest, globals)
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
        printSuccess(`Token stored for ${result.serverUrl} (now the default server)`)
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
      const result = await runDeviceLogin({
        server: values.server,
        // Empty = an account-scoped key; --workspace narrows it. The server
        // (not the CLI) decides what an empty scope grants.
        workspaceIds: values.workspace ?? [],
        scopes: values.scope,
        purpose: parseKeyPurpose(values.purpose),
        timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : undefined,
        onVerification: (device) => {
          // Always to stderr: a verification prompt must show even in JSON
          // mode (else a piped device login hangs with no code).
          process.stderr.write(
            `\n${stderrColors.bold}Authorize this device${stderrColors.reset}\n` +
              `  Open: ${device.verificationUriComplete}\n` +
              `  Code: ${device.userCode}\n\n`,
          )
        },
      })
      if (mode === 'json') {
        printJson(result)
      } else {
        printSuccess(`API key stored for ${result.serverUrl} (now the default server)`)
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
        console.log(
          `${colors.dim}No stored credentials. Sign in: \`glovebox auth device --workspace <id>\`.${colors.reset}`,
        )
        return
      }
      for (const entry of result.servers) {
        const kind = entry.isApiKey
          ? 'api key'
          : entry.expired === null
            ? 'token'
            : entry.expired
              ? `${colors.red}EXPIRED${colors.reset}`
              : 'valid'
        const star = entry.isDefault ? ` ${colors.green}(default)${colors.reset}` : ''
        console.log(`${colors.bold}${entry.serverUrl}${colors.reset} [${kind}]${star}`)
        if (entry.claims) {
          console.log(`  Principal: ${entry.claims.principalId}`)
          console.log(`  Workspace: ${entry.claims.workspaceId}`)
          console.log(`  Epoch:     ${entry.claims.epoch}`)
          console.log(`  Expires:   ${new Date(entry.claims.exp).toISOString()}`)
        } else if (entry.isApiKey) {
          console.log(
            `  ${colors.dim}Run \`glovebox whoami\` to resolve this key's identity.${colors.reset}`,
          )
        }
      }
      return
    }
    case 'use': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true })
      const target = positionals[0]
      if (!target) {
        printError('auth use requires a <url>')
        process.exitCode = 1
        return
      }
      const result = await runAuthUse({ server: target })
      if (mode === 'json') printJson(result)
      else printSuccess(`Default server set to ${result.serverUrl}`)
      return
    }
    case 'token': {
      const { values } = parseArgs({
        args: rest,
        options: { server: { type: 'string', short: 's' } },
        strict: true,
      })
      const result = await runAuthToken({ server: values.server })
      // Missing token is a failure in BOTH modes so scripts can rely on the
      // exit code, not just on parsing output.
      if (!result.token) {
        if (mode === 'json') printJson(result)
        else printError(`No token stored for ${result.serverUrl}`)
        process.exitCode = 1
        return
      }
      // The raw token IS the machine output here; emit it unwrapped in human
      // mode so `$(glovebox auth token)` works.
      if (mode === 'json') printJson(result)
      else console.log(result.token)
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
