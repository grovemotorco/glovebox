# Glovebox agent guide

How agents edit Glovebox workspace documents with `glovebox pull` / `glovebox push` —
the stateless text-push tier. You hold no CRDT state: you pull working text, edit it
as a plain file, and push it back; the **server** performs the three-way merge inside
the document's CRDT, so concurrent human edits always survive. Everything here is
verified against the CLI source (`apps/cli/src/commands/{pull,push}.ts`) and the
server merge (`packages/sync/src/server/workspace-server.ts#pushText`).

## Setup

```sh
# one-time: store a gbx_ API key for the server (browser device flow)
glovebox auth device --workspace <workspaceId>

# or, on a dev stack without auth provisioned:
glovebox auth mint-dev --workspace <workspaceId>
```

Credentials live in `~/.glovebox/auth.json` (mode 600), keyed by server URL.
Pushes attribute to the API key's principal in version history and the
workspace event log.

## Command table

| Command                                             | Does                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `glovebox pull <path> --workspace <id>`             | fetch working text; write it at its workspace-relative path; record the merge base |
| `glovebox pull --file-id <fileId> --workspace <id>` | same, addressed by file ID                                                         |
| `glovebox push <path> [--force]`                    | merge your local edits into the live document                                      |
| `glovebox --json pull/push …`                       | structured output (default when stdout is not a TTY)                               |

## Workspace anatomy

```
work/                        # wherever you ran `glovebox pull`
  .glovebox/
    <fileId>/meta.json       # {workspaceId, fileId, path, serverUrl, baseHashHex, …}
    <fileId>/base.md         # the three-way merge base — NEVER edit this
  docs/note.md               # the working text, at its workspace-relative path
```

**Never edit anything under `.glovebox/`** — `base.md` is the merge base;
corrupting it corrupts every future push of that file.

## The merge model

1. **Pull** writes the document text plus `base.md` and its sha-256
   (`baseHashHex`) — a record of what the server looked like when you last
   converged. The server also caches that base content-addressed by hash.
2. **Push** sends `{newText, baseHashHex}`. If the server's base cache has
   expired, the CLI automatically re-sends `base.md` and resumes — you never
   handle this case yourself.
3. The server computes `diff(base, yourText)` — only what YOU changed — and
   fuzzy-patches it onto the **current** document text, landing the result as
   minimal CRDT ops under a server-owned peer ID in one transaction. Edits
   humans made since your pull are untouched, and live editors see your push
   instantly.
4. Hunks that no longer apply (a human rewrote the same region) are returned
   verbatim, never silently dropped → exit 2.
5. **Degenerate guard**: if the document drifted from your base AND your diff
   deletes more than 60% of it, the push is refused (exit 3) — that shape
   usually means a stale agent about to flatten human work.
6. On a clean merge the local file AND the base advance to the merged result,
   so you can keep editing and push again without re-pulling.

All text is normalized to `\n` line endings at every boundary; writing CRLF is
safe. Retries are safe: each push presents a deterministic idempotency key, so
a re-run of the identical push replays the recorded result instead of applying
twice.

## Exit codes and recovery

| Exit | Meaning                                                                        | What to do                                                                                                     |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `0`  | clean merge (including drifted merges where every hunk placed)                 | nothing — local file and base now match the server                                                             |
| `2`  | some hunks could not be placed; printed verbatim; **base unchanged**           | `glovebox pull` the file fresh, reconcile your change against the new text, push again                         |
| `3`  | degenerate-rewrite refusal (drifted base + >60% deletion)                      | `glovebox pull` and re-derive your edit; pass `--force` ONLY when flattening the document is the actual intent |
| `1`  | anything else (no credentials, unknown file, no merge base, oversize, network) | read the error; usually `glovebox auth …` or `glovebox pull` first                                             |

Recovery is always pull-shaped: nothing in this tier can lose server-side
text. A refused or partial push changes nothing remotely beyond the hunks
that did place, and your base file only advances on exit 0.

## Etiquette

- Pull immediately before editing; push promptly after. Long-held bases make
  drift (and exit 2/3) more likely.
- Keep pushes focused. One logical change per push gives humans clean
  version-history entries (each push is a named version row).
- Do not bypass the guard with `--force` to "make it work" — exit 3 nearly
  always means your base is stale, not that the guard is wrong.
- The sidecar daemon (`glovebox run`) is a different client class for live
  mirroring; don't run both over the same directory.
