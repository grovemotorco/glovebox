---
'@glovebox.md/cli': minor
---

CLI UX overhaul: default to production, fix auth/server resolution, and add discovery commands

- **Default to production.** Commands now target `https://api.glovebox.md` by default (was the dev URL `api.glovebox.test`). Override with `--server`, the new `GLOVEBOX_SERVER_URL` env var, or a persisted default.
- **Unified server resolution.** Precedence: `--server` → `GLOVEBOX_SERVER_URL` → `~/.glovebox/config.json` `defaultServer` → built-in default. A successful `auth device`/`auth login` records the server as the default, so later commands need no `--server` — fixing the "logged into one server, command defaults to another" breakage. `pull`/`push` now resolve credentials through the same chain (the help text previously misstated this).
- **`auth device` works when piped.** The verification URL and code now print to stderr in every output mode (previously suppressed in JSON/non-TTY mode, which left piped device logins hanging with no code). `--workspace` is now optional.
- **New commands:** `whoami` (identity + accessible workspaces), `workspaces list|create` (discover or create — closes the chicken-and-egg of needing a workspace ID before you can log in), `doctor` (health, resolved server, auth, and reachability), plus `auth use <url>` and `auth token`. `whoami` degrades gracefully where the server hasn't implemented `me.get` yet, falling back to listing accessible workspaces.
- **Output & help.** Added `--human` (alias `--no-json`) to force human output even when piped; grouped `--help` with Getting-started, Configuration, and Environment sections; `--version` now reads from the package manifest (was hardcoded and stale); "did you mean" suggestions include every command.
- **`run` diagnostics.** Warns up front when no credentials are stored for the mount's server, and surfaces an authentication hint on connection failure instead of an opaque WebSocket error.
