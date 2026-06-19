/**
 * Machine-readable affordances for `--json` consumers (agents). Success
 * responses carry a `nextActions` array of runnable command templates; errors
 * carry a `fix` string and may carry `nextActions`. Human output is unaffected —
 * these only ride along in JSON mode. The shape is deliberately lightweight
 * (runnable `command` + `description`); `params` is available for the rare case
 * a follow-up has an enumerated or pre-filled argument, but most next actions
 * bake the value straight into `command` so an agent can run them verbatim.
 */

export interface NextActionParam {
  description?: string
  /** Pre-filled from the current context (an agent may override). */
  value?: string | number
  default?: string | number
  enum?: string[]
  required?: boolean
}

export interface NextAction {
  /** A runnable command, e.g. `glovebox push docs/note.md`. */
  command: string
  description: string
  params?: Record<string, NextActionParam>
}

/**
 * A CLI error that carries machine-readable remediation. The top-level handler
 * surfaces `fix`/`nextActions` in JSON mode and the `fix` line as a dim hint in
 * human mode (see `output.ts#printCommandError`). Throwing this (rather than
 * printing inline) routes usage/validation failures through the one error
 * renderer, so they honor `--json` like every other error.
 */
export class CliError extends Error {
  readonly code?: string
  readonly fix?: string
  readonly nextActions?: NextAction[]

  constructor(
    message: string,
    options: { code?: string; fix?: string; nextActions?: NextAction[] } = {},
  ) {
    super(message)
    this.name = 'CliError'
    this.code = options.code
    this.fix = options.fix
    this.nextActions = options.nextActions
  }
}

/**
 * Merge `nextActions` into a JSON result object as a sibling key. Additive and
 * backward-compatible — existing fields keep their place, so `jq '.fileId'`
 * still works; the array is simply omitted when empty.
 */
export function withNextActions<T extends object>(
  data: T,
  nextActions?: NextAction[],
): T & { nextActions?: NextAction[] } {
  if (nextActions && nextActions.length > 0) return { ...data, nextActions }
  return data
}
