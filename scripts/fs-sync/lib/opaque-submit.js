// Send one opaque.submit using the DOFS-style manifest/object wire shape.
// Placeholders:
//   __WSID__, __FILEID__, __PATH__, __OPID__, __BASE_HASH_HEX__, __BYTES_B64__.
;(async () => {
  const WSID = '__WSID__'
  const fileId = '__FILEID__'
  const observedPath = '__PATH__'
  const opId = '__OPID__'
  const baseHashHex = '__BASE_HASH_HEX__'
  const bytesB64 = '__BYTES_B64__'
  const chunkSize = 512 * 1024

  function base64ToBytes(value) {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  function bytesToBase64(bytes) {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  function bytesToHex(bytes) {
    let hex = ''
    for (const byte of bytes) {
      hex += byte.toString(16).padStart(2, '0')
    }
    return hex
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  }

  const bytes = base64ToBytes(bytesB64)
  const chunks = []
  const objects = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    const hashB64 = bytesToBase64(await sha256(chunk))
    chunks.push({ hashB64, size: chunk.byteLength })
    objects.push({ hashB64, bytesB64: bytesToBase64(chunk) })
  }
  const hashHex = bytesToHex(await sha256(bytes))

  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  const sock = new WebSocket(proto + location.host + '/ws/' + WSID)
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ err: 'timeout waiting for opaque ack' }), 10000)
    sock.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if (m.opId === opId) {
        clearTimeout(timer)
        resolve(m)
      }
    }
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'hello', deviceId: 'fs-sync-harness' }))
      sock.send(
        JSON.stringify({
          type: 'opaque.submit',
          fileId,
          observedPath,
          opId,
          baseHashHex,
          hashHex,
          sizeBytes: bytes.byteLength,
          manifest: { chunks },
          objects,
        }),
      )
    }
    sock.onerror = () => {
      clearTimeout(timer)
      resolve({ err: 'ws error' })
    }
  })
  try {
    sock.close()
  } catch {}
  return JSON.stringify(result)
})().catch((error) =>
  JSON.stringify({ err: error instanceof Error ? error.message : String(error) }),
)
