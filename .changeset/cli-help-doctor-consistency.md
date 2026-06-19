---
'@glovebox.md/cli': patch
---

CLI help consistency, fixed `auth <sub> --help`, and `doctor --fix`

A second UX pass against the reference CLIs (`portless`, `agent-browser`, `dotagents`).

- **Fix `glovebox auth <sub> --help`.** `auth device|login|logout|status|use|token|mint-dev --help` previously threw `Unknown option '--help'` (the strict subcommand parsers never declared it), and `auth status --help` silently _ran_ the command. The dispatcher now intercepts `--help`/`-h` before the subcommand parser and prints focused, per-subcommand help.
- **Consistent per-command help.** All command `--help` screens render through one shared `renderHelp()` layout — uniform section order (Usage → description → Arguments → Options → Examples), aligned columns, and an auto-appended `-h, --help` row. Every command now has copy-pasteable `Examples:`, and the root help points at `glovebox <command> --help`.
- **Uniform usage errors.** Missing-argument paths (`mount`, `unmount`, `pull`, `push`, `auth use`, `auth mint-dev`, `workspaces create`) now print a one-line `error:` plus a `Run \`glovebox <cmd> --help\``hint and exit`1`, instead of dumping the whole help screen (or, for some, exiting `0`).
- **`doctor` is tri-state and self-repairing.** Each check is now `ok` / `warn` (non-fatal, e.g. missing credentials) / `error` (usage-blocking), rendered with `✓ / ! / ✗`. New `glovebox doctor --fix` applies safe automatic repairs — currently clearing stale daemon lockfiles (a dead-pid lock that would otherwise refuse `unmount`). The `--json doctor` output shape changed accordingly: each check carries `status` (was `ok: boolean`) and the result gains a `fixed` count.
- **Friendlier durations.** `glovebox run --rescan-interval` accepts `30m` / `1h` / `90s` in addition to a bare number of seconds (still backward compatible).
