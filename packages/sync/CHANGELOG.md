# @glovebox.md/sync

## 0.0.1

### Patch Changes

- [#16](https://github.com/grovemotorco/glovebox/pull/16) [`a6fb62f`](https://github.com/grovemotorco/glovebox/commit/a6fb62f9eec41f4af9a8cd9cfb801a5acf82b279) Thanks [@marwanhilmi](https://github.com/marwanhilmi)! - Recover file identity after interrupted creates and mint usable workspace API keys

  - Persist pending daemon creates before the server-side registration effect, record the create-time content version, and safely reconcile response-loss restarts without confusing same-file edits with unrelated path collisions.
  - Mint Settings API keys with workspace read/write access, require an active workspace, and keep administrator privileges opt-in.

- Updated dependencies [[`a6fb62f`](https://github.com/grovemotorco/glovebox/commit/a6fb62f9eec41f4af9a8cd9cfb801a5acf82b279)]:
  - @glovebox.md/core@0.0.1
