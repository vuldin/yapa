# Changelog

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
