import { colors, stderrColors } from './colors.ts'

type OutputMode = 'human' | 'json'

export function resolveOutputMode(flags: { json?: boolean }): OutputMode {
  if (flags.json) return 'json'
  if (!process.stdout.isTTY) return 'json'
  return 'human'
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function printError(msg: string): void {
  console.error(`${stderrColors.red}error${stderrColors.reset}: ${msg}`)
}

export function printWarn(msg: string): void {
  console.error(`${stderrColors.yellow}warning${stderrColors.reset}: ${msg}`)
}

export function printSuccess(msg: string): void {
  console.log(`${colors.green}✓${colors.reset} ${msg}`)
}
