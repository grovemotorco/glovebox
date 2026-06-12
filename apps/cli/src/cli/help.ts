const VERSION = '0.1.0'

export function getVersion(): string {
  return VERSION
}

export function printUsage(): void {
  console.log(`glovebox — sync a local directory with a collaborative workspace

Usage: glovebox [--json] <command> [options]

Commands:
  auth      Manage server tokens (login / status / logout / mint-dev)
  mount     Register a directory ↔ workspace binding (no process starts)
  run       Run the sync daemon for a mount in the foreground
  list      List registered mounts and their daemon state
  status    Show sync status for a mount (works without a running daemon)
  unmount   Remove a mount binding and its daemon state (keeps your files)
  pull      Fetch a file's working text and record the merge base
  push      Merge local edits into the live document (exit 0/2/3/1)

Options:
  --json       Output structured JSON (default when stdout is not a TTY)
  --help, -h   Show this help message
  --version    Show version`)
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

// `pull` and `push` are reserved for the M7 text-push tier (exit-code
// contract) — do not hand them to another command.
const COMMAND_NAMES = ['auth', 'mount', 'run', 'list', 'status', 'unmount']

/** Suggest a command name if the input is close to a known command. */
export function getSuggestion(input: string): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const name of COMMAND_NAMES) {
    const dist = levenshtein(input, name)
    if (dist < bestDist && dist <= 2) {
      bestDist = dist
      best = name
    }
  }
  return best
}
