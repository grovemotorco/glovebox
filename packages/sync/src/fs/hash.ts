import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

const encoder = new TextEncoder()

/**
 * Isomorphic synchronous sha256 (pure JS via @noble/hashes): the same
 * watermarks and base hashes are computed in the browser engine, the
 * worker/DO, the daemon, and the CLI. `node:crypto` is off-limits here —
 * this module is reachable from `@glovebox.md/sync/client`, and a browser
 * bundle externalizes node built-ins; WebCrypto's digest is async and the
 * sync call sites (scan watermarks, opaque conflicts, push bases) cannot
 * await it.
 */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? encoder.encode(data) : data))
}
