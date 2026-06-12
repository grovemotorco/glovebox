import { describe, expect, it } from 'vitest'
import { SeededRandom, SimCrash } from '../src/sim/scheduler.ts'
import { SimWorld, type SimDaemon } from '../src/sim/world.ts'

const PATH = 'notes.md'
const CHURN_PATH = 'churn.md'

/**
 * M4 daemon under the seeded harness: a real DaemonSyncEngine over a
 * MemoryFS mount, alongside real browser engines, with lossy broadcast
 * delivery and CRASH INJECTION between the daemon's persistence writes.
 * A second "churn" file is deleted/restored on the mount while the virtual
 * clock jumps across the tombstone delay, so delete intents race crashes,
 * propagation, and restores. After quiescence: INV-1 across daemon doc,
 * daemon mount disk, every browser client, and the server; INV-2 — every
 * marker that reached disk or was acked survives; INV-3 — the marker file
 * (never deliberately deleted) is never deleted anywhere, and the churn
 * file's daemon state is self-consistent. Failures print the seed for
 * exact replay.
 */
describe('SimWorld daemon randomized convergence', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 104729 + 7)

  for (const seed of SEEDS) {
    it(`seed ${seed}: daemon cycles + crashes + edits + delete churn converge`, async () => {
      const world = new SimWorld({
        seed,
        broadcastPolicy: { dropRate: 0.25, duplicateRate: 0.1 },
      })
      const random = new SeededRandom(seed ^ 0xdae)

      const daemon = await world.addDaemon('daemon', {
        [PATH]: 'seed-doc\n',
        [CHURN_PATH]: 'churn-doc\n',
      })
      await daemon.engine.runCycle()
      const files = daemon.engine.files()
      expect(files).toHaveLength(2)
      const fileId = files.find((file) => file.path === PATH)!.fileId

      const clients = [await world.addClient('alpha'), await world.addClient('beta')]
      for (const client of clients) {
        await client.engine.openFile(fileId, PATH)
      }

      const cycleSurvivingCrash = async (target: SimDaemon): Promise<void> => {
        try {
          await target.engine.runCycle()
        } catch (error) {
          if (!(error instanceof SimCrash)) throw error
          await target.reboot()
        }
      }

      const markers: string[] = []
      for (let step = 0; step < 14; step += 1) {
        const roll = random.next()
        if (roll < 0.3) {
          // Browser-side edit, flushed to ack (INV-2 marker).
          const client = random.pick(clients)
          const current = client.engine.getText(fileId)
          if (current === null) continue
          const marker = `[${client.deviceId}-${step}]`
          await client.engine.client(fileId)!.setTextContent(`${current}${marker}\n`)
          await client.engine.flush()
          markers.push(marker)
        } else if (roll < 0.6) {
          // Mount-side edit: bytes on disk MUST survive crashes — the mount
          // itself is durable even when the daemon process dies (INV-2).
          const current = daemon.fs.getFile(PATH)
          if (current === null) continue
          const marker = `[disk-${step}]`
          daemon.fs.putFile(PATH, `${current}${marker}\n`)
          markers.push(marker)
          await cycleSurvivingCrash(daemon)
        } else if (roll < 0.72) {
          // Arm the fuse on an upcoming persistence write, then cycle: the
          // process dies between two artifact writes and restarts over
          // whatever made it to storage.
          daemon.armCrash(1 + random.int(4))
          await cycleSurvivingCrash(daemon)
          if (daemon.crashed()) await daemon.reboot()
        } else if (roll < 0.82) {
          // Delete churn: remove or restore the churn file on the mount.
          // Restores while an intent is open exercise cancelation; deletes
          // that survive a clock jump exercise propagation + finalize.
          if (daemon.fs.getFile(CHURN_PATH) === null) {
            daemon.fs.putFile(CHURN_PATH, `churn-restored-${step}\n`)
          } else {
            await daemon.fs.deletePath(CHURN_PATH)
          }
          await cycleSurvivingCrash(daemon)
        } else if (roll < 0.9) {
          // Time passes — open intents may cross the tombstone delay.
          world.advanceClock(random.int(40_000))
          await cycleSurvivingCrash(daemon)
        } else if (roll < 0.96) {
          await cycleSurvivingCrash(daemon)
        } else {
          await world.quiesce()
          await random.pick(clients).reboot()
        }
      }

      await world.quiesce()
      const finalText = await world.assertConverged(fileId)
      for (const marker of markers) {
        expect(finalText, `marker ${marker} lost (seed ${seed})`).toContain(marker)
      }

      // INV-3: nothing ever deletes the marker file — its absence was never
      // observed, so no intent may exist and the mount copy must survive.
      expect(
        daemon.fs.getFile(PATH),
        `marker file vanished from the mount (seed ${seed})`,
      ).not.toBeNull()
      expect(daemon.engine.pendingDeletes().map((intent) => intent.fileId)).not.toContain(fileId)

      // Churn-file self-consistency on the daemon: tracked + no open intent
      // ⇒ materialized on disk with exactly the doc text; an open intent ⇒
      // the disk copy is absent (that is what the intent witnesses).
      const churn = daemon.engine.files().find((file) => file.path === CHURN_PATH)
      if (churn) {
        const intentOpen = daemon.engine
          .pendingDeletes()
          .some((intent) => intent.fileId === churn.fileId)
        const disk = daemon.fs.getFile(CHURN_PATH)
        if (intentOpen) {
          expect(disk, `open intent but file on disk (seed ${seed})`).toBeNull()
        } else {
          expect(disk, `tracked churn file missing on disk (seed ${seed})`).toBe(
            daemon.engine.getText(churn.fileId),
          )
        }
      }
    })
  }
})
