// Send an opaque.submit with decoded bytes just over LIMITS.maxOpaqueBytes.
// Placeholders: __WSID__, __FILEID__, __PATH__, __OPID__.
;(async () => {
  const WSID = '__WSID__'
  const fileId = '__FILEID__'
  const observedPath = '__PATH__'
  const opId = '__OPID__'
  const bytes = new Uint8Array(10 * 1024 * 1024 + 1)
  const chunkSize = 512 * 1024
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251

  function bytesToBase64(value) {
    let binary = ''
    for (let i = 0; i < value.length; i += 0x8000) {
      binary += String.fromCharCode(...value.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  function bytesToHex(value) {
    let hex = ''
    for (const byte of value) {
      hex += byte.toString(16).padStart(2, '0')
    }
    return hex
  }

  async function sha256(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', value))
  }

  const chunks = []
  const objects = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
    const hashB64 = bytesToBase64(await sha256(chunk))
    chunks.push({ hashB64, size: chunk.byteLength })
    objects.push({ hashB64, bytesB64: bytesToBase64(chunk) })
  }
  const hashHex = bytesToHex(await sha256(bytes))

  async function socketUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
    const base = proto + location.host + '/ws/' + encodeURIComponent(WSID)
    const res = await fetch('/api/rpc/auth/mintWorkspaceSocketToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ json: { workspaceId: WSID } }),
    })
    if (!res.ok) return base
    const body = await res.json().catch(() => null)
    const token = body?.json?.token
    return token ? base + '?token=' + encodeURIComponent(token) : base
  }
  const sock = new WebSocket(await socketUrl())
  const result = await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ err: 'timeout waiting for oversize rejection' }),
      15000,
    )
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
          baseHashHex: '',
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
