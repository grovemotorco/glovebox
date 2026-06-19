import type { RootCommand } from './index.ts'
import type { NextAction } from './envelope.ts'
import { DEFAULT_SERVER_URL } from '../lib/url.ts'
import pkg from '../../package.json' with { type: 'json' }

/** Version inlined from the package manifest at build time, so `--version`
 * never drifts from what was shipped. */
export function getVersion(): string {
  return pkg.version
}

/**
 * Declarative spec for one command's `--help` screen. Every command builds one
 * of these and renders it through {@link renderHelp}, so the section order,
 * column alignment, and the trailing `-h, --help` row stay identical across the
 * whole surface (the inconsistency the pre-overhaul per-command strings had).
 */
export interface CommandHelp {
  /** Fully-qualified invocation, e.g. `glovebox auth device`. */
  name: string
  /** One-line tagline shown after the em-dash on the title row. */
  summary: string
  /** A single `Usage: …` line, or several rendered under a `Usage:` block. */
  usage: string | string[]
  /** Optional prose paragraph(s); embedded newlines are preserved. */
  description?: string
  /** Positional arguments as `[name, description]` rows. */
  args?: [string, string][]
  /** Flags as `[flag, description]` rows; `-h, --help` is appended for you. */
  options?: [string, string][]
  /** Copy-pasteable example invocations. */
  examples?: string[]
}

/**
 * Machine-readable command tree, emitted instead of the prose help screen when
 * the root command runs in JSON mode (`glovebox --json`, or piped). Lets an
 * agent discover the whole surface in one call instead of scraping `--help`.
 */
export interface CommandTree {
  name: 'glovebox'
  version: string
  defaultServer: string
  commands: { name: string; group: string; summary: string }[]
  nextActions: NextAction[]
}

export function buildCommandTree(commands: RootCommand[]): CommandTree {
  return {
    name: 'glovebox',
    version: getVersion(),
    defaultServer: DEFAULT_SERVER_URL,
    commands: commands
      .filter((command) => !command.hidden)
      .map((command) => ({
        name: command.name,
        group: command.group,
        summary: command.summary,
      })),
    nextActions: [
      {
        command: 'glovebox auth device --workspace <id>',
        description: 'Sign in (browser device flow)',
      },
      {
        command: 'glovebox <command> --help',
        description: "Show a command's arguments and examples",
      },
    ],
  }
}

/** Render a {@link CommandHelp} to the shared, aligned help layout. */
export function renderHelp(help: CommandHelp): string {
  const lines: string[] = [`${help.name} — ${help.summary}`, '']

  const usages = Array.isArray(help.usage) ? help.usage : [help.usage]
  if (usages.length === 1) {
    lines.push(`Usage: ${usages[0]}`)
  } else {
    lines.push('Usage:')
    for (const usage of usages) lines.push(`  ${usage}`)
  }

  if (help.description) {
    lines.push('', help.description.trim())
  }

  // Every command gets the same help row, so callers never repeat it.
  const options: [string, string][] = [
    ...(help.options ?? []),
    ['-h, --help', 'Show this help message'],
  ]
  const pad =
    Math.max(
      0,
      ...(help.args ?? []).map(([label]) => label.length),
      ...options.map(([label]) => label.length),
    ) + 3

  if (help.args && help.args.length > 0) {
    lines.push('', 'Arguments:')
    for (const [label, desc] of help.args) lines.push(`  ${label.padEnd(pad)}${desc}`)
  }

  lines.push('', 'Options:')
  for (const [label, desc] of options) lines.push(`  ${label.padEnd(pad)}${desc}`)

  if (help.examples && help.examples.length > 0) {
    lines.push('', 'Examples:')
    for (const example of help.examples) lines.push(`  ${example}`)
  }

  return lines.join('\n')
}

export function printUsage(commands: RootCommand[]): void {
  const visible = commands.filter((c) => !c.hidden)
  const groups = [...new Set(visible.map((c) => c.group))]
  const pad = Math.max(...visible.map((c) => c.name.length)) + 2

  const lines: string[] = [
    'glovebox — sync a local directory with a collaborative workspace',
    '',
    'Usage: glovebox [--json|--human] <command> [options]',
    '',
    'Getting started:',
    '  glovebox auth device --workspace <id>   Sign in (opens a browser)',
    '  glovebox workspaces list                Find your workspace IDs',
    '  glovebox mount ./notes --workspace <id> Bind a directory',
    '  glovebox run ./notes                    Start syncing',
    '',
    'Commands:',
  ]
  for (const group of groups) {
    lines.push(`  ${group}`)
    for (const c of visible.filter((x) => x.group === group)) {
      lines.push(`    ${c.name.padEnd(pad)}${c.summary}`)
    }
  }
  lines.push(
    '',
    "Run 'glovebox <command> --help' for a command's arguments and examples.",
    '',
    'Global options:',
    '  --json          Structured JSON output (default when stdout is not a TTY)',
    '  --human         Force human output even when piped (alias: --no-json)',
    '  --help, -h      Show this help message',
    '  --version, -V   Show version',
    '',
    'Configuration (override the dir with GLOVEBOX_HOME):',
    '  ~/.glovebox/auth.json     Stored tokens (0600)',
    '  ~/.glovebox/config.json   Default server + preferences',
    '  ~/.glovebox/mounts.json   Registered mounts',
    '',
    'Environment:',
    '  GLOVEBOX_SERVER_URL   Default server URL (an explicit --server still wins)',
    '  GLOVEBOX_HOME         Override the ~/.glovebox config directory',
    '',
    `Default server: ${DEFAULT_SERVER_URL}   ·   Diagnose: glovebox doctor`,
  )
  console.log(lines.join('\n'))
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[])
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

/** Suggest the closest known command name (edit distance ≤ 2). */
export function getSuggestion(input: string, names: string[]): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const name of names) {
    const dist = levenshtein(input, name)
    if (dist < bestDist && dist <= 2) {
      bestDist = dist
      best = name
    }
  }
  return best
}
