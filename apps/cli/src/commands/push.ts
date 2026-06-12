import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import type { GloveboxClient, TextPushResult } from '@glovebox/api'
import type { GlobalFlags } from '../cli/index.ts'
import { printError, printJson, printSuccess, printWarn, resolveOutputMode } from '../cli/output.ts'
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
      server: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help) {
    console.log(`glovebox push — merge local edits into the live document

Usage: glovebox push <path> [options]

Merges your edits (diffed against the recorded base from \`glovebox pull\`)
into the live document server-side; concurrent edits are preserved. On a
clean merge the local file and base advance to the merged result.

Exit codes: 0 clean · 2 failed hunks (printed verbatim; base unchanged) ·
3 degenerate-rewrite refused (use --force only intentionally) · 1 other.

Options:
      --force        Apply even a degenerate rewrite (>60% deletion)
      --server <url> Server URL (default: recorded at pull)
  -h, --help         Show this help message`)
    return
  }

  const path = positionals[0]
  if (!path) throw new Error('push requires a <path>')

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
      if (json) printJson({ ...outcome.result, resent: outcome.resent })
      else {
        printWarn(
          `${outcome.result.failedHunks.length} hunk(s) could not be placed — base unchanged`,
        )
        for (const hunk of outcome.result.failedHunks) console.error(hunk)
      }
      process.exitCode = 2
      return
    case 3:
      if (json) printJson(outcome.result)
      else {
        printError(
          `refused: drifted base and the push deletes ${Math.round(outcome.result.deletedRatio * 100)}% of it — re-pull, or use --force only if the rewrite is intended`,
        )
      }
      process.exitCode = 3
      return
    case 1:
      printError(outcome.error)
      process.exitCode = 1
      return
  }
}
