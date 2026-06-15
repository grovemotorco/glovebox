# fs-sync — live convergence harness

Validates that the CLI filesystem mount (`glovebox run` daemon) and the
browser editor stay convergent on a **live stack**: real worker, two real
`agent-browser` sessions in one workspace, and two real daemons syncing two
real directories. Companion report (matrix, defects, gotchas):
`.docs/context/ref-fs-sync-validation-v1.md`.

## Quick start

```bash
vp run dev:worker &                      # https://api.glovebox.test
scripts/fs-sync/validate.sh warm         # dev server crashes if hit cold
scripts/fs-sync/validate.sh setup fresh  # sign in sessions a+b, NEW workspace,
                                         # empty mounts, daemons under fast timers
scripts/fs-sync/validate.sh run all      # the regression gate; nonzero on FAIL
```

Prereqs: `agent-browser`, `node`, `python3` on PATH; CLI built
(`apps/cli/dist/glovebox.mjs`, via `vp run build`).

## Commands

| Command                | What it does                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warm`                 | retried curls until the worker serves 200s                                                                                                                                                                    |
| `setup [fresh]`        | sign in both sessions (sign-up on first run), discover or (`fresh`) create the workspace, mount A + B, start both daemons. `fresh` keeps a full pass hermetic and repoints both sessions at the new workspace |
| `run <scenario…>\|all` | drive scenarios; `list` shows names/order                                                                                                                                                                     |
| `status`               | daemon status + live server tree                                                                                                                                                                              |
| `teardown`             | SIGINT daemon + unmount (state under `/tmp/glovebox-fs-sync` kept)                                                                                                                                            |

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

## Cross-target browser matrix

The gate also drives browser↔disk↔browser cells that require two browser
targets and the daemon on one live WorkspaceDO:

- `s_browser_delete_vs_edit_resurrect`: browser delete racing an unacked
  browser edit resurrects on disk, server, and the other browser.
- `s_tree_after_content_no_gap`: content and tree events share one seq cursor;
  a tree op after content does not strand later content as a gap.
- `s_open_file_rename_delete_room`: renamed open files keep their room; deleted
  open files close without dropping unacked edits.
- `s_opaque_oversize_rejected`: >1 MiB opaque submit is rejected and never
  corrupts the tree or disk.
- `s_crlf_normalize_e2e`: CRLF disk input normalizes to LF through server,
  browsers, and repaired disk bytes.
- `s_stopped_daemon_create_collision`: daemon-stopped local create racing a
  browser create at the same path keeps both suffixed survivors.
- `s_fresh_tab_midstream_repair`: a fresh browser session hydrates mid-stream
  edits from engine persistence/snapshot repair.

## Environment knobs

`GLOVEBOX_URL`, `FS_SYNC_BASE` (default `/tmp/glovebox-fs-sync`),
`FS_SYNC_MOUNT_A/B` (default `$FS_SYNC_BASE/mount-a|mount-b`),
`FS_SYNC_SESSION_A/B` (default `a`/`b`), `FS_SYNC_EMAIL`/`FS_SYNC_PASS`
(default email is run-unique: `fs-sync-<timestamp>@glovebox.test`).
`setup fresh` clears cookies and browser storage before sign-in so both
sessions share the same account/workspace; this matters because dev WebSocket
auth is off and raw socket tests can otherwise mask RPC membership mistakes.
Sync timers are pinned in `validate.sh`
(`GLOVEBOX_SYNC_OVERRIDES`: 1 s rescan, 2 s tombstone, 1 s rename window,
2 s bulk window, bulkMinCount 5) — keep `tombstoneDelayMs >=
renameCorrectionWindowMs` or the engine throws.

One harness footgun: do not use bare `wait` in a scenario. `run` starts the
daemon as a background child, so scenarios must wait only for their own captured
writer PIDs.
