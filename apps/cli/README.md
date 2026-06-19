# @glovebox.md/cli

`glovebox` — sync a local directory with a collaborative workspace. The
"mount" is a **sidecar observer** (architecture D2): a foreground daemon
that watches and reconciles a real directory over a WebSocket to the
workspace server. No FUSE, no kernel anything.

## Install

```sh
npm install -g @glovebox.md/cli   # then run `glovebox`
# or, without installing:
npx @glovebox.md/cli --help
```

Requires **Node.js ≥ 24**. Web app: <https://app.glovebox.md>.

## Quick start

```sh
glovebox auth login --workspace <id>    # sign in (opens a browser, stores an API key)
glovebox whoami                         # confirm who you are + list your workspaces
glovebox mount ./notes --workspace <id> # bind a local directory to a workspace
glovebox run ./notes                    # start the foreground sync daemon (Ctrl-C to stop)
```

New here and don't know a workspace ID? Sign in, then `glovebox workspaces
list` (or `glovebox workspaces create <name>`). Stuck? `glovebox doctor`
reports the resolved server, whether you're authenticated, and reachability.

## Commands

| Command                                      | What it does                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `glovebox auth login [--workspace <id>...]`  | Sign in: browser device flow (or `--with-token` to store a token from stdin). Sets the default server |
| `glovebox whoami`                            | Show your identity, active workspace, and every workspace you can access                              |
| `glovebox workspaces list` / `create <name>` | Discover or create workspaces                                                                         |
| `glovebox auth token` / `logout`             | Print the stored token (for scripting), or sign out                                                   |
| `glovebox doctor [--fix]`                    | Check CLI health, the resolved server, auth, and reachability (`--fix` repairs stale locks)           |
| `glovebox mount <dir> --workspace <id>`      | Register the directory↔workspace binding (no process starts)                                          |
| `glovebox run [<dir>]`                       | Run the sync daemon in the foreground (one process per mount)                                         |
| `glovebox list`                              | Registered mounts + running/stopped                                                                   |
| `glovebox status [<dir>]`                    | Cursor, tracked files, pending pushes, and the INV-3 deletion stack                                   |
| `glovebox unmount <dir>`                     | Remove the binding + daemon state (never your files); refuses while running                           |
| `glovebox pull <path> --workspace <id>`      | Fetch a file's working text and record the merge base                                                 |
| `glovebox push <path>`                       | Merge local edits into the live document (exit 0 clean · 2 hunks · 3 refuse)                          |

Run `glovebox <command> --help` for per-command options. `--json` gives
structured output on any command (the default when stdout is not a TTY);
`--human` forces human output even when piped.

For agents, JSON responses carry machine-readable affordances: a `nextActions`
array of runnable next steps on success, a `fix` string on errors, and
`glovebox --json` (no subcommand) returns the full command tree for discovery.
`glovebox --json run <dir>` streams newline-delimited JSON events whose last
line is the terminal `result`/`error` envelope.

## Choosing the server

The server a command talks to is resolved in this order (highest first):

1. `--server <url>` on the command
2. `GLOVEBOX_SERVER_URL` environment variable
3. the default recorded at login (`~/.glovebox/config.json`)
4. the built-in default, **`https://api.glovebox.md`**

A successful `auth login` records its server as the default, so after signing
in you usually need no `--server`. To target a different server, pass
`--server <url>`, set `GLOVEBOX_SERVER_URL`, or sign in to it (which makes it
the new default). `glovebox run`/`status`/`list`/`unmount` use the server
recorded on the mount itself.

## Editing files (pull / push)

```sh
glovebox pull docs/note.md --workspace <id>   # writes the file + records a merge base
$EDITOR docs/note.md                          # edit locally with anything
glovebox push docs/note.md                     # 3-way merge into the live doc
```

Push exit codes: `0` clean merge · `2` some hunks couldn't be placed (printed
verbatim; base unchanged — re-pull and retry) · `3` degenerate-rewrite refused
(use `--force` only intentionally) · `1` other (auth, network, unknown file).

## Files

Everything the CLI persists lives under `~/.glovebox/` (override with
`GLOVEBOX_HOME`):

- `auth.json` — stored tokens, one per server URL (mode `0600`).
- `config.json` — non-secret preferences (the default server).
- `mounts.json` — the directory↔workspace registry.
- `state/`, `locks/` — per-mount daemon bookkeeping.

The only in-mount artifact is the `.glovebox.json` sentinel; `pull`/`push`
also keep a per-file merge base under `.glovebox/` in the working directory.

## Local dev (against the dev worker)

The dev worker (`vp run dev:worker`) serves `https://api.glovebox.test` via
portless (`portless proxy start --tld test` once per boot). Point the CLI at
it with `--server https://api.glovebox.test` or `GLOVEBOX_SERVER_URL`. Without
`WS_AUTH_SECRET` the dev worker accepts anonymous connections; otherwise sign
a local token with the dev-only helper:

```sh
glovebox auth mint-dev --secret <WS_AUTH_SECRET> --workspace demo \
  --server https://api.glovebox.test --save
glovebox mount ~/glovebox-demo --workspace demo --server https://api.glovebox.test
glovebox run ~/glovebox-demo
```

## Notes

- The per-mount lockfile is mandatory — a second `run` on the same mount
  refuses while the first is alive, and breaks the lock if it died.
- Watcher events are hints only; a jittered full rescan
  (`--rescan-interval <dur>`, e.g. `30m`/`1h`/bare seconds, default 30 min) is
  the correctness backstop, so even with no watcher events nothing is ever
  missed — just slower.
- `GLOVEBOX_SYNC_OVERRIDES` (JSON env) shrinks delete-policy delays and
  intervals for tests/debugging. Not for production use.
- **TLS to `.test` domains**: browsers use the OS trust store; Node does
  not by default. `glovebox run` augments Node's CAs with the system store
  at startup (so `portless trust` is enough), and on a connection failure
  it probes the TLS handshake and prints the actual certificate error —
  fallbacks: `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem` or
  `NODE_OPTIONS=--use-system-ca`.
