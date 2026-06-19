import { rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createGloveboxClient } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { type NextAction, withNextActions } from '../cli/envelope.ts'
import { renderHelp } from '../cli/help.ts'
import { printHint, printJson, printSuccess, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { loadAuth } from '../lib/auth-store.ts'
import { resolveServer } from '../lib/config.ts'
import { isProcessAlive, readLockRecord } from '../lib/lockfile.ts'
import { gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { loadRegistry } from '../lib/registry.ts'

/**
 * `doctor` — one command that answers "why isn't this working?": which server
 * a bare command targets and where that choice came from, whether a token is
 * stored for it, whether the server is reachable, plus Node/version/config
 * facts. Each check is tri-state — `ok`, a non-fatal `warn`, or a usage-blocking
 * `error` — and a check may carry a `fix` that `--fix` applies (e.g. removing a
 * stale daemon lock). Exit 1 when any check is in the `error` state.
 */

export type CheckStatus = 'ok' | 'warn' | 'error'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
  /** Present only when `--fix` can repair this automatically. */
  fix?: () => Promise<void>
  /** Detail to show after a successful fix (defaults to the original). */
  fixedDetail?: string
}

export interface DoctorResult {
  serverUrl: string
  source: string
  /** True when no check is in the `error` state (warnings don't fail). */
  ok: boolean
  /** Number of checks auto-repaired this run. */
  fixed: number
  checks: DoctorCheck[]
}

export async function runDoctor(
  options: {
    server?: string
    fix?: boolean
    paths?: GloveboxPaths
    env?: NodeJS.ProcessEnv
    fetch?: typeof fetch
  } = {},
): Promise<DoctorResult> {
  const env = options.env ?? process.env
  const paths = options.paths ?? gloveboxPaths(env)
  const checks: DoctorCheck[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeOk = Number.isFinite(nodeMajor) && nodeMajor >= 24
  checks.push({
    name: 'Node.js',
    status: nodeOk ? 'ok' : 'error',
    detail: nodeOk ? `v${process.versions.node}` : `v${process.versions.node} (requires >= 24)`,
  })

  const { serverUrl, source } = await resolveServer(options.server, paths, env)
  checks.push({ name: 'Server', status: 'ok', detail: `${serverUrl} (from ${source})` })

  const hasToken = Boolean((await loadAuth(paths)).servers[serverUrl])
  checks.push({
    name: 'Credentials',
    // Missing credentials is a warning, not a failure: `doctor` is often the
    // first thing run, before `auth device`.
    status: hasToken ? 'ok' : 'warn',
    detail: hasToken ? 'token stored' : 'none — run `glovebox auth device --workspace <id>`',
  })

  let reachable = false
  let reachDetail: string
  try {
    const res = await createGloveboxClient({
      baseUrl: serverUrl,
      fetch: options.fetch,
    }).health.check()
    reachable = res.ok === true
    reachDetail = `reachable (api ${res.apiVersion})`
  } catch (error) {
    reachDetail = `unreachable — ${error instanceof Error ? error.message : String(error)}`
  }
  checks.push({ name: 'Reachability', status: reachable ? 'ok' : 'error', detail: reachDetail })

  const registry = await loadRegistry(paths)
  // A lock whose holder pid is no longer alive is stale — it would refuse a
  // future `unmount` until removed. Safe to clear automatically.
  const staleMountIds: string[] = []
  for (const mount of registry.mounts) {
    const record = await readLockRecord(paths, mount.mountId)
    if (record && !isProcessAlive(record.pid)) staleMountIds.push(mount.mountId)
  }
  if (staleMountIds.length > 0) {
    checks.push({
      name: 'Locks',
      status: 'warn',
      detail: `${staleMountIds.length} stale daemon lock(s) — run \`glovebox doctor --fix\``,
      fixedDetail: `removed ${staleMountIds.length} stale lock(s)`,
      fix: async () => {
        for (const mountId of staleMountIds) {
          await rm(paths.lockFile(mountId), { force: true })
        }
      },
    })
  } else {
    checks.push({ name: 'Locks', status: 'ok', detail: 'no stale locks' })
  }

  checks.push({ name: 'Mounts', status: 'ok', detail: `${registry.mounts.length} registered` })
  checks.push({ name: 'Config dir', status: 'ok', detail: paths.home })

  let fixed = 0
  if (options.fix) {
    for (const check of checks) {
      if (check.status !== 'ok' && check.fix) {
        await check.fix()
        check.status = 'ok'
        check.detail = check.fixedDetail ?? check.detail
        fixed += 1
      }
    }
  }

  const ok = checks.every((check) => check.status !== 'error')
  return { serverUrl, source, ok, fixed, checks }
}

export default async function doctor(args: string[], globals: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string', short: 's' },
      fix: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(
      renderHelp({
        name: 'glovebox doctor',
        summary: 'check CLI health, config, and server reachability',
        usage: 'glovebox doctor [options]',
        description:
          "Prints the resolved server (and why), whether you're authenticated to it, and\nwhether it answers. Exits 1 if something that blocks usage is wrong.",
        options: [
          ['-s, --server <url>', 'Server to probe (default: the one a bare command uses)'],
          ['--fix', 'Apply safe automatic repairs (e.g. remove stale daemon locks)'],
        ],
        examples: ['glovebox doctor', 'glovebox doctor --fix', 'glovebox --json doctor'],
      }),
    )
    return
  }

  const result = await runDoctor({ server: values.server, fix: values.fix })
  if (resolveOutputMode(globals) === 'json') {
    const nextActions: NextAction[] = []
    if (result.checks.some((check) => check.status !== 'ok' && check.fix)) {
      nextActions.push({
        command: 'glovebox doctor --fix',
        description: 'Apply the available automatic repairs',
      })
    }
    if (result.checks.find((check) => check.name === 'Credentials')?.status === 'warn') {
      nextActions.push({
        command: 'glovebox auth device --workspace <id>',
        description: 'Sign in to the resolved server',
      })
    }
    printJson(withNextActions(result, nextActions))
  } else {
    for (const check of result.checks) {
      const icon =
        check.status === 'ok'
          ? `${colors.green}✓${colors.reset}`
          : check.status === 'warn'
            ? `${colors.yellow}!${colors.reset}`
            : `${colors.red}✗${colors.reset}`
      console.log(`${icon} ${colors.bold}${check.name.padEnd(12)}${colors.reset} ${check.detail}`)
    }
    const fixable = result.checks.filter((check) => check.status !== 'ok' && check.fix).length
    if (fixable > 0) {
      printHint(`Run \`glovebox doctor --fix\` to auto-fix ${fixable} issue(s).`)
    } else if (result.fixed > 0) {
      printSuccess(`Fixed ${result.fixed} issue(s).`)
    }
  }
  process.exitCode = result.ok ? 0 : 1
}
