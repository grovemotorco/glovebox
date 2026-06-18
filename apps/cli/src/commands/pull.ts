import { parseArgs } from 'node:util'
import type { GloveboxClient } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { printJson, printSuccess, resolveOutputMode } from '../cli/output.ts'
import type { GloveboxPaths } from '../lib/paths.ts'
import {
  resolveTextPushClient,
  writeBookkeeping,
  writeLocalFile,
  type TextPushMeta,
} from '../lib/textpush.ts'

export interface PullView {
  fileId: string
  path: string
  localFile: string
  hashHex: string
  bytes: number
}

export async function runPull(options: {
  workspaceId: string
  path?: string
  fileId?: string
  serverUrl?: string
  cwd?: string
  paths?: GloveboxPaths
  client?: GloveboxClient
}): Promise<PullView> {
  const cwd = options.cwd ?? process.cwd()
  const { client, serverUrl } = await resolveTextPushClient(options)
  const read = await client.workspaces.readText({
    workspaceId: options.workspaceId,
    fileId: options.fileId,
    path: options.path,
  })

  const meta: TextPushMeta = {
    workspaceId: options.workspaceId,
    fileId: read.document.fileId,
    path: read.document.path,
    serverUrl,
    baseHashHex: read.hashHex,
    contentVersionB64: read.contentVersionB64,
    pulledAt: Date.now(),
  }
  const localFile = await writeLocalFile(cwd, read.document.path, read.text)
  await writeBookkeeping(cwd, meta, read.text)

  return {
    fileId: read.document.fileId,
    path: read.document.path,
    localFile,
    hashHex: read.hashHex,
    bytes: Buffer.byteLength(read.text, 'utf-8'),
  }
}

export default async function pull(args: string[], globals: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      workspace: { type: 'string', short: 'w' },
      'file-id': { type: 'string' },
      server: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  if (values.help) {
    console.log(`glovebox pull — fetch a file's working text and record the merge base

Usage: glovebox pull <path> --workspace <id> [options]
       glovebox pull --file-id <fileId> --workspace <id> [options]

Writes the file at its workspace-relative path under the current directory
and records the merge base in .glovebox/<fileId>/ (never edit that). Push
edits back with \`glovebox push <path>\`.

Options:
  -w, --workspace <id>   Workspace ID (required)
      --file-id <id>     Pull by file ID instead of path
  -s, --server <url>     Server URL (default: GLOVEBOX_SERVER_URL, config, or built-in)
  -h, --help             Show this help message`)
    return
  }

  const workspaceId = values.workspace
  if (!workspaceId) throw new Error('pull requires --workspace <id>')
  const path = positionals[0]
  if (!path && !values['file-id']) throw new Error('pull requires a <path> or --file-id')

  const view = await runPull({
    workspaceId,
    path,
    fileId: values['file-id'],
    serverUrl: values.server,
  })

  if (resolveOutputMode(globals) === 'json') {
    printJson(view)
    return
  }
  printSuccess(`pulled ${view.path} (${view.bytes} bytes) → ${view.localFile}`)
}
