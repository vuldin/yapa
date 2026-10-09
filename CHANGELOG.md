# Changelog

## 1.0.0 (unreleased)

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
3. Restart Claude Code, then check that `sync` (action `status`) shows "Signed in as".
4. Run a sync once to backfill your subscribed collections.
5. Set `project_roots` (and `customers`) so each folder maps to its collection.
