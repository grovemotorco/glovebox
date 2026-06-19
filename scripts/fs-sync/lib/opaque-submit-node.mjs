#!/usr/bin/env node
import { createHash } from 'node:crypto'

const [serverUrl, workspaceId, fileId, observedPath, opId, baseHashHex, bytesArg, socketToken] =
  process.argv.slice(2)

if (!serverUrl || !workspaceId || !fileId || !observedPath || !opId || baseHashHex === undefined) {
  console.error(
    'usage: opaque-submit-node.mjs <server-url> <workspace-id> <file-id> <path> <op-id> <base-hash-hex> <bytes-b64|--oversize> [socket-token]',
  )
  process.exit(2)
}

const bytes =
  bytesArg === '--oversize'
    ? oversizeBytes()
    : new Uint8Array(Buffer.from(bytesArg ?? '', 'base64'))
const chunkSize = 512 * 1024

function oversizeBytes() {
  const out = new Uint8Array(10 * 1024 * 1024 + 1)
  for (let i = 0; i < out.length; i += 1) out[i] = i % 251
  return out
}

function sha256(value) {
  return createHash('sha256').update(value).digest()
}

function submitPayload() {
  const chunks = []
  const objects = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    const hash = sha256(chunk)
    const hashB64 = hash.toString('base64')
    chunks.push({ hashB64, size: chunk.byteLength })
    objects.push({ hashB64, bytesB64: Buffer.from(chunk).toString('base64') })
  }
  return {
    type: 'opaque.submit',
    fileId,
    observedPath,
    opId,
    baseHashHex,
    hashHex: sha256(bytes).toString('hex'),
    sizeBytes: bytes.byteLength,
    manifest: { chunks },
    objects,
  }
}

function socketUrl() {
  const url = new URL(serverUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/${encodeURIComponent(workspaceId)}`
  url.search = ''
  if (socketToken) url.searchParams.set('token', socketToken)
  url.hash = ''
  return url.toString()
}

const result = await new Promise((resolve) => {
  const sock = new WebSocket(socketUrl())
  const timer = setTimeout(() => {
    try {
      sock.close()
    } catch {
      // Already closed.
    }
    resolve({ err: 'timeout waiting for opaque ack' })
  }, 20_000)
  sock.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.opId === opId) {
      clearTimeout(timer)
      resolve(message)
      sock.close()
    }
  })
  sock.addEventListener('open', () => {
    sock.send(JSON.stringify({ type: 'hello', deviceId: 'fs-sync-harness' }))
    sock.send(JSON.stringify(submitPayload()))
  })
  sock.addEventListener('error', () => {
    clearTimeout(timer)
    resolve({ err: 'ws error' })
  })
})

console.log(JSON.stringify(result))
process.exit(0)
