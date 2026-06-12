#!/usr/bin/env bash
# Perf harness for the glovebox editor + Loro sync path. See README.md.
#
# Preconditions:
#   - Worker running: `vp run dev:worker` (served at https://api.glovebox.test)
#   - Two agent-browser sessions signed in to the SAME workspace with a doc open,
#     e.g.  agent-browser --session a open https://api.glovebox.test/   (sign in)
#           agent-browser --session b open https://api.glovebox.test/   (sign in)
#   - `agent-browser` and `python3` on PATH.
#
# Commands:
#   warm                          retried curls until the worker serves 200s
#   latency  [--sender a] [--receiver b] [--count 25] [--interval 140] [--where start]
#   coldopen --session b --file notes.md --sentinel "# notes" [--timeout 20000]
#   paste    --session a [--size-kb 300] [--sentinel PASTESTART]
#
# NOTE: macOS sed (BSD) is assumed (darwin dev box). Sentinels/file names must
# not contain & / | (used as sed delimiters/metachars).
set -o pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$DIR/lib"
URL="${GLOVEBOX_URL:-https://api.glovebox.test}"
TMP="${TMPDIR:-/tmp}/glovebox-perf"
mkdir -p "$TMP"

# render <jsfile> <KEY=val>...  -> prints path to a substituted temp script
render() {
  local src="$1"; shift
  local out; out="$(mktemp "$TMP/eval.XXXXXX")"
  cp "$src" "$out"
  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    v="$(printf '%s' "$v" | sed -e 's/[&/|]/\\&/g')"
    sed -i '' "s|$k|$v|g" "$out"
  done
  printf '%s' "$out"
}

# eval_to <session> <jsfile> <outfile> : run eval, keep only the JSON result line
eval_to() { agent-browser --session "$1" eval --stdin < "$2" 2>/dev/null | tail -1 > "$3"; }
run_eval() { agent-browser --session "$1" eval --stdin < "$2" 2>/dev/null | tail -1; }

cmd="${1:-help}"; shift 2>/dev/null || true

# defaults
sender=a; receiver=b; session=b; count=25; interval=140; where=start
file=""; sentinel=""; timeout=20000; size_kb=300
while [ $# -gt 0 ]; do
  case "$1" in
    --sender)   sender="$2";   shift 2;;
    --receiver) receiver="$2"; shift 2;;
    --session)  session="$2";  shift 2;;
    --count)    count="$2";    shift 2;;
    --interval) interval="$2"; shift 2;;
    --where)    where="$2";    shift 2;;
    --file)     file="$2";     shift 2;;
    --sentinel) sentinel="$2"; shift 2;;
    --timeout)  timeout="$2";  shift 2;;
    --size-kb)  size_kb="$2";  shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

case "$cmd" in
  warm)
    for i in 1 2 3 4 5 6; do
      code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 6 "$URL/" 2>/dev/null || echo 000)"
      echo "warm $i: HTTP $code"
      [ "$code" = "200" ] && sleep 1
    done
    ;;

  latency)
    nonce="R${RANDOM}${RANDOM}"
    echo "arm receiver=$receiver"; run_eval "$receiver" "$LIB/arm-observer.js"
    echo "burst sender=$sender nonce=$nonce count=$count interval=${interval}ms where=$where"
    js="$(render "$LIB/edit-burst.js" "__NONCE__=$nonce" "__COUNT__=$count" "__INTERVAL__=$interval" "__WHERE__=$where")"
    eval_to "$sender" "$js" "$TMP/send.json"
    sleep 1.5
    eval_to "$receiver" "$LIB/read-events.js" "$TMP/recv.json"
    python3 "$DIR/join.py" "$TMP/send.json" "$TMP/recv.json"
    ;;

  coldopen)
    [ -n "$file" ]     || { echo "--file required" >&2; exit 2; }
    [ -n "$sentinel" ] || { echo "--sentinel required" >&2; exit 2; }
    js="$(render "$LIB/cold-open.js" "__FILE__=$file" "__SENTINEL__=$sentinel" "__TIMEOUT__=$timeout")"
    run_eval "$session" "$js"
    ;;

  paste)
    sentinel="${sentinel:-PASTESTART}"
    js="$(render "$LIB/paste-profile.js" "__SIZE_KB__=$size_kb" "__SENTINEL__=$sentinel")"
    run_eval "$session" "$js"
    ;;

  help|*)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
