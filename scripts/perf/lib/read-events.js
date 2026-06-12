// Dump the receiver's observed text-change events (armed by arm-observer.js).
// Run in the RECEIVER session:
//   agent-browser --session <recv> eval --stdin < lib/read-events.js
;(() => JSON.stringify((window.__ev || []).map((e) => ({ t: e.t, text: e.text }))))()
