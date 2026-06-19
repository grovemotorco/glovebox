#!/usr/bin/env bash
# FS-sync convergence harness: real worker + 2 real browser sessions + two real
# `glovebox run` daemons against one workspace. Drives every cell of the
# convergence matrix from both sides and asserts convergence. See README.md.
#
# Preconditions:
#   - Worker running: `vp run dev:worker` (https://api.glovebox.test), WARMED
#     (`./validate.sh warm`) — the dev server can crash on a cold SSR fetch.
#   - `agent-browser`, `node`, `python3`, `shasum` on PATH.
#   - CLI built: apps/cli/dist/glovebox.mjs (vp run build).
#
# Commands:
#   warm                 retried curls until the worker serves 200s
#   setup                sign in sessions a+b (sign-up if needed), mount, start daemons
#   run <scenario>|all   drive scenarios (see SCENARIO_ORDER below)
#   list                 list scenario names
#   status               daemon + tree snapshot
#   teardown             stop daemon, unmount, keep user dirs
#
# State (all disposable): $FS_SYNC_BASE (default /tmp/glovebox-fs-sync)
#   home/           GLOVEBOX_HOME (registry, state, locks, auth)
#   mount-a|mount-b two synced directories bound to the same workspace
#   daemon-a.log daemon-b.log daemon-a.pid daemon-b.pid wsid
set -o pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
LIB="$DIR/lib"

URL="${GLOVEBOX_URL:-https://api.glovebox.test}"
SA="${FS_SYNC_SESSION_A:-a}"
SB="${FS_SYNC_SESSION_B:-b}"
BASE="${FS_SYNC_BASE:-/tmp/glovebox-fs-sync}"
MOUNT_A="${FS_SYNC_MOUNT_A:-$BASE/mount-a}"
MOUNT_B="${FS_SYNC_MOUNT_B:-$BASE/mount-b}"
# Most scenarios write through the primary mount; the secondary mount is kept
# live for replica convergence checks and for cross-mount final sweeps.
MOUNT="$MOUNT_A"
EMAIL="${FS_SYNC_EMAIL:-fs-sync-$(date +%s)@glovebox.test}"
PASS_WORD="${FS_SYNC_PASS:-fs-sync-pass-123}"
CLI="$ROOT/apps/cli/dist/glovebox.mjs"

# The opaque-submit helper (lib/opaque-submit-node.mjs) runs in Node — not the
# browser — and opens a raw wss:// socket to the portless-served dev worker,
# whose TLS cert is signed by the local portless CA. Node only trusts that CA
# via NODE_EXTRA_CA_CERTS; without it every opaque.submit fails the TLS
# handshake ("ws error", no opaque.ack) and all opaque scenarios time out. The
# browser eval helpers are unaffected — the browser already trusts the cert.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ "${URL#https:}" != "$URL" ]; then
  for _ca in "$HOME/.portless/ca.pem" "$HOME/.portless/ca.crt"; do
    if [ -f "$_ca" ]; then export NODE_EXTRA_CA_CERTS="$_ca"; break; fi
  done
fi

# Shrunk timers: defaults (30 s tombstone, 30 min jittered rescan) are
# untestable by hand. Constraint: tombstoneDelayMs >= renameCorrectionWindowMs.
# bulkMinCount lowered so the runtime bulk guard trips on a 6-file rm.
export GLOVEBOX_HOME="$BASE/home"
export GLOVEBOX_SYNC_OVERRIDES='{"rescanIntervalMs":1000,"watchDebounceMs":100,"deletePolicy":{"tombstoneDelayMs":2000,"renameCorrectionWindowMs":1000,"bulkWindowMs":2000,"bulkMinCount":5}}'

TOMBSTONE_S=2     # keep in sync with overrides above
CONVERGE_S=12     # poll budget for one-rescan-cycle convergence
TMP="${TMPDIR:-/tmp}/glovebox-fs-sync-evals"
mkdir -p "$TMP" "$BASE"

# ---------------------------------------------------------------- plumbing --

# render <jsfile> <KEY=val>... -> path to substituted temp script (BSD sed).
# Values must not contain newlines; & / | are escaped.
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

run_eval() { agent-browser --session "$1" eval --stdin < "$2" 2>/dev/null | tail -1; }

page() { # page <session> <libfile> [KEY=val...]
  local s="$1" f="$2"; shift 2
  run_eval "$s" "$(render "$LIB/$f" "$@")"
}

# pyj <expr>: parse (possibly double-encoded) JSON from stdin, eval expr with
# the value bound to d, print result. agent-browser eval prints a JSON string
# literal; the CLI prints plain JSON — both land here.
pyj() {
  python3 -c '
import json, sys
raw = sys.stdin.read().strip()
v = json.loads(raw)
if isinstance(v, str):
    v = json.loads(v)
d = v
print(eval(sys.argv[1]))
' "$1" 2>/dev/null
}

wsid() { cat "$BASE/wsid" 2>/dev/null; }

api() { # api <session> <procedure-path> <one-line-json-input>
  page "$1" api.js "__PATH__=$2" "__INPUT__=$3"
}

tree_json() { api "$SA" workspaces/tree "{\"workspaceId\":\"$(wsid)\"}"; }
server_seq() { tree_json | pyj "d['body']['json']['seq']"; }
file_id() { tree_json | pyj "[e['fileId'] for e in d['body']['json']['entries'] if e['path']=='$1' and not e['tombstone']][0]"; }
live_paths() { tree_json | pyj "' '.join(sorted(e['path'] for e in d['body']['json']['entries'] if not e['tombstone']))"; }
entry_field() { tree_json | pyj "[e['$2'] for e in d['body']['json']['entries'] if e['path']=='$1' and not e['tombstone']][0]"; }
# NOTE: workspaces.tree EXCLUDES tombstoned entries — "deleted" is asserted
# as absence from the live tree, never via a tombstone flag.
server_text() { # by path
  api "$SA" workspaces/readText "{\"workspaceId\":\"$(wsid)\",\"path\":\"$1\"}" | pyj "d['body']['json']['text']"
}
recovery_list() { api "$SA" documents/recoveryList "{\"workspaceId\":\"$(wsid)\",\"pendingOnly\":true}"; }

ws_batch() { page "$1" ws-batch.js "__WSID__=$(wsid)" "__OPS__=$2"; }
ws_raw() { page "$1" ws-raw.js "__WSID__=$(wsid)" "__MSG__=$2"; }
socket_token() {
  api "$1" auth/mintWorkspaceSocketToken "{\"workspaceId\":\"$(wsid)\"}" |
    pyj "d['body']['json'].get('token') or ''"
}
opaque_submit_b64() {
  local token; token="$(socket_token "$1")"
  node "$LIB/opaque-submit-node.mjs" "$URL" "$(wsid)" "$2" "$3" "$4" "$5" "$6" "$token"
}
opaque_submit_text() {
  local b64; b64="$(printf '%s' "$6" | base64 | tr -d '\n')"
  opaque_submit_b64 "$1" "$2" "$3" "$4" "$5" "$b64"
}
opaque_oversize() {
  local token; token="$(socket_token "$1")"
  node "$LIB/opaque-submit-node.mjs" "$URL" "$(wsid)" "$2" "$3" "$4" "" --oversize "$token"
}

type_text() { page "$1" type-text.js "__TEXT__=$2" "__WHERE__=${3:-start}"; }
editor_text() { page "$1" editor-text.js | pyj "d['text']"; }

open_file() { # open_file <session> <filename> — in-page click + wait for editor
  local out attempt
  for attempt in 1 2 3; do   # the eval itself can transiently fail (daemon busy)
    out="$(page "$1" open-file.js "__NAME__=$2")"
    contains "$out" 'ok' && return 0
    sleep 2
  done
  echo "    (open_file $1 $2: $out)" >&2
  return 1
}

create_file_ui() { # create_file_ui <session> <path> — the only file op the UI has
  local s="$1" p="$2"
  agent-browser --session "$s" find role button click --name "New markdown file" >/dev/null 2>&1 || return 1
  agent-browser --session "$s" fill "input[aria-label='New file path']" "$p" >/dev/null 2>&1 || return 1
  agent-browser --session "$s" press Enter >/dev/null 2>&1
}

click_button_text() {
  local s="$1" label="$2"
  agent-browser --session "$s" eval "Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === '$label')?.click(); true" >/dev/null 2>&1
}

gstatus() { node "$CLI" --json status "$MOUNT" 2>/dev/null; }
daemon_pid_for() {
  node "$CLI" --json status "$1" 2>/dev/null | pyj "d['daemon']['pid'] if d['daemon']['running'] else ''"
}
daemon_pid() { daemon_pid_for "$MOUNT"; }

daemon_start_for() {
  local dir="$1" name="$2" log="$3" pidfile="$4"
  [ -n "$(daemon_pid_for "$dir")" ] && return 0
  nohup node "$CLI" run "$dir" >> "$log" 2>&1 &
  echo $! > "$pidfile"
  poll 15 "daemon $name running" sh -c "node '$CLI' --json status '$dir' 2>/dev/null | grep -q '\"running\": true'"
}

daemon_start() {
  daemon_start_for "$MOUNT_A" "A" "$BASE/daemon-a.log" "$BASE/daemon-a.pid"
}

daemon_start_secondary() {
  daemon_start_for "$MOUNT_B" "B" "$BASE/daemon-b.log" "$BASE/daemon-b.pid"
}

daemon_start_all() {
  daemon_start
  daemon_start_secondary
}

daemon_stop_for() { # graceful SIGINT
  local dir="$1" pid; pid="$(daemon_pid_for "$dir")"
  [ -n "$pid" ] || return 0
  kill -INT "$pid" 2>/dev/null
  poll 15 "daemon stopped" sh -c "! kill -0 $pid 2>/dev/null"
}

daemon_stop() { daemon_stop_for "$MOUNT_A"; }

daemon_stop_all() {
  daemon_stop_for "$MOUNT_A"
  daemon_stop_for "$MOUNT_B"
}

daemon_kill9() {
  local pid; pid="$(daemon_pid)"
  [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
}

poll() { # poll <seconds> <description> <cmd...>
  local t="$1" desc="$2"; shift 2
  local end=$(( $(date +%s) + t ))
  while [ "$(date +%s)" -le "$end" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "    (timeout ${t}s: $desc)" >&2
  return 1
}

# ------------------------------------------------------------- accounting --

PASS=0; FAIL=0; CURRENT=""
FAILLOG="$BASE/failures.log"

ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); echo "$CURRENT: $1" >> "$FAILLOG"; }

check() { # check <desc> <cmd...> — cmd exit 0 => PASS
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}

check_poll() { # check_poll <seconds> <desc> <cmd...>
  local t="$1" desc="$2"; shift 2
  if poll "$t" "$desc" "$@"; then ok "$desc"; else bad "$desc"; fi
}

contains() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }

nonce() { echo "$(date +%s)$RANDOM"; }

json_string() {
  python3 -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"
}

server_text_raw() { # exact bytes for markdown text, no print-added newline
  local path_json
  path_json="$(json_string "$1")"
  api "$SA" workspaces/readText "{\"workspaceId\":\"$(wsid)\",\"path\":$path_json}" |
    python3 -c '
import json, sys
raw = sys.stdin.read().strip()
v = json.loads(raw)
if isinstance(v, str):
    v = json.loads(v)
sys.stdout.write(v["body"]["json"]["text"])
'
}

server_manifest() {
  tree_json | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
v = json.loads(raw)
if isinstance(v, str):
    v = json.loads(v)
entries = v["body"]["json"]["entries"]
for e in sorted((e for e in entries if not e.get("tombstone")), key=lambda e: e["path"]):
    print("{}\t{}\t{}".format(e["path"], e.get("contentKind", ""), e.get("contentHash", "")))
'
}

server_has_exact() {
  tree_json | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
path = sys.argv[1]
v = json.loads(raw)
if isinstance(v, str):
    v = json.loads(v)
paths = {e["path"] for e in v["body"]["json"]["entries"] if not e.get("tombstone")}
sys.exit(0 if path in paths else 1)
' "$1"
}

mount_manifest() {
  local dir="$1"
  (cd "$dir" && find . -type f ! -name '.glovebox.json' -print | sed 's#^\./##' | LC_ALL=C sort)
}

convergence_once() {
  local manifest server_paths a_paths b_paths expected id
  id="$$-$RANDOM"
  manifest="$TMP/manifest-$id.tsv"
  server_paths="$TMP/server-paths-$id.txt"
  a_paths="$TMP/mount-a-paths-$id.txt"
  b_paths="$TMP/mount-b-paths-$id.txt"
  expected="$TMP/server-text-$id.txt"
  : > "$BASE/convergence-last.err"

  server_manifest > "$manifest" || { echo "server manifest failed" > "$BASE/convergence-last.err"; return 1; }
  cut -f1 "$manifest" | LC_ALL=C sort > "$server_paths"
  mount_manifest "$MOUNT_A" > "$a_paths" || { echo "mount A manifest failed" > "$BASE/convergence-last.err"; return 1; }
  mount_manifest "$MOUNT_B" > "$b_paths" || { echo "mount B manifest failed" > "$BASE/convergence-last.err"; return 1; }

  if ! diff -u "$server_paths" "$a_paths" > "$BASE/convergence-last.diff"; then
    echo "server path set differs from mount A" > "$BASE/convergence-last.err"
    return 1
  fi
  if ! diff -u "$server_paths" "$b_paths" > "$BASE/convergence-last.diff"; then
    echo "server path set differs from mount B" > "$BASE/convergence-last.err"
    return 1
  fi

  local path kind hash ah bh
  while IFS="$(printf '\t')" read -r path kind hash; do
    [ -n "$path" ] || continue
    [ -f "$MOUNT_A/$path" ] || { echo "mount A missing $path" > "$BASE/convergence-last.err"; return 1; }
    [ -f "$MOUNT_B/$path" ] || { echo "mount B missing $path" > "$BASE/convergence-last.err"; return 1; }
    if ! cmp -s "$MOUNT_A/$path" "$MOUNT_B/$path"; then
      echo "mount A and B byte mismatch for $path" > "$BASE/convergence-last.err"
      return 1
    fi
    if [ "$kind" = "markdown" ]; then
      server_text_raw "$path" > "$expected" || { echo "server text read failed for $path" > "$BASE/convergence-last.err"; return 1; }
      if ! cmp -s "$expected" "$MOUNT_A/$path"; then
        echo "server markdown text differs from mounts for $path" > "$BASE/convergence-last.err"
        return 1
      fi
    elif [ -n "$hash" ]; then
      ah="$(shasum -a 256 "$MOUNT_A/$path" | cut -d' ' -f1)"
      bh="$(shasum -a 256 "$MOUNT_B/$path" | cut -d' ' -f1)"
      if [ "$ah" != "$hash" ] || [ "$bh" != "$hash" ]; then
        echo "opaque hash mismatch for $path (server $hash, A $ah, B $bh)" > "$BASE/convergence-last.err"
        return 1
      fi
    fi
  done < "$manifest"
}

assert_convergence() {
  local label="$1"
  check_poll 25 "replicas converge after $label (server, browser API, mount A, mount B)" convergence_once
}

# -------------------------------------------------------------- lifecycle --

cmd_warm() {
  local i code
  for i in 1 2 3 4 5 6; do
    code="$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 6 "$URL/" 2>/dev/null || echo 000)"
    echo "warm $i: HTTP $code"
    [ "$code" = "200" ] && sleep 1 || sleep 2
  done
}

ensure_signed_in() { # ensure_signed_in <session>
  local s="$1"
  agent-browser --session "$s" open "$URL/" >/dev/null 2>&1
  agent-browser --session "$s" wait --load networkidle >/dev/null 2>&1
  if agent-browser --session "$s" snapshot -i 2>/dev/null | grep -q 'Switch workspace'; then
    echo "session $s: already signed in"
    return 0
  fi
  echo "session $s: signing in as $EMAIL"
  agent-browser --session "$s" find role button click --name "Sign in" >/dev/null 2>&1 || true
  agent-browser --session "$s" fill "input[aria-label='Email']" "$EMAIL" >/dev/null 2>&1
  agent-browser --session "$s" fill "input[aria-label='Password']" "$PASS_WORD" >/dev/null 2>&1
  agent-browser --session "$s" press Enter >/dev/null 2>&1
  if ! poll 15 "signed in" sh -c "agent-browser --session '$s' snapshot -i 2>/dev/null | grep -q 'Switch workspace'"; then
    echo "session $s: sign-in failed — creating account"
    click_button_text "$s" "Create account"
    agent-browser --session "$s" fill "input[aria-label='Name']" "fs-sync validator" >/dev/null 2>&1
    agent-browser --session "$s" fill "input[aria-label='Email']" "$EMAIL" >/dev/null 2>&1
    agent-browser --session "$s" fill "input[aria-label='Password']" "$PASS_WORD" >/dev/null 2>&1
    agent-browser --session "$s" press Enter >/dev/null 2>&1
    if ! poll 15 "account created" sh -c "agent-browser --session '$s' snapshot -i 2>/dev/null | grep -q 'Switch workspace'"; then
      click_button_text "$s" "Sign in"
      agent-browser --session "$s" fill "input[aria-label='Email']" "$EMAIL" >/dev/null 2>&1
      agent-browser --session "$s" fill "input[aria-label='Password']" "$PASS_WORD" >/dev/null 2>&1
      agent-browser --session "$s" press Enter >/dev/null 2>&1
      poll 15 "signed in after account creation" sh -c "agent-browser --session '$s' snapshot -i 2>/dev/null | grep -q 'Switch workspace'" || return 1
    fi
  fi
}

cmd_setup() { # setup [fresh] — fresh creates a NEW workspace + empty mount,
              # making a full `run all` hermetic (run-unique nonces keep
              # scenarios independent either way; fresh also repoints both
              # browser sessions at the new workspace).
  mkdir -p "$MOUNT_A" "$MOUNT_B"
  if [ "${1:-}" = "fresh" ]; then
    local s
    for s in "$SA" "$SB"; do
      # Fresh means hermetic: do not accept whatever account a reused
      # agent-browser session happened to have from a previous run.
      agent-browser --session "$s" open "$URL/" >/dev/null 2>&1 || true
      agent-browser --session "$s" cookies clear >/dev/null 2>&1 || true
      agent-browser --session "$s" storage local clear >/dev/null 2>&1 || true
      agent-browser --session "$s" storage session clear >/dev/null 2>&1 || true
      agent-browser --session "$s" open "$URL/" >/dev/null 2>&1 || true
      agent-browser --session "$s" wait --load networkidle >/dev/null 2>&1 || true
    done
  fi
  ensure_signed_in "$SA" || { echo "setup: session $SA sign-in failed" >&2; exit 1; }
  ensure_signed_in "$SB" || { echo "setup: session $SB sign-in failed" >&2; exit 1; }

  if [ "${1:-}" = "fresh" ]; then
    local name id
    name="fs-sync-$(nonce)"
    id="$(api "$SA" workspaces/create "{\"name\":\"$name\"}" | pyj "d['body']['json']['id']")"
    [ -n "$id" ] || { echo "setup: workspace create failed" >&2; exit 1; }
    echo "$id" > "$BASE/wsid"
    local s
    for s in "$SA" "$SB"; do
      run_eval "$s" <(printf "localStorage.setItem('glovebox.activeWorkspace', '%s')" "$id") >/dev/null
      agent-browser --session "$s" open "$URL/" >/dev/null 2>&1
      agent-browser --session "$s" wait --load networkidle >/dev/null 2>&1
    done
    daemon_stop_all
    node "$CLI" unmount "$MOUNT_A" >/dev/null 2>&1
    node "$CLI" unmount "$MOUNT_B" >/dev/null 2>&1
    rm -rf "$MOUNT_A" "$MOUNT_B"
    mkdir -p "$MOUNT_A" "$MOUNT_B"
  else
    # Reuse: first workspace of the account (both sessions share it).
    api "$SA" workspaces/list '{}' | pyj "d['body']['json']['workspaces'][0]['id']" > "$BASE/wsid"
  fi
  [ -s "$BASE/wsid" ] || { echo "setup: could not discover workspace id" >&2; exit 1; }
  echo "workspace: $(wsid)"

  if ! node "$CLI" --json list 2>/dev/null | grep -q "$MOUNT_A"; then
    node "$CLI" mount "$MOUNT_A" --workspace "$(wsid)" --server "$URL" || exit 1
  fi
  if ! node "$CLI" --json list 2>/dev/null | grep -q "$MOUNT_B"; then
    node "$CLI" mount "$MOUNT_B" --workspace "$(wsid)" --server "$URL" || exit 1
  fi
  if [ -z "$(daemon_pid_for "$MOUNT_A")" ] || [ -z "$(daemon_pid_for "$MOUNT_B")" ]; then
    daemon_start_all || { echo "setup: daemon failed to start (see $BASE/daemon-a.log / daemon-b.log)" >&2; exit 1; }
  fi
  echo "mount A: $MOUNT_A"
  echo "mount B: $MOUNT_B"
  echo "daemon A: pid $(daemon_pid_for "$MOUNT_A"), log $BASE/daemon-a.log"
  echo "daemon B: pid $(daemon_pid_for "$MOUNT_B"), log $BASE/daemon-b.log"
}

cmd_teardown() {
  daemon_stop_all
  node "$CLI" unmount "$MOUNT_A" 2>/dev/null
  node "$CLI" unmount "$MOUNT_B" 2>/dev/null
  echo "stopped daemons + unmounted ($BASE left in place)"
}

cmd_status() {
  echo "--- mount A ---"
  node "$CLI" status "$MOUNT_A"
  echo "--- mount B ---"
  node "$CLI" status "$MOUNT_B"
  echo "--- CLI list ---"
  node "$CLI" --json list
  echo "--- server tree ---"
  live_paths
}

# -------------------------------------------------------------- scenarios --
# Every scenario uses run-unique names; convergence asserts poll within
# CONVERGE_S (~one 1 s rescan cycle + push + checkout + margin).

s_text_browser_to_disk() {
  local n; n="$(nonce)"
  create_file_ui "$SB" "tbd-$n.md" || { bad "create tbd-$n.md via UI"; return; }
  check_poll "$CONVERGE_S" "browser-created file lands on disk" test -f "$MOUNT/tbd-$n.md"
  open_file "$SB" "tbd-$n.md" || { bad "open tbd-$n.md in $SB"; return; }
  type_text "$SB" "[[B2D-$n]]" start >/dev/null
  check_poll "$CONVERGE_S" "browser edit reaches disk" grep -q "B2D-$n" "$MOUNT/tbd-$n.md"
}

s_text_disk_to_browser() {
  local n; n="$(nonce)"
  printf '# disk file\n\nseed\n' > "$MOUNT/dtb-$n.md"
  check_poll "$CONVERGE_S" "disk file reaches server" sh -c "$0 __server_has dtb-$n.md"
  open_file "$SA" "dtb-$n.md" || { bad "open dtb-$n.md in $SA"; return; }
  open_file "$SB" "dtb-$n.md" || { bad "open dtb-$n.md in $SB"; return; }
  printf '[[D2B-%s]]\n' "$n" >> "$MOUNT/dtb-$n.md"
  check_poll "$CONVERGE_S" "disk edit visible in editor $SA" sh -c "$0 __editor_has $SA D2B-$n"
  check_poll "$CONVERGE_S" "disk edit visible in editor $SB" sh -c "$0 __editor_has $SB D2B-$n"
}

s_text_concurrent_merge() {
  local n; n="$(nonce)"
  printf '# merge\n\nmiddle\n' > "$MOUNT/merge-$n.md"
  poll "$CONVERGE_S" "file on server" sh -c "$0 __server_has merge-$n.md" || { bad "seed file never synced"; return; }
  open_file "$SA" "merge-$n.md" || { bad "open in $SA"; return; }
  # Concurrent: browser types at start while disk appends at end.
  type_text "$SA" "[[CM-A-$n]]" start >/dev/null &
  local typer=$!
  printf '[[CM-D-%s]]\n' "$n" >> "$MOUNT/merge-$n.md"
  wait "$typer"
  check_poll "$CONVERGE_S" "disk has BOTH markers (no lost chars)" \
    sh -c "grep -q 'CM-A-$n' '$MOUNT/merge-$n.md' && grep -q 'CM-D-$n' '$MOUNT/merge-$n.md'"
  check_poll "$CONVERGE_S" "editor $SA has BOTH markers" \
    sh -c "$0 __editor_has $SA CM-A-$n && $0 __editor_has $SA CM-D-$n"
  check_poll "$CONVERGE_S" "server text has BOTH markers" \
    sh -c "$0 __server_text merge-$n.md | grep -q 'CM-A-$n' && $0 __server_text merge-$n.md | grep -q 'CM-D-$n'"
}

s_create_disk_to_browser() {
  local n; n="$(nonce)"
  mkdir -p "$MOUNT/nested-$n/sub"
  printf '# nested\n' > "$MOUNT/nested-$n/sub/deep.md"
  check_poll "$CONVERGE_S" "nested disk file reaches server tree" sh -c "$0 __server_has nested-$n/sub/deep.md"
  # Folders render collapsed — expand the new folder before looking for the leaf.
  check_poll 20 "nested folder appears in browser tree" \
    sh -c "agent-browser --session '$SB' snapshot -i 2>/dev/null | grep -q 'nested-$n'"
  agent-browser --session "$SB" find text "nested-$n" click >/dev/null 2>&1
  agent-browser --session "$SB" find text "sub" click >/dev/null 2>&1
  check_poll 10 "nested disk file appears in browser tree" \
    sh -c "agent-browser --session '$SB' snapshot -i 2>/dev/null | grep -q 'deep.md'"
}

s_create_browser_to_disk() {
  local n; n="$(nonce)"
  create_file_ui "$SB" "bdir-$n/note.md" || { bad "create via UI"; return; }
  check_poll "$CONVERGE_S" "browser-created nested file lands on disk" test -f "$MOUNT/bdir-$n/note.md"
}

s_create_collision() {
  local n; n="$(nonce)"
  # Same path created from disk and browser in the same instant: server
  # suffix-collision policy (file.md -> file-2.md) must keep BOTH.
  printf 'from disk %s\n' "$n" > "$MOUNT/col-$n.md" &
  local writer=$!
  create_file_ui "$SB" "col-$n.md"
  wait "$writer"
  check_poll "$CONVERGE_S" "both collision survivors live on server" \
    sh -c "[ \$($0 __count_prefix col-$n) -eq 2 ]"
  check_poll "$CONVERGE_S" "both collision survivors on disk" \
    sh -c "[ \$(ls '$MOUNT' | grep -c '^col-$n') -eq 2 ]"
  check_poll "$CONVERGE_S" "disk content survived the collision" \
    sh -c "cat '$MOUNT'/col-$n*.md | grep -q 'from disk $n'"
}

s_overwrite_truncate() {
  local n; n="$(nonce)"
  printf 'first line %s\nsecond line\nthird line\n' "$n" > "$MOUNT/ow-$n.md"
  poll "$CONVERGE_S" "overwrite fixture synced" sh -c "$0 __server_has ow-$n.md" || { bad "overwrite fixture never synced"; return; }
  printf 'short-%s' "$n" > "$MOUNT/ow-$n.md"
  check_poll "$CONVERGE_S" "overwrite+truncate reaches server exactly" \
    sh -c "[ \"\$($0 __server_text ow-$n.md)\" = 'short-$n' ]"
  check_poll "$CONVERGE_S" "overwrite+truncate reaches secondary mount exactly" \
    sh -c "[ \"\$(cat '$MOUNT_B/ow-$n.md')\" = 'short-$n' ]"
}

s_special_paths() {
  local n long p
  n="$(nonce)"
  long="$(printf 'long-%080d' "$n")"
  mkdir -p "$MOUNT/special-$n"
  local paths=(
    "special-$n/space name.multi.part.md"
    "special-$n/.leading-dot.md"
    "special-$n/shell chars [x] (y) & dollar$.md"
    "special-$n/$long.markdown"
  )
  for p in "${paths[@]}"; do
    printf 'path payload %s\n' "$p" > "$MOUNT/$p"
  done
  for p in "${paths[@]}"; do
    check_poll "$CONVERGE_S" "special path reaches server: $p" server_has_exact "$p"
    check_poll "$CONVERGE_S" "special path reaches mount B: $p" test -f "$MOUNT_B/$p"
  done
}

s_directory_move_delete() {
  local n; n="$(nonce)"
  mkdir -p "$MOUNT/dir-$n/a" "$MOUNT/keep-$n"
  printf 'move one %s\n' "$n" > "$MOUNT/dir-$n/a/one.md"
  printf 'move two %s\n' "$n" > "$MOUNT/dir-$n/a/two.md"
  printf 'sibling survives %s\n' "$n" > "$MOUNT/keep-$n/sibling.md"
  poll "$CONVERGE_S" "directory fixtures synced" \
    sh -c "$0 __server_has dir-$n/a/one.md && $0 __server_has dir-$n/a/two.md && $0 __server_has keep-$n/sibling.md" || { bad "directory fixtures never synced"; return; }

  mkdir -p "$MOUNT/moved-$n"
  mv "$MOUNT/dir-$n/a" "$MOUNT/moved-$n/a"
  check_poll "$CONVERGE_S" "directory rename/move propagates: one" sh -c "$0 __server_has moved-$n/a/one.md"
  check_poll "$CONVERGE_S" "directory rename/move propagates: two" sh -c "$0 __server_has moved-$n/a/two.md"
  check "old moved directory paths gone" \
    sh -c "! $0 __server_has dir-$n/a/one.md && ! $0 __server_has dir-$n/a/two.md"

  rm -rf "$MOUNT/moved-$n"
  check_poll 15 "recursive directory delete propagates after tombstone" \
    sh -c "! $0 __server_has moved-$n/a/one.md && ! $0 __server_has moved-$n/a/two.md"
  check "directory delete did not delete unrelated sibling" sh -c "$0 __server_has keep-$n/sibling.md"
}

s_rename_create_collision() {
  local n fid seq ack
  n="$(nonce)"
  printf 'source %s\n' "$n" > "$MOUNT/rc-source-$n.md"
  printf 'target %s\n' "$n" > "$MOUNT/rc-target-$n.md"
  poll "$CONVERGE_S" "rename collision fixtures synced" \
    sh -c "$0 __server_has rc-source-$n.md && $0 __server_has rc-target-$n.md" || { bad "rename collision fixtures never synced"; return; }
  fid="$(file_id "rc-source-$n.md")"
  seq="$(server_seq)"
  ack="$(ws_batch "$SB" "[{\"type\":\"file.rename\",\"opId\":\"rc-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"fromPath\":\"rc-source-$n.md\",\"toPath\":\"rc-target-$n.md\"}]")"
  check "rename/create collision is deferred, not destructive" \
    sh -c "echo '$ack' | grep -q 'deferredOps' && echo '$ack' | grep -q 'target-occupied'"
  check "source path survives collision" sh -c "$0 __server_has rc-source-$n.md"
  check "target path survives collision" sh -c "$0 __server_has rc-target-$n.md"
}

s_editor_temp_litter_ignored() {
  local n; n="$(nonce)"
  printf 'original editor body %s\n' "$n" > "$MOUNT/edit-save-$n.md"
  poll "$CONVERGE_S" "editor-save fixture synced" sh -c "$0 __server_has edit-save-$n.md" || { bad "editor-save fixture never synced"; return; }

  printf 'partial temp should not sync %s\n' "$n" > "$MOUNT/edit-save-$n.md.tmp.1234"
  printf 'backup should not sync %s\n' "$n" > "$MOUNT/edit-save-$n.md~"
  sleep 2
  check "tmp save artifact did not become canonical on server" \
    sh -c "! $0 __server_has edit-save-$n.md.tmp.1234"
  check "backup save artifact did not become canonical on server" \
    sh -c "! $0 __server_has edit-save-$n.md~"
  check "tmp save artifact did not reach mount B" sh -c "test ! -f '$MOUNT_B/edit-save-$n.md.tmp.1234'"
  check "backup save artifact did not reach mount B" sh -c "test ! -f '$MOUNT_B/edit-save-$n.md~'"

  printf 'saved final body %s\n' "$n" > "$MOUNT/edit-save-$n.md.tmp.1234"
  mv "$MOUNT/edit-save-$n.md.tmp.1234" "$MOUNT/edit-save-$n.md"
  rm -f "$MOUNT/edit-save-$n.md~"
  check_poll "$CONVERGE_S" "atomic tempfile save becomes canonical only after rename" \
    sh -c "$0 __server_text edit-save-$n.md | grep -q 'saved final body $n'"
}

s_invalid_workspace_paths() {
  local n out
  n="$(nonce)"
  out="$(opaque_submit_text "$SB" "bad_rel_$n" "../evil-$n.bin" "bad-rel-$n" "" "evil")"
  check "opaque submit with .. path rejected" \
    sh -c "echo '$out' | grep -q 'submit.rejected' && echo '$out' | grep -q 'invalid-path'"
  out="$(opaque_submit_text "$SB" "bad_abs_$n" "/tmp/evil-$n.bin" "bad-abs-$n" "" "evil")"
  check "opaque submit with absolute path rejected" \
    sh -c "echo '$out' | grep -q 'submit.rejected' && echo '$out' | grep -q 'invalid-path'"
  out="$(opaque_submit_text "$SB" "dup_slash_$n" "dup-$n//safe.bin" "dup-slash-$n" "" "safe")"
  if contains "$out" "submit.rejected"; then
    check "duplicate slash path rejected safely" sh -c "echo '$out' | grep -q 'invalid-path'"
  else
    check_poll "$CONVERGE_S" "duplicate slash path normalized safely" server_has_exact "dup-$n/safe.bin"
  fi
  check "invalid path rows did not materialize on disk" \
    sh -c "test ! -e '$MOUNT/../evil-$n.bin' && test ! -e '$MOUNT/tmp/evil-$n.bin'"
}

# ISSUE-0045 (was GAP-1 canary): the daemon opaque cycle. Disk binaries
# propagate to the server tree (opaque rows), overwrites roll the row hash,
# wire-created binaries materialize to disk, deletes follow the INV-3 stack.
s_binary_daemon_sync() {
  local n; n="$(nonce)"
  head -c 256 /dev/urandom > "$MOUNT/bin-$n.png"
  local h; h="$(shasum -a 256 "$MOUNT/bin-$n.png" | cut -d' ' -f1)"
  check_poll "$CONVERGE_S" "disk binary reaches the server tree" sh -c "$0 __server_has bin-$n.png"
  check "server row is opaque with the disk bytes' hash" \
    sh -c "[ \"\$($0 __entry_field bin-$n.png contentHash)\" = '$h' ] && [ \"\$($0 __entry_field bin-$n.png contentKind)\" = 'opaque' ]"
  check "daemon tracks the binary (state artifact)" \
    sh -c "cat '$GLOVEBOX_HOME'/state/*/workspace-state.json | grep -q 'bin-$n.png'"
  # Overwrite from disk: LWW push rolls the row hash.
  head -c 300 /dev/urandom > "$MOUNT/bin-$n.png"
  local h2; h2="$(shasum -a 256 "$MOUNT/bin-$n.png" | cut -d' ' -f1)"
  check_poll "$CONVERGE_S" "binary overwrite propagates" \
    sh -c "[ \"\$($0 __entry_field bin-$n.png contentHash)\" = '$h2' ]"
  # Reverse leg: a wire-created binary gets a tree row AND lands on disk.
  opaque_submit_text "$SB" "binw_$n" "binw-$n.dat" "bw-$n" "" "wire-bytes-$n" >/dev/null
  check_poll "$CONVERGE_S" "wire-created binary lands a tree row" sh -c "$0 __server_has binw-$n.dat"
  check_poll "$CONVERGE_S" "wire-created binary materializes on disk" \
    sh -c "grep -q 'wire-bytes-$n' '$MOUNT/binw-$n.dat'"
  # Delete leg: rm propagates only after the tombstone delay (INV-3).
  rm -f "$MOUNT/bin-$n.png"
  check_poll 15 "binary delete propagates after tombstone delay" \
    sh -c "! $0 __server_has bin-$n.png"
}

# Server-side opaque semantics (LWW + recovery store + conflict flag) are
# validated over the manifest/object wire path.
s_binary_lww_recovery() {
  local n fid; n="$(nonce)"; fid="op_$n"
  local h1 h2
  h1="$(printf 'v1-%s' "$n" | shasum -a 256 | cut -d' ' -f1)"
  h2="$(printf 'v2-%s' "$n" | shasum -a 256 | cut -d' ' -f1)"
  local a1 a2 a3 c1 c2 c3
  a1="$(opaque_submit_text "$SB" "$fid" "lww-$n.bin" "l1-$n" "" "v1-$n")"
  c1="$(echo "$a1" | pyj "d.get('conflict')")"
  check "fresh opaque write acked clean (conflict=$c1)" sh -c "[ '$c1' = 'False' ]"
  a2="$(opaque_submit_text "$SA" "$fid" "lww-$n.bin" "l2-$n" "$h1" "v2-$n")"
  c2="$(echo "$a2" | pyj "d.get('conflict')")"
  check "up-to-date overwrite (base=v1) acked clean (conflict=$c2)" sh -c "[ '$c2' = 'False' ]"
  # Stale writer: base hash is still v1 but current is v2 -> LWW, v2 preserved.
  a3="$(opaque_submit_text "$SB" "$fid" "lww-$n.bin" "l3-$n" "$h1" "v3-$n")"
  c3="$(echo "$a3" | pyj "d.get('conflict')")"
  check "stale overwrite wins LWW but acks conflict:true (conflict=$c3)" sh -c "[ '$c3' = 'True' ]"
  check_poll "$CONVERGE_S" "loser (v2) preserved in recovery store, not dropped" \
    sh -c "$0 __recovery | python3 -c 'import json,sys; v=json.loads(sys.stdin.read()); v=json.loads(v) if isinstance(v,str) else v; recs=[r for r in v[\"body\"][\"json\"][\"records\"] if r[\"opId\"]==\"l3-$n\"]; import base64; p=json.loads(recs[0][\"payload\"]); assert p[\"hashHex\"]==\"$h2\", p; print(\"ok\")' | grep -q ok"
}

s_op_kind_rejection() {
  local n; n="$(nonce)"
  local r1 r2
  r1="$(ws_raw "$SB" "{\"type\":\"content.submit\",\"fileId\":\"k1f-$n\",\"observedPath\":\"kind-$n.dat\",\"opId\":\"k1-$n\",\"baseContentVersionB64\":\"\",\"loroUpdateB64\":\"\"}")"
  check "content.submit on opaque path rejected (invalid-path)" sh -c "echo '$r1' | grep -q 'submit.rejected' && echo '$r1' | grep -q 'invalid-path'"
  r2="$(opaque_submit_text "$SB" "k2f-$n" "kind-$n.md" "k2-$n" "" "")"
  check "opaque.submit on markdown path rejected (invalid-path)" sh -c "echo '$r2' | grep -q 'submit.rejected' && echo '$r2' | grep -q 'invalid-path'"
}

s_rename_disk_one_op() {
  local n; n="$(nonce)"
  printf '# rename me\n\nbody-%s\n' "$n" > "$MOUNT/ren-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has ren-$n.md" || { bad "seed never synced"; return; }
  local fid; fid="$(file_id "ren-$n.md")"
  mv "$MOUNT/ren-$n.md" "$MOUNT/ren2-$n.md"
  check_poll "$CONVERGE_S" "rename propagates (new path live)" sh -c "$0 __server_has ren2-$n.md"
  check "same fileId at new path (ONE rename, not delete+create)" \
    sh -c "[ \"\$($0 __file_id ren2-$n.md)\" = '$fid' ]"
  check "old path gone, exactly one live survivor (no delete+create residue)" \
    sh -c "! $0 __server_has ren-$n.md && [ \$($0 __count_prefix ren) -ge 1 ]"
  check "content preserved across rename" sh -c "$0 __server_text ren2-$n.md | grep -q 'body-$n'"
}

s_rename_browser_to_disk() {
  local n; n="$(nonce)"
  printf '# browser rename\nbody-%s\n' "$n" > "$MOUNT/bren-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has bren-$n.md" || { bad "seed never synced"; return; }
  local fid seq; fid="$(file_id "bren-$n.md")"; seq="$(server_seq)"
  local ack; ack="$(ws_batch "$SB" "[{\"type\":\"file.rename\",\"opId\":\"br-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"fromPath\":\"bren-$n.md\",\"toPath\":\"bren2-$n.md\"}]")"
  check "rename accepted by server" sh -c "echo '$ack' | grep -q 'batch.ack' && echo '$ack' | grep -q 'br-$n'"
  check_poll "$CONVERGE_S" "file moved on disk (new path, old gone)" \
    sh -c "test -f '$MOUNT/bren2-$n.md' && test ! -f '$MOUNT/bren-$n.md'"
  check "content intact after browser rename" sh -c "grep -q 'body-$n' '$MOUNT/bren2-$n.md'"
}

s_rename_vs_edit() {
  local n; n="$(nonce)"
  printf '# race\nbody-%s\n' "$n" > "$MOUNT/race-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has race-$n.md" || { bad "seed never synced"; return; }
  local fid seq0 bh; fid="$(file_id "race-$n.md")"; seq0="$(server_seq)"; bh="$(entry_field "race-$n.md" contentHash)"
  # Bump the file's seq with a content edit, then submit a rename with the
  # STALE pre-edit baseSeq: server must defer remote-edit-wins, file survives.
  api "$SA" workspaces/textPush "{\"workspaceId\":\"$(wsid)\",\"fileId\":\"$fid\",\"newText\":\"# race edited [[RE-$n]]\",\"baseHashHex\":\"$bh\",\"idempotencyKey\":\"re-$n\"}" >/dev/null
  poll "$CONVERGE_S" "edit landed" sh -c "$0 __server_text race-$n.md | grep -q 'RE-$n'" || { bad "edit never landed"; return; }
  local ack; ack="$(ws_batch "$SB" "[{\"type\":\"file.rename\",\"opId\":\"rr-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq0,\"fromPath\":\"race-$n.md\",\"toPath\":\"race2-$n.md\"}]")"
  check "stale rename deferred as remote-edit-wins" \
    sh -c "echo '$ack' | grep -q 'deferredOps' && echo '$ack' | grep -q 'remote-edit-wins'"
  check "file not lost: still live at original path" sh -c "$0 __server_has race-$n.md"
  check "edited content intact" sh -c "$0 __server_text race-$n.md | grep -q 'RE-$n'"
  # Fresh baseSeq: rename now goes through and reaches disk.
  local seq1 ack2; seq1="$(server_seq)"
  ack2="$(ws_batch "$SB" "[{\"type\":\"file.rename\",\"opId\":\"rr2-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq1,\"fromPath\":\"race-$n.md\",\"toPath\":\"race2-$n.md\"}]")"
  check "fresh-baseSeq rename accepted" sh -c "echo '$ack2' | grep -q 'batch.ack'"
  check_poll "$CONVERGE_S" "renamed file lands on disk with edit" \
    sh -c "grep -q 'RE-$n' '$MOUNT/race2-$n.md'"
}

s_delete_tombstone_gate() {
  local n; n="$(nonce)"
  printf 'doomed\n' > "$MOUNT/del-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has del-$n.md" || { bad "seed never synced"; return; }
  rm "$MOUNT/del-$n.md"
  sleep 1   # < tombstoneDelayMs: intent must exist but NOT have propagated
  check "delete intent visible in status with countdown" \
    sh -c "node '$CLI' --json status '$MOUNT' | grep -q 'del-$n.md'"
  check "server still has file inside tombstone window" sh -c "$0 __server_has del-$n.md"
  check_poll 10 "delete propagates after tombstone delay" \
    sh -c "! $0 __server_has del-$n.md"
  check_poll 20 "file disappears from browser tree" \
    sh -c "! agent-browser --session '$SB' snapshot -i 2>/dev/null | grep -q 'del-$n.md'"
}

s_delete_vs_edit_resurrect() {
  local n; n="$(nonce)"
  printf '# keep me\n' > "$MOUNT/res-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has res-$n.md" || { bad "seed never synced"; return; }
  local fid bh; fid="$(file_id "res-$n.md")"; bh="$(entry_field "res-$n.md" contentHash)"
  rm "$MOUNT/res-$n.md"
  # Remote edit INSIDE the tombstone window bumps the file's seq past the
  # intent's baseSeq -> server defers remote-edit-wins -> daemon resurrects.
  api "$SA" workspaces/textPush "{\"workspaceId\":\"$(wsid)\",\"fileId\":\"$fid\",\"newText\":\"# resurrected [[RZ-$n]]\",\"baseHashHex\":\"$bh\",\"idempotencyKey\":\"rz-$n\"}" >/dev/null
  check_poll 15 "file RESURRECTED on disk with remote edit" \
    sh -c "grep -q 'RZ-$n' '$MOUNT/res-$n.md'"
  check "file still live on server" sh -c "$0 __server_has res-$n.md"
}

s_delete_browser_to_disk() {
  local n; n="$(nonce)"
  printf 'bye\n' > "$MOUNT/bdel-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has bdel-$n.md" || { bad "seed never synced"; return; }
  local fid seq; fid="$(file_id "bdel-$n.md")"; seq="$(server_seq)"
  local ack; ack="$(ws_batch "$SB" "[{\"type\":\"file.deleteIntent\",\"opId\":\"bd-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"path\":\"bdel-$n.md\"}]")"
  check "browser delete accepted" sh -c "echo '$ack' | grep -q 'batch.ack'"
  check_poll "$CONVERGE_S" "file removed from disk" sh -c "test ! -f '$MOUNT/bdel-$n.md'"
}

s_browser_delete_vs_edit_resurrect() {
  local n; n="$(nonce)"
  printf '# browser delete race\n' > "$MOUNT/bder-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has bder-$n.md" || { bad "seed never synced"; return; }
  open_file "$SB" "bder-$n.md" || { bad "open bder-$n.md in $SB"; return; }
  local fid seq; fid="$(file_id "bder-$n.md")"; seq="$(server_seq)"
  type_text "$SB" "[[BDE-$n]]" end >/dev/null &
  local typer=$!
  local ack; ack="$(ws_batch "$SA" "[{\"type\":\"file.deleteIntent\",\"opId\":\"bde-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"path\":\"bder-$n.md\"}]")"
  wait "$typer"
  check "browser-origin delete race got a batch response" sh -c "echo '$ack' | grep -q 'batch.ack'"
  check_poll 20 "browser pending edit survives remote delete on disk (RESURRECT)" \
    sh -c "grep -q 'BDE-$n' '$MOUNT/bder-$n.md'"
  check_poll 20 "browser pending edit survives remote delete on server" \
    sh -c "$0 __server_text bder-$n.md | grep -q 'BDE-$n'"
  open_file "$SA" "bder-$n.md" || { bad "open resurrected bder-$n.md in $SA"; return; }
  check_poll "$CONVERGE_S" "other browser sees resurrected edit" sh -c "$0 __editor_has $SA BDE-$n"
}

s_tree_after_content_no_gap() {
  local n; n="$(nonce)"
  printf '# ordered\n' > "$MOUNT/order-$n.md"
  printf '# side\n' > "$MOUNT/order-side-$n.md"
  poll "$CONVERGE_S" "ordered fixtures synced" \
    sh -c "$0 __server_has order-$n.md && $0 __server_has order-side-$n.md" || { bad "fixtures never synced"; return; }
  open_file "$SA" "order-$n.md" || { bad "open order-$n.md in $SA"; return; }
  open_file "$SB" "order-$n.md" || { bad "open order-$n.md in $SB"; return; }
  type_text "$SA" "[[ORD-1-$n]]" end >/dev/null
  check_poll "$CONVERGE_S" "first content edit reaches other browser" sh -c "$0 __editor_has $SB ORD-1-$n"
  local fid seq ack; fid="$(file_id "order-side-$n.md")"; seq="$(server_seq)"
  ack="$(ws_batch "$SB" "[{\"type\":\"file.rename\",\"opId\":\"ord-rn-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"fromPath\":\"order-side-$n.md\",\"toPath\":\"order-side2-$n.md\"}]")"
  check "interleaved tree op accepted" sh -c "echo '$ack' | grep -q 'batch.ack'"
  check_poll "$CONVERGE_S" "interleaved rename reaches disk" test -f "$MOUNT/order-side2-$n.md"
  type_text "$SA" "[[ORD-2-$n]]" end >/dev/null
  check_poll "$CONVERGE_S" "content after tree op reaches other browser without gap repair fallout" \
    sh -c "$0 __editor_has $SB ORD-1-$n && $0 __editor_has $SB ORD-2-$n"
  check_poll "$CONVERGE_S" "content after tree op reaches disk" \
    sh -c "grep -q 'ORD-1-$n' '$MOUNT/order-$n.md' && grep -q 'ORD-2-$n' '$MOUNT/order-$n.md'"
}

s_open_file_rename_delete_room() {
  local n; n="$(nonce)"
  printf '# open room\n' > "$MOUNT/openrd-$n.md"
  poll "$CONVERGE_S" "open-room fixture synced" sh -c "$0 __server_has openrd-$n.md" || { bad "fixture never synced"; return; }
  open_file "$SA" "openrd-$n.md" || { bad "open openrd-$n.md in $SA"; return; }
  type_text "$SA" "[[OPEN-BEFORE-$n]]" end >/dev/null
  check_poll "$CONVERGE_S" "pre-rename edit on disk" sh -c "grep -q 'OPEN-BEFORE-$n' '$MOUNT/openrd-$n.md'"
  local fid seq ack; fid="$(file_id "openrd-$n.md")"; seq="$(server_seq)"
  ack="$(ws_batch "$SB" "[{\"type\":\"file.rename\",\"opId\":\"open-rn-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"fromPath\":\"openrd-$n.md\",\"toPath\":\"openrd2-$n.md\"}]")"
  check "remote rename of open file accepted" sh -c "echo '$ack' | grep -q 'batch.ack'"
  check_poll "$CONVERGE_S" "open editor kept its room across rename" sh -c "$0 __editor_has $SA OPEN-BEFORE-$n"
  type_text "$SA" "[[OPEN-AFTER-$n]]" end >/dev/null
  check_poll "$CONVERGE_S" "post-rename edit writes to renamed disk path" \
    sh -c "grep -q 'OPEN-AFTER-$n' '$MOUNT/openrd2-$n.md' && test ! -f '$MOUNT/openrd-$n.md'"
  seq="$(server_seq)"
  ack="$(ws_batch "$SB" "[{\"type\":\"file.deleteIntent\",\"opId\":\"open-del-$n\",\"fileId\":\"$fid\",\"baseSeq\":$seq,\"path\":\"openrd2-$n.md\"}]")"
  check "remote delete of open file accepted" sh -c "echo '$ack' | grep -q 'batch.ack'"
  check_poll "$CONVERGE_S" "deleted open file is removed from disk" sh -c "test ! -f '$MOUNT/openrd2-$n.md'"
  check_poll 20 "deleted open file closes the editor" sh -c "$0 __editor_missing $SA"
}

s_opaque_oversize_rejected() {
  local n out; n="$(nonce)"
  out="$(opaque_oversize "$SB" "big_$n" "big-$n.bin" "big-$n")"
  check "opaque >10MiB rejected as too-large" \
    sh -c "echo '$out' | grep -q 'submit.rejected' && echo '$out' | grep -q 'too-large'"
  check "oversize opaque row not created" sh -c "! $0 __server_has big-$n.bin"
  check "oversize opaque bytes not materialized on disk" sh -c "test ! -f '$MOUNT/big-$n.bin'"
}

s_crlf_normalize_e2e() {
  local n; n="$(nonce)"
  printf 'crlf-a\r\ncrlf-b\r\n' > "$MOUNT/crlf-$n.md"
  poll "$CONVERGE_S" "crlf file synced" sh -c "$0 __server_has crlf-$n.md" || { bad "crlf fixture never synced"; return; }
  check_poll 20 "server text normalized to LF" sh -c "$0 __server_text crlf-$n.md | python3 -c 'import sys; s=sys.stdin.read(); assert \"\\r\" not in s and \"crlf-a\\ncrlf-b\" in s'"
  open_file "$SB" "crlf-$n.md" || { bad "open crlf-$n.md in $SB"; return; }
  check_poll "$CONVERGE_S" "browser editor sees LF-normalized text" sh -c "$0 __editor_no_cr $SB"
  check_poll 20 "disk view is repaired to LF-normalized bytes" \
    sh -c "python3 -c 'import pathlib,sys; data=pathlib.Path(\"$MOUNT/crlf-$n.md\").read_bytes(); sys.exit(0 if b\"\\r\" not in data else 1)'"
}

s_stopped_daemon_create_collision() {
  local n; n="$(nonce)"
  daemon_stop || { bad "daemon stop for stopped collision"; return; }
  printf 'LOCAL-A-%s\n' "$n" > "$MOUNT/stopped-col-$n.md"
  create_file_ui "$SB" "stopped-col-$n.md" || { bad "browser create while daemon stopped"; daemon_start; return; }
  open_file "$SB" "stopped-col-$n.md" || { bad "open browser-created stopped-col-$n.md"; daemon_start; return; }
  type_text "$SB" "[[BROWSER-B-$n]]" end >/dev/null
  poll "$CONVERGE_S" "browser create reached server while daemon stopped" sh -c "$0 __server_has stopped-col-$n.md" || { bad "browser create never synced"; daemon_start; return; }
  daemon_start || { bad "daemon restart for stopped collision"; return; }
  check_poll 20 "stopped-daemon same-path create keeps both server rows" \
    sh -c "[ \$($0 __count_prefix stopped-col-$n) -eq 2 ]"
  check_poll 20 "stopped-daemon same-path create keeps both disk files" \
    sh -c "[ \$(ls '$MOUNT' | grep -c '^stopped-col-$n') -eq 2 ]"
  check_poll 20 "both stopped-daemon collision payloads survived" \
    sh -c "cat '$MOUNT'/stopped-col-$n*.md | grep -q 'LOCAL-A-$n' && cat '$MOUNT'/stopped-col-$n*.md | grep -q 'BROWSER-B-$n'"
}

s_fresh_tab_midstream_repair() {
  local n; n="$(nonce)"
  printf '# fresh tab\n' > "$MOUNT/fresh-$n.md"
  poll "$CONVERGE_S" "fresh-tab fixture synced" sh -c "$0 __server_has fresh-$n.md" || { bad "fixture never synced"; return; }
  open_file "$SA" "fresh-$n.md" || { bad "open fresh-$n.md in $SA"; return; }
  type_text "$SA" "[[FRESH-$n]]" end >/dev/null
  agent-browser --session "$SB" open "$URL/" >/dev/null 2>&1
  agent-browser --session "$SB" wait --load networkidle >/dev/null 2>&1
  open_file "$SB" "fresh-$n.md" || { bad "open fresh-$n.md in fresh $SB"; return; }
  check_poll "$CONVERGE_S" "fresh browser tab hydrates mid-stream edit" sh -c "$0 __editor_has $SB FRESH-$n"
  check_poll "$CONVERGE_S" "fresh browser tab and disk agree" sh -c "grep -q 'FRESH-$n' '$MOUNT/fresh-$n.md'"
}

s_bulk_delete_window_guard() {
  local n i; n="$(nonce)"
  for i in 1 2 3 4 5 6; do printf 'bulk %s\n' "$i" > "$MOUNT/bulk-$n-$i.md"; done
  poll "$CONVERGE_S" "6 files synced" sh -c "[ \$($0 __count_prefix bulk-$n) -eq 6 ]" || { bad "bulk seeds never synced"; return; }
  rm "$MOUNT"/bulk-$n-*.md
  sleep $(( TOMBSTONE_S + 2 ))   # well past tombstone: only the guard can be holding them
  check "all 6 intents HELD by bulk-window guard" \
    sh -c "[ \"\$(node '$CLI' --json status '$MOUNT' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for i in d[\"deleteIntents\"] if i[\"held\"]==\"bulk-window\"))')\" = '6' ]"
  check "no bulk file tombstoned on server" sh -c "[ \$($0 __count_prefix bulk-$n) -eq 6 ]"
  # Restoring the files cancels the held intents.
  for i in 1 2 3 4 5 6; do printf 'bulk %s\n' "$i" > "$MOUNT/bulk-$n-$i.md"; done
  check_poll "$CONVERGE_S" "restored files cancel held intents" \
    sh -c "! node '$CLI' --json status '$MOUNT' | grep -q 'bulk-$n'"
}

# First-scan-after-boot wipe protection. NOTE: the absences are recorded by
# the guarded checkout (which runs before scan), so the runtime bulk-WINDOW
# guard usually claims them before scan's bulk-STARTUP upgrade — the hold
# label differs but the protection (never propagate) is identical. Assert
# held-of-either-type, and that the server stays untouched.
s_bulk_delete_startup_guard() {
  local n; n="$(nonce)"
  local intents_before
  intents_before="$(node "$CLI" --json status "$MOUNT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["deleteIntents"]))' 2>/dev/null)"
  daemon_stop || { bad "daemon stop for startup-guard"; return; }
  local live_before; live_before="$(live_paths | wc -w | tr -d ' ')"
  local tracked_before
  tracked_before="$(find "$MOUNT" -type f ! -name '.glovebox.json' | wc -l | tr -d ' ')"
  tar -C "$MOUNT" -cf "$BASE/stash-$n.tar" --exclude .glovebox.json .
  find "$MOUNT" -type f ! -name '.glovebox.json' -delete
  daemon_start || { bad "daemon restart for startup-guard"; return; }
  sleep 3
  local held total
  held="$(node "$CLI" --json status "$MOUNT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(1 for i in d["deleteIntents"] if i["held"] in ("bulk-startup","bulk-window")))' 2>/dev/null)"
  total="$(node "$CLI" --json status "$MOUNT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["deleteIntents"]))' 2>/dev/null)"
  check "boot wipe: every intent held by a bulk guard ($held/$total, $tracked_before files gone)" \
    sh -c "[ -n '$held' ] && [ '$held' = '$total' ] && [ '$held' != '0' ]"
  sleep $(( TOMBSTONE_S + 1 ))
  check "no file tombstoned on server during startup hold (live count $live_before unchanged)" \
    sh -c "[ \"\$($0 __live_count)\" = '$live_before' ]"
  tar -C "$MOUNT" -xf "$BASE/stash-$n.tar"
  rm -f "$BASE/stash-$n.tar"
  check_poll 20 "restored files cancel the wipe's intents (back to $intents_before pre-existing)" \
    sh -c "[ \"\$(node '$CLI' --json status '$MOUNT' | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d[\"deleteIntents\"]))')\" -le '${intents_before:-0}' ]"
}

s_sentinel_freeze() {
  local n; n="$(nonce)"
  printf 'victim\n' > "$MOUNT/sent-$n.md"
  printf '# alive\n' > "$MOUNT/sent-edit-$n.md"
  poll "$CONVERGE_S" "fixtures synced" sh -c "$0 __server_has sent-$n.md && $0 __server_has sent-edit-$n.md" || { bad "fixtures never synced"; return; }
  mv "$MOUNT/.glovebox.json" "$BASE/sentinel-stash.json"
  sleep 2
  rm "$MOUNT/sent-$n.md"
  sleep $(( TOMBSTONE_S + 2 ))
  check "mount suspect while sentinel missing" \
    sh -c "node '$CLI' --json status '$MOUNT' | grep -q '\"mountSuspect\": true'"
  check "delete FROZEN: server still has file well past tombstone" sh -c "$0 __server_has sent-$n.md"
  printf '[[SF-%s]]\n' "$n" >> "$MOUNT/sent-edit-$n.md"
  check_poll "$CONVERGE_S" "edits still flow while deletes frozen" \
    sh -c "$0 __server_text sent-edit-$n.md | grep -q 'SF-$n'"
  mv "$BASE/sentinel-stash.json" "$MOUNT/.glovebox.json"
  check_poll 15 "delete propagates after sentinel restored" \
    sh -c "! $0 __server_has sent-$n.md"
}

# Kind boundary, rename-only half: a rename across .md <-> .png propagates
# as ONE rename with the fileId and content intact, in BOTH directions, and
# the row's contentKind follows the path (ISSUE-0043 server decision).
s_md_opaque_rename_boundary() {
  local n; n="$(nonce)"
  printf '# was markdown %s\n' "$n" > "$MOUNT/kindren-$n.md"
  poll "$CONVERGE_S" "md fixture synced" sh -c "$0 __server_has kindren-$n.md" || { bad "fixture never synced"; return; }
  local fid; fid="$(file_id "kindren-$n.md")"
  mv "$MOUNT/kindren-$n.md" "$MOUNT/kindren-$n.png"
  check_poll "$CONVERGE_S" "md->png rename propagates" sh -c "$0 __server_has kindren-$n.png"
  check "same fileId across kind boundary" sh -c "[ \"\$($0 __file_id kindren-$n.png)\" = '$fid' ]"
  check "row kind re-derived to opaque" \
    sh -c "[ \"\$($0 __entry_field kindren-$n.png contentKind)\" = 'opaque' ]"
  sleep 3   # several cycles: rename alone must never corrupt the bytes
  check "rename-only is safe: disk content intact across cycles" \
    sh -c "grep -q 'was markdown $n' '$MOUNT/kindren-$n.png'"
  # Reverse: .png -> .md crosses back; same fileId, readable as markdown.
  mv "$MOUNT/kindren-$n.png" "$MOUNT/kindren-back-$n.md"
  check_poll "$CONVERGE_S" "png->md rename propagates" sh -c "$0 __server_has kindren-back-$n.md"
  check "same fileId back across the boundary" \
    sh -c "[ \"\$($0 __file_id kindren-back-$n.md)\" = '$fid' ]"
  check_poll "$CONVERGE_S" "content readable as markdown text after the crossing" \
    sh -c "$0 __server_text kindren-back-$n.md | grep -q 'was markdown $n'"
}

# ISSUE-0043 regression (was the DEFECT-1 canary s_defect_kind_boundary_loss):
# mv note.md note.png, then write bytes to note.png. The daemon re-derives the
# view's kind at the rename and the edit flows through the opaque LWW push —
# the old defect absorbed it as markdown, got refused invalid-path, and the
# repair/checkout interplay TRUNCATED the file to 0 bytes within ~2 cycles.
s_kind_boundary_edit() {
  local n; n="$(nonce)"
  printf '# victim %s\n' "$n" > "$MOUNT/kbl-$n.md"
  poll "$CONVERGE_S" "fixture synced" sh -c "$0 __server_has kbl-$n.md" || { bad "fixture never synced"; return; }
  local fid; fid="$(file_id "kbl-$n.md")"
  mv "$MOUNT/kbl-$n.md" "$MOUNT/kbl-$n.png"
  poll "$CONVERGE_S" "rename synced" sh -c "$0 __server_has kbl-$n.png" || { bad "rename never synced"; return; }
  printf 'PNGBYTES-%s' "$n" > "$MOUNT/kbl-$n.png"
  local h; h="$(shasum -a 256 "$MOUNT/kbl-$n.png" | cut -d' ' -f1)"
  check_poll "$CONVERGE_S" "post-boundary edit reaches the server as opaque bytes" \
    sh -c "[ \"\$($0 __entry_field kbl-$n.png contentHash)\" = '$h' ]"
  sleep 3   # several cycles: the defect destroyed the bytes within ~2
  check "disk bytes survive every cycle (DEFECT-1 regression)" \
    sh -c "grep -q 'PNGBYTES-$n' '$MOUNT/kbl-$n.png'"
  check "same fileId across boundary + edit" sh -c "[ \"\$($0 __file_id kbl-$n.png)\" = '$fid' ]"
}

s_lock_second_run_refused() {
  local out rc
  out="$(node "$CLI" run "$MOUNT" 2>&1)"; rc=$?
  check "second 'glovebox run' refused by mandatory lock (rc=$rc)" \
    sh -c "[ $rc -ne 0 ] && echo '$out' | grep -qi 'lock\|in use'"
  check "original daemon still running" sh -c "[ -n \"\$(node '$CLI' --json status '$MOUNT' | grep '\"running\": true')\" ]"
}

s_unmount_guard() {
  local out rc
  out="$(node "$CLI" unmount "$MOUNT" 2>&1)"; rc=$?
  check "unmount refused while daemon holds the lock" sh -c "[ $rc -ne 0 ]"
  daemon_stop || { bad "daemon stop before unmount"; return; }
  local before after mount_id
  mount_id="$(node "$CLI" --json status "$MOUNT" | pyj "d['mountId']")"
  before="$(find "$MOUNT" -type f ! -name '.glovebox.json' | sort | shasum | cut -d' ' -f1)"
  node "$CLI" unmount "$MOUNT" >/dev/null 2>&1
  rc=$?
  after="$(find "$MOUNT" -type f ! -name '.glovebox.json' | sort | shasum | cut -d' ' -f1)"
  check "unmount succeeds once daemon stopped" sh -c "[ $rc -eq 0 ]"
  check "user files untouched by unmount" sh -c "[ '$before' = '$after' ]"
  check "sentinel removed" sh -c "test ! -f '$MOUNT/.glovebox.json'"
  check "state dir for unmounted binding removed" sh -c "test ! -d '$GLOVEBOX_HOME/state/$mount_id'"
  check "registry entry removed" sh -c "! node '$CLI' --json list 2>/dev/null | grep -q '$MOUNT'"
  # Restore the stack for any scenarios that follow.
  local live_before; live_before="$(live_paths | wc -w | tr -d ' ')"
  node "$CLI" mount "$MOUNT" --workspace "$(wsid)" --server "$URL" >/dev/null 2>&1
  daemon_start
  check_poll 20 "stack restored after remount" \
    sh -c "node '$CLI' --json status '$MOUNT' | grep -q '\"running\": true'"
  # ISSUE-0044 (was the DEFECT-2 canary): re-adoption binds disk files to
  # the workspace's existing fileIds by path — the live tree count must be
  # UNCHANGED after a remount (no file.md + file-2.md doubling).
  sleep 8
  check "remount adoption keeps the live tree unchanged ($live_before files, was DEFECT-2)" \
    sh -c "[ \"\$($0 __live_count)\" = '$live_before' ]"
}

s_sigint_clean_stop() {
  local pid mid; pid="$(daemon_pid)"
  [ -n "$pid" ] || { bad "no daemon to stop"; return; }
  # Locks are keyed by mountId (<mountId>.lock). Only THIS daemon's lock must
  # be released on stop — the secondary daemon (mount B) legitimately keeps its
  # own. (Asserting the whole locks dir was empty broke once the harness ran
  # two daemons.)
  mid="$(node "$CLI" --json status "$MOUNT" 2>/dev/null | pyj "d['mountId']")"
  [ -n "$mid" ] || { bad "could not resolve mount A mountId"; return; }
  kill -INT "$pid"
  check_poll 15 "SIGINT stops daemon" sh -c "! kill -0 $pid 2>/dev/null"
  check_poll 5 "lockfile released on clean stop" \
    sh -c "! test -f '$GLOVEBOX_HOME/locks/$mid.lock'"
  daemon_start
  check_poll 15 "daemon restarts cleanly" sh -c "node '$CLI' --json status '$MOUNT' | grep -q '\"running\": true'"
}

s_kill9_restart_reconcile() {
  local n; n="$(nonce)"
  # Make work for the cycle, then kill -9 immediately: mid-cycle death.
  printf '# k9 a [[K9A-%s]]\n' "$n" > "$MOUNT/k9a-$n.md"
  printf '# k9 b [[K9B-%s]]\n' "$n" > "$MOUNT/k9b-$n.md"
  printf '# k9 c [[K9C-%s]]\n' "$n" > "$MOUNT/k9c-$n.md"
  local mid; mid="$(node "$CLI" --json status "$MOUNT" 2>/dev/null | pyj "d['mountId']")"
  daemon_kill9
  sleep 1
  # Target mount A's own stale lock (<mountId>.lock); a bare locks-dir glob
  # would pass trivially on the secondary daemon's live lock.
  check "kill -9 leaves stale lock on disk" \
    sh -c "[ -n '$mid' ] && test -f '$GLOVEBOX_HOME/locks/$mid.lock'"
  daemon_start || { bad "restart after kill -9 (stale lock not broken?)"; return; }
  check "stale lock broken by pid-liveness, restart succeeded" true
  check_poll 20 "all pre-kill files converge after restart" \
    sh -c "$0 __server_text k9a-$n.md | grep -q 'K9A-$n' && $0 __server_text k9b-$n.md | grep -q 'K9B-$n' && $0 __server_text k9c-$n.md | grep -q 'K9C-$n'"
  check "no duplicate/suffixed files from double-apply" \
    sh -c "[ \$($0 __count_prefix k9a-$n) -eq 1 ] && [ \$($0 __count_prefix k9b-$n) -eq 1 ] && [ \$($0 __count_prefix k9c-$n) -eq 1 ]"
  # And edits made WHILE the daemon was dead reconcile on restart too.
  daemon_kill9; sleep 1
  printf '[[K9D-%s]]\n' "$n" >> "$MOUNT/k9a-$n.md"
  daemon_start
  check_poll 20 "edit made while daemon dead reconciles on restart" \
    sh -c "$0 __server_text k9a-$n.md | grep -q 'K9D-$n'"
}

s_concurrent_three_writers() {
  local n; n="$(nonce)"
  printf '# three writers\n\nmiddle\n' > "$MOUNT/tri-$n.md"
  poll "$CONVERGE_S" "file synced" sh -c "$0 __server_has tri-$n.md" || { bad "seed never synced"; return; }
  open_file "$SA" "tri-$n.md" || { bad "open in $SA"; return; }
  open_file "$SB" "tri-$n.md" || { bad "open in $SB"; return; }
  type_text "$SA" "[[TRI-A-$n]]" start >/dev/null &
  local typer_a=$!
  type_text "$SB" "[[TRI-B-$n]]" end >/dev/null &
  local typer_b=$!
  printf '[[TRI-D-%s]]\n' "$n" >> "$MOUNT/tri-$n.md"
  wait "$typer_a" "$typer_b"
  local want="TRI-A-$n TRI-B-$n TRI-D-$n" m
  for m in $want; do
    check_poll "$CONVERGE_S" "disk has $m" sh -c "grep -q '$m' '$MOUNT/tri-$n.md'"
  done
  for m in $want; do
    check_poll "$CONVERGE_S" "server has $m" sh -c "$0 __server_text tri-$n.md | grep -q '$m'"
  done
  for m in $want; do
    check_poll "$CONVERGE_S" "editor $SA has $m" sh -c "$0 __editor_has $SA $m"
    check_poll "$CONVERGE_S" "editor $SB has $m" sh -c "$0 __editor_has $SB $m"
  done
}

SCENARIO_ORDER="
s_text_disk_to_browser
s_text_browser_to_disk
s_text_concurrent_merge
s_create_disk_to_browser
s_create_browser_to_disk
s_create_collision
s_overwrite_truncate
s_special_paths
s_directory_move_delete
s_rename_create_collision
s_editor_temp_litter_ignored
s_invalid_workspace_paths
s_binary_daemon_sync
s_binary_lww_recovery
s_op_kind_rejection
s_rename_disk_one_op
s_rename_browser_to_disk
s_rename_vs_edit
s_delete_tombstone_gate
s_delete_vs_edit_resurrect
s_delete_browser_to_disk
s_browser_delete_vs_edit_resurrect
s_tree_after_content_no_gap
s_open_file_rename_delete_room
s_opaque_oversize_rejected
s_crlf_normalize_e2e
s_stopped_daemon_create_collision
s_fresh_tab_midstream_repair
s_bulk_delete_window_guard
s_sentinel_freeze
s_md_opaque_rename_boundary
s_kind_boundary_edit
s_concurrent_three_writers
s_lock_second_run_refused
s_sigint_clean_stop
s_kill9_restart_reconcile
s_bulk_delete_startup_guard
s_unmount_guard
"

run_scenario() {
  CURRENT="$1"
  echo "== $1"
  "$1"
  assert_convergence "$1"
}

cmd_run() {
  : > "$FAILLOG"
  if [ -z "$(daemon_pid_for "$MOUNT_A")" ] || [ -z "$(daemon_pid_for "$MOUNT_B")" ]; then
    daemon_start_all || {
      echo "run: daemon failed to start (see $BASE/daemon-a.log / daemon-b.log)" >&2
      exit 1
    }
  fi
  if [ "${1:-all}" = "all" ]; then
    for s in $SCENARIO_ORDER; do run_scenario "$s"; done
  else
    for s in "$@"; do run_scenario "$s"; done
  fi
  assert_convergence "final sweep"
  echo
  echo "== RESULT: $PASS passed, $FAIL failed"
  if [ "$FAIL" -gt 0 ]; then echo "-- failures:"; cat "$FAILLOG"; exit 1; fi
}

cmd_full() {
  cmd_setup "${1:-fresh}"
  cmd_run all
}

# ---------------------------------------------------- internal subcommands --
# (used by check_poll via `$0 __helper args` so polls re-evaluate fresh state)

case "${1:-help}" in
  __server_has)   live_paths | grep -q "$2"; exit $? ;;
  __server_text)  server_text "$2"; exit 0 ;;
  __file_id)      file_id "$2"; exit 0 ;;
  __entry_field)  entry_field "$2" "$3"; exit 0 ;;
  __count_prefix) tree_json | pyj "sum(1 for e in d['body']['json']['entries'] if e['path'].startswith('$2') and not e['tombstone'])"; exit 0 ;;
  __editor_has)   editor_text "$2" | grep -q "$3"; exit $? ;;
  __editor_missing) page "$2" editor-text.js | grep -q 'no .cm-content'; exit $? ;;
  __editor_no_cr)  editor_text "$2" | python3 -c 'import sys; sys.exit(0 if "\r" not in sys.stdin.read() else 1)'; exit $? ;;
  __recovery)     recovery_list; exit 0 ;;
  __live_count)   live_paths | wc -w | tr -d ' '; exit 0 ;;
esac

cmd="${1:-help}"; shift 2>/dev/null || true
case "$cmd" in
  warm)     cmd_warm ;;
  setup)    cmd_setup "$@" ;;
  teardown) cmd_teardown ;;
  status)   cmd_status ;;
  list)     echo "$SCENARIO_ORDER" ;;
  run)      cmd_run "$@" ;;
  full)     cmd_full "$@" ;;
  help|*)
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
