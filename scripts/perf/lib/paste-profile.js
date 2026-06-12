// Profile a single REAL clipboard paste of ~__SIZE_KB__ KB into the focused
// editor — one transaction, the realistic large-edit path. Returns synchronous
// handler time + main-thread long tasks during settling.
// Placeholders substituted by measure.sh: __SIZE_KB__ __SENTINEL__
//
// The sentinel is prepended so you can later verify the paste synced to a peer
// (open the doc there and look for the sentinel near the top).
;(async () => {
  const SIZE_KB = __SIZE_KB__,
    SENTINEL = '__SENTINEL__'
  const c = document.querySelector('.cm-content')
  if (!c) return JSON.stringify({ err: 'no .cm-content (open a doc first)' })
  let body = '',
    i = 0
  while (body.length < SIZE_KB * 1024) {
    body += `## Section ${i}\n\nThe quick brown fox jumps over the lazy dog. Paragraph ${i} **bold** _italic_ \`code\`.\n\n- a${i}\n- b${i}\n\n`
    i++
  }
  const content = SENTINEL + ' ' + body
  const data = new DataTransfer()
  data.setData('text/plain', content)
  const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  c.focus()
  const sel = window.getSelection()
  sel.selectAllChildren(c)
  sel.collapseToStart()
  const lt = []
  const po = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) lt.push(Math.round(e.duration))
  })
  po.observe({ entryTypes: ['longtask'] })
  const t0 = performance.now()
  const ok = c.dispatchEvent(ev)
  const t1 = performance.now()
  await new Promise((r) => setTimeout(r, 2500)) // let async parse/export/render settle
  po.disconnect()
  return JSON.stringify({
    pastedChars: content.length,
    syncDispatchMs: Math.round(t1 - t0),
    handledByEditor: !ok, // CodeMirror calls preventDefault on a handled paste
    longtasksMs: lt,
    totalBlockedMs: lt.reduce((a, b) => a + b, 0),
    maxBlockMs: lt.length ? Math.max(...lt) : 0,
  })
})()
