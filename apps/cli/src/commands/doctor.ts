import { parseArgs } from 'node:util'
import { createGloveboxClient } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { printJson, resolveOutputMode } from '../cli/output.ts'
import { colors } from '../cli/colors.ts'
import { loadAuth } from '../lib/auth-store.ts'
import { resolveServer } from '../lib/config.ts'
import { gloveboxPaths, type GloveboxPaths } from '../lib/paths.ts'
import { loadRegistry } from '../lib/registry.ts'

/**
 * `doctor` — one command that answers "why isn't this working?": which server
 * a bare command targets and where that choice came from, whether a token is
 * stored for it, whether the server is reachable, plus Node/version/config
 * facts. Exit 1 when something that blocks usage (Node too old, server
 * unreachable) is wrong.
 */

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DoctorResult {
  serverUrl: string
  source: string
  ok: boolean
  checks: DoctorCheck[]
}

export async function runDoctor(
  options: {
    server?: string
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
    ok: nodeOk,
    detail: nodeOk ? `v${process.versions.node}` : `v${process.versions.node} (requires >= 24)`,
  })

  const { serverUrl, source } = await resolveServer(options.server, paths, env)
  checks.push({ name: 'Server', ok: true, detail: `${serverUrl} (from ${source})` })

  const hasToken = Boolean((await loadAuth(paths)).servers[serverUrl])
  checks.push({
    name: 'Credentials',
    ok: hasToken,
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
  checks.push({ name: 'Reachability', ok: reachable, detail: reachDetail })

  const mounts = (await loadRegistry(paths)).mounts.length
  checks.push({ name: 'Mounts', ok: true, detail: `${mounts} registered` })
  checks.push({ name: 'Config dir', ok: true, detail: paths.home })

  return { serverUrl, source, ok: nodeOk && reachable, checks }
}

export default async function doctor(args: string[], globals: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })

  if (values.help) {
    console.log(`glovebox doctor — check CLI health, config, and server reachability

Prints the resolved server (and why), whether you're authenticated to it, and
whether it answers. Exits 1 if something that blocks usage is wrong.

Options:
  -s, --server <url>   Server to probe (default: the one a bare command uses)
  -h, --help           Show this help message`)
    return
  }

  const result = await runDoctor({ server: values.server })
  if (resolveOutputMode(globals) === 'json') {
    printJson(result)
  } else {
    for (const check of result.checks) {
      const icon = check.ok ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`
      console.log(`${icon} ${colors.bold}${check.name.padEnd(12)}${colors.reset} ${check.detail}`)
    }
  }
  process.exitCode = result.ok ? 0 : 1
}
