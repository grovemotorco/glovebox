import { ORPCError } from '@glovebox.md/api'
import { CliError } from './envelope.ts'
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
  // CliError extends Error — check it first so its `code` survives.
  if (error instanceof CliError) {
    return { code: error.code ?? null, status: null, message: error.message }
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
  const isCli = error instanceof CliError
  const fix = isCli ? error.fix : undefined
  const nextActions = isCli ? error.nextActions : undefined
  // Our own CliErrors already carry a fix/suggestion; for foreign errors (node
  // arg-parse failures, network errors) derive the equivalent from the message
  // so they're just as actionable — and in both output modes, since a piped
  // agent now reads the JSON envelope on failure too.
  const guidance = isCli ? {} : deriveErrorGuidance(error)
  const effectiveFix = fix ?? guidance.fix
  if (mode === 'json') {
    console.error(
      JSON.stringify(
        {
          error: envelope,
          ...(guidance.suggestion ? { suggestion: guidance.suggestion } : {}),
          ...(effectiveFix ? { fix: effectiveFix } : {}),
          ...(nextActions && nextActions.length > 0 ? { nextActions } : {}),
        },
        null,
        2,
      ),
    )
    return
  }
  printError(envelope.code ? `${envelope.message} (${envelope.code})` : envelope.message)
  if (guidance.suggestion) printHint(`Did you mean "${guidance.suggestion}"?`)
  if (effectiveFix) printHint(effectiveFix)
}

export function printWarn(msg: string): void {
  console.error(`${stderrColors.yellow}warning${stderrColors.reset}: ${msg}`)
}

/**
 * A missing-argument / bad-invocation error. Throws a {@link CliError} carrying
 * the `--help` pointer as its `fix`, so the one top-level renderer handles it —
 * a one-line reason + dim hint in human mode, a `{ error, fix }` envelope under
 * `--json`, exit 1 either way (never the whole help screen). Callers use
 * `return usageError(...)` since it never returns.
 */
export function usageError(message: string, command: string): never {
  throw new CliError(message, { fix: `Run \`${command} --help\` for usage.` })
}

export function printSuccess(msg: string): void {
  console.log(`${colors.green}✓${colors.reset} ${msg}`)
}

/** Dim follow-up guidance on stderr (keeps stdout/JSON clean). */
export function printHint(msg: string): void {
  console.error(`${stderrColors.dim}${msg}${stderrColors.reset}`)
}

/**
 * Known flags across the whole CLI surface, for "did you mean" on an unknown
 * option. The failing subcommand's strict parser only reports the bad flag, not
 * its own option set, so we match against this global list — a small accepted
 * trade-off: a flag valid on a *different* command can still be suggested.
 */
const KNOWN_FLAGS = [
  '--json',
  '--human',
  '--no-json',
  '--help',
  '--version',
  '--server',
  '--workspace',
  '--scope',
  '--purpose',
  '--timeout-ms',
  '--with-token',
  '--slug',
  '--fix',
  '--force',
  '--secret',
  '--principal',
  '--principal-type',
  '--role',
  '--owner',
  '--epoch',
  '--ttl-hours',
  '--save',
  '--file-id',
  '--rescan-interval',
  '--list',
  '--confirm',
  '--restore',
] as const

/**
 * Turn a foreign error message into the same suggestion/fix our own CliErrors
 * carry: an unknown `--flag` gets the closest known flag plus a `--help` pointer;
 * a failed fetch gets a reachability hint. Returns {} when nothing matches.
 */
function deriveErrorGuidance(error: unknown): { suggestion?: string; fix?: string } {
  const message = error instanceof Error ? error.message : String(error)
  const unknownOption = /Unknown option '(--[^']+)'/.exec(message)?.[1]
  if (unknownOption) {
    // `--token` was removed with the auth consolidation; it's too far from any
    // current flag for a useful fuzzy match, so point migrators at its successor.
    if (unknownOption === '--token') {
      return { fix: 'Use `glovebox auth login --with-token` and pipe the token on stdin.' }
    }
    const suggestion = suggestFlag(unknownOption)
    return {
      ...(suggestion ? { suggestion } : {}),
      fix: 'Run the command with --help for its options.',
    }
  }
  if (message === 'fetch failed') {
    return {
      fix: "Couldn't reach the server. Check the URL is right and online — run `glovebox doctor`.",
    }
  }
  return {}
}

/** Closest known flag within edit distance 3, else null. */
function suggestFlag(input: string): string | null {
  let best: { flag: string; distance: number } | null = null
  for (const flag of KNOWN_FLAGS) {
    const distance = levenshtein(input, flag)
    if (distance > 3) continue
    if (!best || distance < best.distance) best = { flag, distance }
  }
  return best?.flag ?? null
}

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
    }
  }
  return dp[m]![n]!
}
