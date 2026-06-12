import { createHash } from 'node:crypto'
import { sha256Hex as nobleSha256Hex } from '../fs/hash.ts'

/**
 * Server-side sha256: `node:crypto`'s native hash (available in node, bun,
 * and workerd under `nodejs_compat`). The pure-JS isomorphic fallback in
 * `../fs/hash.ts` runs at ~15 MB/s inside workerd, which put ~22ms of
 * hashing on every content submit of a ~350KB doc — native is two orders
 * of magnitude faster. Server-only: never import from client-reachable code.
 */
const nativeWorks = (() => {
  try {
    return (
      createHash('sha256').update('').digest('hex') ===
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  } catch {
    return false
  }
})()

export function sha256Hex(data: Uint8Array | string): string {
  if (nativeWorks) {
    return createHash('sha256').update(data).digest('hex')
  }
  return nobleSha256Hex(data)
}
