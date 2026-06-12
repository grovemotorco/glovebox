// Read the FULL doc text of the open editor. Prefers the CodeMirror state doc
// (innerText is viewport-only — CM virtualizes); falls back to innerText for
// small docs that fit the viewport.
;(() => {
  const c = document.querySelector('.cm-content')
  if (!c) return JSON.stringify({ err: 'no .cm-content (open a doc first)' })
  let text = null
  let source = 'cmView'
  try {
    text = c.cmView.view.state.doc.toString()
  } catch {
    text = null
  }
  if (text === null) {
    text = c.innerText
    source = 'innerText'
  }
  return JSON.stringify({ text, source })
})()
