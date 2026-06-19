#!/usr/bin/env node

import auth from '../commands/auth.ts'
import doctor from '../commands/doctor.ts'
import list from '../commands/list.ts'
import mount from '../commands/mount.ts'
import pull from '../commands/pull.ts'
import push from '../commands/push.ts'
import run from '../commands/run.ts'
import status from '../commands/status.ts'
import sync from '../commands/sync.ts'
import unmount from '../commands/unmount.ts'
import whoami from '../commands/whoami.ts'
import workspaces from '../commands/workspaces.ts'
import { CliError } from './envelope.ts'
import { buildCommandTree, getSuggestion, getVersion, printUsage } from './help.ts'
import { printCommandError, printJson, resolveOutputMode } from './output.ts'

export interface GlobalFlags {
  json: boolean
  human: boolean
}

export type CommandFn = (args: string[], globals: GlobalFlags) => Promise<void>

export interface RootCommand {
  name: string
  group: string
  summary: string
  /** Optional one-line subtitle (e.g. the subcommand list) shown in help. */
  detail?: string
  /** Hidden from help (aliases, dev helpers) but still dispatchable. */
  hidden?: boolean
  run: CommandFn
}

export const COMMANDS: RootCommand[] = [
  {
    name: 'auth',
    group: 'Setup',
    summary: 'Manage credentials and the default server',
    detail: 'login · logout · token',
    run: auth,
  },
  {
    name: 'whoami',
    group: 'Setup',
    summary: 'Show your identity and workspaces on a server',
    run: whoami,
  },
  {
    name: 'workspaces',
    group: 'Setup',
    summary: 'List and create workspaces',
    detail: 'list · create',
    run: workspaces,
  },
  { name: 'ws', group: 'Setup', summary: 'Alias of workspaces', hidden: true, run: workspaces },
  {
    name: 'doctor',
    group: 'Setup',
    summary: 'Check CLI health, config, and server reachability',
    run: doctor,
  },
  {
    name: 'mount',
    group: 'Sync',
    summary: 'Bind a local directory to a workspace',
    run: mount,
  },
  {
    name: 'run',
    group: 'Sync',
    summary: 'Start syncing a mount (runs in the foreground)',
    run: run,
  },
  {
    name: 'list',
    group: 'Sync',
    summary: "List your mounts and whether they're running",
    run: list,
  },
  {
    name: 'status',
    group: 'Sync',
    summary: "Show a mount's sync status",
    run: status,
  },
  {
    name: 'sync',
    group: 'Sync',
    summary: 'Inspect and resolve sync internals',
    detail: 'deletes',
    run: sync,
  },
  {
    name: 'unmount',
    group: 'Sync',
    summary: 'Remove a mount binding (keeps your files)',
    run: unmount,
  },
  {
    name: 'pull',
    group: 'Files',
    summary: "Download a file's latest text for local editing",
    run: pull,
  },
  {
    name: 'push',
    group: 'Files',
    summary: 'Merge your local edits back into the live document',
    run: push,
  },
]

function findCommand(name: string): RootCommand | undefined {
  return COMMANDS.find((command) => command.name === name)
}

/** Remove every occurrence of a global flag from argv (it may sit before or
 * after the subcommand) and report whether it was present. */
function takeFlag(args: string[], ...names: string[]): boolean {
  let present = false
  for (let i = args.length - 1; i >= 0; i--) {
    if (names.includes(args[i]!)) {
      args.splice(i, 1)
      present = true
    }
  }
  return present
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  // `--human`/`--no-json` wins over `--json`; both are global and stripped
  // before the subcommand's strict parser sees them.
  const human = takeFlag(args, '--human', '--no-json')
  const json = takeFlag(args, '--json')
  const globals: GlobalFlags = { json, human }

  const first = args[0]

  if (!first || first === '--help' || first === '-h') {
    // Agents (or any piped/`--json` caller) get the command tree as JSON so they
    // can discover the surface without scraping `--help`; humans get the prose.
    if (resolveOutputMode(globals) === 'json') printJson(buildCommandTree(COMMANDS))
    else printUsage(COMMANDS)
    return
  }
  if (first === '--version' || first === '-V') {
    console.log(getVersion())
    return
  }

  const command = findCommand(first)
  if (!command) {
    const names = COMMANDS.filter((c) => !c.hidden).map((c) => c.name)
    const suggestion = getSuggestion(first, names)
    // Route through the top-level renderer so it honors --json and carries a fix.
    throw new CliError(
      suggestion
        ? `Unknown command: ${first}. Did you mean "${suggestion}"?`
        : `Unknown command: ${first}`,
      {
        fix: "Run 'glovebox --help' to list commands.",
        nextActions: suggestion
          ? [{ command: `glovebox ${suggestion}`, description: 'Run the closest matching command' }]
          : undefined,
      },
    )
  }

  await command.run(args.slice(1), globals)
}

main().catch((err: unknown) => {
  // `main` already consumed (and spliced) the global flags from its own argv
  // copy; re-derive them here from the untouched process.argv. Errors follow the
  // SAME resolution as data — interactive TTYs get the human "error: …" line,
  // while piped/`--json` callers get the JSON `{ error, fix, nextActions }`
  // envelope. Otherwise an agent piping us reads JSON on success but unparseable
  // prose on failure, exactly when `fix`/`nextActions` matter most.
  // `printCommandError` always writes to stderr, so a piped/redirected stdout is
  // never polluted with an error.
  const argv = process.argv.slice(2)
  const mode = resolveOutputMode({
    json: argv.includes('--json'),
    human: argv.includes('--human') || argv.includes('--no-json'),
  })
  printCommandError(err, mode)
  process.exitCode = 1
})
