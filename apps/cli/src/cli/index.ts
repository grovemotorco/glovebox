#!/usr/bin/env node

import auth from '../commands/auth.ts'
import doctor from '../commands/doctor.ts'
import list from '../commands/list.ts'
import mount from '../commands/mount.ts'
import pull from '../commands/pull.ts'
import push from '../commands/push.ts'
import run from '../commands/run.ts'
import status from '../commands/status.ts'
import unmount from '../commands/unmount.ts'
import whoami from '../commands/whoami.ts'
import workspaces from '../commands/workspaces.ts'
import { getSuggestion, getVersion, printUsage } from './help.ts'
import { printCommandError, printError, resolveOutputMode } from './output.ts'

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
    detail: 'device · login · whoami · status · use · token · logout',
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
    summary: 'Register a directory ↔ workspace binding (no process starts)',
    run: mount,
  },
  {
    name: 'run',
    group: 'Sync',
    summary: 'Run the sync daemon for a mount in the foreground',
    run: run,
  },
  {
    name: 'list',
    group: 'Sync',
    summary: 'List registered mounts and their daemon state',
    run: list,
  },
  {
    name: 'status',
    group: 'Sync',
    summary: 'Show sync status for a mount (works without a running daemon)',
    run: status,
  },
  {
    name: 'unmount',
    group: 'Sync',
    summary: 'Remove a mount binding and its daemon state (keeps your files)',
    run: unmount,
  },
  {
    name: 'pull',
    group: 'Files',
    summary: "Fetch a file's working text and record the merge base",
    run: pull,
  },
  {
    name: 'push',
    group: 'Files',
    summary: 'Merge local edits into the live document (exit 0/2/3/1)',
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
    printUsage(COMMANDS)
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
    printError(
      suggestion
        ? `Unknown command: ${first}. Did you mean "${suggestion}"?`
        : `Unknown command: ${first}`,
    )
    printUsage(COMMANDS)
    process.exitCode = 1
    return
  }

  await command.run(args.slice(1), globals)
}

main().catch((err: unknown) => {
  // `main` already consumed (and spliced) the global flags from its own argv
  // copy; re-derive them here from the untouched process.argv. Diagnostics stay
  // human unless JSON is explicitly requested: the non-TTY→JSON default is for a
  // command's *data*, not its errors. `printCommandError` always writes to
  // stderr, so a piped/redirected stdout is never polluted with an error.
  const argv = process.argv.slice(2)
  const mode = resolveOutputMode(
    {
      json: argv.includes('--json'),
      human: argv.includes('--human') || argv.includes('--no-json'),
    },
    { defaultMode: 'human' },
  )
  printCommandError(err, mode)
  process.exitCode = 1
})
