import { parseArgs } from 'node:util'
import type { GloveboxClient, WorkspaceSummary } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { printError, printJson, printSuccess, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { resolveAuthedClient } from '../lib/client.ts'
import type { GloveboxPaths } from '../lib/paths.ts'

/**
 * `workspaces list|create` — closes the chicken-and-egg gap: device login
 * wants a workspace ID, but there was no way to discover one from the CLI
 * even though the server exposes `workspaces.list`/`create`.
 */

interface ResolveOptions {
  server?: string
  paths?: GloveboxPaths
  env?: NodeJS.ProcessEnv
  client?: GloveboxClient
  serverUrl?: string
}

async function clientFor(
  options: ResolveOptions,
): Promise<{ client: GloveboxClient; serverUrl: string }> {
  if (options.client) return { client: options.client, serverUrl: options.serverUrl ?? '' }
  return resolveAuthedClient(options)
}

export async function runWorkspacesList(
  options: ResolveOptions = {},
): Promise<{ serverUrl: string; workspaces: WorkspaceSummary[] }> {
  const { client, serverUrl } = await clientFor(options)
  const { workspaces } = await client.workspaces.list({})
  return { serverUrl, workspaces }
}

export async function runWorkspaceCreate(
  options: { name: string; slug?: string } & ResolveOptions,
): Promise<{ serverUrl: string; workspace: WorkspaceSummary }> {
  const { client, serverUrl } = await clientFor(options)
  const workspace = await client.workspaces.create({ name: options.name, slug: options.slug })
  return { serverUrl, workspace }
}

const HELP = `glovebox workspaces — list and create workspaces

Usage:
  glovebox workspaces [list] [--server <url>]
  glovebox workspaces create <name> [--slug <slug>] [--server <url>]

Options:
  -s, --server <url>   Server (default: GLOVEBOX_SERVER_URL, config, or built-in)
  -h, --help           Show this help message`

export default async function workspaces(args: string[], globals: GlobalFlags): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(HELP)
    return
  }
  // First non-flag positional is the subcommand; default to `list`.
  const hasSub = args[0] !== undefined && !args[0].startsWith('-')
  const sub = hasSub ? args[0] : 'list'
  const rest = hasSub ? args.slice(1) : args
  const mode = resolveOutputMode(globals)

  if (sub === 'list') {
    const { values } = parseArgs({
      args: rest,
      options: {
        server: { type: 'string', short: 's' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    })
    if (values.help) {
      console.log(HELP)
      return
    }
    const { workspaces: list, serverUrl } = await runWorkspacesList({ server: values.server })
    if (mode === 'json') {
      printJson({ serverUrl, workspaces: list })
      return
    }
    if (list.length === 0) {
      console.log(
        `${colors.dim}No workspaces. Create one: \`glovebox workspaces create <name>\`.${colors.reset}`,
      )
      return
    }
    for (const ws of list) {
      const slug = ws.slug ? `  ${colors.dim}${ws.slug}${colors.reset}` : ''
      const role = ws.currentPrincipalRole
        ? ` ${colors.dim}(${ws.currentPrincipalRole})${colors.reset}`
        : ''
      console.log(`${colors.bold}${ws.id}${colors.reset}  ${ws.name}${slug}${role}`)
    }
    return
  }

  if (sub === 'create') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        slug: { type: 'string' },
        server: { type: 'string', short: 's' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    })
    if (values.help) {
      console.log(HELP)
      return
    }
    const name = positionals[0]
    if (!name) {
      printError('workspaces create requires a <name>')
      process.exitCode = 1
      return
    }
    const { workspace, serverUrl } = await runWorkspaceCreate({
      name,
      slug: values.slug,
      server: values.server,
    })
    if (mode === 'json') {
      printJson({ serverUrl, workspace })
      return
    }
    printSuccess(`Created workspace ${colors.bold}${workspace.name}${colors.reset}`)
    console.log(`  ID:   ${workspace.id}`)
    if (workspace.slug) console.log(`  Slug: ${workspace.slug}`)
    console.log(
      `\nMount it: ${colors.cyan}glovebox mount <dir> --workspace ${workspace.id}${colors.reset}`,
    )
    return
  }

  printError(`Unknown workspaces subcommand: ${sub}`)
  console.log(HELP)
  process.exitCode = 1
}
