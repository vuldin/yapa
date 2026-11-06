# Changelog

## Unreleased

**Upgrading:** `collection_delete` now removes a shared collection from this machine only, unless you pass `scope: "everyone"`.

### Features
- **Deleting a collection no longer deletes it for the team by default.** `collection_delete` (and DSH `yapa_collection_delete`) takes `scope`:
  - `local` (the default): a shared collection is removed from this machine only. Your unpushed documents in it are pushed first, and the delete is refused if any can't be. Teammates and the sync service keep everything, and this machine stops following it (no backfill, pull, recovery or push auto-subscribe) until `sync subscribe` or `collection_create`.
  - `everyone`: needs `confirm: "<name>"`, and deletes your documents in it from the sync service and from every teammate's machine (as `collection_delete` did before). Teammates' own documents stay shared.
  - The reply says exactly what was removed where.

### Fixes
- **Deleting a collection that has no other copy needs `confirm`.** A non-empty local-only collection (`private-*`, `local-*`, `global`), or any collection while sync is off, was deleted without confirmation, and that is permanent.
- A claim in a local-only collection says "this machine: your other sessions see it as yours" instead of "teammates see it as yours".

### Service
- **Deletes are soft: the owner can list, restore and purge deleted rows.** `documents:batchDelete` now moves a row into `deleted_documents` instead of dropping it; its owner can list their deleted rows (`GET /v1/me/deleted`), restore one (`POST /v1/documents:restore`, back as an update with a new `updated_at`; `id_taken` when the id is live again) or remove an id for good (`POST /v1/documents:purge`, after which any upsert of it is refused with the permanent item error `purged`). Deleted rows stay restorable for `YAPA_DELETED_RETENTION_DAYS` (default 30). Pull deletion entries now carry `reason` (`delete` or `retract`) and `purged`; older clients ignore them. The client library has the matching optional `listDeleted`/`restore`/`purge` backend methods; an older service answers them with `UnsupportedByRemoteError`. See `docs/sync-api.md` section 5, "Soft delete".
- **Deploy order:** apply `infra/cloudsql/sql/07_soft_delete.sql` (schema v4, by hand with psql, see `infra/cloudsql/README.md`) BEFORE deploying a `yapa-service` or `yapa-mcp` built from this release: the new pull reads the new `deletions` columns. Clients must not rely on restore or purge until both are done.

## 1.10.3 (2026-11-03)

The status line always says which collection a session writes to and whether it stays on this machine, and `yapa scope` tells a project's scripts which collection their folder uses.

**Upgrading:** update the plugin and restart Claude Code. Nothing to deploy.

### Features
- **The status line always says where a session writes, and whether that is private.** Before a session's first write it shows the collection its hooks detected for the folder (`collection_map`, then `project_roots`), so a session that only reads still shows one. A collection that never leaves this machine is tagged: `| private-acme (local only)`. Leases and counters (`lease`, `counter_next`, `yapa coord`) now count as writes.
- **`yapa scope [--cwd DIR]`** prints the collection YAPA uses for a folder, with `local_only` and `mapped`, so a project's scripts can ask instead of naming a collection themselves. `collection_map` stays the one place a folder's collection is set.

## 1.10.2 (2026-11-03)

No false "restart" note on the status line while a resumed session's YAPA server starts.

**Upgrading:** update the plugin and restart Claude Code. Nothing to deploy.

### Fixes
- **No false "restart" note when a session resumes.** A resumed session's transcript is old, so for the few seconds before its new YAPA server reported, the status line showed `yapa (restart for v...)`. The session-start hook (which also runs on resume) now notes each start (`sessions/<id>.starting`), and the status line waits a minute from then before concluding that no new server is running.

## 1.10.1 (2026-11-03)

The status line now shows the YAPA each session actually runs, and says when a session needs a restart to load the installed one.

**Upgrading:** update the plugin and restart Claude Code, including old sessions (they then show `(restart for v1.10.1)` until restarted). Nothing to deploy.

### Fixes
- **The status line shows the YAPA this session runs.** It showed the installed script's version, so a session still running an older YAPA after an update looked current and silently lacked newer features (such as the last-written collection). Each MCP server now records its version for its session at start (`~/.local/share/yapa/sessions/<session id>.json`, removed at exit), and the status line shows that version, with `(restart for v<installed>)` when it is older. A session that has run a minute without any server record (older than 1.10.1, or no YAPA server) shows `yapa (restart for v<installed>)`.

## 1.10.0 (2026-11-02)

Private and local-only collections work fully on one machine: claims, leases, counters and task ids are coordinated there, a project folder can be mapped to a private collection, private memories stay out of other projects' recall, and sessions on one machine no longer lose each other's writes.

**Upgrading:** restart every Claude Code session after updating. Older YAPA processes don't take the new locks.

### Features
- **Local-only collections coordinate on this machine.** `private-*`, `local-*` and `global` (and every collection while sync is off) now get what the sync service gives shared ones, served from `~/.local/share/yapa/coord/` (`YAPA_LOCAL_COORD_DIR`) under a lock file every YAPA process respects:
  - **Claims:** `task_update` to `in_progress`, `task_next` with `claim` and `yapa task claim` refuse a second session with the holder and since when, and a claim that lapsed is offered again by `task_next`. Until now claims were skipped there, so two sessions could both start the same task.
  - **Leases:** `lease` and `yapa coord acquire|heartbeat|release|list` work with the service's rules (key and scope overlap, TTL, reclaim, takeovers); they used to fail with `local_only_collection`. The hooks renew local leases, also with sync off. A local grant says `(this machine)`, and `yapa coord` adds `"local": true`.
  - **Counters and task ids:** `counter_next` / `yapa coord counter-next` never repeat a value, and task ids minted without the service come from a counter on this machine instead of "highest seen + 1", so two sessions can no longer mint the same id and overwrite each other's task. `task_create` also skips an id some document already uses.
- **Session-start presence** lists live claims in a local-only collection too.
- **After upgrading:** an `in_progress` task in a local-only collection (or any, with sync off) has no claim on record yet, so `task_next` offers it again only once it has been untouched for two hours, not at once. A busy lock on this machine refuses a claim plainly ("try again"), and `yapa task` exits 4. An unreadable coordination file names the command that moves it aside. A heartbeat the service can't answer is retried on the next prompt and reported as "NOT renewed on the sync service".
- **Folder to collection map (`collection_map`, `YAPA_COLLECTION_MAP`).** `path=collection` entries separated by `;` or newlines (commas and colons stay part of the path, so Windows paths work), `~` expanded, e.g. `~/work/acme=private-acme`. A session in a mapped folder, or below it, uses that collection; the longest matching path wins (on separator boundaries, through symlinks, case-insensitively on Windows), ahead of `project_roots`, and a mapped scope is never ambiguous. Relative entries and entries without `=` are ignored with a warning; a mapped name that looks private but syncs (`Private-acme`, `privat-acme`) gets a warning and a note on the scope line. It is the only way a folder gets a `private-*` or `local-*` scope, so Stop and PostCompact capture no longer write a private project's notes into a shared collection. The scope line reads ``**Scope:** `private-acme` (local only, never synced)``. The DSH plugin takes the same option as `collectionMap`.
- **Recall fence.** Cross-collection recall extras (the prompt hook's hits from other collections) never come from `private-*`/`local-*` collections, and session start's "Waiting on you" (hooks and DSH) only counts their items in a shared scope. Recalling in that collection, or with no collection at all, still finds them; `global` is unchanged.
- **Merging a shared collection into a private one says what happens remotely.** `collection_merge` (and DSH `yapa_collection_merge`) reports up to how many of your docs the next push retracts from the shared copy, how many teammates' docs stay shared in the source, that the source won't come back, and that the redirect is for this machine only (merge on your other devices too). The description no longer claims nothing is deleted remotely.

### Fixes
- Lease markers and claim notices are written atomically under a lock, so a hook and the MCP server acting for one session can't drop each other's watched leases or notices.
- **No lost writes between sessions on one machine.**
  - **Embedded store** (`storage: local`): every change now happens under its collection file's lock, against a fresh read. Two sessions writing at once could lose one's change, or crash on a shared temp file.
  - **Read-modify-writes** (both stores): `task_update`, task dependencies, links from memories to tasks, `memory_update` notes, `yapa task release` notes and tags, and `yapa memory put` now run under a per-document lock and merge into the current document. Concurrent edits all land, and a ref put twice at once makes one memory.
  - **Push:** it marks a doc synced only if the doc is unchanged since it was pushed. An edit made during a push stays unsynced and goes out next, instead of being reverted.
  - **Recurring tasks:** completing one twice at once creates its next occurrence once, and the first close time is kept.
  - **Field patches** (new store operation `patchDocuments`, which merges into the document as it is now; `null` removes a key): the recall salience boost, decay, archiving (supersede, compaction, janitor), selection and promotion, classification, and locked updates now write only the fields they change. A boost after another session's edit no longer reverts it, and an edit no longer reverts a boost.
  - **Merges, re-keys and pull links:** a merge re-copies a doc edited while it ran; a task re-keyed on push carries edits made during the upsert; pull links a similar local doc under that doc's own lock, and calls the remote after releasing it.
- **A merged collection stays merged.** A merge records a local redirect `from -> into` (in `global`, never synced) and unsubscribes `from`, with sync off too. Scope detection follows it, so the old folder lands in the target (the scope line notes "merged from ..."; the DSH injector re-detects after a merge), writes that name the old collection (`memory_store`, `task_create`, `journal_append`, `memory_update`, `compaction_apply`, `yapa memory put`) land in the target and say so, and no pull (prompt hook, recovery, a leftover subscription) or push auto-subscribe recreates and re-follows the source from teammates' rows. `sync subscribe` on the old name, or `collection_create` of it, drops the redirect.
- **`global` can't be merged away.** `collection_merge from=global` is refused: `global` holds this machine's sync subscriptions, pull point and merge redirects.

## 1.9.0 (2026-11-02)

The status line now names the collection this session last wrote to.

**Upgrading:** update the plugin and restart Claude Code. Nothing to deploy.

### Features
- **The status line names the collection you last wrote to:** `yapa@v1.8.0 <-> acme ● synced 1m ago | project-acme`. Every write through the YAPA tools or the `yapa memory` / `yapa task` CLI (memories stored, updated or forgotten, tasks created, updated, claimed, completed or deleted, dependencies, journal entries, compaction, merges) notes its collection for the session in `~/.local/share/yapa/last-write/<session id>.json`; the status line reads the session id Claude Code sends it. Nothing shows before the session's first write, and sync pulls, decay and the janitor never change it. Records untouched for a week are removed.

## 1.8.0 (2026-11-01)

One sync cycle per interval for the whole machine, however many sessions are open. Each Claude Code session runs its own YAPA server, and each used to run its own full push and pull of every collection every 5 minutes.

**Upgrading:** update the plugin and restart Claude Code, including old sessions: servers older than 1.8.0 keep syncing on their own timer. Nothing to deploy.

### Features
- **Shared sync cycle.** The servers on one machine share a record of the last cycle and a lock beside the sync health file, keyed by remote, local store and username. A timer tick (now jittered ±10%) skips when another server synced within the interval or holds the lock; a lock whose holder died, or that is older than twice the interval, is taken over. Startup still syncs at once for a store that has never pulled and for a server newer than the last one that synced. A manual `sync now` always runs. `YAPA_SYNC_COORDINATE=false` turns it off. `sync status` shows the shared record and the ticks this server skipped.
- **A write pushes only.** The sync 2 seconds after a write no longer pulls every collection as well; pulls come from the shared cycle and the prompt hook.
- **Prompt-hook pull shared too.** The prompt hook skips its pull of the active collection when any session pulled it, or a full cycle finished, in the last 30 seconds (`YAPA_HOOK_PULL_WINDOW_MS`, `0` to always pull). Session start and a collection's first visit (its full backfill) always pull.

## 1.7.0 (2026-11-01)

The status line now says which YAPA you run, what your team's remote is called, and when a newer YAPA is out, and it sets itself up from the install command.

**Upgrading:** update the plugin and restart Claude Code. If you named the status line with "Status line name" (`status_label`), that name carries over; set it from now on with `remote_name`. Nothing to deploy.

### Features
- **`yapa@v<version> <-> <remote> ● synced 2m ago`.** The status line starts with the YAPA version running. The new option `remote_name` (`YAPA_REMOTE_NAME`) names your team's sync remote; the name, and the `<->` before it (printed as is, so ligature fonts draw one arrow), appear only when it is set. Set it at install: `claude plugin install yapa@yapa --config remote_name=acme`; change it with `claude plugin configure yapa@yapa --values-stdin` or `/plugin`. `status_label` is deprecated and still read when `remote_name` is empty.
- **New releases on the status line.** The MCP server checks once a day for a newer release (the plugin manifest on `main`; `YAPA_UPDATE_SOURCE`, `YAPA_UPDATE_CHECK=false`), and the status line shows `(v1.8.0 available)` right after the version. The next session start tells Claude the update command once; the note clears itself after updating.
- **The status line sets itself up.** New option `statusline` (on by default): the session-start hook adds YAPA's status line to `~/.claude/settings.json`, keeping one you already have, so the two install commands are all it takes. Removing it (`--uninstall`, or by hand) keeps it removed; `/yapa:statusline` adds it back.

### Fixes
- The status line's install and uninstall recognize their script wherever it lives (a custom `YAPA_SYNC_HEALTH_FILE` folder), so an install never wraps YAPA's own status line again.
- The MCP server reports YAPA's real version instead of 0.1.0.

## 1.6.0 (2026-11-01)

Working in YAPA now leaves findings, decisions, questions and follow-ups behind on its own, keeps them current as people answer, and shows each person what waits on them.

**Upgrading:** no schema change. The new metadata keys are opaque to the remote (listed in [docs/sync-api.md](docs/sync-api.md) section 7); older clients keep them on pull. `response_capture` is now on by default (one or two small-model calls per turn, through `claude -p --model haiku` without an API key). An install that saved `false` for it keeps that: turn it on in the plugin settings to get the per-turn capture and follow-through.

### Features
- **Typed memories.** `memory_store` takes `kind` (finding, decision, limitation, question, idea) with a per-kind `status`, `owner`, `task_ids`, `options`, `recommendation`, `disposition`, `exit_criteria`; validated (a needed decision lists two options; a resolved finding says what became of it). `memory_update` changes one in place with a dated note. `memory_recall` and `memory_list` filter on kind and status and label each hit `[decision, needed, for josh]`.
- **Waiting on a person.** `waiting` (and `yapa waiting`) lists decisions to make, questions to answer, task steps only a person can take (`needs-human`, `needs:<user>`) and blocked tasks; session start shows what waits on you across collections.
- **Capture when work closes.** `task_complete` takes `learned` and `follow_ups`; `task_update` takes `decision_needed`, which records the decision and makes the task wait on it (`waits_on`) until it is recorded. A memory linked to a task is listed on the task (`memory_ids`); a task closed with nothing recorded gets a one-line nudge. `yapa task release` takes `--learned-file`, `--follow-ups-file`, `--decision-needed-file` and `--waits-on`.
- **Follow-through after each turn, on by default.** Response capture (now on unless `response_capture` / `YAPA_RESPONSE_CAPTURE` is `false`) (extractor prompt v2) types what it stores and links it to the session's task, then judges the open items the turn touches and records what it settles: a person's choice, an answer, a finding's disposition. Only the owner settles a decision that names one.
- **Triage and cleanup in the queue.** `task_next` skips tasks that wait on an open decision or need a person, takes `auto_only`, and offers cleanup items (`cleanup:triage`, `cleanup:findings`, `cleanup:compaction`) when nothing is ready. New `/yapa:work` skill (DSH: `yapa-work`) runs the loop. DSH gains `yapa_task_next`, `yapa_memory_update` and `yapa_waiting`.
- **`yapa memory list|put|update`** for project tooling; `put --ref` indexes a record kept outside YAPA (created once, updated in place).
- Reference remote: `yapa-mcp-remote` labels typed memories, shows task triage and waits, and adds `waiting`; the service and conformance suites check that typed metadata round-trips and a status-only update is served.

### Fixes
- `task_list`, `yapa task list` and the open tasks at session start missed most open tasks in a busy collection: only the first 100 task documents per collection were read, completed ones included. Every task is read now; `task_list` shows the first 100 and says how many more there are.
- `yapa task`, `yapa memory`, `yapa waiting`, `yapa coord` and the hooks could cut their output off at 64 KiB when stdout was a pipe; they now exit only after stdout drains.
- A task's blocked reason now syncs on its own and is cleared when the task leaves blocked.
- `memory_list` with a tag filter no longer misses matches past the first `limit` memories.
- Typed memories are never folded into a compaction summary or merged by the janitor, and response capture never replaces one.

## 1.5.0 (2026-11-01)

Two people (or two of your own sessions) can no longer start the same task without knowing: claiming a task is a lease the sync service grants or refuses on the spot.

**Upgrading:** deploy the sync service (or a remote that implements the section 9 changes below) before or with the client; an older service still grants ordinary claims, it just doesn't keep a renewal's scope or support `reclaim`.

### Features
- **Task claims.** In a shared collection, setting a task to `in_progress` (`task_update`, `task_next` with `claim`, `yapa task claim`) takes a lease on its id first. Someone else's live claim refuses the change (nothing is written; the reply names the holder and since when); a granted claim is pushed at once instead of after the debounce; leaving `in_progress` (complete, blocked, pending, delete) releases it. Offline or signed out, the status changes locally with a "not shared" warning, the claim is retried after the next good sync, and a clash found then is reported on the next prompt. A session that loses a claim to a takeover hears about it on its next prompt. A task created offline is pushed before it is claimed, so a re-keyed id cannot leave the lease on the wrong key. Works the same in the DSH plugin, which now also renews its claims each turn.
- **Who holds what.** `task_list`, session-start open tasks and the DSH open-tasks block show `claimed by <who> since <time>`, or `no live claim` for an `in_progress` task nobody holds. Your own other sessions are shown with their full id.
- **`task_next`: the ready queue.** Pending tasks whose dependencies are complete and that nobody holds, ordered by priority, due date, how many open tasks each unblocks, then age, with the reason every other open task was skipped; tag filters; `claim: true` claims the first one and moves on if someone got there first. An `in_progress` task whose claim lapsed is offered again. New task field `claim_scope` (soft scope) ranks tasks near live claims last.
- **`yapa task list|next|claim|release|show`** for scripts and project tooling: the same claims, JSON output, `yapa coord` exit codes (0 done, 3 refused, 4 not shared). `release --status pending|blocked|complete` sets the status, appends `--note`, adds `--tag`s and pushes before exiting.
- **Lease renewal keeps scope and TTL.** Re-acquiring your own lease (same user and session, live or expired) without `scope` now keeps the stored scope, and without `ttl_seconds` keeps the stored TTL, the way `title` already did; the overlap check uses the kept scope. A value that is sent still replaces the stored one (`scope: []` leaves just `key:<key>`). A fresh acquire or a takeover without them still gets `key:<key>` and 7200 s. The client no longer sends `scope: []` when none was given ([docs/sync-api.md](docs/sync-api.md) section 9).
- **`reclaim` on lease acquire.** `POST /v1/leases:acquire` takes `reclaim: true` (non-boolean: `400 invalid_request`): live leases of your own other sessions stop being conflicts, so a resumed or restarted session can take its work back. A live lease on the same key held by your other session is taken over (`took_over_from.reclaim: true`, logged as `takeover`); your leases on other keys stay. Another user's overlapping lease still refuses, and `conflicts` then lists only theirs. Exposed as `yapa coord acquire --reclaim` and the `lease` tool's `reclaim` parameter ("took over from <session> (your other session)").
- Conformance: the live suite checks a renewal without `scope` and `reclaim` over your own other session.

## 1.4.0 (2026-11-01)

You can see whether team sync is working without asking: a status line segment under the prompt shows synced, signed out (with the fix), offline or local only.

**Upgrading:** update the plugin and restart Claude Code, then run `/yapa:statusline` once (with `claude mcp add`: `yapa statusline install`). There is no schema change and nothing to deploy.

### Features
- **Sync health in the Claude Code status line.** An expired `gcloud` sign-in used to stop sync silently: errors went to stderr and an in-memory "last error" that was never cleared. Every sync outcome (the MCP server's cycles, the hooks' pulls, and sign-in failures on lease calls, which were not recorded at all) now goes to `~/.local/share/yapa/sync-health.json` (`YAPA_SYNC_HEALTH_FILE`), with when the outage started and how many local writes are waiting. `/yapa:statusline` (or `yapa statusline install`) adds a status line segment that reads it: `yapa ● synced 2m ago`, `yapa ● signed out since 09:12 · run: gcloud auth login`, `yapa ● offline since 09:12`. An existing status line is kept and restored on uninstall. New option `status_label` (`YAPA_STATUS_LABEL`) renames the segment. `yapa statusline show` prints it.
- While sync is down, the session-start and prompt hooks add one line telling Claude that writes are staying local and why.
- `sync status` shows the health record (status, since, last ok, to push).

### Fixes
- A successful sync now clears the "last error" `sync status` reported; it used to stay until the server restarted.

## 1.3.0 (2026-10-30)

Other services can now be a YAPA client's remote: the sync API is written down as a contract, with a conformance runner to check an implementation.

**Upgrading:** update the plugin. There is no schema change and nothing to deploy; `yapa-mcp` picks up the dependency bumps on its next deploy.

### Features
- **YAPA Sync API v1 spec** ([docs/sync-api.md](docs/sync-api.md)): the HTTP contract the client depends on (auth and identity, headers, idempotency, errors and how the client treats them, every endpoint and the fields the client reads, pull cursors and the deletions feed, document shapes, server rules, coordination), plus hints for implementers (durable vs volatile metadata, read-only documents). `packages/service` is the reference implementation.
- **Conformance runner.** `npm run conformance -- <url>` runs the live suite (`packages/core/src/sync/live.test.ts`) against any remote: sign-in, push/pull across two devices, ownership lookups, deletes and the deletions feed, leases with two sessions, counters, task ids, JSON 404s. Throwaway collection, temporary local stores; skipped without a URL.
- **Read-only documents.** Docs a remote serves with `metadata.read_only: true` are pulled as usual but cannot be forgotten, updated, completed, deleted or superseded ("read-only: owned by the remote service"), and are never pushed or queued for a remote delete. The client never mints `read_only` itself.
- **Connecting to a remote** ([docs/connecting-to-a-remote.md](docs/connecting-to-a-remote.md)): configure, sign in, verify, what syncs, and how to evaluate a remote without pushing your data to it. Linked from the README, pilot onboarding, `.env.example`, the plugin option and the install wizard (new option "Yes - existing sync service (URL)").

### Fixes
- Docs: `embedding_dimension` / `embedding_invalid` are `422`, not `400` (service design); the ID token is cached in a 0600 file, not kept in memory only (README, pilot onboarding); `.env.example` now covers the sync service URL.
- **The prompt hook ignores background-task notifications.** Claude Code delivers each finished background command and each Monitor event through the UserPromptSubmit hook, as a prompt made of `<task-notification>` blocks. The hook treated these as the user's prompts: it ran a recall on the notification text (injecting unrelated matches under every build-log line) and recorded it as the user's turn, so response capture judged the notification instead of what the user asked. A notification-only prompt now gets no recall and isn't recorded, and the pending capture notice waits for the next real prompt. Its leases are still renewed, so a session waiting hours on a long job keeps them. A prompt that mixes user text with notifications gets recall on the user text only.
- Dependencies: fast-uri 3.1.9, body-parser 2.4.0, ip-address 10.7.5, zod 4.6.7, qs 6.17.1 (#38-#42); the plugin bundle is rebuilt with them (#45).

## 1.2.0 (2026-10-29)

Multi-session coordination on the sync service, for any project whose tooling runs several sessions or people on one shared collection. Nothing changes for people who don't use it, except that task ids now come from the service.

**Upgrading:** apply `infra/cloudsql/sql/06_coordination.sql` (schema v3), then deploy the service, then update the plugin. A 1.2.0 plugin against an older service works as before: task ids fall back to local numbering and the "Work in progress" list is skipped.

### Features
- **Leases.** `POST /v1/leases:acquire`, `:heartbeat`, `:release` and `GET /v1/leases`: take a lease on a key with a scope and a TTL. It is granted only if no live lease (anyone else's, or your own other sessions) has the same key or an overlapping scope. Answered synchronously from Postgres under a per-collection advisory lock. Expired leases can be taken over (recorded in `lease_log`); the listing doubles as presence.
- **Atomic counters.** `POST /v1/counters:next` hands out strictly increasing values per collection and name, above a caller-supplied floor (for numbered record ids).
- **Task ids from the service.** `POST /v1/me/task-ids:next` gives each user one sequence across all collections, so two sessions (or machines) of one user no longer mint the same `<user>-N`. `task_create` uses it and falls back to the local max + 1 when the service is unreachable or older.
- **Hands-off leases.** One session identity for the tool, the CLI, the hooks and scripts (Claude Code's session id unless `YAPA_SESSION` or `--session` says otherwise); the prompt and turn-end hooks renew a session's leases automatically while it is active (only sessions that hold leases make the call); session start lists live leases in the active collection under "Work in progress"; the standing rules tell the agent how to react to refusals, takeovers and offline fallbacks without leasing on its own.
- **Plugin: `lease` and `counter_next` MCP tools, and the `yapa coord` CLI** (`acquire`, `heartbeat`, `release`, `list`, `counter-next`, `task-id`) with stable exit codes for scripts: 0 done, 3 refused, 4 service unavailable (fall back locally), 2 bad input. The CLI reads the plugin options from Claude Code `settings.json`.

## 1.1.1 (2026-10-14)

`yapa-mcp` recall now knows what is recent. Asking an agent for "details from the most recent meeting with Acme" returned older, higher-salience notes instead of the meeting synced minutes earlier: ranking had no time signal, and salience on the service is a snapshot that favors old, much-used memories. No plugin changes.

### Fixes
- **Recency in `memory_recall` ranking.** Every recall gives recently updated memories a small boost (fading over about a month). Questions about what is recent ("latest", "recent", "last", "new", "this week", "yesterday", ...) get a much stronger boost, and the named customer's newest memories are always considered, so the latest meeting surfaces even when older notes match the wording better.
- **Fresh follow-ups first.** The open follow-ups appended to recall list tasks updated in the last 14 days first (newest first), then the rest by priority, and each line shows its updated date, so action items from the latest meeting aren't crowded out by older high-priority tasks.

## 1.1.0 (2026-10-14)

Adds `yapa-mcp`, a remote MCP server so people who don't use Claude Code (for example through an agent platform such as Redpanda's Agentic Data Plane, or other MCP clients) can ask the team's shared memory questions. Read-only. No plugin behavior changes.

### Features
- **`yapa-mcp` remote MCP service (`packages/mcp-remote`, `infra/mcp-remote`).** Stateless Streamable HTTP at `POST /mcp`, deployed as its own Cloud Run service that does its own authentication (the Cloud Run invoker IAM check is off because MCP clients can't present a Google ID token for our audience). The sync service and its database access are unchanged.
- **Two ways to sign in.**
  - **Static keys** (`yapa_sk_<kid>_<secret>`): only a sha256 is stored (Secret Manager); each key acts as a read-only service identity such as `svc-adp`. `scripts/new-static-key.mjs` generates one; rotation adds a second key id.
  - **Per-user Google OAuth**: Google ID tokens, or access tokens checked with tokeninfo (the token must be issued to an allowed OAuth client, with a verified email in the company domain) plus userinfo. The caller is the real colleague, with the same username mapping and "by <user>" attribution as the plugin. RFC 9728 protected-resource metadata and `WWW-Authenticate` let clients discover the sign-in.
- **One tool by default: `memory_recall`.** Users ask in plain words. The customer or project the question names ("what's new with Acme?") is detected and boosted (never used as a filter), each result is a whole memory (chunks are stitched back together) with its customer, author and date, and the customer's open follow-ups are appended, highest priority first. `collection` is optional and also accepts plain names ("Acme CT"). Blank form fields are treated as unset. `memory_list`, `task_list`, `task_search`, `collection_list` and `collection_changes` can be enabled per deployment (`YAPA_MCP_TOOLS`, Terraform `tools`).
- **Server-side embeddings.** The same model as the plugin (all-MiniLM-L6-v2, q8, 384-d) is baked into the image and loaded offline; the core embedder was extracted as `createLocalEmbedder` with unchanged behavior.
- **Database role for the MCP service.** `infra/cloudsql` adds a runtime service account and IAM database user; `sql/05_mcp_runtime.sql` grants SELECT (plus first-sign-in user creation) and a row-level-security read policy limited to shared collections. No update or delete rights.
- **Limits and logging.** Per-identity rate limits, size caps per item and per result, a 256 KB request cap, and one `mcp_call` log line per call (never arguments or tokens). Alerts for 5xx rate and auth failures.

### Fixes
- **Cloud Build source uploads no longer include local-only files.** gcloud's default ignore only reads the root `.gitignore`, so `gcloud builds submit .` uploaded gitignored `infra/*/terraform.tfvars`, Terraform backend state and similar files. A `.gcloudignore` now excludes them for every image built from the repo.

### Docs
- `docs/adp-onboarding.md`: register YAPA in an agent platform, static keys, the Google OAuth client, example prompts.

## 1.0.2 (2026-10-14)

Patch release: a safe way to merge collections, a guard on shared collection deletes, and two task-tool gaps. Motivation: a request to merge two collections could only be done with `collection_delete`, which hard-deletes the shared collection for every teammate.

### Features
- **`collection_merge` (`from`, `into`, optional `dry_run`).** Moves every document (memories, tasks, journals) into an existing collection with ids and metadata intact, marks each one unsynced so the next push moves the shared row in place (nothing is deleted remotely; other devices relocate their copy on pull), verifies the target, then removes the empty source. The target must already exist. Private (`private-*`, `local-*`, `global`) into shared is refused, since it would publish private notes; shared into private retracts your shared copies as any move into a private collection does. Also in the DSH plugin as `yapa_collection_merge`.
- **`task_remove_dependency`.** Removes a depends-on/blocks edge from both tasks, and clears a dangling edge when the other task is gone. Core: `removeDependency`.
- **`task_update` takes `title`.** Renaming a task also rewrites its document content, so search matches the new title.

### Fixes
- **`collection_delete` refuses a non-empty shared collection** unless `confirm` repeats its exact name. The refusal gives the document count, says the delete reaches every teammate on the sync service, and points to `collection_merge`. Local-only and empty collections delete as before. The uninstall steps pass `confirm`.
- **Deploy smoke test uses `/health`.** Cloud Run reserves `/healthz` from outside, so `infra/service/deploy.sh` always got a 404.

## 1.0.1 (2026-10-14)

Service-only release: adds read-only reader principals so a team task dashboard can read shared collections as a service account. No plugin or client changes. This is the version for security review.

### Features
- **Read-only reader principals for the sync service.** `YAPA_READER_PRINCIPALS` (`sa@project.iam.gserviceaccount.com=svc-name`, comma-separated) lets a service account, such as a team task dashboard, read every shared collection. Service-account tokens have no `hd` claim, so listed accounts are matched by exact email instead. They need no `users` row and may only call GET routes; anything else returns `403 read_only_principal`. Each one also needs `roles/run.invoker` (the `domain:` binding doesn't cover service accounts), and its tokens use the service URL as audience. Off by default; nothing changes for existing users. Sign-up never auto-creates a `svc-*` username for a person, so a reader is never confused with a teammate in logs.

## 1.0.0 (2026-10-12)

First team-ready release. This is the version that goes to security review and to the pilot.

### Features
- **Claude Code plugin.** Install with `claude plugin marketplace add vuldin/yapa && claude plugin install yapa@yapa`. Options are prompted (username, storage, project roots, customers, sync service URL). The embedded local store is the default; ChromaDB is optional. Hooks run on session start, every prompt, stop, compaction and session end. Includes the `/yapa:standup` skill.
- **YAPA sync service.** Team sync goes through a Cloud Run service. You sign in with your company Google account; anyone in the company domain can use it, and an account is created on first sign-in. The server enforces the sharing rules: owner-only deletes, authorship can't be changed, local-only collections are rejected, task-id namespaces are per user, secret-looking content and invalid embeddings are rejected. Teammate edits are attributed and audited. The database has row-level security and is reachable only over a private IP.
- **Team sync model.**
  - Each device stamps what it writes, so it doesn't re-pull its own changes.
  - Teammates' updates reach you.
  - Deletes propagate through a deletions feed.
  - Collection moves are handled.
  - A new or wiped store rebuilds itself on first sync (recovery pull).
  - Subscribing to a collection backfills its history.
  - Pull uses an overlap window, so nothing is missed between cycles.
  - Changes are pushed shortly after each write.
  - The first time you open a shared project or customer folder, its full history is pulled and the collection is followed from then on; local-only collections never call the service from the hooks.
- **Cross-account recall.** Each prompt's recall includes a few strong hits from other customers or projects, labeled with their collection. Teammates' items are labeled "by <user>".
- **Salience model.** Importance decays with real elapsed time, boosts are gated on relevance (and capped per day), and ranking blends distance with salience.
- **Data integrity.**
  - Reused task ids never overwrite a different task.
  - Your docs in private collections never keep a shared copy.
  - Archives and journal drafts are handled correctly.
  - TLS everywhere.
- **Production infrastructure as code.** `infra/cloudsql`: private-IP Cloud SQL with backups, point-in-time recovery, pgaudit, and a tested restore runbook. `infra/service`: Cloud Run behind IAM, with alerts.

### Breaking changes
- `global` is local-only: it never syncs, not even between your own devices. The share-global option is removed; put team-wide knowledge in a shared collection such as `project-cs-team`.
- Syncing directly to a database (`sync_database_url`) is now an advanced, self-host option. Teams use `sync_service_url`.
- With the service, your username comes from your Google account (the email local part). The `username` option is informational.

### Upgrade notes
1. Update the plugin, then set `sync_service_url` and clear `sync_database_url`.
2. Run `gcloud auth login` with your company account.
3. Set `project_roots` (and `customers`) so each folder maps to its collection.
4. Restart Claude Code and ask "Is my YAPA sync working?"; it should show "Signed in as" and a healthy connection.
5. Open Claude Code in your project folders as usual; each one backfills its collection on first visit.

### Docs
- [docs/pilot-onboarding.md](docs/pilot-onboarding.md) (install, configure, verify, privacy, troubleshooting, rollback), [docs/second-user-test.md](docs/second-user-test.md) (two-person runbook) and [docs/pilot-feedback-template.md](docs/pilot-feedback-template.md).
- `npm test` builds first, so it works from a fresh clone.
