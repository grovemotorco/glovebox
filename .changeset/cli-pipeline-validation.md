---
'@glovebox.md/cli': patch
---

Validate the automated release pipeline end-to-end — first tokenless publish over npm OIDC trusted publishing. No runtime behavior changes; this release also lands a CI-only fix giving the heavy 4 MiB CRDT round-trip tests enough timeout headroom to stay green on the GitHub Actions runner.
