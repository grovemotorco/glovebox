# fs-sync — live convergence harness

Validates that the CLI filesystem mount (`glovebox run` daemon) and the
browser editor stay convergent on a **live stack**: real worker, two real
`agent-browser` sessions in one workspace, real daemon syncing a real
directory. Companion report (matrix, defects, gotchas):
`.docs/context/ref-fs-sync-validation-v1.md`.

## Quick start

```bash
vp run dev:worker &                      # https://api.glovebox.test
scripts/fs-sync/validate.sh warm         # dev server crashes if hit cold
scripts/fs-sync/validate.sh setup fresh  # sign in sessions a+b, NEW workspace,
                                         # empty mount, daemon under fast timers
scripts/fs-sync/validate.sh run all      # the regression gate; nonzero on FAIL
```

Prereqs: `agent-browser`, `node`, `python3` on PATH; CLI built
(`apps/cli/dist/glovebox.mjs`, via `vp run build`).

## Commands

| Command                | What it does                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warm`                 | retried curls until the worker serves 200s                                                                                                                                                            |
| `setup [fresh]`        | sign in both sessions (sign-up on first run), discover or (`fresh`) create the workspace, mount, start the daemon. `fresh` keeps a full pass hermetic and repoints both sessions at the new workspace |
| `run <scenario…>\|all` | drive scenarios; `list` shows names/order                                                                                                                                                             |
| `status`               | daemon status + live server tree                                                                                                                                                                      |
| `teardown`             | SIGINT daemon + unmount (state under `/tmp/glovebox-fs-sync` kept)                                                                                                                                    |

## Layout

- `validate.sh` — orchestrator, scenario functions (`s_*`), PASS/FAIL accounting.
  Internal `__helpers` subcommands let poll loops re-evaluate fresh state.
- `lib/*.js` — in-page eval templates (rendered with the same `sed`
  substitution as `scripts/perf/measure.sh`): oRPC calls with cookie auth,
  raw wire messages over an in-page WebSocket (the browser-origin
  rename/delete/opaque path — the UI has no rename/delete affordance yet),
  reliable tree-click + editor open, typing, full-doc readback via `cmView`.

## Former defect canaries (now convergence assertions)

The three defects found by v1 of this harness are fixed
(ISSUE-0043/0044/0045) and their canaries are flipped into regression
assertions, all in `run all`:

- `s_unmount_guard` (end): remount after unmount binds disk files to
  existing fileIds by path — live tree count unchanged (was **DEFECT-2**).
- `s_binary_daemon_sync`: full daemon opaque cycle — disk binaries
  propagate, wire binaries materialize, deletes follow INV-3 (was **GAP-1**,
  `s_binary_daemon_gap`).
- `s_kind_boundary_edit`: `.md`→`.png` rename then disk edit keeps the
  bytes and syncs them as opaque content (was **DEFECT-1**,
  `s_defect_kind_boundary_loss`, which asserted the truncation-to-0-bytes).
  `s_md_opaque_rename_boundary` covers the rename-only halves in both
  directions.

## Environment knobs

`GLOVEBOX_URL`, `FS_SYNC_BASE` (default `/tmp/glovebox-fs-sync`),
`FS_SYNC_SESSION_A/B` (default `a`/`b`), `FS_SYNC_EMAIL`/`FS_SYNC_PASS`
(default `fs-sync@glovebox.test`). Sync timers are pinned in `validate.sh`
(`GLOVEBOX_SYNC_OVERRIDES`: 1 s rescan, 2 s tombstone, 1 s rename window,
2 s bulk window, bulkMinCount 5) — keep `tombstoneDelayMs >=
renameCorrectionWindowMs` or the engine throws.
