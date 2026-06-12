// Send ONE raw workspace wire message (content.submit / opaque.submit /
// snapshot.get ...) over a fresh in-page WebSocket and return the first
// response that answers it (matched by opId or requestId).
// Placeholders: __WSID__, __MSG__ (one-line JSON object).
;(async () => {
  const WSID = '__WSID__'
  const msg = __MSG__
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  const sock = new WebSocket(proto + location.host + '/ws/' + WSID)
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ err: 'timeout waiting for ack' }), 10000)
    sock.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(ev.data)
      } catch {
        return
      }
      const answersOp = msg.opId && m.opId === msg.opId
      const answersReq = msg.requestId && m.requestId === msg.requestId
      if (answersOp || answersReq) {
        clearTimeout(timer)
        resolve(m)
      }
    }
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: 'hello', deviceId: 'fs-sync-harness' }))
      sock.send(JSON.stringify(msg))
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
