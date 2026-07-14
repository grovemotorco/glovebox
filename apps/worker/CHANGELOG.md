# @glovebox.md/worker

## 0.0.1

### Patch Changes

- [#10](https://github.com/grovemotorco/glovebox/pull/10) [`5901352`](https://github.com/grovemotorco/glovebox/commit/59013521d9bcb7fb8dee2ecbf54138a5dad88f80) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - oRPC client + typed error handling across the HTTP/RPC boundary

  Refactor the API client to idiomatic oRPC and make contract-defined errors typed end-to-end for both the CLI and the browser (using `+GARAGE` as the reference).

  - **`@glovebox.md/api` — unwrap the client, expose typed errors.** Dropped the dead "safe client" layer (`createSafeClient` + the `.then`-stripping `maskThen` proxy + the `SafeGloveboxClient` type); `createGloveboxWebClient` now returns the plain typed client with `credentials: 'include'`. Added the typed-error surface — `GloveboxClientError`/`GloveboxDefinedError`, an `isGloveboxError()` narrowing guard, and re-exports of `isDefinedError`/`ORPCError`/`safe`. Fixed the `FORBIDDEN` contract: the server threw `reason` values (`commenter_required`, `editor_required`, `admin_scope_required`) that weren't in the declared enum and so didn't match the published contract; the enum now includes them.
  - **`@glovebox.md/cli` — structured errors at the top level.** The top-level error handler now routes every thrown error through `toErrorEnvelope`/`printCommandError`: a `{ error: { code, status, message, data? } }` JSON envelope when `--json` is explicitly passed, otherwise a human line with the oRPC `code`. Both go to **stderr** (stdout is the data channel, so a piped `$(glovebox auth token)` never captures the diagnostic). `whoami` narrows its `NOT_IMPLEMENTED` fallback with `isGloveboxError` instead of duck-typing `.status`/`.code`.
  - **`@glovebox.md/worker` — browser adopts `safe()`.** oRPC calls in the app shell handle errors with oRPC's `safe()` result helper (`{ data, error }` / `result.isSuccess`) instead of try/catch, on the plain throwing client (no client-level proxy). `errorMessage` prefers a contract-defined error's server-authored message.

- [#16](https://github.com/grovemotorco/glovebox/pull/16) [`a6fb62f`](https://github.com/grovemotorco/glovebox/commit/a6fb62f9eec41f4af9a8cd9cfb801a5acf82b279) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - Recover file identity after interrupted creates and mint usable workspace API keys

  - Persist pending daemon creates before the server-side registration effect, record the create-time content version, and safely reconcile response-loss restarts without confusing same-file edits with unrelated path collisions.
  - Mint Settings API keys with workspace read/write access, require an active workspace, and keep administrator privileges opt-in.

- [#9](https://github.com/grovemotorco/glovebox/pull/9) [`4f95cef`](https://github.com/grovemotorco/glovebox/commit/4f95cefbf865810394da041c08174af9e44f7f28) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - Implement `me.*` and fix account-scoped API-key workspace access

  Three server-side defects surfaced while smoke-testing the CLI against the deployed API:

  - **`me.get` / `me.sessions` / `me.setActiveWorkspace` were `501 NOT_IMPLEMENTED`.** Now implemented: `me.get` returns the principal, accessible workspaces (reusing the `workspaces.list` membership query), and the active workspace (surfaced only when it's in the caller's visible set); `me.sessions` lists the user's persisted sessions; `me.setActiveWorkspace` persists to `user.activeWorkspaceId` and is gated by workspace access. The CLI's `whoami` auto-upgrades from its `workspaces.list` fallback now that `me.get` works.
  - **Account-scoped API keys couldn't see or reach their own workspaces.** An empty `apiKey.workspaceIds` was treated as "zero workspaces" instead of "no per-workspace restriction", so a key minted without `--workspace` got an empty `workspaces.list` and `403`s on every per-workspace op — even for a workspace it just created. Empty scope now means "all of the principal's own workspaces", with the `workspaceMember` join as the real gate. A key scoped to `[idA]` still `403`s on `idB`; browser sessions stay unrestricted.
  - **Owner `workspaces.delete` / `update` via API key returned an opaque `403`.** The admin-scope requirement is intentional (a read/write key shouldn't delete the workspace) but is now explicit: reason `admin_scope_required` and a message pointing to `auth device --scope workspace:admin`. Browser-session owners are unaffected.

- Updated dependencies [[`5901352`](https://github.com/grovemotorco/glovebox/commit/59013521d9bcb7fb8dee2ecbf54138a5dad88f80), [`a6fb62f`](https://github.com/grovemotorco/glovebox/commit/a6fb62f9eec41f4af9a8cd9cfb801a5acf82b279)]:
  - @glovebox.md/api@0.1.0
  - @glovebox.md/core@0.0.1
  - @glovebox.md/sync@0.0.1
