## Glovebox

Real-time file sync and collaborative markdown editing platform. Vite+ (`vp`) monorepo.

### Commands

| Task                      | Command                            |
| ------------------------- | ---------------------------------- |
| Install deps              | `vp install`                       |
| Dev (all apps, parallel)  | `vp run dev`                       |
| Dev server (worker + web) | `vp run dev:worker`                |
| Dev server (prototype)    | `vp run dev:prototype` (port 5174) |
| Build all                 | `vp run build`                     |
| Run all tests             | `vp test`                          |
| Lint + format + typecheck | `vp check`                         |
| Full verification         | `vp run verify`                    |

### Local Dev

`apps/worker` is served through portless (`.test` TLD):

| App           | dev script                     | URL                         |
| ------------- | ------------------------------ | --------------------------- |
| `apps/worker` | `portless api.glovebox vp dev` | `https://api.glovebox.test` |

Bootstrap the proxy once with:

```bash
portless proxy start --tld test
```

Useful diagnostics:

- `portless list` — show registered routes and assigned ports.
- `portless proxy stop` — stop the proxy.
- `portless proxy start --tld test --foreground` — debug proxy logs.

### Structure

- `apps/worker` — Cloudflare Worker, TanStack web app, API, and WorkspaceDO
- `apps/prototype` — UI prototype (port 5174)
- `packages/core` — Shared types and protocol constants
- `packages/sync` — Isomorphic sync primitives + Loro CRDT wrappers (V1 push/pull/checkout refactor in progress)
- `packages/loro-codemirror` — CodeMirror binding for Loro

### Rules

- **No dynamic imports** — use static `import` at module scope. No `import()`, `React.lazy()`, or dynamic WASM.
- **Test imports** — use `from 'vitest'`, not `from 'vite-plus/test'`. The catalog aliases vitest correctly; `vite-plus/test` causes duplicate instances with `test.projects`.
- **Shared packages build first** — `vp run build` handles dependency ordering. `@glovebox.md/core` must be built before apps can start.
- **Toolchain** — `vp` wraps Vite, Vitest, oxlint, and oxfmt. Root `pnpm.onlyBuiltDependencies` is required for `esbuild`, `sharp`, `workerd`.

## Cursor Cloud specific instructions

The startup update script installs the `vp` toolchain (`curl -fsSL https://vite.plus | bash`),
Node 25.9.0 (`vp env install`), and dependencies (`vp install`). Everything below is the
non-obvious runtime context that the update script intentionally does not cover.

- **`vp` on PATH** — the installer adds `vp` to `~/.bashrc`, so new interactive shells have it.
  In a non-interactive script, source it first: `. "$HOME/.vite-plus/env"`. `vp` runs Node 25.9.0
  internally via `.node-version` even though the login shell's default `node` may be older.
- **Build + migrate before running** — these are deliberately not in the update script. Run once
  per session: `vp run build` (builds `@glovebox/core` first) and
  `vp run @glovebox/worker#db:migrate:local` (applies local D1 migrations; D1 is in-process via
  miniflare, no external DB). Both are idempotent.
- **Auth is pinned to `https://api.glovebox.test`** — `apps/worker/wrangler.jsonc` hardcodes
  `BETTER_AUTH_URL`, trusted origin, and cookie domain `.glovebox.test`. The worker dev server
  MUST be reached at exactly that origin; serving it on `*.localhost` breaks sign-in (origin/cookie
  mismatch). Email/password sign-up works out of the box in dev (`BETTER_AUTH_DEV_PASSWORD`,
  `AUTH_EMAIL_MODE=none`) — no email verification.
- **portless `.test` startup (the main gotcha)** — `vp run dev:worker` serves through portless.
  Two non-obvious requirements:
  1. The proxy needs port 443, so portless re-execs itself with `sudo`. The elevated daemon then
     defaults its state dir to `/root/.portless` while the (unprivileged) dev server reads
     `~/.portless` — they end up with different `routes.json` and every request 404s. Fix: pin the
     state dir when starting the proxy so both share it:
     `PORTLESS_STATE_DIR="$HOME/.portless" apps/worker/node_modules/.bin/portless proxy start --tld test`.
  2. `.test` does not auto-resolve (unlike `.localhost`). Add a hosts entry (does not persist across
     VM restarts): `echo "127.0.0.1 api.glovebox.test" | sudo tee -a /etc/hosts`. Then start the dev
     server with `PORTLESS_TLD=test vp run dev:worker` (or `echo test > ~/.portless/proxy.tld`) so it
     registers under `.test`. Verify with `curl -k https://api.glovebox.test/openapi.json` (expect 200).
- **Tests** — `vp test`: the single heavy test `round-trips a 4 MiB opaque submit` in
  `packages/sync` has a hardcoded 5s timeout and can exceed it on slower VMs (it does real
  WASM/CRDT work). It is a perf-timeout, not a real failure — confirm with
  `vp test --project @glovebox/sync --testTimeout=30000 -t "round-trips a 4 MiB opaque submit"`.
- **Lint** — `vp check` currently reports pre-existing violations in `scripts/perf/lib/*`,
  `scripts/fs-sync/lib/*`, and a couple `apps/worker/tests/*` files (unrelated to app source).
