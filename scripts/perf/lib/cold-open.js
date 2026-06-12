// Measure cold-open / switch time + import jank for a file, within one session.
// Placeholders substituted by measure.sh: __FILE__ __SENTINEL__ __TIMEOUT__
//
//   __FILE__     sidebar button text to click (e.g. "notes.md")
//   __SENTINEL__ text guaranteed to render in the INITIAL viewport once loaded
//                (e.g. the doc's first line, or "Section 0" for the seeded doc).
//                CodeMirror virtualizes, so pick something near the top.
//   __TIMEOUT__  ms to wait for the sentinel before giving up.
//
// Reports time-to-content and main-thread long tasks (the visible freeze).
;(async () => {
  const FILE = '__FILE__',
    SENTINEL = '__SENTINEL__',
    TIMEOUT = __TIMEOUT__
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes(FILE))
  if (!btn) return JSON.stringify({ err: 'no sidebar button matching ' + FILE })
  const lt = []
  const po = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) lt.push(Math.round(e.duration))
  })
  po.observe({ entryTypes: ['longtask'] })
  const t0 = performance.now()
  btn.click()
  let contentMs = null
  const dl = t0 + TIMEOUT
  while (performance.now() < dl) {
    const c = document.querySelector('.cm-content')
    if (c && c.innerText.includes(SENTINEL)) {
      contentMs = Math.round(performance.now() - t0)
      break
    }
    await new Promise((r) => requestAnimationFrame(r))
  }
  await new Promise((r) => setTimeout(r, 800)) // catch trailing long tasks
  po.disconnect()
  return JSON.stringify({
    file: FILE,
    contentRenderedMs: contentMs,
    timedOut: contentMs === null,
    longtasksMs: lt,
    totalBlockedMs: lt.reduce((a, b) => a + b, 0),
    maxBlockMs: lt.length ? Math.max(...lt) : 0,
    renderedLines: document.querySelectorAll('.cm-line').length,
  })
})()
