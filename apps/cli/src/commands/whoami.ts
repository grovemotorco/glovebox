import { parseArgs } from 'node:util'
import type { GloveboxClient, MeView, WorkspaceSummary } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { printHint, printJson, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { resolveAuthedClient } from '../lib/client.ts'
import type { GloveboxPaths } from '../lib/paths.ts'

/**
 * `whoami` — the online identity check (`me.get`), as opposed to the offline
 * `auth status` listing. Resolves the target server, attaches the stored
 * credential, and prints the principal, active workspace, and every workspace
 * you can reach. The fix for `gbx_` keys reading as "opaque": a key carries no
 * decodable claims, so ask the server who it belongs to.
 *
 * If the server hasn't implemented `me.get` yet (it currently 501s on
 * api.glovebox.md), fall back to the live `workspaces.list` so the command
 * still does its main job — surfacing workspace IDs — and upgrades on its own
 * once `me.get` ships.
 */

export interface WhoamiResult {
  serverUrl: string
  /** Null when the server hasn't implemented `me.get` (fell back to listing). */
  me: MeView | null
  workspaces: WorkspaceSummary[]
}

function isNotImplemented(error: unknown): boolean {
  const e = error as { status?: number; code?: string; message?: string } | null
  return (
    e?.status === 501 || e?.code === 'NOT_IMPLEMENTED' || /not implemented/i.test(e?.message ?? '')
  )
}

export async function runWhoami(
  options: {
    server?: string
    paths?: GloveboxPaths
    env?: NodeJS.ProcessEnv
    client?: GloveboxClient
    serverUrl?: string
  } = {},
): Promise<WhoamiResult> {
  const { client, serverUrl } = options.client
    ? { client: options.client, serverUrl: options.serverUrl ?? '' }
    : await resolveAuthedClient(options)
  try {
    const me = await client.me.get()
    return { serverUrl, me, workspaces: me.workspaces }
  } catch (error) {
    if (!isNotImplemented(error)) throw error
    const { workspaces } = await client.workspaces.list({})
    return { serverUrl, me: null, workspaces }
  }
}

function renderWorkspace(ws: WorkspaceSummary, activeId: string | null): string {
  const active = ws.id === activeId ? `${colors.green}●${colors.reset} ` : '  '
  const role = ws.currentPrincipalRole
    ? ` ${colors.dim}(${ws.currentPrincipalRole}${ws.currentPrincipalOwner ? ', owner' : ''})${colors.reset}`
    : ''
  return `    ${active}${colors.bold}${ws.id}${colors.reset}  ${ws.name}${role}`
}

export default async function whoami(args: string[], globals: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(`glovebox whoami — show your identity and workspaces on a server

Calls the server with your stored credentials and prints the signed-in
principal, the active workspace, and every workspace you can access. Use this
to find a workspace ID for \`glovebox mount\`/\`pull\`.

Options:
  -s, --server <url>   Server (default: GLOVEBOX_SERVER_URL, config, or built-in)
  -h, --help           Show this help message`)
    return
  }

  const result = await runWhoami({ server: values.server })
  if (resolveOutputMode(globals) === 'json') {
    printJson(result)
    return
  }

  const { me, serverUrl, workspaces } = result
  if (me) {
    const id = me.principal.email ?? me.principal.id
    console.log(
      `${colors.bold}${me.principal.displayName}${colors.reset} ${colors.dim}<${id}>${colors.reset}`,
    )
    console.log(`  Server:     ${serverUrl}`)
    console.log(`  Principal:  ${me.principal.id} (${me.principal.type})`)
  } else {
    console.log(`${colors.bold}${serverUrl}${colors.reset}`)
    printHint('identity (me.get) not available on this server yet — showing accessible workspaces')
  }

  if (workspaces.length === 0) {
    console.log(
      `  Workspaces: ${colors.dim}none — create one with \`glovebox workspaces create <name>\`${colors.reset}`,
    )
    return
  }
  console.log(`  Workspaces:`)
  for (const ws of workspaces) {
    console.log(renderWorkspace(ws, me?.activeWorkspaceId ?? null))
  }
}
