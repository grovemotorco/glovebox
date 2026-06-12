# Editor / Loro sync perf harness

Reproducible measurements for the three perf targets in
[`.docs/context/ref-perf-baseline-v1.md`](../../.docs/context/ref-perf-baseline-v1.md):
multi-user **edit latency**, document **switch**, and document **init** — plus a
**large-paste** profiler. Drives two real browser clients over the live
WebSocket path via [`agent-browser`](../../.claude/skills/agent-browser).

## Requirements

- `agent-browser` and `python3` on PATH.
- Worker running: `vp run dev:worker` → `https://api.glovebox.test`.
- Override the URL with `GLOVEBOX_URL=… ./measure.sh …` if different.

## One-time setup each run

```bash
# 1. Start + warm the worker (the dev server crashes if hit cold — see baseline doc)
vp run dev:worker &
scripts/perf/measure.sh warm

# 2. Sign two clients into the SAME workspace, open the same doc.
#    (Email+password works out of the box in dev.)
agent-browser --session a open https://api.glovebox.test/   # then sign in, open the doc
agent-browser --session b open https://api.glovebox.test/   # then sign in, open the same doc
```

Connect/sign-in one session at a time, and `warm` first — a fresh page load
before workerd is ready can crash the dev server (no unhandled-rejection guard;
see the baseline doc).

## Commands

```bash
cd scripts/perf
chmod +x measure.sh            # first time

# Multi-user edit latency (A types markers, B observes); prints p50/p90/p95/max.
./measure.sh latency --sender a --receiver b --count 25 --interval 140 --where start

# Cold-open / switch time + import jank for a file in one session.
./measure.sh coldopen --session b --file notes.md   --sentinel "# notes"
./measure.sh coldopen --session b --file largedoc.md --sentinel "Section 0" --timeout 30000

# Profile a single ~300KB real clipboard paste (sync time + long tasks).
./measure.sh paste --session a --size-kb 300
```

`latency` writes `send.json` / `recv.json` to `$TMPDIR/glovebox-perf/`; rerun
`python3 join.py <send> <recv>` to recompute.

## How it works (and the gotchas baked in)

- **`lib/arm-observer.js`** — run in the RECEIVER: a `MutationObserver` on
  `.cm-content` logs `{ t: Date.now(), text }` per change into `window.__ev`.
- **`lib/edit-burst.js`** — run in the SENDER: types `COUNT` run-unique markers
  (`[[<nonce>-i]]`), one transaction each, returning the send log.
- **`lib/read-events.js`** — dumps the receiver's `window.__ev`.
- **`lib/cold-open.js`** — clicks a sidebar file, polls (rAF) until a viewport
  sentinel renders, and records `longtask` durations.
- **`lib/paste-profile.js`** — dispatches one real `paste` `ClipboardEvent` and
  records sync handler time + long tasks.
- **`join.py`** — joins by marker; latency = receiver arrival − sender send time.

Gotchas these encode (learned the hard way — see baseline doc):

1. **Use `Date.now()` across sessions**, never `performance.timeOrigin+now()`
   (per-page skew → negative latencies).
2. **Run-unique nonce markers** — reused markers match stale doc text.
3. **CodeMirror virtualizes**: `.cm-content.innerText` is only the rendered
   viewport. Keep both clients scrolled to the edited region (`--where start`,
   observer scrolls to top) or arrivals are missed.
4. **Markers are inserted via `execCommand` one tiny transaction at a time** —
   fine for keystrokes. Never bulk-insert large text that way (grapheme-by-
   grapheme input events wedge the tab); use the `paste` command for big content.
