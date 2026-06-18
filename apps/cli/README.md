# @glovebox.md/cli

`glovebox` — sync a local directory with a collaborative workspace. The
"mount" is a **sidecar observer** (architecture D2): a foreground daemon
that watches and reconciles a real directory over a WebSocket to the
workspace server. No FUSE, no kernel anything.

## Commands

| Command                                                       | What it does                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `glovebox auth login --server <url> --token <t>`              | Store a server token (mint tokens in the product; the CLI never mints)                                                       |
| `glovebox auth mint-dev --secret <s> --workspace <id> --save` | **Dev only**: sign a token locally for a no-auth/dev worker                                                                  |
| `glovebox mount <dir> --workspace <id> [--server <url>]`      | Register the directory↔workspace binding (no process starts)                                                                 |
| `glovebox run [<dir>]`                                        | Run the sync daemon in the foreground (one process per mount, Ctrl-C stops)                                                  |
| `glovebox list`                                               | Registered mounts + running/stopped                                                                                          |
| `glovebox status [<dir>]`                                     | Cursor, tracked files, pending pushes, and the INV-3 deletion stack (intents with countdowns, `held` reasons, mount-suspect) |
| `glovebox unmount <dir>`                                      | Remove the binding + daemon state (never your files); refuses while running                                                  |

`--json` on any command gives structured output (default when piped).

## Manual smoke (local dev stack)

1. Start the worker: `vp run dev:worker` → `https://api.glovebox.test`
   (portless; run `portless proxy start --tld test` once per boot). Without
   `WS_AUTH_SECRET` the dev worker accepts anonymous connections — no
   `auth` step needed.
2. Build the CLI once: `vp run build` (the binary is
   `apps/cli/dist/glovebox.mjs`).
3. Mount and run a real directory:

   ```sh
   alias glovebox="node $(pwd)/apps/cli/dist/glovebox.mjs"
   glovebox mount ~/glovebox-demo --workspace demo --server https://api.glovebox.test
   glovebox run ~/glovebox-demo
   ```

4. Open the browser editor at `https://api.glovebox.test` on workspace
   `demo`, and edit files in `~/glovebox-demo` with any editor — vim, VS
   Code, `echo >>`. Both sides converge; `glovebox status ~/glovebox-demo`
   shows the live picture.
5. Delete a file and watch `status` count its tombstone down before the
   delete propagates; `rm` everything at once and watch the bulk-delete
   guard hold (`held: bulk-…`) instead of wiping the workspace.

## Notes

- Daemon state lives under `~/.glovebox/` (override: `GLOVEBOX_HOME`); the
  only in-mount artifact is the `.glovebox.json` sentinel.
- The per-mount lockfile is mandatory — a second `run` on the same mount
  refuses while the first is alive, and breaks the lock if it died.
- Watcher events are hints only; a jittered full rescan
  (`--rescan-interval <s>`, default 30 min) is the correctness backstop, so
  even with no watcher events nothing is ever missed — just slower.
- `GLOVEBOX_SYNC_OVERRIDES` (JSON env) shrinks delete-policy delays and
  intervals for tests/debugging. Not for production use.
- **TLS to `.test` domains**: browsers use the OS trust store; Node does
  not by default. `glovebox run` augments Node's CAs with the system store
  at startup (so `portless trust` is enough), and on a connection failure
  it probes the TLS handshake and prints the actual certificate error —
  fallbacks: `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem` or
  `NODE_OPTIONS=--use-system-ca`.
- `pull`/`push` are reserved for the text-push tier (M7) and not part of
  this milestone.
