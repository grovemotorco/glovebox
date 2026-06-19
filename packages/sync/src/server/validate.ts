import type { WorkspaceClientMessage } from './workspace-server.ts'

/**
 * Strict ingress validation (INV-12): every inbound WS message is checked
 * against an exact key set with per-field length caps, and the raw message
 * length is capped before any JSON decode. Anything unexpected throws — the
 * server reports it as a protocol error and applies nothing.
 */

export interface IngressLimits {
  /** Absolute pre-decode cap on the raw inbound message, in UTF-16 code units. */
  maxMessageChars: number
  /** Cap on a base64 Loro update field (chars), derived from maxUpdateBytes. */
  maxUpdateB64Chars: number
  /** Cap on one opaque object/chunk base64 field (chars). */
  maxOpaqueObjectB64Chars: number
  /** Raw-message cap for markdown content.submit. */
  maxContentSubmitMessageChars: number
  /** Raw-message cap for opaque.submit. */
  maxOpaqueSubmitMessageChars: number
  /** Raw-message cap for snapshot.get with initialContent. */
  maxSnapshotMessageChars: number
  /** Raw-message cap for lightweight control messages. */
  maxControlMessageChars: number
  /** Cap on inline initial content (chars). */
  maxInitialContentChars: number
}

const FILE_ID_MAX = 256
const OP_ID_MAX = 128
const REQUEST_ID_MAX = 128
const DEVICE_ID_MAX = 128
const PATH_MAX = 1024
const VERSION_B64_MAX = 262_144
/** Structural ops per batch — bounds the work one message can demand. */
const BATCH_OPS_MAX = 128
const OPAQUE_CHUNKS_MAX = 256
const OPAQUE_HASH_B64_MAX = 64
/**
 * Cap on a connection's serialized presence state. Presence is display
 * data (cursor, name, color) — it is broadcast to every socket, so the cap
 * bounds the amplification, not just storage.
 */
export const PRESENCE_STATE_JSON_MAX = 4096

export function parseClientMessage(raw: string, limits: IngressLimits): WorkspaceClientMessage {
  if (raw.length > limits.maxMessageChars) {
    throw new Error('Message exceeds size limit')
  }
  const hintedLimit = hintedRawLimit(raw, limits)
  if (hintedLimit !== undefined && raw.length > hintedLimit) {
    throw new Error('Message exceeds size limit')
  }

  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object message')
  }
  const message = value as Record<string, unknown>

  switch (message.type) {
    case 'hello':
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'deviceId'])
      optionalString(message, 'deviceId', DEVICE_ID_MAX)
      return message as Extract<WorkspaceClientMessage, { type: 'hello' }>
    case 'snapshot.get':
      requireRawLength(raw, limits.maxSnapshotMessageChars)
      allowKeys(message, ['type', 'requestId', 'fileId', 'initialContent', 'observedPath'])
      requireString(message, 'requestId', REQUEST_ID_MAX)
      requireString(message, 'fileId', FILE_ID_MAX)
      optionalString(message, 'initialContent', limits.maxInitialContentChars, {
        allowEmpty: true,
      })
      optionalString(message, 'observedPath', PATH_MAX)
      return message as Extract<WorkspaceClientMessage, { type: 'snapshot.get' }>
    case 'events.since':
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'requestId', 'afterSeq'])
      requireString(message, 'requestId', REQUEST_ID_MAX)
      requireNonNegativeInteger(message, 'afterSeq')
      return message as Extract<WorkspaceClientMessage, { type: 'events.since' }>
    case 'tree.list':
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'requestId'])
      requireString(message, 'requestId', REQUEST_ID_MAX)
      return message as Extract<WorkspaceClientMessage, { type: 'tree.list' }>
    case 'opaque.get':
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'requestId', 'fileId', 'haveObjects', 'metadataOnly'])
      requireString(message, 'requestId', REQUEST_ID_MAX)
      requireString(message, 'fileId', FILE_ID_MAX)
      optionalOpaqueHashArray(message.haveObjects, 'haveObjects')
      optionalBoolean(message, 'metadataOnly')
      return message as Extract<WorkspaceClientMessage, { type: 'opaque.get' }>
    case 'presence.set':
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'stateJson'])
      requireString(message, 'stateJson', PRESENCE_STATE_JSON_MAX)
      requireJsonString(message, 'stateJson')
      return message as Extract<WorkspaceClientMessage, { type: 'presence.set' }>
    case 'presence.get':
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'requestId'])
      requireString(message, 'requestId', REQUEST_ID_MAX)
      return message as Extract<WorkspaceClientMessage, { type: 'presence.get' }>
    case 'opaque.submit':
      requireRawLength(raw, limits.maxOpaqueSubmitMessageChars)
      allowKeys(message, [
        'type',
        'fileId',
        'observedPath',
        'opId',
        'baseHashHex',
        'hashHex',
        'sizeBytes',
        'manifest',
        'objects',
      ])
      requireString(message, 'fileId', FILE_ID_MAX)
      requireString(message, 'observedPath', PATH_MAX)
      requireString(message, 'opId', OP_ID_MAX)
      requireString(message, 'baseHashHex', 64, { allowEmpty: true })
      requireString(message, 'hashHex', 64)
      requireNonNegativeInteger(message, 'sizeBytes')
      requireOpaqueManifest(message.manifest)
      requireOpaqueObjects(message.objects, limits.maxOpaqueObjectB64Chars)
      return message as Extract<WorkspaceClientMessage, { type: 'opaque.submit' }>
    case 'content.submit':
      requireRawLength(raw, limits.maxContentSubmitMessageChars)
      allowKeys(message, [
        'type',
        'fileId',
        'observedPath',
        'opId',
        'baseContentVersionB64',
        'loroUpdateB64',
      ])
      requireString(message, 'fileId', FILE_ID_MAX)
      requireString(message, 'observedPath', PATH_MAX)
      requireString(message, 'opId', OP_ID_MAX)
      requireString(message, 'baseContentVersionB64', VERSION_B64_MAX, { allowEmpty: true })
      requireString(message, 'loroUpdateB64', limits.maxUpdateB64Chars, { allowEmpty: true })
      return message as Extract<WorkspaceClientMessage, { type: 'content.submit' }>
    case 'batch.submit': {
      requireRawLength(raw, limits.maxControlMessageChars)
      allowKeys(message, ['type', 'requestId', 'ops'])
      requireString(message, 'requestId', REQUEST_ID_MAX)
      const ops = message.ops
      if (!Array.isArray(ops)) {
        throw new Error('Expected array field: ops')
      }
      if (ops.length === 0 || ops.length > BATCH_OPS_MAX) {
        throw new Error('Field out of bounds: ops')
      }
      for (const raw of ops) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('Expected object op in batch')
        }
        const op = raw as Record<string, unknown>
        switch (op.type) {
          case 'file.rename':
            allowKeys(op, ['type', 'opId', 'fileId', 'baseSeq', 'fromPath', 'toPath'])
            requireString(op, 'opId', OP_ID_MAX)
            requireString(op, 'fileId', FILE_ID_MAX)
            requireNonNegativeInteger(op, 'baseSeq')
            requireString(op, 'fromPath', PATH_MAX)
            requireString(op, 'toPath', PATH_MAX)
            break
          case 'file.deleteIntent':
            allowKeys(op, ['type', 'opId', 'fileId', 'baseSeq', 'path'])
            requireString(op, 'opId', OP_ID_MAX)
            requireString(op, 'fileId', FILE_ID_MAX)
            requireNonNegativeInteger(op, 'baseSeq')
            requireString(op, 'path', PATH_MAX)
            break
          default:
            throw new Error('Unknown batch op type')
        }
      }
      return message as Extract<WorkspaceClientMessage, { type: 'batch.submit' }>
    }
    default:
      throw new Error('Unknown message type')
  }
}

function allowKeys(message: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(message)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unexpected key: ${key}`)
    }
  }
}

function requireRawLength(raw: string, maxChars: number): void {
  if (raw.length > maxChars) {
    throw new Error('Message exceeds size limit')
  }
}

function hintedRawLimit(raw: string, limits: IngressLimits): number | undefined {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(raw.slice(0, 4096))
  if (!match) return undefined
  switch (match[1]) {
    case 'opaque.submit':
      return limits.maxOpaqueSubmitMessageChars
    case 'content.submit':
      return limits.maxContentSubmitMessageChars
    case 'snapshot.get':
      return limits.maxSnapshotMessageChars
    case 'hello':
    case 'events.since':
    case 'tree.list':
    case 'opaque.get':
    case 'presence.set':
    case 'presence.get':
    case 'batch.submit':
      return limits.maxControlMessageChars
    default:
      return limits.maxControlMessageChars
  }
}

function requireString(
  message: Record<string, unknown>,
  key: string,
  maxChars: number,
  options: { allowEmpty?: boolean } = {},
): void {
  const value = message[key]
  if (typeof value !== 'string') {
    throw new Error(`Expected string field: ${key}`)
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`Field must not be empty: ${key}`)
  }
  if (value.length > maxChars) {
    throw new Error(`Field exceeds size limit: ${key}`)
  }
}

function requireNonNegativeInteger(message: Record<string, unknown>, key: string): void {
  const value = message[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer field: ${key}`)
  }
}

/** The field must parse as JSON (length is already capped by requireString). */
function requireJsonString(message: Record<string, unknown>, key: string): void {
  try {
    JSON.parse(message[key] as string)
  } catch {
    throw new Error(`Expected JSON string field: ${key}`)
  }
}

function optionalString(
  message: Record<string, unknown>,
  key: string,
  maxChars: number,
  options: { allowEmpty?: boolean } = {},
): void {
  if (message[key] === undefined) return
  requireString(message, key, maxChars, options)
}

function optionalBoolean(message: Record<string, unknown>, key: string): void {
  if (message[key] === undefined) return
  if (typeof message[key] !== 'boolean') {
    throw new Error(`Expected boolean field: ${key}`)
  }
}

function requireOpaqueManifest(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object field: manifest')
  }
  const manifest = value as Record<string, unknown>
  allowKeys(manifest, ['chunks'])
  const chunks = manifest.chunks
  if (!Array.isArray(chunks) || chunks.length > OPAQUE_CHUNKS_MAX) {
    throw new Error('Field out of bounds: manifest.chunks')
  }
  for (const raw of chunks) {
    requireOpaqueChunk(raw)
  }
}

function requireOpaqueObjects(value: unknown, maxBytesB64Chars: number): void {
  if (!Array.isArray(value) || value.length > OPAQUE_CHUNKS_MAX) {
    throw new Error('Field out of bounds: objects')
  }
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Expected object in opaque objects')
    }
    const object = raw as Record<string, unknown>
    allowKeys(object, ['hashB64', 'bytesB64'])
    requireString(object, 'hashB64', OPAQUE_HASH_B64_MAX)
    requireString(object, 'bytesB64', maxBytesB64Chars, { allowEmpty: true })
  }
}

function optionalOpaqueHashArray(value: unknown, key: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > OPAQUE_CHUNKS_MAX) {
    throw new Error(`Field out of bounds: ${key}`)
  }
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > OPAQUE_HASH_B64_MAX) {
      throw new Error(`Invalid opaque hash in ${key}`)
    }
  }
}

function requireOpaqueChunk(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected object in manifest.chunks')
  }
  const chunk = value as Record<string, unknown>
  allowKeys(chunk, ['hashB64', 'size'])
  requireString(chunk, 'hashB64', OPAQUE_HASH_B64_MAX)
  requireNonNegativeInteger(chunk, 'size')
}
