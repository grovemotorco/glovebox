import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory-fs.ts'
import { DELETION_SCENARIOS, EDITOR_SAVE_PATTERNS } from '../src/corpus/editor-saves.ts'

const TARGET = 'notes/a.md'
const BEFORE = 'original content\n'
const AFTER = 'saved content v2\n'

async function seededFs(): Promise<MemoryFS> {
  const fs = new MemoryFS('/mount')
  await fs.writeFile('.glovebox.json', '{"workspaceId":"sim"}\n')
  await fs.writeFile(TARGET, BEFORE)
  await fs.writeFile('notes/b.md', 'bystander\n')
  return fs
}

describe('editor-save syscall matrix (ISSUE-0026)', () => {
  for (const pattern of EDITOR_SAVE_PATTERNS) {
    it(`${pattern.name}: lands the new content with no litter`, async () => {
      const fs = await seededFs()
      const statBefore = await fs.stat(TARGET)
      await pattern.run(fs, TARGET, AFTER)

      expect(await fs.readFile(TARGET)).toBe(AFTER)
      for (const transient of pattern.transientPaths(TARGET)) {
        expect(await fs.exists(transient)).toBe(false)
      }
      expect(await fs.readFile('notes/b.md')).toBe('bystander\n')

      const statAfter = await fs.stat(TARGET)
      if (pattern.replacesNode) {
        // tmp+rename savers replace the inode — nodeId-first rename
        // detection must treat this as the same logical file.
        expect(statAfter!.nodeId).not.toBe(statBefore!.nodeId)
      } else {
        expect(statAfter!.nodeId).toBe(statBefore!.nodeId)
      }
    })
  }

  it('every pattern is idempotent over repeated saves', async () => {
    for (const pattern of EDITOR_SAVE_PATTERNS) {
      const fs = await seededFs()
      await pattern.run(fs, TARGET, 'first\n')
      await pattern.run(fs, TARGET, 'second\n')
      await pattern.run(fs, TARGET, 'third\n')
      expect(await fs.readFile(TARGET)).toBe('third\n')
    }
  })
})

describe('deletion-safety scenario scripts (ISSUE-0013/0023/0031/0034)', () => {
  for (const scenario of DELETION_SCENARIOS) {
    it(`${scenario.name} [${scenario.issue}] replays on MemoryFS`, async () => {
      const fs = await seededFs()
      await scenario.run(fs)
      // FS-level choreography only — the named daemon policy
      // (scenario.expectation) is asserted against the M4 daemon.
      expect(scenario.expectation).toBeTruthy()
    })
  }

  it('bulk disappearance wipes everything the daemon would scan', async () => {
    const fs = await seededFs()
    await DELETION_SCENARIOS.find((s) => s.expectation === 'bulk-delete-guard')!.run(fs)
    expect(await fs.scan(() => true)).toHaveLength(0)
  })

  it('rename-correction script leaves the recreated file in place', async () => {
    const fs = await seededFs()
    await DELETION_SCENARIOS.find((s) => s.expectation === 'rename-correction-window')!.run(fs)
    expect(await fs.readFile(TARGET)).toBe('recreated by rename\n')
  })
})
