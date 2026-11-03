---
name: statusline
description: Show YAPA's version, team remote and sync health in the Claude Code status line (synced, signed out, offline, a newer release), add it back, rename the remote, or remove it. Use when the user asks about the YAPA status line, wants to see whether sync is working, or asks to remove it.
---

# YAPA status line

The status line shows one segment under the prompt, read from YAPA's local
sync health record and its daily release check (no network calls of its own):

    yapa@v1.7.0 (v1.8.0 available) <-> acme ● synced 2m ago | project-acme

- `yapa@v<version>`: the YAPA running. `(v<new> available)` (yellow) when a
  newer release is out.
- `<-> acme`: the team remote's name, only when the option `remote_name` is
  set. `<->` is printed as is so ligature fonts draw one arrow.
- The sync state: `● synced 2m ago` (green, with `· 3 to push` when local
  writes are waiting), `● signed out since 09:12 · run: gcloud auth login`
  (red), `● offline since 09:12` / `● sync error ...` (yellow), `○ local only` /
  `○ sync status unknown` (dim).
- `(restart for v<installed>)` (yellow): this session's YAPA server is older
  than the one installed (or never reported its version); restart the
  session to load it.
- `| project-acme`: the collection this session last wrote to (a memory,
  task, journal entry or merge through YAPA). Absent until the session's
  first write.

YAPA adds it by itself at session start while the option `statusline` is on
(the default), unless the user removed it.

The session-start hook keeps the script at a stable path,
`~/.local/share/yapa/statusline.mjs` (next to the file named by
`YAPA_SYNC_HEALTH_FILE` when that is set).

## Install

Only needed when the user removed it, or turned the option `statusline` off.

1. Run `node ~/.local/share/yapa/statusline.mjs --install`.
   - If the file does not exist yet, the session started before this YAPA
     version: ask the user to restart Claude Code, then run it again.
2. Report the settings file it changed. Claude Code shows the status line
   right away, with no restart.
3. If the user already had a status line, theirs is kept: it still runs, and
   the YAPA segment is added as a line beneath it.
4. To name the remote: `echo '{"remote_name":"acme"}' | claude plugin configure
   yapa@yapa --values-stdin` (suggest `!` so it runs in this session), or
   `/plugin` → Configure options. It shows from the next sync check on.

## Remove

Run `node ~/.local/share/yapa/statusline.mjs --uninstall`. That puts back the
status line the user had before, if any, and YAPA does not add its own back.

## A newer release

When it says `(v<new> available)`: `claude plugin marketplace update yapa &&
claude plugin update yapa@yapa`, then restart Claude Code.

## When it shows a problem

- **signed out:** the user runs `gcloud auth login` (suggest `! gcloud auth login`
  so it runs in this session). Sync resumes on its own, with no restart; the
  segment turns green at the next sync check or prompt.
- **offline:** the sync service could not be reached; writes stay local and
  push when it is back.
- **sync error:** call the `sync` tool with action `status` for details.
