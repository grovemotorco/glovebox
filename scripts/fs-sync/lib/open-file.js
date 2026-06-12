// Open a file from the tree by clicking its button IN PAGE (synthesized CDP
// clicks proved flaky after reloads), then wait for the editor to mount.
// Placeholder: __NAME__ (file name; matched as textContent suffix).
;(async () => {
  const NAME = '__NAME__'
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.trim().endsWith(NAME),
    )
    if (btn) {
      btn.click()
      const editorDeadline = Date.now() + 5000
      while (Date.now() < editorDeadline) {
        if (document.querySelector('.cm-content')) return JSON.stringify({ ok: true })
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    await new Promise((r) => setTimeout(r, 500)) // tree polls every 10 s
  }
  return JSON.stringify({ err: 'file never opened: ' + NAME })
})()
