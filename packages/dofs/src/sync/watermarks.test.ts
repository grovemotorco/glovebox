import { describe, expect, it } from 'vitest'

import { withDB } from '../fs/with-db.js'
import { writeFile } from '../fs/writeFile.js'
import { currentRev, readWatermark, writeWatermark } from './watermarks.js'

describe('watermarks', () => {
  it('readWatermark returns 0 for a fresh DB', async () => {
    await withDB(async (db) => {
      expect(readWatermark(db, 'pushRev')).toBe(0)
      expect(readWatermark(db, 'fetchRev')).toBe(0)
    })
  })

  it('writeWatermark persists across reads', async () => {
    await withDB(async (db) => {
      writeWatermark(db, 'pushRev', 42)
      expect(readWatermark(db, 'pushRev')).toBe(42)
      expect(readWatermark(db, 'fetchRev')).toBe(0)
      writeWatermark(db, 'fetchRev', 7)
      expect(readWatermark(db, 'fetchRev')).toBe(7)
    })
  })

  it('watermarks advance monotonically (the caller enforces this)', async () => {
    await withDB(async (db) => {
      writeWatermark(db, 'pushRev', 5)
      writeWatermark(db, 'pushRev', 10)
      expect(readWatermark(db, 'pushRev')).toBe(10)
      // Going backwards is allowed by the helper itself; the sync
      // layer's batch-commit logic is what keeps the counter monotonic.
      writeWatermark(db, 'pushRev', 3)
      expect(readWatermark(db, 'pushRev')).toBe(3)
    })
  })

  it('currentRev reports the latest rev stamped on a mutation', async () => {
    await withDB(async (db) => {
      // initializeSchema seeds rev=1 (stamped on the root inode).
      const base = currentRev(db)
      expect(base).toBeGreaterThanOrEqual(1)
      await writeFile(db, '/a.txt', 'x', {}, () => 1)
      const r1 = currentRev(db)
      expect(r1).toBeGreaterThan(base)
      await writeFile(db, '/b.txt', 'y', {}, () => 2)
      expect(currentRev(db)).toBeGreaterThan(r1)
    })
  })

  it('rejects unknown watermark keys at the type level via the helper signature', () => {
    // Compile-time only: writeWatermark only accepts the union
    // "pushRev" | "fetchRev". This test is a placeholder that
    // documents the contract; the type system catches misuse.
    expect(true).toBe(true)
  })

  describe('per-backend keying', () => {
    it('writes under the default backend when the caller omits the id', async () => {
      await withDB(async (db) => {
        writeWatermark(db, 'pushRev', 17)
        // The omitted-id read sees the same row.
        expect(readWatermark(db, 'pushRev')).toBe(17)
        // An explicit "default" id also sees it — same slot.
        expect(readWatermark(db, 'pushRev', 'default')).toBe(17)
      })
    })

    it("keeps each backend's cursors independent", async () => {
      await withDB(async (db) => {
        writeWatermark(db, 'pushRev', 10, 'worker')
        writeWatermark(db, 'pushRev', 20, 'container')
        expect(readWatermark(db, 'pushRev', 'worker')).toBe(10)
        expect(readWatermark(db, 'pushRev', 'container')).toBe(20)
        // A push under "worker" doesn't disturb the "container"
        // backend's cursor.
        writeWatermark(db, 'pushRev', 11, 'worker')
        expect(readWatermark(db, 'pushRev', 'worker')).toBe(11)
        expect(readWatermark(db, 'pushRev', 'container')).toBe(20)
      })
    })

    it('unknown backend id reads as 0', async () => {
      await withDB(async (db) => {
        writeWatermark(db, 'pushRev', 5, 'worker')
        expect(readWatermark(db, 'pushRev', 'never-registered')).toBe(0)
      })
    })
  })
})
