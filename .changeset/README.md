# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets) — the tool
that versions and publishes the workspace's public packages. See the
[intro docs](https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md)
for the basics.

## Release flow

Only **`@glovebox.md/cli`** is published to npm; everything else in the workspace is private/bundled,
so the CLI is the only package changesets tracks.

1. In your PR, run `pnpm changeset` and describe the change (pick the semver bump).
2. Merge to `main` → `.github/workflows/release.yml` opens/updates a **Version Packages** PR that
   bumps `apps/cli/package.json` and writes its `CHANGELOG.md`.
3. Merge the Version Packages PR → `verify` passes → `.github/workflows/publish.yml` publishes the
   CLI to npm via **OIDC trusted publishing** (no token).

See `DEPLOYMENT.md` for the one-time seed + trusted-publisher setup.
