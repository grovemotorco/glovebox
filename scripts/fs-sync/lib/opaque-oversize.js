// Send an opaque.submit with decoded bytes just over LIMITS.maxUpdateBytes.
// Placeholders: __WSID__, __FILEID__, __PATH__, __OPID__.
;(async () => {
  const WSID = '__WSID__'
  const fileId = '__FILEID__'
  const observedPath = '__PATH__'
  const opId = '__OPID__'
  const bytes = new Uint8Array(1_048_576 + 1)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  const sock = new WebSocket(proto + location.host + '/ws/' + WSID)
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ err: 'timeout waiting for oversize rejection' }), 15000)
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
          bytesB64: btoa(binary),
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
})()
