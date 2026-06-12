import { parseArgs } from 'node:util'
import type { GlobalFlags } from '../cli/index.ts'
import { printJson, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { lockHolderPid } from '../lib/lockfile.ts'
import { gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { loadRegistry } from '../lib/registry.ts'

export interface ListEntryView {
  mountId: string
  dir: string
  workspaceId: string
  serverUrl: string
  daemon: 'running' | 'stopped'
  pid: number | null
}

export async function runList(options: { paths?: GloveboxPaths } = {}): Promise<{
  mounts: ListEntryView[]
}> {
  const paths = options.paths ?? gloveboxPaths()
  const registry = await loadRegistry(paths)
  const mounts: ListEntryView[] = []
  for (const entry of registry.mounts) {
    const pid = await lockHolderPid(paths, entry.mountId)
    mounts.push({
      mountId: entry.mountId,
      dir: entry.dir,
      workspaceId: entry.workspaceId,
      serverUrl: entry.serverUrl,
      daemon: pid === null ? 'stopped' : 'running',
      pid,
    })
  }
  return { mounts }
}

export default async function list(args: string[], globals: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    strict: true,
  })

  if (values.help) {
    console.log(`glovebox list — list registered mounts and their daemon state

Options:
  -h, --help   Show this help message`)
    return
  }

  const result = await runList()
  const mode = resolveOutputMode(globals)
  if (mode === 'json') {
    printJson(result)
    return
  }
  if (result.mounts.length === 0) {
    console.log(
      `${colors.dim}No mounts. Run \`glovebox mount <dir> --workspace <id>\`.${colors.reset}`,
    )
    return
  }
  for (const m of result.mounts) {
    const icon =
      m.daemon === 'running' ? `${colors.green}●${colors.reset}` : `${colors.dim}○${colors.reset}`
    const pid = m.pid ? ` ${colors.dim}(pid ${m.pid})${colors.reset}` : ''
    console.log(
      `${icon} ${colors.bold}${m.workspaceId}${colors.reset}  ${m.dir}  ${m.daemon}${pid}`,
    )
  }
}
