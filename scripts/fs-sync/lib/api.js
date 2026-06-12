// Call an oRPC procedure from the signed-in page (session cookie auth).
// Placeholders: __PATH__ (e.g. workspaces/tree), __INPUT__ (one-line JSON).
// Returns {status, body} where body is the parsed {json: ...} envelope.
;(async () => {
  const res = await fetch('/api/rpc/__PATH__', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ json: __INPUT__ }),
  })
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return JSON.stringify({ status: res.status, body })
})()
