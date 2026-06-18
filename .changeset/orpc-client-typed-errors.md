---
'@glovebox.md/api': minor
'@glovebox.md/cli': minor
'@glovebox.md/worker': patch
---

oRPC client + typed error handling across the HTTP/RPC boundary

Refactor the API client to idiomatic oRPC and make contract-defined errors typed end-to-end for both the CLI and the browser (using `+GARAGE` as the reference).

- **`@glovebox.md/api` — unwrap the client, expose typed errors.** Dropped the dead "safe client" layer (`createSafeClient` + the `.then`-stripping `maskThen` proxy + the `SafeGloveboxClient` type); `createGloveboxWebClient` now returns the plain typed client with `credentials: 'include'`. Added the typed-error surface — `GloveboxClientError`/`GloveboxDefinedError`, an `isGloveboxError()` narrowing guard, and re-exports of `isDefinedError`/`ORPCError`/`safe`. Fixed the `FORBIDDEN` contract: the server threw `reason` values (`commenter_required`, `editor_required`, `admin_scope_required`) that weren't in the declared enum and so didn't match the published contract; the enum now includes them.
- **`@glovebox.md/cli` — structured errors at the top level.** The top-level error handler now routes every thrown error through `toErrorEnvelope`/`printCommandError`: a `{ error: { code, status, message, data? } }` JSON envelope when `--json` is explicitly passed, otherwise a human line with the oRPC `code`. Both go to **stderr** (stdout is the data channel, so a piped `$(glovebox auth token)` never captures the diagnostic). `whoami` narrows its `NOT_IMPLEMENTED` fallback with `isGloveboxError` instead of duck-typing `.status`/`.code`.
- **`@glovebox.md/worker` — browser adopts `safe()`.** oRPC calls in the app shell handle errors with oRPC's `safe()` result helper (`{ data, error }` / `result.isSuccess`) instead of try/catch, on the plain throwing client (no client-level proxy). `errorMessage` prefers a contract-defined error's server-authored message.
