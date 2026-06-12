// Type a burst of unique-marker edits in the SENDER session; return the send log.
// Placeholders substituted by measure.sh: __NONCE__ __COUNT__ __INTERVAL__ __WHERE__
//
// Each marker is a SMALL string inserted as one transaction — this is the
// realistic keystroke path. (Never bulk-insert large text via execCommand: it
// fires grapheme-by-grapheme input events → thousands of micro-transactions and
// wedges the tab. For large content use lib/paste-profile.js, a real paste.)
//
// Cursor is placed at the doc __WHERE__ (start|end). Use 'start' so the markers
// stay in both clients' viewport — CodeMirror only renders the visible viewport,
// so a marker typed off-screen will not be observed by the receiver.
;(async () => {
  const NONCE = '__NONCE__',
    COUNT = __COUNT__,
    INTERVAL = __INTERVAL__,
    WHERE = '__WHERE__'
  const sc = document.querySelector('.cm-scroller')
  if (sc) sc.scrollTop = 0
  const c = document.querySelector('.cm-content')
  if (!c) return JSON.stringify({ err: 'no .cm-content (open a doc first)' })
  c.focus()
  const send = []
  for (let i = 0; i < COUNT; i++) {
    const sel = window.getSelection()
    sel.selectAllChildren(c)
    if (WHERE === 'end') sel.collapseToEnd()
    else sel.collapseToStart()
    const m = '[[' + NONCE + '-' + i + ']]' // run-unique → no stale-text false matches
    const t0 = Date.now()
    document.execCommand('insertText', false, m)
    send.push({ i, t0, m })
    await new Promise((r) => setTimeout(r, INTERVAL))
  }
  return JSON.stringify(send)
})()
