# @glovebox.md/cli

## 0.2.0

### Minor Changes

- [#12](https://github.com/grovemotorco/glovebox/pull/12) [`24009ed`](https://github.com/grovemotorco/glovebox/commit/24009edfbec66552c6e58d435aa42139a3bc1b00) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - Agent affordances in JSON mode: nextActions, error `fix`, a command tree, and NDJSON for `run`

  - **`nextActions` on success.** JSON responses now carry a `nextActions` array of runnable next steps with the context baked in: `pull` → `glovebox push <path>`, `mount` → `glovebox run <dir>`, `workspaces create` → `glovebox mount … --workspace <id>`, `auth device`/`login` → verify/list, `doctor` → `--fix`/`auth device`, `status` (stopped) → `run`. Added as a sibling key, so existing fields are untouched (`jq '.fileId'` still works).
  - **`fix` on errors.** The JSON error envelope gains an optional `fix` string (the remediation humans already see). Usage errors and the unknown-command path now throw a typed `CliError` routed through the one renderer, so they honor `--json` (previously some printed human text even under `--json`) and carry `fix` (plus `nextActions` for a "did you mean" suggestion). In human mode the `fix` prints as a dim hint.
  - **Machine-readable command tree.** `glovebox` with no args (or `--help`) in JSON mode — `glovebox --json`, or any piped/non-TTY invocation — now emits `{ name, version, defaultServer, commands[], nextActions[] }` instead of the prose help, so an agent can discover the whole surface in one call instead of scraping `--help`. Humans on a TTY still get the grouped help screen.
  - **NDJSON for `glovebox run`.** `glovebox --json run <dir>` streams newline-delimited, typed JSON events (`start`, `connected`, `log`) with the **last line always a `result`/`error` envelope** (the HATEOAS terminal line) — a clean stop is `{ "type": "result", "ok": true, … }`, a server close is `{ "type": "error", "ok": false, "fix": …, "nextActions": … }`. A tool reading only the final line gets exactly the envelope it expects. Streaming is opt-in via `--json` only (not auto-on-pipe): a supervised daemon shouldn't have its log format flip based on TTY, so humans and log scrapers keep the `[glovebox] …` lines.

- [#7](https://github.com/grovemotorco/glovebox/pull/7) [`bb116dc`](https://github.com/grovemotorco/glovebox/commit/bb116dc22046fd86a3a741a4e73f7d096339930c) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - CLI UX overhaul: default to production, fix auth/server resolution, and add discovery commands

  - **Default to production.** Commands now target `https://api.glovebox.md` by default (was the dev URL `api.glovebox.test`). Override with `--server`, the new `GLOVEBOX_SERVER_URL` env var, or a persisted default.
  - **Unified server resolution.** Precedence: `--server` → `GLOVEBOX_SERVER_URL` → `~/.glovebox/config.json` `defaultServer` → built-in default. A successful `auth device`/`auth login` records the server as the default, so later commands need no `--server` — fixing the "logged into one server, command defaults to another" breakage. `pull`/`push` now resolve credentials through the same chain (the help text previously misstated this).
  - **`auth device` works when piped.** The verification URL and code now print to stderr in every output mode (previously suppressed in JSON/non-TTY mode, which left piped device logins hanging with no code). `--workspace` is now optional.
  - **New commands:** `whoami` (identity + accessible workspaces), `workspaces list|create` (discover or create — closes the chicken-and-egg of needing a workspace ID before you can log in), `doctor` (health, resolved server, auth, and reachability), plus `auth use <url>` and `auth token`. `whoami` degrades gracefully where the server hasn't implemented `me.get` yet, falling back to listing accessible workspaces.
  - **Output & help.** Added `--human` (alias `--no-json`) to force human output even when piped; grouped `--help` with Getting-started, Configuration, and Environment sections; `--version` now reads from the package manifest (was hardcoded and stale); "did you mean" suggestions include every command.
  - **`run` diagnostics.** Warns up front when no credentials are stored for the mount's server, and surfaces an authentication hint on connection failure instead of an opaque WebSocket error.

- [#10](https://github.com/grovemotorco/glovebox/pull/10) [`5901352`](https://github.com/grovemotorco/glovebox/commit/59013521d9bcb7fb8dee2ecbf54138a5dad88f80) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - oRPC client + typed error handling across the HTTP/RPC boundary

  Refactor the API client to idiomatic oRPC and make contract-defined errors typed end-to-end for both the CLI and the browser (using `+GARAGE` as the reference).

  - **`@glovebox.md/api` — unwrap the client, expose typed errors.** Dropped the dead "safe client" layer (`createSafeClient` + the `.then`-stripping `maskThen` proxy + the `SafeGloveboxClient` type); `createGloveboxWebClient` now returns the plain typed client with `credentials: 'include'`. Added the typed-error surface — `GloveboxClientError`/`GloveboxDefinedError`, an `isGloveboxError()` narrowing guard, and re-exports of `isDefinedError`/`ORPCError`/`safe`. Fixed the `FORBIDDEN` contract: the server threw `reason` values (`commenter_required`, `editor_required`, `admin_scope_required`) that weren't in the declared enum and so didn't match the published contract; the enum now includes them.
  - **`@glovebox.md/cli` — structured errors at the top level.** The top-level error handler now routes every thrown error through `toErrorEnvelope`/`printCommandError`: a `{ error: { code, status, message, data? } }` JSON envelope when `--json` is explicitly passed, otherwise a human line with the oRPC `code`. Both go to **stderr** (stdout is the data channel, so a piped `$(glovebox auth token)` never captures the diagnostic). `whoami` narrows its `NOT_IMPLEMENTED` fallback with `isGloveboxError` instead of duck-typing `.status`/`.code`.
  - **`@glovebox.md/worker` — browser adopts `safe()`.** oRPC calls in the app shell handle errors with oRPC's `safe()` result helper (`{ data, error }` / `result.isSuccess`) instead of try/catch, on the plain throwing client (no client-level proxy). `errorMessage` prefers a contract-defined error's server-authored message.

### Patch Changes

- [#12](https://github.com/grovemotorco/glovebox/pull/12) [`1559647`](https://github.com/grovemotorco/glovebox/commit/15596477b14ee30cd132221dec2c7010acd6aefd) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - CLI help consistency, fixed `auth <sub> --help`, and `doctor --fix`

  A second UX pass against the reference CLIs (`portless`, `agent-browser`, `dotagents`).

  - **Fix `glovebox auth <sub> --help`.** `auth device|login|logout|status|use|token|mint-dev --help` previously threw `Unknown option '--help'` (the strict subcommand parsers never declared it), and `auth status --help` silently _ran_ the command. The dispatcher now intercepts `--help`/`-h` before the subcommand parser and prints focused, per-subcommand help.
  - **Consistent per-command help.** All command `--help` screens render through one shared `renderHelp()` layout — uniform section order (Usage → description → Arguments → Options → Examples), aligned columns, and an auto-appended `-h, --help` row. Every command now has copy-pasteable `Examples:`, and the root help points at `glovebox <command> --help`.
  - **Uniform usage errors.** Missing-argument paths (`mount`, `unmount`, `pull`, `push`, `auth use`, `auth mint-dev`, `workspaces create`) now print a one-line `error:` plus a `Run \`glovebox <cmd> --help\``hint and exit`1`, instead of dumping the whole help screen (or, for some, exiting `0`).
  - **`doctor` is tri-state and self-repairing.** Each check is now `ok` / `warn` (non-fatal, e.g. missing credentials) / `error` (usage-blocking), rendered with `✓ / ! / ✗`. New `glovebox doctor --fix` applies safe automatic repairs — currently clearing stale daemon lockfiles (a dead-pid lock that would otherwise refuse `unmount`). The `--json doctor` output shape changed accordingly: each check carries `status` (was `ok: boolean`) and the result gains a `fixed` count.
  - **Friendlier durations.** `glovebox run --rescan-interval` accepts `30m` / `1h` / `90s` in addition to a bare number of seconds (still backward compatible).

- [#12](https://github.com/grovemotorco/glovebox/pull/12) [`d27ac57`](https://github.com/grovemotorco/glovebox/commit/d27ac5715dc9e07b3551cf91b217e069404956cb) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - CLI UX: consolidated auth, clearer help, agent-parseable errors (breaking)

  A second UX pass benchmarked against the `garage` and `gh` CLIs.

  **Auth flow consolidated (breaking).** The `auth` surface dropped from eight subcommands to three (`login`, `logout`, `token`), modeled on `gh auth`.

  - **`auth login` is the one sign-in command.** It runs the browser device flow by default (what `auth device` did). To store a pre-minted token, pipe it on stdin with `--with-token` — e.g. `echo "$GLOVEBOX_TOKEN" | glovebox auth login --with-token`. Following `gh`, there is no `--token <value>` flag (a secret on argv leaks into `ps`/shell history) and no implicit stdin slurp. Login without `--workspace` warns that an account-scoped key can't open workspaces.
  - **`auth device` removed** — use `auth login`. **`auth use <url>` removed** — login records its server as the default; target another with `--server`, `GLOVEBOX_SERVER_URL`, or by signing in to it. **`auth status` removed** — use `whoami` (verified identity) or `doctor` (local config/reachability). Removed names print a precise migration hint.
  - `auth token`, `auth logout`, and the dev-only `auth mint-dev` are unchanged.

  **Group help defers to leaf help.** `auth --help` and `workspaces --help` now list each subcommand as `name — summary` and defer every flag, usage, and example to the leaf `<sub> --help`, so the option set lives in one place and can't drift. `workspaces list`/`create` gained real per-subcommand help.

  **Errors are agent-parseable.** Errors now follow the same `--json`/non-TTY default as data: piped or `--json` callers get the `{ error, fix, nextActions }` envelope on failure (previously they got the human `error:` line); interactive TTYs still get the human line, and `--human` forces it. Unknown subcommands return a "Did you mean …?" suggestion + `--help` fix + runnable `nextActions`, serialized as JSON. Unknown flags suggest the closest known flag (e.g. `--srever` → `--server`). A bare `fetch failed` now carries a reachability hint pointing at `glovebox doctor`.

  **Help trimmed to user-facing detail.** Audited every `--help` screen and command summary, dropping internal language — no more "daemon"/"lockfile"/"adopts the directory"/"sentinel"/"merge base"/"INV-3 deletion stack"/"holder pid", the server-resolution precedence note, or the `~/.glovebox/*.json` file table. `pull`/`push` keep their user-relevant exit codes and workflow, de-jargoned.

## 0.1.1

### Patch Changes

- [#4](https://github.com/grovemotorco/glovebox/pull/4) [`84f603a`](https://github.com/grovemotorco/glovebox/commit/84f603a36830af92b7c2838954731d011543adbf) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - Validate the automated release pipeline end-to-end — first tokenless publish over npm OIDC trusted publishing. No runtime behavior changes; this release also lands a CI-only fix giving the heavy 4 MiB CRDT round-trip tests enough timeout headroom to stay green on the GitHub Actions runner.
