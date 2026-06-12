#!/usr/bin/env python3
"""Join the sender send-log and receiver event-log into latency percentiles.

Usage: join.py [send.json] [recv.json]
  send.json  output of lib/edit-burst.js  (array of {i, t0, m})
  recv.json  output of lib/read-events.js (array of {t, text})

Both files contain a single JSON *string* (the eval return value), so we
json.loads twice. Latency = receiver's first-observed arrival of marker m,
minus the sender's send time t0. Both timestamps are Date.now() (shared clock).
"""
import json
import sys


def load(path):
    v = json.loads(open(path).read().strip())
    return json.loads(v) if isinstance(v, str) else v


def main():
    send = load(sys.argv[1] if len(sys.argv) > 1 else "send.json")
    recv = load(sys.argv[2] if len(sys.argv) > 2 else "recv.json")
    lat = []
    for s in send:
        arr = next((e["t"] for e in recv if s["m"] in e["text"]), None)
        if arr is not None:
            lat.append(arr - s["t0"])
    if not lat:
        print(
            f"no markers matched (sent {len(send)}, recv events {len(recv)}) — "
            "check both clients are scrolled to the edited region (viewport-only)"
        )
        sys.exit(1)
    ls = sorted(lat)
    pct = lambda p: ls[int(round((p / 100) * (len(ls) - 1)))]
    print(f"matched {len(lat)}/{len(send)} edits")
    print(
        f"  min {min(lat):.0f} | p50 {pct(50):.0f} | p90 {pct(90):.0f} | "
        f"p95 {pct(95):.0f} | max {max(lat):.0f} | mean {sum(lat)/len(lat):.1f}  (ms)"
    )


if __name__ == "__main__":
    main()
