---
'@glovebox.md/worker': patch
---

Implement `me.*` and fix account-scoped API-key workspace access

Three server-side defects surfaced while smoke-testing the CLI against the deployed API:

- **`me.get` / `me.sessions` / `me.setActiveWorkspace` were `501 NOT_IMPLEMENTED`.** Now implemented: `me.get` returns the principal, accessible workspaces (reusing the `workspaces.list` membership query), and the active workspace (surfaced only when it's in the caller's visible set); `me.sessions` lists the user's persisted sessions; `me.setActiveWorkspace` persists to `user.activeWorkspaceId` and is gated by workspace access. The CLI's `whoami` auto-upgrades from its `workspaces.list` fallback now that `me.get` works.
- **Account-scoped API keys couldn't see or reach their own workspaces.** An empty `apiKey.workspaceIds` was treated as "zero workspaces" instead of "no per-workspace restriction", so a key minted without `--workspace` got an empty `workspaces.list` and `403`s on every per-workspace op — even for a workspace it just created. Empty scope now means "all of the principal's own workspaces", with the `workspaceMember` join as the real gate. A key scoped to `[idA]` still `403`s on `idB`; browser sessions stay unrestricted.
- **Owner `workspaces.delete` / `update` via API key returned an opaque `403`.** The admin-scope requirement is intentional (a read/write key shouldn't delete the workspace) but is now explicit: reason `admin_scope_required` and a message pointing to `auth device --scope workspace:admin`. Browser-session owners are unaffected.
