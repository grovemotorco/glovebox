---
'@glovebox.md/core': patch
'@glovebox.md/sync': patch
'@glovebox.md/worker': patch
---

Recover file identity after interrupted creates and mint usable workspace API keys

- Persist pending daemon creates before the server-side registration effect, record the create-time content version, and safely reconcile response-loss restarts without confusing same-file edits with unrelated path collisions.
- Mint Settings API keys with workspace read/write access, require an active workspace, and keep administrator privileges opt-in.
