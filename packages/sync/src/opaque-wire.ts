import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { OpaqueManifest } from '@glovebox.md/core'
import { sha256Hex } from './fs/hash.ts'
import { base64ToBytes, bytesToBase64 } from './loro/base64.ts'

export const OPAQUE_CHUNK_SIZE = 512 * 1024

export interface OpaqueObjectPayload {
  hashB64: string
  bytesB64: string
}

export interface OpaqueWirePayload {
  hashHex: string
  sizeBytes: number
  manifest: OpaqueManifest
  objects: OpaqueObjectPayload[]
}

export interface OpaqueContentRef {
  hashHex: string
  sizeBytes: number
  manifest: OpaqueManifest
}

export function buildOpaqueWirePayload(bytes: Uint8Array): OpaqueWirePayload {
  const chunks = []
  const objects: OpaqueObjectPayload[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += OPAQUE_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, Math.min(offset + OPAQUE_CHUNK_SIZE, bytes.byteLength))
    const hash = sha256(chunk)
    const hashB64 = bytesToBase64(hash)
    chunks.push({ hashB64, size: chunk.byteLength })
    objects.push({ hashB64, bytesB64: bytesToBase64(chunk) })
  }
  return {
    hashHex: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    manifest: { chunks },
    objects,
  }
}

export function contentRefFromPayload(payload: OpaqueWirePayload): OpaqueContentRef {
  return {
    hashHex: payload.hashHex,
    sizeBytes: payload.sizeBytes,
    manifest: payload.manifest,
  }
}

export function assembleOpaqueWirePayload(payload: OpaqueWirePayload): Uint8Array {
  const objects = new Map<string, Uint8Array>()
  for (const object of payload.objects) {
    const bytes = base64ToBytes(object.bytesB64)
    const actualHash = bytesToBase64(sha256(bytes))
    if (actualHash !== object.hashB64) {
      throw new Error('Opaque object hash mismatch')
    }
    objects.set(object.hashB64, bytes)
  }

  let total = 0
  const ordered: Uint8Array[] = []
  for (const chunk of payload.manifest.chunks) {
    const bytes = objects.get(chunk.hashB64)
    if (bytes === undefined) {
      throw new Error('Opaque object missing from payload')
    }
    if (bytes.byteLength !== chunk.size) {
      throw new Error('Opaque object size mismatch')
    }
    ordered.push(bytes)
    total += bytes.byteLength
  }

  if (total !== payload.sizeBytes) {
    throw new Error('Opaque payload size mismatch')
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const bytes of ordered) {
    out.set(bytes, offset)
    offset += bytes.byteLength
  }
  if (bytesToHex(sha256(out)) !== payload.hashHex) {
    throw new Error('Opaque payload hash mismatch')
  }
  return out
}
