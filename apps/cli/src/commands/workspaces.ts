import { parseArgs } from 'node:util'
import type { GloveboxClient, WorkspaceSummary } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { withNextActions } from '../cli/envelope.ts'
import { type CommandHelp, renderGroupHelp, renderHelp, unknownSubcommand } from '../cli/help.ts'
import { printJson, printSuccess, resolveOutputMode, usageError } from '../cli/output.ts'
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

/** Group help is a thin index; each subcommand's flags live in its leaf spec. */
const HELP = renderGroupHelp({
  name: 'glovebox workspaces',
  summary: 'list and create workspaces',
  subcommands: [
    { name: 'list', summary: 'list your workspaces on a server (the default)' },
    { name: 'create', summary: 'create a workspace' },
  ],
})

const SERVER_OPTION: [string, string] = [
  '-s, --server <url>',
  'Server (default: GLOVEBOX_SERVER_URL, config, or built-in)',
]

/** Per-subcommand leaf help, routed before the strict parser sees `--help`. */
const WS_SUBHELP: Record<string, CommandHelp> = {
  list: {
    name: 'glovebox workspaces list',
    summary: 'list your workspaces on a server',
    usage: 'glovebox workspaces list [options]',
    options: [SERVER_OPTION],
    examples: ['glovebox workspaces list', 'glovebox --json workspaces list'],
  },
  create: {
    name: 'glovebox workspaces create',
    summary: 'create a workspace',
    usage: 'glovebox workspaces create <name> [options]',
    args: [['name', 'Display name for the workspace']],
    options: [['--slug <slug>', 'URL-friendly identifier (optional)'], SERVER_OPTION],
    examples: [
      'glovebox workspaces create "My Notes"',
      'glovebox workspaces create "My Notes" --slug my-notes',
    ],
  },
}

const SUBCOMMAND_SCAN_OPTIONS = {
  server: { type: 'string', short: 's' },
  slug: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const

function splitSubcommand(args: string[]): { sub: string; rest: string[] } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: SUBCOMMAND_SCAN_OPTIONS,
    strict: false,
    tokens: true,
  })
  const subcommand = parsed.tokens?.find((token) => token.kind === 'positional')
  if (!subcommand) return { sub: 'list', rest: args }
  return {
    sub: subcommand.value,
    rest: [...args.slice(0, subcommand.index), ...args.slice(subcommand.index + 1)],
  }
}

export default async function workspaces(args: string[], globals: GlobalFlags): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(HELP)
    return
  }
  const { sub, rest } = splitSubcommand(args)
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
      console.log(renderHelp(WS_SUBHELP.list!))
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
      console.log(renderHelp(WS_SUBHELP.create!))
      return
    }
    const name = positionals[0]
    if (!name) {
      return usageError('workspaces create requires a <name>', 'glovebox workspaces create')
    }
    const { workspace, serverUrl } = await runWorkspaceCreate({
      name,
      slug: values.slug,
      server: values.server,
    })
    if (mode === 'json') {
      printJson(
        withNextActions({ serverUrl, workspace }, [
          {
            command: `glovebox mount <dir> --workspace ${workspace.id}`,
            description: 'Bind a local directory to this workspace',
          },
        ]),
      )
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

  throw unknownSubcommand('workspaces', sub, ['list', 'create'])
}
