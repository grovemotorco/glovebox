import { describe, expect, it } from 'vitest'
import { SeededRandom } from '../src/sim/scheduler.ts'
import { SimWorld, type SimClient } from '../src/sim/world.ts'

const FILE = 'doc-1'
const PATH = 'notes.md'

/**
 * Randomized convergence sweep: three real engines against the real server
 * core, broadcasts dropped/duplicated/reordered by seed, random append
 * edits and client reboots, then quiesce and assert INV-1 + INV-2 markers.
 * On failure the error carries the seed — rerunning that seed replays the
 * exact interleaving.
 */
describe('SimWorld randomized convergence', () => {
  const SEEDS = [1, 2, 3, 7, 11, 42, 99, 1234, 31337, 951_413]

  for (const seed of SEEDS) {
    it(`seed ${seed}: random edits + drops + reorders + reboots converge`, async () => {
      const world = new SimWorld({
        seed,
        broadcastPolicy: { dropRate: 0.25, duplicateRate: 0.1 },
      })
      const random = new SeededRandom(seed ^ 0x5eed)

      const clients: SimClient[] = []
      for (const deviceId of ['alpha', 'beta', 'gamma']) {
        clients.push(await world.addClient(deviceId))
      }
      await clients[0]!.engine.openFile(FILE, PATH, 'seed-doc\n')
      for (const client of clients.slice(1)) {
        await client.engine.openFile(FILE, PATH)
      }

      const ackedMarkers: string[] = []
      for (let step = 0; step < 12; step += 1) {
        const client = random.pick(clients)
        if (random.chance(0.2)) {
          await world.quiesce()
          await client.reboot()
          continue
        }
        const marker = `[${client.deviceId}-${step}]`
        const current = client.engine.getText(FILE)
        if (current === null) continue
        await client.engine.client(FILE)!.setTextContent(`${current}${marker}\n`)
        await client.engine.flush()
        ackedMarkers.push(marker)
      }

      await world.quiesce()
      const finalText = await world.assertConverged(FILE)
      for (const marker of ackedMarkers) {
        expect(finalText).toContain(marker)
      }
    })
  }
})
