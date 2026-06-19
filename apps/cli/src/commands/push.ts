import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import type { GloveboxClient, TextPushResult } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { CliError, type NextAction, withNextActions } from '../cli/envelope.ts'
import { renderHelp } from '../cli/help.ts'
import {
  printError,
  printJson,
  printSuccess,
  printWarn,
  resolveOutputMode,
  usageError,
} from '../cli/output.ts'
import type { GloveboxPaths } from '../lib/paths.ts'
import {
  findBookkeepingByPath,
  localFilePath,
  normalizeEol,
  resolveTextPushClient,
  stablePushKey,
  writeBookkeeping,
  writeLocalFile,
} from '../lib/textpush.ts'

/**
 * Agent exit-code contract (D5, spec §5.3):
 *   0 — clean merge (including drifted merges with every hunk placed)
 *   2 — some hunks could not be placed; they are printed verbatim and the
 *       local base does NOT advance — re-pull, reconcile, retry
 *   3 — degenerate-rewrite refusal (drifted base + >60% deletion); re-pull,
 *       or pass --force only when the flattening is intended
 *   1 — anything else (auth, network, unknown file, oversize, …)
 */
export type PushOutcome =
  | { exitCode: 0; result: Extract<TextPushResult, { status: 'applied' }>; resent: boolean }
  | { exitCode: 2; result: Extract<TextPushResult, { status: 'applied' }>; resent: boolean }
  | { exitCode: 3; result: Extract<TextPushResult, { status: 'degenerate-rewrite' }> }
  | { exitCode: 1; error: string }

export async function runPush(options: {
  path: string
  force?: boolean
  serverUrl?: string
  cwd?: string
  paths?: GloveboxPaths
  client?: GloveboxClient
}): Promise<PushOutcome> {
  const cwd = options.cwd ?? process.cwd()
  const record = await findBookkeepingByPath(cwd, options.path)
  if (!record) {
    return {
      exitCode: 1,
      error: `No merge base for ${options.path} — run \`glovebox pull\` first`,
    }
  }
  const { meta, baseText } = record

  let newText: string
  try {
    newText = normalizeEol(await readFile(localFilePath(cwd, meta.path), 'utf-8'))
  } catch {
    return { exitCode: 1, error: `Cannot read local file for ${meta.path}` }
  }

  const { client } = await resolveTextPushClient({
    serverUrl: options.serverUrl ?? meta.serverUrl,
    paths: options.paths,
    client: options.client,
  })

  const idempotencyKey = stablePushKey(meta.fileId, meta.baseHashHex, newText)
  const input = {
    workspaceId: meta.workspaceId,
    fileId: meta.fileId,
    newText,
    baseHashHex: meta.baseHashHex,
    force: options.force,
    idempotencyKey,
  }

  let resent = false
  let result = await client.workspaces.textPush(input)
  if (result.status === 'base-missing') {
    // The server's content-addressed base cache expired — re-send the
    // recorded base and resume (the protocol is designed for this).
    resent = true
    result = await client.workspaces.textPush({ ...input, baseText })
  }

  switch (result.status) {
    case 'base-missing':
      return { exitCode: 1, error: 'Server rejected the recorded base — re-pull and retry' }
    case 'degenerate-rewrite':
      return { exitCode: 3, result }
    case 'applied': {
      if (result.failedHunks.length > 0) {
        // The local file and base stay untouched: the caller reconciles
        // against a fresh pull and retries.
        return { exitCode: 2, result, resent }
      }
      // Clean merge: the merged text (which may include concurrent edits
      // folded in server-side) becomes both the local file and the base,
      // so the next push needs no re-pull.
      await writeLocalFile(cwd, meta.path, result.text)
      await writeBookkeeping(
        cwd,
        {
          ...meta,
          baseHashHex: result.hashHex,
          contentVersionB64: result.contentVersionB64,
          pulledAt: Date.now(),
        },
        result.text,
      )
      return { exitCode: 0, result, resent }
    }
  }
}

export default async function push(args: string[], globals: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      server: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help) {
    console.log(
      renderHelp({
        name: 'glovebox push',
        summary: 'merge local edits into the live document',
        usage: 'glovebox push <path> [options]',
        description:
          'Merges your local edits back into the live document, preserving other\n' +
          "people's concurrent changes. Pull the file first if you haven't.\n\n" +
          'Exit codes: 0 clean · 2 some changes could not be applied (re-pull and\n' +
          'retry) · 3 looks like a destructive rewrite, refused (use --force) · 1 other.',
        options: [
          ['--force', 'Apply even when it looks like a destructive rewrite (>60% deleted)'],
          ['-s, --server <url>', 'Server URL (default: the server recorded at pull time)'],
        ],
        examples: ['glovebox push docs/note.md', 'glovebox push docs/note.md --force'],
      }),
    )
    return
  }

  const path = positionals[0]
  if (!path) {
    return usageError('push requires a <path>', 'glovebox push')
  }

  // Recovery for both partial (exit 2) and refused (exit 3) pushes is the same
  // shape: re-pull, reconcile, retry.
  const repull: NextAction[] = [
    {
      command: `glovebox pull ${path} --workspace <id>`,
      description: 'Re-pull, then reconcile and push again',
    },
  ]

  const outcome = await runPush({ path, force: values.force, serverUrl: values.server })
  const json = resolveOutputMode(globals) === 'json'

  switch (outcome.exitCode) {
    case 0:
      if (json) printJson({ ...outcome.result, resent: outcome.resent })
      else if (outcome.result.changed)
        printSuccess(`merged ${path} (version ${outcome.result.versionId})`)
      else printSuccess(`${path} already up to date`)
      return
    case 2:
      if (json)
        printJson(
          withNextActions(
            {
              ...outcome.result,
              resent: outcome.resent,
              fix: 're-pull the file, reconcile the failed hunks, and push again',
            },
            repull,
          ),
        )
      else {
        printWarn(
          `${outcome.result.failedHunks.length} hunk(s) could not be placed — base unchanged`,
        )
        for (const hunk of outcome.result.failedHunks) console.error(hunk)
      }
      process.exitCode = 2
      return
    case 3:
      if (json)
        printJson(
          withNextActions(
            {
              ...outcome.result,
              fix: 're-pull and re-derive your edit; pass --force only if flattening is intended',
            },
            repull,
          ),
        )
      else {
        printError(
          `refused: drifted base and the push deletes ${Math.round(outcome.result.deletedRatio * 100)}% of it — re-pull, or use --force only if the rewrite is intended`,
        )
      }
      process.exitCode = 3
      return
    case 1:
      // A real failure (auth, missing base, unreadable file): route through the
      // top-level renderer so it honors --json and carries a fix.
      throw new CliError(outcome.error, {
        fix: 'usually `glovebox pull` the file first, or refresh credentials with `glovebox auth login`',
      })
  }
}
