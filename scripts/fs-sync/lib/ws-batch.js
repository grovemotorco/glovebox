// Submit structural ops (file.rename / file.deleteIntent) over a fresh
// workspace WebSocket from the browser page — the same wire protocol the
// daemon speaks. This is the "browser-origin" rename/delete path: the web UI
// has no rename/delete affordance yet, so a second in-page socket is the
// closest browser-side writer.
// Placeholders: __WSID__, __OPS__ (one-line JSON array of wire ops).
;(async () => {
  const WSID = '__WSID__'
  const ops = __OPS__
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  const sock = new WebSocket(proto + location.host + '/ws/' + WSID)
  const reqId = 'fsx-' + Math.random().toString(36).slice(2)
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ err: 'timeout waiting for batch ack' }), 10000)
    sock.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      if ((m.type === 'batch.ack' || m.type === 'batch.rejected') && m.requestId === reqId) {
        clearTimeout(timer)
        resolve(m)
      }
    }
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'hello', deviceId: 'fs-sync-harness' }))
      sock.send(JSON.stringify({ type: 'batch.submit', requestId: reqId, ops }))
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
