import { parseArgs } from 'node:util'
import type { GloveboxClient } from '@glovebox.md/api'
import type { GlobalFlags } from '../cli/index.ts'
import { renderHelp } from '../cli/help.ts'
import { printJson, printSuccess, resolveOutputMode, usageError } from '../cli/output.ts'
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
    console.log(
      renderHelp({
        name: 'glovebox pull',
        summary: "fetch a file's working text and record the merge base",
        usage: [
          'glovebox pull <path> --workspace <id> [options]',
          'glovebox pull --file-id <fileId> --workspace <id> [options]',
        ],
        description:
          'Writes the file at its workspace-relative path under the current directory\nand records the merge base in .glovebox/<fileId>/ (never edit that). Push\nedits back with `glovebox push <path>`.',
        options: [
          ['-w, --workspace <id>', 'Workspace ID (required)'],
          ['--file-id <id>', 'Pull by file ID instead of path'],
          ['-s, --server <url>', 'Server URL (default: GLOVEBOX_SERVER_URL, config, or built-in)'],
        ],
        examples: [
          'glovebox pull docs/note.md --workspace ws_abc123',
          'glovebox pull --file-id f_123 --workspace ws_abc123',
        ],
      }),
    )
    return
  }

  const workspaceId = values.workspace
  if (!workspaceId) {
    usageError('pull requires --workspace <id>', 'glovebox pull')
    return
  }
  const path = positionals[0]
  if (!path && !values['file-id']) {
    usageError('pull requires a <path> or --file-id', 'glovebox pull')
    return
  }

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
