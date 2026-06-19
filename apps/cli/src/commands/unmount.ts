import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DEFAULT_DELETE_POLICY } from '@glovebox.md/sync/daemon'
import type { GlobalFlags } from '../cli/index.ts'
import { renderHelp } from '../cli/help.ts'
import { printJson, printSuccess, resolveOutputMode, usageError } from '../cli/output.ts'
import { lockHolderPid } from '../lib/lockfile.ts'
import { parseSyncOverrides } from '../lib/overrides.ts'
import { canonicalizeDir, gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { findMountByDir, loadRegistry, removeMount } from '../lib/registry.ts'

/**
 * Deregister + delete daemon bookkeeping (registry entry, state dir,
 * lockfile, in-mount sentinel) so a future re-mount re-adopts cleanly.
 * NEVER touches user files. Refuses while a live daemon holds the lock.
 */

export interface UnmountResult {
  mountId: string
  dir: string
  workspaceId: string
}

export async function runUnmount(
  target: string,
  options: { paths?: GloveboxPaths; env?: NodeJS.ProcessEnv } = {},
): Promise<UnmountResult> {
  const env = options.env ?? process.env
  const paths = options.paths ?? gloveboxPaths(env)
  // The directory may already be gone — fall back to plain resolution so
  // the registry entry can still be cleaned up.
  const dir = (await canonicalizeDir(target)) ?? resolve(target)
  const registry = await loadRegistry(paths)
  const mount = findMountByDir(registry, dir)
  if (!mount) {
    throw new Error(`no mount registered at ${dir}`)
  }

  const pid = await lockHolderPid(paths, mount.mountId)
  if (pid !== null) {
    throw new Error(`mount is in use by a running daemon (pid ${pid}) — stop it first, then retry`)
  }

  await removeMount(paths, mount.mountId)
  await rm(paths.stateDir(mount.mountId), { recursive: true, force: true })
  await rm(paths.lockFile(mount.mountId), { force: true })
  // Honor a sentinelPath override — a daemon run under it placed the
  // sentinel there, and a survivor would poison the next adoption.
  const sentinelPath =
    parseSyncOverrides(env).deletePolicy?.sentinelPath ?? DEFAULT_DELETE_POLICY.sentinelPath
  await rm(join(mount.dir, sentinelPath), { force: true })

  return { mountId: mount.mountId, dir: mount.dir, workspaceId: mount.workspaceId }
}

export default async function unmount(args: string[], globals: GlobalFlags): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h', default: false } },
    strict: true,
  })

  if (values.help) {
    console.log(
      renderHelp({
        name: 'glovebox unmount',
        summary: 'remove a mount binding (keeps your files)',
        usage: 'glovebox unmount <dir> [options]',
        description:
          "Removes the registry entry, the daemon's state directory, and the in-mount\n.glovebox.json sentinel. Refuses while a daemon is running on the mount.\nUser files are never touched.",
        args: [['dir', 'The mounted directory (exact mount root)']],
        examples: ['glovebox unmount ./notes'],
      }),
    )
    return
  }
  if (!positionals[0]) {
    return usageError('unmount requires a <dir>', 'glovebox unmount')
  }

  const result = await runUnmount(positionals[0])
  const mode = resolveOutputMode(globals)
  if (mode === 'json') {
    printJson(result)
  } else {
    printSuccess(`Unmounted ${result.dir} (workspace ${result.workspaceId})`)
  }
}
