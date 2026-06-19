import { ORPCError } from '@glovebox.md/api'
import { colors, stderrColors } from './colors.ts'

type OutputMode = 'human' | 'json'

/**
 * Normalized shape of any thrown error for `--json` output. oRPC errors
 * (`ORPCError`, including contract-defined ones reconstructed across the RPC
 * boundary) carry a `code`/`status`/`data`; everything else collapses to a
 * message. `ORPCError` uses a custom `Symbol.hasInstance`, so `instanceof`
 * stays reliable even across package/dependency-graph boundaries.
 */
export interface CliErrorEnvelope {
  code: string | null
  status: number | null
  message: string
  data?: unknown
}

export function toErrorEnvelope(error: unknown): CliErrorEnvelope {
  if (error instanceof ORPCError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    }
  }
  if (error instanceof Error) return { code: null, status: null, message: error.message }
  return { code: null, status: null, message: String(error) }
}

export function resolveOutputMode(
  flags: { json?: boolean; human?: boolean },
  options: { defaultMode?: OutputMode } = {},
): OutputMode {
  if (flags.human) return 'human'
  if (flags.json) return 'json'
  if (options.defaultMode) return options.defaultMode
  if (!process.stdout.isTTY) return 'json'
  return 'human'
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function printError(msg: string): void {
  console.error(`${stderrColors.red}error${stderrColors.reset}: ${msg}`)
}

/**
 * Terminal handler for an error that reached the top level. Errors always go to
 * stderr — never stdout — so a piped `$(glovebox auth token)` can't capture the
 * diagnostic as its value and the message survives stdout redirection. In JSON
 * mode the payload is the same `{ error }` envelope, just on stderr.
 */
export function printCommandError(error: unknown, mode: OutputMode): void {
  const envelope = toErrorEnvelope(error)
  if (mode === 'json') {
    console.error(JSON.stringify({ error: envelope }, null, 2))
    return
  }
  printError(envelope.code ? `${envelope.message} (${envelope.code})` : envelope.message)
}

export function printWarn(msg: string): void {
  console.error(`${stderrColors.yellow}warning${stderrColors.reset}: ${msg}`)
}

/**
 * A missing-argument / bad-invocation error. Prints a one-line reason plus a
 * pointer to the command's `--help` (never the whole help screen) and sets a
 * non-zero exit code — uniform across every command's usage paths.
 */
export function usageError(message: string, command: string): void {
  printError(message)
  printHint(`Run \`${command} --help\` for usage.`)
  process.exitCode = 1
}

export function printSuccess(msg: string): void {
  console.log(`${colors.green}✓${colors.reset} ${msg}`)
}

/** Dim follow-up guidance on stderr (keeps stdout/JSON clean). */
export function printHint(msg: string): void {
  console.error(`${stderrColors.dim}${msg}${stderrColors.reset}`)
}
