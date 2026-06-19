import { parseArgs } from 'node:util'
import {
  createGloveboxClient,
  type DeviceAuthorizationStartOutput,
  type GloveboxClient,
  type KeyPurpose,
} from '@glovebox.md/api'
import { signWorkspaceToken } from '@glovebox.md/sync/server'
import type { GlobalFlags } from '../cli/index.ts'
import { CliError, withNextActions } from '../cli/envelope.ts'
import { type CommandHelp, renderGroupHelp, renderHelp, unknownSubcommand } from '../cli/help.ts'
import {
  printError,
  printJson,
  printSuccess,
  printWarn,
  resolveOutputMode,
  usageError,
} from '../cli/output.ts'
import { stderrColors } from '../cli/colors.ts'
import {
  decodeTokenClaims,
  getToken,
  removeToken,
  saveToken,
  type DecodedTokenClaims,
} from '../lib/auth-store.ts'
import { resolveServerUrl, setDefaultServer } from '../lib/config.ts'
import { gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { normalizeServerUrl } from '../lib/url.ts'
import whoamiCommand from './whoami.ts'

/**
 * Token STORAGE + the default-server preference. Minting belongs to the
 * product server (overlook, the auth/sessions boundary); `auth login` runs the
 * browser device flow and stores the returned `gbx_` key (or, with
 * `--with-token`, stores a token piped on stdin), while the labeled `mint-dev`
 * helper signs locally with a supplied `WS_AUTH_SECRET` for dev workers and
 * tests. A successful login also records the server as the default so later
 * commands need no `--server` (see `lib/config.ts`).
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

export async function runLogout(
  options: { server?: string } & CommandOptions,
): Promise<{ serverUrl: string; removed: boolean }> {
  const paths = options.paths ?? gloveboxPaths()
  const serverUrl = await resolveServerUrl(options.server, paths)
  return { serverUrl, removed: await removeToken(paths, serverUrl) }
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

/**
 * Read a pre-minted token for `auth login --with-token`. Stdin ONLY — never an
 * argv flag — so the secret can't leak into `ps` output or shell history (the
 * `gh auth login --with-token` convention). It is never echoed.
 */
async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError('No token on stdin.', {
      fix: 'Pipe a token: `echo "$GLOVEBOX_TOKEN" | glovebox auth login --with-token`.',
    })
  }
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk
  }
  const token = data.trim()
  if (!token) {
    throw new CliError('No token on stdin.', {
      fix: 'Pipe a non-empty token: `echo "$GLOVEBOX_TOKEN" | glovebox auth login --with-token`.',
    })
  }
  return token
}

/**
 * Group help is a thin index — name + summary per subcommand — and defers each
 * subcommand's flags/usage/examples to `auth <sub> --help` (the AUTH_SUBHELP
 * leaf specs), so the option set lives in exactly one place. `whoami` is not
 * listed: it's the top-level `glovebox whoami`, not an auth subcommand (the
 * `whoami` case below stays only as a back-compat passthrough).
 */
const HELP = renderGroupHelp({
  name: 'glovebox auth',
  summary: 'manage credentials and the default server',
  subcommands: [
    { name: 'login', summary: 'sign in (browser device flow, or --with-token from stdin)' },
    { name: 'logout', summary: 'forget a stored token' },
    { name: 'token', summary: 'print the stored token (for scripting)' },
    { name: 'mint-dev', summary: 'sign a workspace token locally', tag: 'dev' },
  ],
})

/** Dispatchable auth subcommands, for "did you mean" on a typo. Includes the
 * `whoami` passthrough even though it's omitted from the displayed index. */
const AUTH_SUBCOMMANDS = ['login', 'logout', 'token', 'mint-dev', 'whoami']

/**
 * Subcommands removed in the auth-flow consolidation, mapped to a migration
 * hint. Routed before the generic "did you mean" so users running the old names
 * get a precise pointer instead of a fuzzy guess.
 */
const REMOVED_SUBCOMMANDS: Record<string, string> = {
  device: 'Use `glovebox auth login` — the browser device flow is now the default.',
  status: 'Removed. Use `glovebox whoami` (verified identity) or `glovebox doctor` (local state).',
  use: 'Removed. Login sets the default server; override per-command with --server or GLOVEBOX_SERVER_URL.',
}

/**
 * Per-subcommand help screens. The dispatcher routes `auth <sub> --help` here
 * BEFORE the subcommand's strict `parseArgs` runs — otherwise `--help` is an
 * unknown option and throws (the bug this map fixes). `whoami` is intentionally
 * absent: it forwards to the `whoami` command, which renders its own help.
 */
const AUTH_SUBHELP: Record<string, CommandHelp> = {
  login: {
    name: 'glovebox auth login',
    summary: 'sign in to a Glovebox server',
    usage: [
      'glovebox auth login [--workspace <id>]... [options]',
      'echo "$GLOVEBOX_TOKEN" | glovebox auth login --with-token',
    ],
    description:
      'Signs in and records the server as your default. By default runs the browser\ndevice flow — prints a verification URL and code, polls until you approve, then\nstores the returned gbx_ key. With --with-token, stores a token piped on stdin\ninstead (never echoed, never passed on argv).',
    options: [
      ['-w, --workspace <id>', 'Scope the key to a workspace (repeatable; omit = account-scoped)'],
      ['-s, --server <url>', 'Server URL (default: GLOVEBOX_SERVER_URL, config, or built-in)'],
      ['--scope <s>', 'Capability scope (repeatable; default workspace:read + workspace:write)'],
      ['--purpose <p>', 'Key purpose: cli, agent, or api (default cli)'],
      ['--with-token', 'Store a pre-minted token read from stdin instead of the browser flow'],
    ],
    examples: [
      'glovebox auth login --workspace ws_abc123',
      'glovebox auth login -w ws_abc123 --server https://api.glovebox.test',
      'echo "$GLOVEBOX_TOKEN" | glovebox auth login --with-token',
    ],
  },
  logout: {
    name: 'glovebox auth logout',
    summary: 'forget a stored token',
    usage: 'glovebox auth logout [options]',
    options: [
      ['-s, --server <url>', 'Server whose token to forget (default: the resolved server)'],
    ],
    examples: ['glovebox auth logout', 'glovebox auth logout --server https://api.glovebox.test'],
  },
  token: {
    name: 'glovebox auth token',
    summary: 'print the stored token (for scripting)',
    usage: 'glovebox auth token [options]',
    description:
      'Prints the raw stored token to stdout (exit 1 if none), so it can be captured:\n`TOKEN=$(glovebox auth token)`.',
    options: [['-s, --server <url>', 'Server whose token to print (default: the resolved server)']],
    examples: ['glovebox auth token', 'TOKEN=$(glovebox auth token)'],
  },
  'mint-dev': {
    name: 'glovebox auth mint-dev',
    summary: 'sign a workspace token locally (dev workers/tests only)',
    usage: 'glovebox auth mint-dev --secret <s> --workspace <id> [options]',
    description:
      'Signs a workspace token locally with a supplied WS_AUTH_SECRET. For dev\nworkers and tests only — production tokens come from the server.',
    options: [
      ['--secret <s>', 'The signing secret (WS_AUTH_SECRET; required)'],
      ['-w, --workspace <id>', 'Workspace ID to sign for (required)'],
      ['--principal <id>', 'Principal ID (default dev-cli)'],
      ['--principal-type <t>', 'human or agent (default human)'],
      ['--role <r>', 'viewer, commenter, or editor (default editor)'],
      ['--owner <bool>', 'Owner flag (default true)'],
      ['--epoch <n>', 'Auth epoch (default 0)'],
      ['--ttl-hours <n>', 'Token lifetime in hours (default 12)'],
      ['-s, --server <url>', 'Server URL the token targets'],
      ['--save', 'Also store the minted token as the default credential'],
    ],
    examples: ['glovebox auth mint-dev --secret dev-secret --workspace ws_abc123 --save'],
  },
}

export default async function auth(args: string[], globals: GlobalFlags): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)
  const mode = resolveOutputMode(globals, { defaultMode: sub === 'token' ? 'human' : undefined })

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(HELP)
    return
  }

  // Intercept `auth <sub> --help` before the subcommand's strict parser sees
  // `--help` (which it doesn't declare, so it would throw "Unknown option").
  if ((rest.includes('--help') || rest.includes('-h')) && AUTH_SUBHELP[sub]) {
    console.log(renderHelp(AUTH_SUBHELP[sub]))
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
          workspace: { type: 'string', short: 'w', multiple: true },
          scope: { type: 'string', multiple: true },
          purpose: { type: 'string' },
          'with-token': { type: 'boolean', default: false },
          'timeout-ms': { type: 'string' },
        },
        strict: true,
      })

      // --with-token: store a token piped on stdin (the secret never touches
      // argv). Otherwise run the browser device flow — the default sign-in.
      if (values['with-token']) {
        const token = await readTokenFromStdin()
        const result = await runLogin({ server: values.server, token })
        if (mode === 'json') {
          printJson(
            withNextActions(result, [
              {
                command: 'glovebox whoami',
                description: 'Verify the stored identity against the server',
              },
            ]),
          )
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

      // Empty = an account-scoped key; --workspace narrows it. The server (not
      // the CLI) decides what an empty scope grants.
      const workspaceIds = values.workspace ?? []
      const result = await runDeviceLogin({
        server: values.server,
        workspaceIds,
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
        printJson(
          withNextActions(result, [
            {
              command: 'glovebox workspaces list',
              description: 'List the workspaces this key can access',
            },
          ]),
        )
      } else {
        printSuccess(`API key stored for ${result.serverUrl} (now the default server)`)
      }
      // An account-scoped key can't list or open workspaces — warn (to stderr,
      // so JSON stdout stays clean) and point at the fix.
      if (workspaceIds.length === 0) {
        printWarn(
          'Signed in account-scoped (no --workspace). Per-workspace commands ' +
            '(pull/push/run) need a workspace-scoped key — re-run ' +
            '`glovebox auth login --workspace <id>`.',
        )
      }
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
        return usageError('mint-dev requires --secret and --workspace', 'glovebox auth mint-dev')
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
    default: {
      const migration = REMOVED_SUBCOMMANDS[sub]
      if (migration) {
        throw new CliError(`\`glovebox auth ${sub}\` has been removed.`, { fix: migration })
      }
      throw unknownSubcommand('auth', sub, AUTH_SUBCOMMANDS)
    }
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
