# Collections and folder rules

Everything YAPA stores, memories and tasks alike, lives in a collection:

| Collection | For | Syncs |
|---|---|---|
| `project-{name}` | one project or codebase | yes |
| `customer-{name}` | one customer | yes |
| `global` | your personal, cross-cutting notes (preferences, writing style) | never |
| `private-{name}`, `local-{name}` | anything that must stay on this machine | never |

Any other name is shared too. Team-wide knowledge goes in a shared collection such as `project-cs-team`, not `global`.

## Folder rules

Which collection a session uses is decided by its folder, from three rules kept in one file on this machine, `~/.local/share/yapa/scope.json` (`YAPA_SCOPE_FILE`). It's the only place they're set, shared by the Claude Code hooks and tools, the CLI and the DSH plugin. A change applies on the next hook or tool call, with no restart.

- **Project roots:** folders whose subfolders are projects. A session in `~/work/api` (root `~/work`) uses `project-api`, or `customer-api` when that collection exists or `api` is a listed customer. The root itself, and anything outside every root, is `global`.
- **Customers:** folder names under a root that are customers.
- **Folder mappings:** a folder and everything below it uses one named collection, ahead of the roots. The longest matching folder wins. This is how a folder gets a private collection (see [Private collections](#private-collections)).

**New shared collections only come from project roots.** A write through the tools (`memory_store`, `task_create`, `journal_append`, `collection_create`, follow-ups, `yapa memory put`) that would create a new shared collection is refused unless the session's folder is at or under a project root, or is mapped to exactly that collection. The refusal suggests a `private-` name. Writes to shared collections that already exist here work from anywhere, and so does following one (`sync subscribe`). With no project roots, no new shared collection is created anywhere. The session's folder is the Claude Code project folder (`CLAUDE_PROJECT_DIR`), the DSH session's folder, or the CLI's current folder.

Edit the rules with `yapa scope`, or the `scope` tool (`yapa_scope` in DSH), which the agent uses only when you ask it to:

```
yapa scope list                          # the rules, and what they mean for this folder
yapa scope add-root ~/work               # its subfolders are projects; sessions there may create shared collections
yapa scope remove-root ~/work
yapa scope add-customer acme             # ~/work/acme uses customer-acme
yapa scope map ~/notes/acme private-acme # this folder (and below) uses private-acme
yapa scope unmap ~/notes/acme
```

**Upgrading from 1.15 or earlier:** the folder rules used to be the `project_roots`, `customers` and `collection_map` options (`YAPA_PROJECT_ROOTS`, `YAPA_CUSTOMERS`, `YAPA_COLLECTION_MAP`; `projectRoots`, `customers`, `collectionMap` in DSH). The first YAPA process after the update moves them into the file, once, while it doesn't exist yet. After that the old options are ignored, and YAPA warns on stderr until you remove them. The plugin no longer declares them, so `/plugin` can't: delete `project_roots`, `customers` and `collection_map` from `pluginConfigs["yapa@yapa"].options` in `~/.claude/settings.json` (or the `-e YAPA_*` values of a `claude mcp add` install, or the DSH settings). Check the result with `yapa scope list`.

A relative folder resolves against the current folder. In the file itself, folders must be absolute or start with `~`. If the file can't be read or isn't valid, every folder is `global` until it's fixed (YAPA says so on stderr), and `yapa scope` refuses to edit it.

`yapa scope [--cwd DIR]` prints the collection YAPA uses for a folder as JSON, `{collection, local_only, mapped}`, or with `--text` as `private-acme (local only)`. A project's own scripts should ask it rather than name a collection themselves, so the folder's collection is set in one place. A script that must stay private can refuse to run unless `local_only` is true.

## Private collections

Collections prefixed with `private-` or `local-`, and `global`, are never synced. Use these for personal notes, credentials, or anything that should stay on one machine.

A doc in a private collection never keeps a shared copy: if one of **your** docs ends up there (moved, restored, or synced by an older YAPA version), the next sync deletes its shared row. Only the same doc is removed (matched by id and creation time), never a different shared task that happens to reuse the id. A private copy of a **teammate's** doc is just a personal copy; their shared row stays. Each private doc is checked once per version, so steady-state syncs make no extra remote lookups.

**A folder with a private collection.** Project roots only produce `project-*` and `customer-*` scopes. To give a folder a private one, map it: `yapa scope map ~/work/acme private-acme`, and `yapa scope map ~/work/acme/shared-docs project-acme` for a shared subfolder. A session in a mapped folder, or anywhere below it, uses that collection; the longest matching folder wins, and mappings are checked before project roots. The hooks (session start, prompt recall, response capture, compaction capture) and the DSH plugin all follow it, and the scope line says so: ``**Scope:** `private-acme` (local only, never synced)``.

- Paths must be absolute or start with `~`. Paths are compared after resolving `..` and through symlinks (a folder reached through a link matches its real path, and the other way round), on separator boundaries (`~/work/acme` never claims `~/work/acme-old`), and case-insensitively on Windows.
- A collection name that looks meant to be private but is not (`Private-acme`, `privat-acme`, `local_acme`) is used as written and syncs, so `yapa scope map` warns and the scope line says `(shared: this name syncs ...)`. Local-only names start with lowercase `private-` or `local-`.
- A mapping beats the project roots for its whole subtree. A broad one such as `~` → `local-me` therefore overrides every project root under your home folder; put specific entries next to it (the longest path wins) for folders that should stay shared.

**The recall fence.** The prompt hook adds a few strongly relevant hits from other collections. Those extras never come from a `private-*` or `local-*` collection, so a private note does not surface while you work in a shared project. Recall in the private collection itself (its folder, or `memory_recall` with that `collection`) finds it as usual. Session start's "Waiting on you" is fenced the same way: in a shared scope, decisions, questions and tasks from private collections are only counted, not listed (the `waiting` tool still lists them).

What is not fenced: `memory_recall` with no collection (an explicit search of everything, private collections included), `global` (your personal cross-cutting scope, surfaced everywhere), and tools you call with a private collection by name. None of these reaches the sync service, but each can put private text in front of an agent working in a shared project; keep secrets out of `global`.

**Moving a shared collection into a private one.** `collection_merge from=project-acme into=private-acme` moves every doc. At the next push your own shared rows are retracted; teammates' docs stay shared in `project-acme`, and you keep a private copy. The merge also unsubscribes `project-acme` (with sync off too) and leaves a local redirect `project-acme -> private-acme` (in `global`, never synced):

- A session in the old folder scopes to `private-acme` (the scope line notes "merged from `project-acme`").
- A write that names `project-acme` (`memory_store`, `task_create`, `journal_append`, `memory_update`, `compaction_apply`, `yapa memory put`) lands in `private-acme`, and the reply says so. A CLAUDE.md or script that still names the old collection never recreates it.
- Neither the prompt hook, a pull (recovery or a leftover subscription) nor push auto-subscribe brings `project-acme` back from teammates' rows.
- `sync subscribe project-acme` follows it again and drops the redirect; so does `collection_create project-acme`.
- `global` itself can't be merged into anything: it holds the sync state and these redirects.

**The redirect is per machine.** Your other devices still follow `project-acme` until you run the same merge on each of them. Until then such a device drops its unedited copies of your docs when the retraction reaches it (your private copy exists only where you merged), and a copy it had edited is pushed back into the shared `project-acme`. The machine that merged checks each private doc once per version, so it does not retract that pushed-back row again. Merge on every device, ideally before it syncs again.
