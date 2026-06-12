// Arm a MutationObserver on the editor to timestamp incoming text changes.
// Run in the RECEIVER session:
//   agent-browser --session <recv> eval --stdin < lib/arm-observer.js
// Stores events in window.__ev as { t: Date.now(), text }. Re-run to reset.
//
// Why Date.now(): it is the shared system wall clock across both browser
// contexts. performance.timeOrigin+performance.now() is skewed per page
// (~15ms here) and yields negative cross-session latencies.
;(() => {
  const sc = document.querySelector('.cm-scroller')
  if (sc) sc.scrollTop = 0 // keep receiver at top so top-edits land in viewport
  const c = document.querySelector('.cm-content')
  if (!c) return JSON.stringify({ err: 'no .cm-content (open a doc first)' })
  if (window.__obs) window.__obs.disconnect()
  window.__ev = []
  window.__obs = new MutationObserver(() => {
    window.__ev.push({ t: Date.now(), text: c.innerText })
  })
  window.__obs.observe(c, { subtree: true, childList: true, characterData: true })
  return JSON.stringify({
    armed: true,
    renderedLines: document.querySelectorAll('.cm-line').length,
  })
})()
