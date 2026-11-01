---
name: statusline
description: Show YAPA team-sync health in the Claude Code status line (synced, signed out, offline), or remove it. Use when the user asks for the YAPA status line, wants to see whether sync is working, or asks to remove it.
---

# YAPA status line

The status line shows one segment under the prompt, read from YAPA's local
sync health record (no network calls):

- `yapa ● synced 2m ago` (green), with `· 3 to push` when local writes are waiting
- `yapa ● signed out since 09:12 · run: gcloud auth login` (red)
- `yapa ● offline since 09:12` / `yapa ● sync error ...` (yellow)
- `yapa ○ local only` / `yapa ○ sync status unknown` (dim)

The session-start hook keeps the script at a stable path,
`~/.local/share/yapa/statusline.mjs` (next to the file named by
`YAPA_SYNC_HEALTH_FILE` when that is set).

## Install

1. Run `node ~/.local/share/yapa/statusline.mjs --install`.
   - If the file does not exist yet, the session started before this YAPA
     version: ask the user to restart Claude Code, then run it again.
2. Report the settings file it changed. Claude Code shows the status line
   right away, with no restart.
3. If the user already had a status line, theirs is kept: it still runs, and
   the YAPA segment is added as a line beneath it.
4. Mention that the plugin option "Status line name" (`status_label`) changes
   the name shown in place of `yapa` (for example the team's remote), from the
   next sync check on.

## Remove

Run `node ~/.local/share/yapa/statusline.mjs --uninstall`. That puts back the
status line the user had before, if any.

## When it shows a problem

- **signed out:** the user runs `gcloud auth login` (suggest `! gcloud auth login`
  so it runs in this session). Sync resumes on its own, with no restart; the
  segment turns green at the next sync check or prompt.
- **offline:** the sync service could not be reached; writes stay local and
  push when it is back.
- **sync error:** call the `sync` tool with action `status` for details.
