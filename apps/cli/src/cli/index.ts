#!/usr/bin/env node

import auth from '../commands/auth.ts'
import list from '../commands/list.ts'
import mount from '../commands/mount.ts'
import pull from '../commands/pull.ts'
import push from '../commands/push.ts'
import run from '../commands/run.ts'
import status from '../commands/status.ts'
import unmount from '../commands/unmount.ts'
import { getSuggestion, getVersion, printUsage } from './help.ts'
import { printError } from './output.ts'

export interface GlobalFlags {
  json: boolean
}

const COMMANDS = { auth, mount, run, list, status, unmount, pull, push } as const
type Command = keyof typeof COMMANDS

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const jsonIndex = args.indexOf('--json')
  const isJson = jsonIndex !== -1
  if (isJson) {
    args.splice(jsonIndex, 1)
  }

  const first = args[0]

  if (!first || first === '--help' || first === '-h') {
    printUsage()
    return
  }
  if (first === '--version' || first === '-V') {
    console.log(getVersion())
    return
  }

  if (!Object.hasOwn(COMMANDS, first)) {
    const suggestion = getSuggestion(first)
    printError(
      suggestion
        ? `Unknown command: ${first}. Did you mean "${suggestion}"?`
        : `Unknown command: ${first}`,
    )
    printUsage()
    process.exitCode = 1
    return
  }

  const command = COMMANDS[first as Command]
  await command(args.slice(1), { json: isJson })
}

main().catch((err: unknown) => {
  printError(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
