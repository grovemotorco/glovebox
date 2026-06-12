import { describe, expect, it } from 'vitest'
import { LoroFileDoc } from '@glovebox/sync/loro'
import { DELETION_SCENARIOS } from '../src/corpus/editor-saves.ts'
import { SimWorld, type SimDaemon } from '../src/sim/world.ts'

/**
 * The ISSUE-0013/0023/0031/0034 deletion-safety corpus, executed against a
 * LIVE daemon (real DaemonSyncEngine + real WorkspaceServer under SimWorld's
 * virtual clock). Each scenario's `expectation` names the policy under test;
 * the dispatch below asserts exactly that policy's observable outcome — a
 * scenario without an assertion block fails loudly.
 */

const FIXTURE = {
  'notes/a.md': 'alpha content\n',
  'notes/b.md': 'beta content\n',
  'notes/c.md': 'gamma content\n',
}

interface Adopted {
  world: SimWorld
  daemon: SimDaemon
  fileIdAt: (path: string) => string
}

async function adoptedDaemon(): Promise<Adopted> {
  const world = new SimWorld({ seed: 7 })
  const daemon = await world.addDaemon('daemon', { ...FIXTURE })
  await daemon.engine.runCycle() // registers the fixture files
  await daemon.engine.runCycle() // settles the cursor over the create events
  const byPath = new Map(daemon.engine.files().map((file) => [file.path, file.fileId]))
  expect([...byPath.keys()].sort()).toEqual(Object.keys(FIXTURE).sort())
  return {
    world,
    daemon,
    fileIdAt: (path) => {
      const fileId = byPath.get(path)
      if (!fileId) throw new Error(`no fileId for ${path}`)
      return fileId
    },
  }
}

/** Tombstone events that actually reached the durable wire log. */
async function propagatedDeletes(daemon: SimDaemon): Promise<number> {
  const result = await daemon.transport.eventsSince(0)
  if (!result.ok) throw new Error('replay window unexpectedly exceeded')
  return result.events.filter((event) => event.type === 'delete').length
}

/** Server text for a file the daemon still tracks (snapshot fetch is then
 *  side-effect free — never call this for a possibly-deleted file). */
async function serverText(daemon: SimDaemon, fileId: string): Promise<string> {
  const snapshot = await daemon.transport.fetchSnapshot(fileId)
  return LoroFileDoc.fromSnapshot(snapshot).getTextContent()
}

describe('deletion-safety corpus against the live daemon', () => {
  for (const scenario of DELETION_SCENARIOS) {
    it(`${scenario.issue}: ${scenario.name} → ${scenario.expectation}`, async () => {
      const { world, daemon, fileIdAt } = await adoptedDaemon()
      const fileA = fileIdAt('notes/a.md')

      switch (scenario.expectation) {
        case 'tombstone-delay': {
          await scenario.run(daemon.fs)
          await daemon.engine.runCycle()
          expect(daemon.engine.pendingDeletes()).toHaveLength(1)
          expect(await propagatedDeletes(daemon)).toBe(0)

          world.advanceClock(29_000)
          await daemon.engine.runCycle()
          expect(await propagatedDeletes(daemon)).toBe(0)

          world.advanceClock(2_000)
          await daemon.engine.runCycle()
          expect(await propagatedDeletes(daemon)).toBe(1)
          expect(
            daemon.engine
              .files()
              .map((file) => file.path)
              .sort(),
          ).toEqual(['notes/b.md', 'notes/c.md'])
          expect(await serverText(daemon, fileIdAt('notes/b.md'))).toBe('beta content\n')
          return
        }

        case 'rename-correction-window': {
          await scenario.run(daemon.fs)
          await daemon.engine.runCycle()
          world.advanceClock(60_000)
          await daemon.engine.runCycle()
          await daemon.engine.runCycle()

          // The absence was transient: never a delete, same fileId, and the
          // recreated bytes are everywhere.
          expect(await propagatedDeletes(daemon)).toBe(0)
          expect(daemon.engine.files().find((file) => file.path === 'notes/a.md')?.fileId).toBe(
            fileA,
          )
          expect(daemon.fs.getFile('notes/a.md')).toBe('recreated by rename\n')
          expect(daemon.engine.getText(fileA)).toBe('recreated by rename\n')
          expect(await serverText(daemon, fileA)).toBe('recreated by rename\n')
          return
        }

        case 'bulk-delete-guard': {
          await scenario.run(daemon.fs)
          await daemon.engine.runCycle()
          world.advanceClock(120_000)
          await daemon.engine.runCycle()
          await daemon.engine.runCycle()

          // The wipe must not propagate, no matter how long it sits; the
          // server retains every file and the daemon keeps tracking them.
          expect(await propagatedDeletes(daemon)).toBe(0)
          expect(daemon.engine.files()).toHaveLength(3)
          for (const [path, content] of Object.entries(FIXTURE)) {
            expect(await serverText(daemon, fileIdAt(path))).toBe(content)
          }
          return
        }

        case 'sentinel-check': {
          await scenario.run(daemon.fs) // removes .glovebox.json only
          // Probe: with the sentinel gone, even a real absence is untrusted.
          await daemon.fs.deletePath('notes/a.md')
          await daemon.engine.runCycle()
          world.advanceClock(120_000)
          await daemon.engine.runCycle()
          await daemon.engine.runCycle()

          expect(daemon.engine.mountSuspect()).toBe(true)
          expect(daemon.engine.pendingDeletes()).toEqual([])
          expect(await propagatedDeletes(daemon)).toBe(0)
          expect(await serverText(daemon, fileA)).toBe('alpha content\n')
          return
        }

        case 'no-recovery-amplification': {
          await scenario.run(daemon.fs)
          await daemon.engine.runCycle()
          await daemon.engine.runCycle()
          const settledSeq = daemon.engine.lastAckedSeq()
          await daemon.engine.runCycle()
          await daemon.engine.runCycle()

          // The last disk write wins exactly once; further cycles are quiet
          // (an amplifier would keep minting content events, INV-11).
          const finalText = 'stale buffer contents replayed\n'
          expect(daemon.fs.getFile('notes/a.md')).toBe(finalText)
          expect(daemon.engine.getText(fileA)).toBe(finalText)
          expect(await serverText(daemon, fileA)).toBe(finalText)
          expect(daemon.engine.lastAckedSeq()).toBe(settledSeq)
          expect(await propagatedDeletes(daemon)).toBe(0)
          return
        }
      }
    })
  }
})
