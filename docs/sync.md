# Sync

Sync lets several machines, or teammates, share memories and tasks. It's optional: YAPA works fully offline, and local features keep working when the remote is unreachable. `global`, `private-*` and `local-*` collections never sync.

## Connecting

A remote is any server that implements [YAPA Sync API v1](sync-api.md). YAPA reaches it one of two ways:

- **Over HTTP:** `sync_service_url` (`YAPA_SYNC_SERVICE_URL`), for example the YAPA sync service in `packages/service`. YAPA signs in with a short-lived Google ID token from `gcloud auth print-identity-token` (`YAPA_SYNC_ID_TOKEN_CMD` for another command). The token is refreshed before it expires and cached in a 0600 file (`~/.local/share/yapa/id-token`; `YAPA_SYNC_ID_TOKEN_CACHE` for another path, or `off` to keep it in memory only).
- **As an MCP tool:** `sync_mcp_url` and `sync_mcp_token_cmd` (`YAPA_SYNC_MCP_URL`, `YAPA_SYNC_MCP_TOKEN_CMD`), for a remote that serves the Sync API as its `yapa_sync` tool, usually behind an MCP gateway. The command prints the bearer token. `sync_mcp_tool` names the tool when it isn't `yapa_sync` or a single prefixed name like `remote__yapa_sync`.

Turn on `sync_enabled` and set one of them. [Connecting to a remote](connecting-to-a-remote.md) walks through configuring, signing in and checking it. Read it first: **the first sync pushes every shared collection on this machine to the remote.** Then check with the `sync` tool (`action: status`): the backend, the URL, who you're signed in as, the last error, and any documents the remote refused.

When both are set, the MCP URL wins over the HTTP one, and either wins over a direct database URL.

With a remote, your username comes from the remote (shown in `sync status`); task ids use it, and the `username` option is informational. The sync service enforces ownership (only the owner deletes a shared row), refuses content that looks like a secret (the doc stays local and unsynced, listed in `sync status`, and is retried only after you edit it), renames a task whose id already belongs to a different task, and sends deletions to teammates' machines (a clean copy is removed; a copy with unpushed edits is kept and reported).

## The status line

Sync fails quietly by design (local work never waits on the remote), so an expired `gcloud` sign-in used to go unnoticed. The MCP server and the hooks record every sync outcome in `~/.local/share/yapa/sync-health.json` (`YAPA_SYNC_HEALTH_FILE`; `off` disables it), and a small script turns it into a Claude Code status line segment:

```
yapa@v1.7.0 (v1.8.0 available) <-> acme ● synced 2m ago | project-acme
└ YAPA's version  └ a newer release  └ your remote  └ sync health  └ last written
```

`<->` is printed as is, so a font with programming ligatures (Fira Code, JetBrains Mono, Cascadia Code, ...) draws it as one arrow. It and the name appear only when `remote_name` is set. The sync states:

| Segment | Meaning |
|---|---|
| `● synced 2m ago · 3 to push` (green) | healthy; local writes waiting for the next push, if any |
| `● signed out since 09:12 · run: gcloud auth login` (red) | the ID token command failed or the remote rejected the sign-in |
| `● offline since 09:12` (yellow) | the remote is unreachable |
| `● sync error since 09:12: ...` (yellow) | any other failure; `sync status` has details |
| `○ local only` / `○ sync status unknown` (dim) | sync is off / no recent check |
| `· capture ✗` (red, after any state) | the per-turn capture is failing: its latest run failed within the hour (a follow-through failure alone doesn't count), or more runs failed than succeeded today; `yapa capture status` has the error |

- **Install:** automatic. With the option `statusline` on (the default), the session-start hook writes `statusLine` in `~/.claude/settings.json`, pointing at a stable copy of the script (`~/.local/share/yapa/statusline.mjs`, refreshed by the session-start hook so plugin updates reach it). A status line you already had keeps running, with the YAPA segment as a line beneath it. `node ~/.local/share/yapa/statusline.mjs --uninstall` (or `yapa statusline uninstall`) restores it, and YAPA then leaves it removed; `/yapa:statusline` or `yapa statusline install` adds it back.
- **Which YAPA this session runs:** the version is the one this session's own MCP server reported when it started (`~/.local/share/yapa/sessions/<session id>.json`), not the installed script's. A session still running an older YAPA after an update shows `yapa@v1.8.0 (restart for v1.10.1)`; one whose server never reported (older than 1.10.1, or no YAPA server) shows `yapa (restart for v1.10.1)` once it has run a minute.
- **Where this session writes:** after ` | `, the collection this session last wrote to through the YAPA tools, the `yapa memory` / `yapa task` CLI or a lease or counter (`lease`, `counter_next`, `yapa coord`); before its first write, the collection its hooks detected for the folder (its [folder rules](collections.md#folder-rules)). A collection that never leaves this machine is tagged `(local only)`, e.g. `| private-acme (local only)`. Reads, sync pulls and background sweeps never change it. Each session keeps its own, in `~/.local/share/yapa/last-write/` and `sessions/`.
- **Name:** the option `remote_name` (`YAPA_REMOTE_NAME`). The older `status_label` is still read when `remote_name` is empty.
- **New releases:** the MCP server checks once a day (the plugin manifest on `main`, `YAPA_UPDATE_SOURCE`; `YAPA_UPDATE_CHECK=false` turns it off) and keeps the answer in `~/.local/share/yapa/update-check.json`. The status line shows `(v1.8.0 available)`, and the next session start tells Claude the update command (`claude plugin marketplace update yapa && claude plugin update yapa@yapa`, then restart). The note clears itself once you run the new version.
- **Capture health:** every per-turn capture (extraction and follow-through) and every compaction capture is counted in `~/.local/share/yapa/capture-health.json`, beside `sync-health.json`. That covers the Claude Code hooks and DSH, two weeks of days, and the last error. `yapa capture status [--days N]` prints the counts and the last error. When capture failed in the last day and hasn't succeeded since, session start says so.
- **Cost:** the script reads a few small local files; no network, no `gcloud`.
- **Recovery:** after `gcloud auth login`, the next request mints a new token; no restart. The segment turns green at the next sync cycle or prompt.
- While sync is down, the hooks also tell Claude, so it doesn't claim your writes reached teammates.

With the service, your username comes from your Google account (shown in `sync status`); task ids use it, and the `username` option is informational. The service enforces ownership (only the owner deletes a shared row), refuses content that looks like a secret (the doc stays local and unsynced, listed in `sync status`, and is retried only after you edit it), renames a task whose id already belongs to a different task, and sends deletions to teammates' machines (a clean copy is removed; a copy with unpushed edits is kept and reported).

## How it works

When sync is enabled, YAPA runs a background push/pull cycle every 5 minutes (configurable via `YAPA_SYNC_INTERVAL_MS`), and two faster paths keep teammates current within seconds:

- **Push on write** — every write tool (`memory_store`, `task_update`, …) schedules a debounced push (`YAPA_SYNC_PUSH_DEBOUNCE_MS`), and the MCP server flushes pending pushes on shutdown. A write pushes only; pulls come from the cycle and the hooks.
- **Pull before recall** — the Claude Code hooks pull the active collection right before injecting context, so a teammate's memory from seconds ago shows up on your next prompt. A prompt skips the pull when any session on this machine pulled that collection in the last 30 seconds (`YAPA_HOOK_PULL_WINDOW_MS`); session start and the first visit to a collection always pull.

**One cycle per machine.** Every Claude Code session runs its own YAPA server, and all of them share one local store, so one cycle per interval is enough for all of them. The servers keep a small record of the last cycle and a lock beside the sync health file (`sync-cycle-<key>.json`, `.lock`; the key is a hash of the remote, the local store and the username, so different installs never sync for each other). A server's timer (jittered ±10%) skips when another server finished a cycle within the interval or is running one; a lock whose holder died or is older than twice the interval (at least 10 minutes) is taken over. Anything unreadable means "go ahead", so the worst case is the old behavior of every server syncing. A manual `sync now` always runs. `sync status` shows the shared record and how many ticks this server skipped. Servers older than 1.8.0 don't take part: restart old sessions after updating.

The cycle itself:

1. **Push** — Local documents flagged as unsynced are uploaded, stamped with this machine's `origin_device`. Collections you push to are automatically subscribed for pull. Journal drafts stay local; only consolidated journals sync.
2. **Pull** — Documents from subscribed collections are downloaded, skipping only rows **last written by this device** (so your other machines still receive your work). A newly subscribed collection backfills its full history. The stored pull point is the cycle *start* minus an overlap window, so a document pushed while a pull is running is never skipped.
3. **Updates** — When a remote document is newer than the local copy and the local copy has no unpushed edits, the remote version replaces it (a teammate completing a task, a corrected memory). A local copy with unpushed edits wins and is pushed on the next cycle.

## Multi-user semantics

- **Attribution** — documents keep their original author (`origin_user`); injected context marks teammates' items `by <user>`.
- **`global` is local-only** — like `private-`/`local-` collections it never leaves your machine (not even to your other devices). Put team-wide knowledge in a shared collection such as `project-cs-team`.
- **Same user, several machines**: sign in with the same Google account (direct database: use the same `YAPA_USERNAME`) everywhere; each install has its own device id.
- **Access control**: with the sync service, the server checks every request against your Google identity; with a direct database, everyone with the URL can read every shared collection. Either way, use `private-`/`local-` collections for anything that must not leave your machine.

You can also trigger a sync manually with `sync` (`action: 'now'`), check status with `action: 'status'`, and manage subscriptions with `action: 'subscribe'` / `'unsubscribe'`.

## Deduplication

Both push and pull compare document embeddings against existing data using cosine similarity:

- **On push**: each local document's embedding is compared against the remote database. If a match exceeds the similarity threshold (default 0.95), the documents are linked via `related_ids` in both local and remote metadata. The document is still pushed — nothing is discarded.
- **On pull**: each remote document is compared against local ChromaDB data. Matches above the threshold are linked the same way. The remote document is still inserted locally.

This means near-duplicates coexist but are cross-referenced, so you can trace where related knowledge came from without losing data. Adjust the threshold with `YAPA_SYNC_SIMILARITY_THRESHOLD` — lower values link more aggressively, higher values require near-exact matches.

## Deleting, restoring and purging

Nothing is lost by accident:
- `collection_delete` removes a collection from this machine only, unless you pass `scope: "everyone"` (with `confirm`). A shared collection stays with teammates, and your unpushed documents in it are pushed first.
- Deleting one of your documents in a shared collection (`memory_forget`, `task_delete`, `collection_delete` with `scope: "everyone"`) removes it for teammates too. The sync service keeps it restorable for 30 days, and each teammate's machine keeps an archived copy for 30 days (`YAPA_DELETED_RETENTION_DAYS`): hidden, never pushed back, back to live if you restore it.
- `trash list` shows both, `trash restore` brings yours back for everyone, and `trash keep` makes a teammate's deleted copy your own.
- Moving a document into a private collection (`collection_merge` from a shared one) retracts it: the sync service keeps none of its content, and teammates drop theirs unless they have unpushed edits to it.
- `trash purge` is for mistakes that must not survive, such as a leaked secret. The service keeps no restorable copy, teammates drop theirs even with local edits, and the id is refused if anyone writes it again. Only the owner can purge. A long memory stored in chunks goes whole, and a purge the service can't take yet stays queued and is retried on every sync.
- A sync remote with stricter rules of its own (one that never deletes rows, say) declares them, and YAPA follows them: `sync status` shows them, and where a remote can't erase, YAPA says the content stays there, hidden.

## Delete propagation

Deleting **your own** memory or task queues the deletion for the remote database; it's processed on the next push, before new documents. Deleting a **teammate's** document only removes it from your machine: it's tombstoned locally so pull won't re-insert it, and the shared row stays for everyone else (the remote delete is also guarded by owner).

## Advanced: a direct database (self-host)

Instead of the service, `sync_database_url` (`YAPA_SYNC_DATABASE_URL`) connects straight to a PostgreSQL+pgvector database you run; it is ignored when a service URL is set. This mode has no server-side access control: everyone with the URL can read and write every shared collection, deletions do not propagate to other machines, and there is no secret check. Any PostgreSQL with the pgvector extension works (a `pgvector/pgvector:pg17` container, or a managed service with pgvector).

## Testing sync

From a fresh clone: `npm ci && npm test` (`npm test` builds first, since the
`yapa-mcp` and DSH tests import the built `@yapa/core`). The first run
downloads the embedding model, so give it a minute.

`npm test` mocks the remote (Postgres seam, and a mock HTTP server for the service client).

Backend contract suite: the same scenarios against the direct-database backend and the service backend (in-process service, test auth, RLS schema from `infra/cloudsql/sql`), on a throwaway pgvector container:

```
docker run -d --rm --name yapa-ct -e POSTGRES_PASSWORD=ct -p 127.0.0.1:55433:5432 pgvector/pgvector:pg17
YAPA_CONTRACT_DB_URL=postgres://postgres:ct@127.0.0.1:55433/postgres npx vitest run src/sync/contract.test.ts   # in packages/core
docker rm -f yapa-ct
```

Live check against a deployed service (after `gcloud auth login`; writes only to a per-run `project-yapa-it-<run>` collection and deletes its rows afterwards):

```
YAPA_LIVE_SERVICE_URL=https://<your-service> npx vitest run src/sync/live.test.ts   # in packages/core
```

Direct-database end-to-end suite (multi-user model,
collection moves, task-id collisions) against a real PostgreSQL+pgvector
database:

```
YAPA_IT_DATABASE_URL=postgres://user:pass@host:5432/yapa npm run test:integration -w packages/core
```

Each run uses unique throwaway usernames and collections and deletes every row
it wrote afterwards; other users' rows are never touched.
