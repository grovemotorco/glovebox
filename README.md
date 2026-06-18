# glovebox

Real-time file sync and collaborative markdown editing. A local directory stays
in sync with a shared workspace, and the same documents are editable live in the
browser.

The platform is a Vite+ monorepo: a Cloudflare Worker (API, WorkspaceDO, and
TanStack web app), a local file-sync CLI, and shared sync/API packages. See
[`architecture.md`](./docs/architecture.md) for the system design.

## Using glovebox

There are three ways to work with a workspace:

- **Browser** — sign in and edit documents live in the web app.
- **CLI** — sync a local directory to a workspace (`glovebox mount` + `run`).
- **API** — a typed SDK or REST for programmatic and agent access.

> Inside this repo the CLI runs as `vp run @glovebox.md/cli -- <args>`; an installed
> build exposes it as the `glovebox` binary. Examples below use `glovebox`.

### Authentication

- Browser users authenticate through **Better Auth** sessions.
- CLI and agent callers use **`gbx_` API keys**.
- Workspace WebSockets need a short-lived **socket token**, which the CLI mints
  from the stored API key before connecting.

Get an API key with a browser device login:

```bash
glovebox auth device \
  --workspace ws_123 \
  --scope workspace:read \
  --scope workspace:write
```

It prints a verification URL and user code, polls until you approve in the
browser, then stores a scoped `gbx_` key in `~/.glovebox/auth.json` (owner-only).

Other auth helpers:

```bash
glovebox auth status                  # list stored tokens (decoded, not verified)
glovebox auth logout --server <url>   # forget a token
glovebox auth mint-dev --secret "$WS_AUTH_SECRET" --workspace ws_123 --save
```

`mint-dev` is for local Worker development only, against a known `WS_AUTH_SECRET`.

### Sync a directory

```bash
glovebox mount ./notes --workspace ws_123   # bind a directory (no process starts)
glovebox run ./notes                        # run the sync daemon in the foreground
glovebox status ./notes                      # show sync status (no daemon required)
glovebox list                                # list mounts and daemon state
glovebox unmount ./notes                     # remove the binding (keeps your files)
```

The default server is `https://api.glovebox.test`; pass `--server <url>` to
target another.

### SDK

```ts
import { createGloveboxCliClient } from '@glovebox.md/api'

const client = createGloveboxCliClient({
  baseUrl: 'https://api.glovebox.test',
  apiKey: process.env.GLOVEBOX_API_KEY!,
})

const { workspaces } = await client.workspaces.list()
const workspaceId = workspaces[0]!.id

const { document, text } = await client.workspaces.readText({
  workspaceId,
  path: 'notes.md',
})

const comment = await client.comments.create({
  workspaceId,
  fileId: document.id,
  baseVersionId: document.currentVersionId,
  range: { start: 0, end: Math.min(5, text.length) },
  body: 'Check this opening phrase.',
})

const suggestion = await client.suggestions.propose({
  workspaceId,
  fileId: document.id,
  baseVersionId: document.currentVersionId,
  range: { start: 0, end: Math.min(5, text.length) },
  replacementText: 'Hello',
})

await client.suggestions.accept({ workspaceId, suggestionId: suggestion.id })
await client.comments.resolve({ workspaceId, threadId: comment.id })
```

### REST

The Worker exposes:

- Better Auth — `/api/auth/*`
- ORPC RPC — `/api/rpc/*`
- REST / OpenAPI — `/api/v1/*`, with `/openapi.json` and interactive `/docs`
- Workspace WebSockets — `/ws/:workspaceId`

```bash
curl -sS https://api.glovebox.test/api/v1/workspaces/list \
  -H "Authorization: Bearer $GLOVEBOX_API_KEY"

curl -sS https://api.glovebox.test/api/v1/comments/create \
  -H "Authorization: Bearer $GLOVEBOX_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "workspaceId":"ws_123",
    "fileId":"file_123",
    "baseVersionId":"ver_123",
    "range":{"start":0,"end":5},
    "body":"Check this opening phrase."
  }'
```

## Development

```bash
vp install
vp run build      # shared packages build first (ordering is handled)
vp test
vp check          # format, lint, typecheck
vp run verify     # check + test + build
```

| Task                   | Command                |
| ---------------------- | ---------------------- |
| Dev all apps           | `vp run dev`           |
| Dev worker/API/web app | `vp run dev:worker`    |
| Dev prototype          | `vp run dev:prototype` |

Local worker/web dev is served through portless:

```bash
portless proxy start --tld test
vp run dev:worker   # https://api.glovebox.test
```

### Structure

| Package                        | Path                       | Purpose                                      |
| ------------------------------ | -------------------------- | -------------------------------------------- |
| `@glovebox.md/worker`          | `apps/worker`              | Worker dispatcher, Better Auth, ORPC, DO, UI |
| `@glovebox.md/cli`             | `apps/cli`                 | Local file-sync CLI daemon                   |
| `@glovebox.md/prototype`       | `apps/prototype`           | Product UI prototype                         |
| `@glovebox.md/api`             | `packages/api`             | ORPC contract, typed clients, OpenAPI inputs |
| `@glovebox.md/sync`            | `packages/sync`            | Sync protocol, daemon/client/server core     |
| `@glovebox.md/core`            | `packages/core`            | Shared types and protocol constants          |
| `@glovebox.md/loro-codemirror` | `packages/loro-codemirror` | CodeMirror binding for Loro CRDTs            |
| `@glovebox.md/dofs`            | `packages/dofs`            | Durable Object filesystem (vendored)         |
| `@glovebox.md/harness`         | `packages/harness`         | Shared test harness                          |

### Database and email

`apps/worker/wrangler.jsonc` defines the D1 `DB` binding and the Cloudflare
Email Service `EMAIL` binding. Tests use fake/no-email modes and never send real
email.

```bash
vp run @glovebox.md/worker#db:generate
vp run @glovebox.md/worker#db:migrate:local
vp run @glovebox.md/worker#db:migrate:remote
```

Secrets such as `BETTER_AUTH_SECRET` and `WS_AUTH_SECRET` are configured as
Worker secrets outside source control.

## Deployment & Publishing

Glovebox runs as one Worker on two custom domains, with the CLI published to npm.

| Artifact           | Where                                              | How                                                                                            |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `glovebox-worker`  | Cloudflare → `api.glovebox.md` + `app.glovebox.md` | `.github/workflows/deploy.yml` (manual) or `pnpm --filter @glovebox.md/worker run deploy`      |
| `@glovebox.md/cli` | npm (public)                                       | Changesets → `.github/workflows/{release,publish}.yml` (OIDC); seeded once with `pnpm publish` |

Production is the **top-level** `apps/worker/wrangler.jsonc`; local dev uses its `env.dev`
block (selected by `CLOUDFLARE_ENV=dev` in the worker `dev` script). The browser client is
same-origin, so each domain is a complete origin.

- **Deploy** — Actions → **deploy** (choose `ref` + whether to apply D1 migrations); it builds, applies remote migrations, then deploys. Locally: `cd apps/worker && pnpm run deploy`. Rollback: `npx wrangler rollback <version-id>` from `apps/worker`.
- **Publish the CLI** — Changesets-managed and OIDC-published (no `NPM_TOKEN`); only `@glovebox.md/cli` is published, the other workspace packages are private/bundled. In your PR run `pnpm changeset`; merging to `main` opens a **Version Packages** PR (`release.yml`); merging that bumps the version and writes the changelog, then once `verify` passes `publish.yml` builds the self-contained bundle (`vp pack`) and publishes via npm trusted publishing (idempotent — skips versions already on the registry; smoke-tests `glovebox --help`).

First-time setup: add `glovebox.md` as a Cloudflare zone; `wrangler d1 create glovebox-db` →
real `database_id` in `wrangler.jsonc`, then apply migrations `--remote`; set the
`BETTER_AUTH_SECRET` / `WS_AUTH_SECRET` Worker secrets; onboard `glovebox.md` in Cloudflare
**Email Sending → Onboard Domain** (prod uses `AUTH_EMAIL_MODE: "send"`). CI needs the
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets (and optionally `RELEASE_PAT`, so the
Version Packages PR triggers `verify`). Custom domains auto-provision DNS + TLS on first deploy.

For npm publishing the `glovebox.md` org already exists. Because OIDC can only be configured on a
package that already exists, **seed the CLI once** from your machine (you're an org member;
`auth-and-writes` 2FA prompts for an OTP), then wire up the trusted publisher:

```bash
cd apps/cli
pnpm publish --dry-run --no-git-checks         # sanity: tarball = dist/glovebox.mjs + loro wasm, no deps
pnpm publish --access public --no-git-checks   # real seed publish (enter OTP)
```

Then on npmjs.com → `@glovebox.md/cli` → **Settings → Publishing access → Trusted Publisher → GitHub
Actions**, add repository `grovemotorco/glovebox` + workflow `publish.yml`. After that, releases publish
tokenlessly via OIDC — no `NPM_TOKEN` anywhere.
