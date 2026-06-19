---
'@glovebox.md/cli': patch
---

CLI UX: consolidated auth, clearer help, agent-parseable errors (breaking)

A second UX pass benchmarked against the `garage` and `gh` CLIs.

**Auth flow consolidated (breaking).** The `auth` surface dropped from eight subcommands to three (`login`, `logout`, `token`), modeled on `gh auth`.

- **`auth login` is the one sign-in command.** It runs the browser device flow by default (what `auth device` did). To store a pre-minted token, pipe it on stdin with `--with-token` — e.g. `echo "$GLOVEBOX_TOKEN" | glovebox auth login --with-token`. Following `gh`, there is no `--token <value>` flag (a secret on argv leaks into `ps`/shell history) and no implicit stdin slurp. Login without `--workspace` warns that an account-scoped key can't open workspaces.
- **`auth device` removed** — use `auth login`. **`auth use <url>` removed** — login records its server as the default; target another with `--server`, `GLOVEBOX_SERVER_URL`, or by signing in to it. **`auth status` removed** — use `whoami` (verified identity) or `doctor` (local config/reachability). Removed names print a precise migration hint.
- `auth token`, `auth logout`, and the dev-only `auth mint-dev` are unchanged.

**Group help defers to leaf help.** `auth --help` and `workspaces --help` now list each subcommand as `name — summary` and defer every flag, usage, and example to the leaf `<sub> --help`, so the option set lives in one place and can't drift. `workspaces list`/`create` gained real per-subcommand help.

**Errors are agent-parseable.** Errors now follow the same `--json`/non-TTY default as data: piped or `--json` callers get the `{ error, fix, nextActions }` envelope on failure (previously they got the human `error:` line); interactive TTYs still get the human line, and `--human` forces it. Unknown subcommands return a "Did you mean …?" suggestion + `--help` fix + runnable `nextActions`, serialized as JSON. Unknown flags suggest the closest known flag (e.g. `--srever` → `--server`). A bare `fetch failed` now carries a reachability hint pointing at `glovebox doctor`.

**Help trimmed to user-facing detail.** Audited every `--help` screen and command summary, dropping internal language — no more "daemon"/"lockfile"/"adopts the directory"/"sentinel"/"merge base"/"INV-3 deletion stack"/"holder pid", the server-resolution precedence note, or the `~/.glovebox/*.json` file table. `pull`/`push` keep their user-relevant exit codes and workflow, de-jargoned.
