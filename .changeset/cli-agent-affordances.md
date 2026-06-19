---
'@glovebox.md/cli': minor
---

Agent affordances in JSON mode: nextActions, error `fix`, a command tree, and NDJSON for `run`

- **`nextActions` on success.** JSON responses now carry a `nextActions` array of runnable next steps with the context baked in: `pull` → `glovebox push <path>`, `mount` → `glovebox run <dir>`, `workspaces create` → `glovebox mount … --workspace <id>`, `auth device`/`login` → verify/list, `doctor` → `--fix`/`auth device`, `status` (stopped) → `run`. Added as a sibling key, so existing fields are untouched (`jq '.fileId'` still works).
- **`fix` on errors.** The JSON error envelope gains an optional `fix` string (the remediation humans already see). Usage errors and the unknown-command path now throw a typed `CliError` routed through the one renderer, so they honor `--json` (previously some printed human text even under `--json`) and carry `fix` (plus `nextActions` for a "did you mean" suggestion). In human mode the `fix` prints as a dim hint.
- **Machine-readable command tree.** `glovebox` with no args (or `--help`) in JSON mode — `glovebox --json`, or any piped/non-TTY invocation — now emits `{ name, version, defaultServer, commands[], nextActions[] }` instead of the prose help, so an agent can discover the whole surface in one call instead of scraping `--help`. Humans on a TTY still get the grouped help screen.
- **NDJSON for `glovebox run`.** `glovebox --json run <dir>` streams newline-delimited, typed JSON events (`start`, `connected`, `log`) with the **last line always a `result`/`error` envelope** (the HATEOAS terminal line) — a clean stop is `{ "type": "result", "ok": true, … }`, a server close is `{ "type": "error", "ok": false, "fix": …, "nextActions": … }`. A tool reading only the final line gets exactly the envelope it expects. Streaming is opt-in via `--json` only (not auto-on-pipe): a supervised daemon shouldn't have its log format flip based on TTY, so humans and log scrapers keep the `[glovebox] …` lines.
