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
- **Shared packages build first** — `vp run build` handles dependency ordering. `@glovebox/core` must be built before apps can start.
- **Toolchain** — `vp` wraps Vite, Vitest, oxlint, and oxfmt. Root `pnpm.onlyBuiltDependencies` is required for `esbuild`, `sharp`, `workerd`.
