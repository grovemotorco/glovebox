import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import type { GlobalFlags } from '../cli/index.ts'
import { withNextActions } from '../cli/envelope.ts'
import { renderHelp } from '../cli/help.ts'
import { printJson, printSuccess, resolveOutputMode, usageError } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { resolveServerUrl } from '../lib/config.ts'
import { canonicalizeDir, gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { addMount, type MountEntry } from '../lib/registry.ts'
import { DEFAULT_SERVER_URL } from '../lib/url.ts'

/**
 * Registration ONLY — no process starts, no network, no sentinel write.
 * The first `glovebox run` cycle adopts the directory: the engine writes
 * the sentinel, binds local files to the workspace's existing fileIds BY
 * PATH (divergent text merges as a union; divergent binaries resolve LWW
 * with the loser preserved in the recovery store), materializes
 * workspace-only files to disk, and only paths unknown to the workspace
 * become creates — so unmount → mount → run never duplicates the tree
 * (ISSUE-0044).
 */

export interface MountOptions {
  workspace: string
  server?: string
  paths?: GloveboxPaths
}

export async function runMount(dirArg: string, options: MountOptions): Promise<MountEntry> {
  const paths = options.paths ?? gloveboxPaths()
  await mkdir(dirArg, { recursive: true })
  const dir = await canonicalizeDir(dirArg)
  if (!dir) {
    throw new Error(`failed to resolve mount directory ${dirArg}`)
  }
  const entry: MountEntry = {
    mountId: randomUUID(),
    dir,
    workspaceId: options.workspace,
    serverUrl: await resolveServerUrl(options.server, paths),
    deviceId: randomUUID(),
    createdAt: Date.now(),
  }
  await addMount(paths, entry)
  return entry
}

export default async function mount(args: string[], globals: GlobalFlags): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      workspace: { type: 'string', short: 'w' },
      server: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(
      renderHelp({
        name: 'glovebox mount',
        summary: 'register a directory ↔ workspace binding',
        usage: 'glovebox mount <dir> --workspace <id> [options]',
        description:
          'Registers only — no process starts. Start syncing with `glovebox run <dir>`.\nRefuses nested or overlapping mounts and directories already claimed by\nanother entry.',
        args: [['dir', 'Directory to bind (created if missing)']],
        options: [
          ['-w, --workspace <id>', 'Workspace ID to bind to (required)'],
          [
            '-s, --server <url>',
            `Server URL (default: GLOVEBOX_SERVER_URL, config, or ${DEFAULT_SERVER_URL})`,
          ],
        ],
        examples: [
          'glovebox mount ./notes --workspace ws_abc123',
          'glovebox mount ./notes -w ws_abc123 -s https://api.glovebox.test',
        ],
      }),
    )
    return
  }
  if (!positionals[0] || !values.workspace) {
    return usageError('mount requires a <dir> and --workspace <id>', 'glovebox mount')
  }

  const entry = await runMount(positionals[0], {
    workspace: values.workspace,
    server: values.server,
  })

  const mode = resolveOutputMode(globals)
  if (mode === 'json') {
    printJson(
      withNextActions(entry, [
        {
          command: `glovebox run ${entry.dir}`,
          description: 'Start the sync daemon for this mount',
        },
      ]),
    )
  } else {
    printSuccess(`Mounted ${colors.bold}${entry.dir}${colors.reset}`)
    console.log(`  Workspace: ${entry.workspaceId}`)
    console.log(`  Server:    ${entry.serverUrl}`)
    console.log(`  Mount ID:  ${entry.mountId}`)
    console.log(`\nStart syncing with: ${colors.cyan}glovebox run ${entry.dir}${colors.reset}`)
  }
}
