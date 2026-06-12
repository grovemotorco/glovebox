// Insert a small text at the start/end of the open editor doc, as one
// insertText transaction (the realistic keystroke path — see scripts/perf
// edit-burst.js for why large bulk inserts must NOT go through execCommand).
// Placeholders: __TEXT__, __WHERE__ (start|end).
;(() => {
  const sc = document.querySelector('.cm-scroller')
  if (sc) sc.scrollTop = 0
  const c = document.querySelector('.cm-content')
  if (!c) return JSON.stringify({ err: 'no .cm-content (open a doc first)' })
  c.focus()
  const sel = window.getSelection()
  sel.selectAllChildren(c)
  if ('__WHERE__' === 'end') sel.collapseToEnd()
  else sel.collapseToStart()
  document.execCommand('insertText', false, '__TEXT__')
  return JSON.stringify({ ok: true })
})()
