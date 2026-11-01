# Changelog

## 1.7.0 (2026-11-01)

The status line now says which YAPA you run, what your team's remote is called, and when a newer YAPA is out, and it sets itself up from the install command.

**Upgrading:** update the plugin and restart Claude Code. If you named the status line with "Status line name" (`status_label`), that name carries over; set it from now on with `remote_name`. Nothing to deploy.

### Features
- **`yapa@v<version> <-> <remote> ● synced 2m ago`.** The status line starts with the YAPA version running. The new option `remote_name` (`YAPA_REMOTE_NAME`) names your team's sync remote; the name, and the `<->` before it (printed as is, so ligature fonts draw one arrow), appear only when it is set. Set it at install: `claude plugin install yapa@yapa --config remote_name=c360`; change it with `claude plugin configure yapa@yapa --values-stdin` or `/plugin`. `status_label` is deprecated and still read when `remote_name` is empty.
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
