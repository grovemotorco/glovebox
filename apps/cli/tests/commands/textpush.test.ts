import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GloveboxClient, TextPushInput, TextPushResult } from '@glovebox/api'
import { sha256Hex } from '@glovebox/sync'
import { runPull } from '../../src/commands/pull.ts'
import { runPush } from '../../src/commands/push.ts'
import { readBookkeeping, stablePushKey } from '../../src/lib/textpush.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return realpath(dir)
}

/**
 * A stub of the two contract procedures the commands use. The real merge
 * semantics are covered by the server-core tests; here we verify the CLI's
 * bookkeeping, exit-code mapping, base re-send, and file writes.
 */
function stubClient(options: {
  readText?: { fileId: string; path: string; text: string }
  push: (input: TextPushInput) => TextPushResult
  pushCalls?: TextPushInput[]
}): GloveboxClient {
  return {
    workspaces: {
      readText: async () => {
        const file = options.readText!
        return {
          document: {
            workspaceId: 'ws-1',
            fileId: file.fileId,
            path: file.path,
            contentKind: 'markdown' as const,
            sizeBytes: Buffer.byteLength(file.text),
            updatedAt: 1_750_000_000_000,
          },
          text: file.text,
          hashHex: sha256Hex(file.text),
          contentVersionB64: 'dnYx',
          role: 'editor' as const,
        }
      },
      textPush: async (input: TextPushInput) => {
        options.pushCalls?.push(input)
        return options.push(input)
      },
    },
  } as unknown as GloveboxClient
}

function appliedResult(
  text: string,
  overrides: Partial<Extract<TextPushResult, { status: 'applied' }>> = {},
): TextPushResult {
  return {
    status: 'applied',
    fileId: 'file-1',
    versionId: 'ver-1',
    changed: true,
    failedHunks: [],
    text,
    hashHex: sha256Hex(text),
    contentVersionB64: 'dnYy',
    ...overrides,
  }
}

async function pulledFixture(text = 'intro\n\nbody\n') {
  const cwd = await tempDir('glovebox-textpush-')
  const client = stubClient({
    readText: { fileId: 'file-1', path: 'docs/note.md', text },
    push: () => appliedResult(text),
  })
  const view = await runPull({ workspaceId: 'ws-1', path: 'docs/note.md', cwd, client })
  return { cwd, view, baseText: text }
}

describe('glovebox pull', () => {
  it('writes the file at its workspace path and records the merge base', async () => {
    const { cwd, view, baseText } = await pulledFixture()
    expect(view).toMatchObject({ fileId: 'file-1', path: 'docs/note.md' })
    expect(await readFile(join(cwd, 'docs/note.md'), 'utf-8')).toBe(baseText)

    const record = await readBookkeeping(cwd, 'file-1')
    expect(record).not.toBeNull()
    expect(record!.baseText).toBe(baseText)
    expect(record!.meta).toMatchObject({
      workspaceId: 'ws-1',
      fileId: 'file-1',
      path: 'docs/note.md',
      baseHashHex: sha256Hex(baseText),
    })
  })
})

describe('glovebox push', () => {
  it('exit 0: clean merge advances the base and the local file', async () => {
    const { cwd, baseText } = await pulledFixture()
    await writeFile(join(cwd, 'docs/note.md'), 'intro\n\nbody edited\n')

    // The server folds in a concurrent edit: merged ≠ what we sent.
    const merged = 'intro (live)\n\nbody edited\n'
    const pushCalls: TextPushInput[] = []
    const client = stubClient({ push: () => appliedResult(merged), pushCalls })

    const outcome = await runPush({ path: 'docs/note.md', cwd, client })
    expect(outcome.exitCode).toBe(0)
    expect(pushCalls[0]).toMatchObject({
      fileId: 'file-1',
      baseHashHex: sha256Hex(baseText),
      idempotencyKey: stablePushKey('file-1', sha256Hex(baseText), 'intro\n\nbody edited\n'),
    })
    // Local file and base advanced to the merged result.
    expect(await readFile(join(cwd, 'docs/note.md'), 'utf-8')).toBe(merged)
    const record = await readBookkeeping(cwd, 'file-1')
    expect(record!.baseText).toBe(merged)
    expect(record!.meta.baseHashHex).toBe(sha256Hex(merged))
  })

  it('exit 2: failed hunks leave the local file and base untouched', async () => {
    const { cwd, baseText } = await pulledFixture()
    await writeFile(join(cwd, 'docs/note.md'), 'intro\n\nbody edited\n')
    const client = stubClient({
      push: () =>
        appliedResult('server text\n', { changed: false, failedHunks: ['@@ -1,3 +1,3 @@ rej'] }),
    })

    const outcome = await runPush({ path: 'docs/note.md', cwd, client })
    expect(outcome.exitCode).toBe(2)
    if (outcome.exitCode !== 2) throw new Error('unreachable')
    expect(outcome.result.failedHunks).toEqual(['@@ -1,3 +1,3 @@ rej'])
    expect(await readFile(join(cwd, 'docs/note.md'), 'utf-8')).toBe('intro\n\nbody edited\n')
    expect((await readBookkeeping(cwd, 'file-1'))!.baseText).toBe(baseText)
  })

  it('exit 3: degenerate refusal, and --force forwards the override', async () => {
    const { cwd } = await pulledFixture()
    await writeFile(join(cwd, 'docs/note.md'), 'tiny\n')
    const pushCalls: TextPushInput[] = []
    const client = stubClient({
      push: (input) =>
        input.force
          ? appliedResult('tiny\n')
          : { status: 'degenerate-rewrite', fileId: 'file-1', deletedRatio: 0.92 },
      pushCalls,
    })

    const refused = await runPush({ path: 'docs/note.md', cwd, client })
    expect(refused.exitCode).toBe(3)
    const forced = await runPush({ path: 'docs/note.md', cwd, client, force: true })
    expect(forced.exitCode).toBe(0)
    expect(pushCalls[1]).toMatchObject({ force: true })
  })

  it('re-sends the recorded base when the server cache missed', async () => {
    const { cwd, baseText } = await pulledFixture()
    await writeFile(join(cwd, 'docs/note.md'), 'intro\n\nbody edited\n')
    const pushCalls: TextPushInput[] = []
    const client = stubClient({
      push: (input) =>
        input.baseText === undefined
          ? { status: 'base-missing', fileId: 'file-1' }
          : appliedResult('intro\n\nbody edited\n'),
      pushCalls,
    })

    const outcome = await runPush({ path: 'docs/note.md', cwd, client })
    expect(outcome.exitCode).toBe(0)
    if (outcome.exitCode !== 0) throw new Error('unreachable')
    expect(outcome.resent).toBe(true)
    expect(pushCalls).toHaveLength(2)
    expect(pushCalls[0]!.baseText).toBeUndefined()
    expect(pushCalls[1]!.baseText).toBe(baseText)
    // Same logical push → same replay key on both attempts.
    expect(pushCalls[1]!.idempotencyKey).toBe(pushCalls[0]!.idempotencyKey)
  })

  it('exit 1: pushing without a pull is refused with guidance', async () => {
    const cwd = await tempDir('glovebox-textpush-')
    const client = stubClient({ push: () => appliedResult('x') })
    const outcome = await runPush({ path: 'docs/unknown.md', cwd, client })
    expect(outcome.exitCode).toBe(1)
    if (outcome.exitCode !== 1) throw new Error('unreachable')
    expect(outcome.error).toContain('glovebox pull')
  })

  it('normalizes CRLF local edits before pushing (INV-13)', async () => {
    const { cwd } = await pulledFixture()
    await writeFile(join(cwd, 'docs/note.md'), 'intro\r\n\r\nbody edited\r\n')
    const pushCalls: TextPushInput[] = []
    const client = stubClient({
      push: () => appliedResult('intro\n\nbody edited\n'),
      pushCalls,
    })

    const outcome = await runPush({ path: 'docs/note.md', cwd, client })
    expect(outcome.exitCode).toBe(0)
    expect(pushCalls[0]!.newText).toBe('intro\n\nbody edited\n')
  })
})
