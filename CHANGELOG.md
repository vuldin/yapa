# Changelog

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
