# YAPA Sync Service: Design and Threat Model

Status: draft (task josh-309). Related: josh-310 (migration/cutover), josh-312
(client rollout), josh-313 (remote MCP endpoint for scheduled routines),
josh-323 (governance review of changes to shared artifacts).

## 0. Background: how sync works today

Every client with sync enabled opens a Postgres connection straight to a
shared Postgres+pgvector database and reads/writes one `documents` table. All
clients use the same database login. There is no per-person identity on the
server, row-level security is off, and network access is limited by an IP
allowlist (TLS is being added as an interim fix). Every sharing rule lives in
client code (`packages/core/src/sync/*.ts`):

| Rule | Where it lives today |
|------|----------------------|
| Attribution: `origin_user` = the pusher's `YAPA_USERNAME` (self-asserted) | `push.ts` |
| `origin_user` and `created_at` are not overwritten on conflict | `upsertRemoteDocument` (`ON CONFLICT ... DO UPDATE` omits them) |
| Echo suppression: skip rows whose `metadata.origin_device` is this device, and legacy rows from this user with no device stamp | `buildRemoteDocsSinceQuery` |
| `global` is personal: pull adds `origin_user = me`, plus rows whose owner stamped `share_global` when the reader opted in | `pull.ts` `isPersonalCollection`, `push.ts` |
| `private-*` / `local-*` never pushed; own shared copies of docs now in such a collection are retracted (deleted remotely) | `push.ts` `isSyncable`, `retractSharedCopies` |
| Remote delete only of own rows (`AND origin_user = $owner`); deleting a teammate's doc writes a local tombstone | `deleteRemoteDocuments`, `deletes.ts` |
| Archive / supersede = metadata update (`archived: true`, `superseded_by`, `duplicate_of`) pushed like any edit | `memory/archive.ts`, curation |
| Task id collision: same id, different `created_at` (>1 s) means a different task; rekey to `max(local next, remote max + 1)` | `rekeyIfTaskIdTaken` |
| Collection moves: upsert rewrites `collection`; pull relocates or drops copies (`dropMovedOut`, `copiesElsewhere`) | `pull.ts` |
| Dedup: cosine similarity > 0.95 within a collection links rows via `related_ids` (both kept) | `findSimilarRemote`, `addRemoteRelatedIds` |
| Journal drafts never sync | push and pull both skip `type: journal_draft` |
| Recovery: a store that never pulled subscribes to every collection the user wrote to and accepts its own device's rows once | `pullFromRemote` (`recovering`) |
| Schema DDL is run by clients on connect | `schema.ts` `migrateSchema` |

Because the rules are client-side, anyone holding the database URL can read
everything (including other people's personal `global`), write as any
username, delete any row, and run DDL. The README says as much ("No access
control yet").

Gaps found while reading the code that the service should fix (not just port):

1. (Fixed client-side in 0dc113b) `SYNC_SHARE_GLOBAL` was evaluated on the
   **reader**. Push now stamps the owner's choice as `metadata.share_global`
   and pull only accepts a teammate's `global` row when it is set. The client
   can still bypass this with a direct DB connection; the service enforces it.
2. `getRemoteCollections`, `getRemoteOwnersByIds`, `getRemoteCollectionsByIds`
   and `getRemoteCreatedAt` ignore the personal rule, so ids and counts from
   other people's `global` are visible (push dedup via `findSimilarRemote` is
   owner-scoped for `global` since 0dc113b).
3. (Fixed in 0dc113b) `addRemoteRelatedIds` used `array_cat`, so retries
   appended duplicate ids; appends are now a set union.
4. The `embedding` column is untyped `vector`; an ivfflat index needs fixed
   dimensions, so `ensureVectorIndex` most likely fails silently and every
   similarity query is a sequential scan.
5. Remote deletes do not reach teammates: the row disappears, but teammates'
   clean local copies are never removed (pull only sees rows that exist).
6. Task ids can be minted in another user's namespace (`bob-12` pushed by
   alice) because the username is self-asserted.

## 1. Goals and non-goals

Goals

- **Only path to shared data.** After cutover, no client holds database
  credentials. The service is the sole reader/writer of the shared store; the
  shared `yapa` login is revoked.
- **Per-person identity.** Every request is tied to a verified Google account,
  mapped to one YAPA username. `origin_user` comes from the server, never from
  the request body.
- **Server-enforced sharing rules.** Every rule in section 0 that protects
  someone else's data moves to the server. Client-side checks stay as an
  optimization (avoid pointless requests), not as the control.
- **Local-first stays.** The embedded/local store remains the default and the
  system of record for each install. YAPA works fully offline; sync is
  optional and eventually consistent, exactly as today.
- **Same sync semantics.** Push/pull, echo rules, moves, rekeys, tombstones,
  and recovery keep working with only the transport swapped.
- **Remote MCP endpoint** on the same service for scheduled routines that have
  no local store (josh-313).

Non-goals

- Not a hosted memory UI or a web app. No browse/edit pages.
- Not a replacement for the local store, and not a multi-tenant SaaS. One
  team, one deployment.
- No server-side curation, compaction, decay, or training. Those stay client
  jobs.
- No fine-grained per-collection ACLs in v1 (everyone in the group can read
  every shared collection, as today). See open questions.
- The direct-DB mode is not deleted; it becomes an advanced/self-host option
  (josh-312).

## 2. Architecture

```
  Laptop (each team member)                     Team GCP project
  +-------------------------------+
  | Claude Code                   |
  |  +-------------------------+  |   HTTPS + Google ID token
  |  | YAPA plugin             |  |   (Authorization: Bearer)
  |  |  hooks CLI  ------------+--+------------------+
  |  |  MCP server (stdio) ----+--+---------------+  |
  |  |   local store (default) |  |               |  |
  |  +-------------------------+  |               v  v
  +-------------------------------+     +----------------------------+
                                        |  Cloud Run: yapa-service   |
  Scheduled routines (josh-313)         |   /v1/*   sync REST API    |
  +-------------------------------+     |   /mcp    remote MCP       |
  | cloud agent, no local store   |---->|   authn: ID token verify   |
  | (OAuth bearer for /mcp)       |     |   authz: rules in sec. 4   |
  +-------------------------------+     |   embedder (MiniLM q8)     |
                                        +-------------+--------------+
                                                      | Direct VPC egress
                                                      | Cloud SQL connector
                                                      | IAM DB auth, private IP
                                                      v
                                        +----------------------------+
                                        | Cloud SQL Postgres 17      |
                                        |  + pgvector, no public IP  |
                                        |  documents, users,         |
                                        |  audit_log, deletions      |
                                        +----------------------------+
                                        Cloud Logging / Monitoring
                                        Cloud Identity Groups API (membership)
```

Request flow for a push: the plugin's sync loop calls the service instead of
`pg`. The service verifies the token, resolves `email -> username`, checks
group membership (cached), applies the authorization rules, writes the row and
an audit record in one transaction, and returns per-item results.

Client seam: `push.ts` and `pull.ts` only call the functions exported from
`postgres.ts`. Those become a `RemoteSyncPort` interface with two adapters:
`PgRemote` (current code, self-host) and `HttpRemote` (this service). No other
sync code needs to know which one is active.

## 3. Identity

### Options

(a) **Service verifies Google ID tokens itself.** Clients send
`Authorization: Bearer <Google ID token>`. The service checks signature (Google
JWKS), `iss`, `exp`, `aud`, `email_verified`, and `hd` (company domain).

- CLI clients get tokens via a YAPA desktop OAuth client (installed-app
  loopback flow with PKCE, `openid email` scopes). `yapa login` opens a
  browser once; the refresh token goes into the OS credential store (already
  used for the DB URL today). The hook CLI and MCP server mint fresh ID
  tokens from it silently.
- Fallback for people who already use gcloud: ADC / `gcloud auth
  print-identity-token`. Service accounts (CI, routines running in GCP) mint
  tokens with `aud` = service URL from the metadata server.

(b) **IAP in front of Cloud Run.** IAP authenticates and passes a signed
`x-goog-iap-jwt-assertion`; the service trusts that header.

### Decision: (a)

- **CLI-friendly.** Hooks run on every prompt with a tight latency budget and
  no browser. IAP programmatic access needs an ID token whose audience is the
  IAP OAuth client, which is the same token-minting work as (a) plus an extra
  hop; IAP's strength (browser sessions, sign-in pages) does not apply to a
  headless client.
- **Remote MCP.** Claude's remote MCP connectors use the MCP authorization
  spec (OAuth 2.1 bearer tokens, protected-resource metadata). IAP in front of
  `/mcp` would block that handshake. With (a) the service already owns token
  validation and can serve both bearer types on one origin.
- **Authorization needs the identity in the app anyway.** IAP only answers
  "is this person allowed in". The username mapping, owner checks and audit
  attribution all live in the service regardless, so IAP adds a component
  without removing code.
- **Portability.** (a) works the same in self-host and local dev (any OIDC
  issuer can be swapped in later); IAP ties the design to one load-balancer
  setup.

Costs of (a), accepted: we own JWT verification (use `google-auth-library`
`verifyIdToken`, never hand-rolled), and Cloud Run is deployed with
`--allow-unauthenticated` at the platform level for `/mcp` reachability, so the
app is the only gate. Mitigation: verification runs as middleware on every
route except `/healthz`; a deny-by-default test asserts every route rejects a
missing/invalid token. If routing allows, the `/v1` API can additionally keep
Cloud Run IAM (`roles/run.invoker` bound to the group) with custom audiences;
see open questions.

Accepted audiences: the YAPA desktop OAuth client id, the service URL (service
accounts), and optionally the gcloud client id (only if the gcloud fallback is
enabled; it is broader because any gcloud-minted token qualifies).

### Membership and username mapping

- **Membership:** a Google group (e.g. `yapa-users@<domain>`). The service
  checks it with the Cloud Identity Groups API
  (`checkTransitiveMembership`), cached per email for 10 minutes.
- **Mapping:** `users` table: `email -> username`, plus `active` and
  `share_global`. A request is allowed only if the token is valid AND the email
  is a group member AND a `users` row exists with `active = true`.
- **First login / existing usernames:** existing `origin_user` values are
  seeded into `users` during migration (josh-310) by an admin, one row per
  person. A new person gets a row from an admin command; no self-service
  username claims (otherwise someone could claim an existing name).
- **Offboarding:** remove from the group (blocks within the cache TTL, at most
  10 minutes) and set `active = false` (immediate). The person's rows remain,
  attributed to their username; the username is never reassigned to someone
  else.

## 4. Authorization

### Collection classes

| Class | Names | Server behavior |
|-------|-------|-----------------|
| Shared | anything syncable except `global` (`customer-*`, `project-*`, others) | readable and writable by all active members |
| Personal | `global` | rows readable by the row owner only, unless the owner's `users.share_global = true`; then readable by members. Writable by owner only. |
| Private | `private-*`, `local-*` | rejected on every endpoint with `403 private_collection`. The server never stores or logs them. |

Collection names must match `^[a-z0-9][a-z0-9._-]{0,127}$` (validated server
side; clients already produce such names).

### Fields

- `origin_user`: set by the server to the caller on insert. Immutable.
- `created_at`: taken from the client on insert (needed for rekey detection),
  bounded to `[2024-01-01, now + 1 day]`. Immutable after insert.
- `last_editor`, `last_device`: set by the server on every write.
  `metadata.origin_device` is overwritten with the `X-Yapa-Device` header so
  echo suppression keeps working.
- `synced_at`: server clock, every write (including related-id appends).
- `updated_at`, `content`, `embedding`, `metadata`, `collection`: client
  controlled, subject to the matrix below.

### Matrix

"Self" = row's `origin_user` is the caller. "Teammate" = someone else.
"ADP" marks change classes that go through governance review once josh-323
lands; in v1 they are allowed, attributed (`last_editor`) and audited.

| Action | Shared, self | Shared, teammate | `global`, self | `global`, teammate | private-*/local-* |
|--------|--------------|------------------|----------------|--------------------|-------------------|
| Insert (new id) | allow; `origin_user` = caller | n/a | allow | n/a | reject |
| Insert, id in another user's task namespace (`bob-12` by alice) | reject `403 task_namespace` | | reject | | reject |
| Update content/metadata | allow | allow, **ADP** | allow | reject | reject |
| Archive / supersede (`archived` false->true, `superseded_by`) | allow | allow, **ADP** | allow | reject | reject |
| Un-archive | allow | allow, **ADP** | allow | reject | reject |
| Move between shared collections | allow | allow, **ADP** | n/a | n/a | n/a |
| Move shared -> `global` | allow (row becomes personal) | reject | | | |
| Move `global` -> shared | allow (publishes it) | | | reject | |
| Move into private-*/local- | not a server call: client retracts (delete own) | client keeps a personal copy; shared row stays | same | same | reject |
| Delete | allow | reject `403 not_owner` (client tombstones locally) | allow | reject | reject |
| Append `related_ids` | allow | allow (link only, capped, not ADP) | allow | reject | reject |
| Read (pull, lookup, similar) | allow | allow | allow | only if owner `share_global` | reject |
| Lookups that reveal existence (owners/collections/created-at by id) | allow | allow | allow | omitted from result | reject |

Notes:

- Echo exclusion is a filter, not an authz rule: the server excludes rows whose
  last device is the caller's device (and legacy rows of the caller with no
  device stamp), unless `include_own_device=true` (recovery pull). Recovery
  can only return rows the caller may read anyway.
- Teammate edits of a shared task (complete, reassign, re-date) are content
  updates and are ADP-classed with the rest; the governance layer can choose to
  auto-approve low-risk fields such as `status`.
- Writes from the remote MCP endpoint (routines) are attributed to the
  routine's identity (see open questions) and follow the same matrix.
- Admin actions (user mapping, reassigning ownership of a departed user's rows)
  are not API endpoints in v1; they run as a separate admin job with its own
  service account.

## 5. API v1

Base path `/v1`. JSON over HTTPS. All requests carry
`Authorization: Bearer <token>` and `X-Yapa-Device: <device uuid>`. Timestamps
are Unix seconds (integers) to match the client code. Every response carries
`X-Request-Id`.

### Endpoint map

| Endpoint | Replaces (`postgres.ts`) |
|----------|--------------------------|
| `GET /healthz` (no auth), `GET /v1/health` | `checkRemoteHealth` |
| `GET /v1/me` | (new) username, email, `share_global`, server limits |
| `GET /v1/collections/{c}/documents` | `getRemoteDocsSince` / `buildRemoteDocsSinceQuery` |
| `POST /v1/documents:batchUpsert` (and `PUT /v1/documents/{id}`) | `upsertRemoteDocument` |
| `POST /v1/documents:batchDelete` | `deleteRemoteDocuments` |
| `GET /v1/collections` | `getRemoteCollections` |
| `GET /v1/me/collections` | `getRemoteCollectionsForUser` |
| `POST /v1/documents:collections` | `getRemoteCollectionsByIds` |
| `POST /v1/documents:owners` | `getRemoteOwnersByIds` |
| `GET /v1/documents/{id}/created-at` | `getRemoteCreatedAt` |
| `GET /v1/me/max-task-number` | `getRemoteMaxTaskNumber` |
| `POST /v1/collections/{c}:similar` | `findSimilarRemote` |
| `POST /v1/documents/{id}/related-ids` | `addRemoteRelatedIds` |
| `GET /v1/deletions` | (new, optional) delete propagation, gap 5 |
| `POST /mcp` | (new) remote MCP, josh-313 |

`migrateSchema` and `ensureVectorIndex` have no endpoint: schema is owned by
the deploy pipeline, never by clients.

### Shared types

```jsonc
// Document (response)
{
  "id": "acme-auth-fix-1",           // string, 1..200 chars, no leading "__"
  "collection": "customer-acme",
  "content": "string",               // <= 64 KiB UTF-8
  "embedding": [0.01, ...],          // 384 floats; omitted when ?embeddings=false
  "metadata": { "type": "memory", "origin_device": "uuid", ... }, // <= 32 KiB
  "origin_user": "alice",
  "last_editor": "bob",
  "related_ids": ["..."],
  "created_at": 1760000000,
  "updated_at": 1760000500,
  "synced_at": 1760000510
}
```

### Pull

`GET /v1/collections/{c}/documents?since=<unix>&cursor=<opaque>&limit=<n>&include_own_device=<bool>&embeddings=<bool>`

- Server applies: collection class check, personal rule for `global`, echo
  rule using the caller's username and `X-Yapa-Device`, `synced_at > since`.
- Order: `(synced_at, id)` ascending. `limit` default 500, max 1000.
- Cursor: opaque base64 of the last `(synced_at, id)` returned. A request with
  a cursor ignores `since`.
- The cursor is on `synced_at`, not `updated_at`: `updated_at` is client clock
  (skewed, can move backwards on a rekey or a stale push) and does not change
  on `related_ids` appends, so it cannot be a reliable change feed.
  `synced_at` is server-assigned on every write. The client keeps its overlap
  window (`SYNC_PULL_OVERLAP_SECONDS`) because a transaction that started
  before a pull can commit after it with an earlier `synced_at`; the service
  uses `clock_timestamp()` to keep that window small.

```jsonc
// 200
{ "documents": [Document, ...], "next_cursor": "b64...", "has_more": true }
```

### Upsert

`POST /v1/documents:batchUpsert` with header `Idempotency-Key: <uuid>`
(optional but sent by the client).

```jsonc
// request
{
  "documents": [{
    "id": "alice-312",
    "collection": "project-yapa",
    "content": "string",
    "embedding": [/* 384 floats */],      // optional: server embeds if absent
    "embedding_model": "Xenova/all-MiniLM-L6-v2:q8",
    "metadata": { "type": "task", "status": "pending" },
    "created_at": 1760000000,
    "updated_at": 1760000500
  }]                                      // max 100 docs or 2 MiB per request
}
// 200 (per-item results; the batch never fails as a whole for item errors)
{
  "results": [
    { "id": "alice-312", "status": "inserted" | "updated" | "unchanged",
      "synced_at": 1760000510,
      "similar": [{ "id": "alice-77", "similarity": 0.97 }] },
    { "id": "bob-12", "status": "error",
      "error": { "code": "task_namespace", "message": "..." } },
    { "id": "alice-300", "status": "error",
      "error": { "code": "id_taken", "remote_created_at": 1750000000,
                 "suggested_id": "alice-341" } }
  ]
}
```

- `similar` returns readable rows above the server's similarity threshold so a
  push needs one round trip instead of similar + upsert. The client still does
  the `related_ids` linking it does today.
- Task rekey: for `metadata.type = task` whose id exists with a `created_at`
  more than 1 s away, the server returns `id_taken` with
  `suggested_id = <user>-<max(remote max)+1>`; the client still takes
  `max(local next, suggested)`. The `created-at` and `max-task-number`
  endpoints remain for clients that check first.
- Idempotency: upsert by id is naturally idempotent (same body, same result;
  `unchanged` when content, metadata, embedding and collection match). The
  `Idempotency-Key` is stored for 24 h to return the original response on a
  retry and to keep audit records from duplicating.
- Concurrency: last-writer-wins, matching today. The response reports
  `stale: true` when the stored `updated_at` was newer than the incoming one,
  so the client can log it. Real conflict handling is an open question.
- `PUT /v1/documents/{id}` is the single-doc form with the same body/result.

### Delete

`POST /v1/documents:batchDelete` `{ "ids": ["..."] }` (max 500) ->
`{ "results": [{ "id": "...", "status": "deleted" | "not_found" | "error", "error": {"code": "not_owner"} }], "deleted": 3 }`.
Each delete writes a row to `deletions` (id, collection, deleted_by,
deleted_at) so teammates can eventually drop their copies (gap 5).

### Lookups

- `GET /v1/collections` -> `{ "collections": [{ "name": "customer-acme", "count": 42 }] }`.
  Counts only rows the caller can read; private names never appear.
- `GET /v1/me/collections` -> `{ "collections": ["customer-acme", "global"] }`
  (rows the caller owns; used by recovery).
- `POST /v1/documents:collections` and `POST /v1/documents:owners`:
  `{ "ids": [...] }` (max 1000) -> `{ "collections": { "id": "name" } }` /
  `{ "owners": { "id": "alice" } }`. Unreadable and missing ids are both
  omitted.
- `GET /v1/documents/{id}/created-at` -> `{ "created_at": 1760000000 }` or 404
  (also 404 when unreadable).
- `GET /v1/me/max-task-number` -> `{ "max": 340 }`. Always the caller's own
  namespace; there is no `user` parameter.

### Similarity

`POST /v1/collections/{c}:similar`
`{ "embedding": [384 floats], "threshold": 0.95, "limit": 5 }` ->
`{ "matches": [{ "id": "...", "similarity": 0.97 }] }`. `threshold` is
clamped to `[0.5, 1.0]`, `limit` to `[1, 20]`. Only readable rows are
searched (fixes gap 2).

### Related ids

`POST /v1/documents/{id}/related-ids` `{ "add": ["..."] }` ->
`{ "related_ids": [...] }`. Set union (fixes gap 3), max 100 ids per row,
bumps `synced_at`. Allowed on any row the caller can read in a shared
collection, or on the caller's own `global` rows.

### Errors

```jsonc
{ "error": { "code": "not_owner", "message": "human readable",
             "request_id": "...", "details": { } } }
```

| HTTP | code | Meaning |
|------|------|---------|
| 400 | `invalid_request`, `invalid_collection`, `embedding_dimension`, `embedding_model` | malformed input |
| 401 | `unauthenticated` | missing/expired/invalid token (client refreshes once, then surfaces "run yapa login") |
| 403 | `not_member`, `user_inactive`, `not_owner`, `personal_collection`, `private_collection`, `task_namespace` | authz |
| 404 | `not_found` | missing or not readable (indistinguishable on purpose) |
| 409 | `id_taken` | task id collision, includes `suggested_id` |
| 413 | `payload_too_large` | over batch/doc limits |
| 429 | `rate_limited` | with `Retry-After` seconds |
| 503 | `unavailable` | DB down / overloaded; client keeps local changes unsynced and retries next cycle |

Per-item errors in batch calls use the same codes inside `results[]`.

### Rate limits

Per user (token bucket, per instance; instance count is capped so the global
bound is `limit x max_instances`):

| Class | Sustained | Burst |
|-------|-----------|-------|
| Reads (pull, lookups) | 20 req/s | 100 |
| Writes (upsert, delete, related-ids) | 10 req/s, 2,000 docs/min | 50 |
| Similarity / server-side embedding | 5 req/s | 20 |
| `/mcp` tool calls | 2 req/s | 10 |

Normal load is far below this (a 5 minute cycle per device plus a pull per
prompt); the limits exist to stop a runaway loop. A per-user daily write cap
(e.g. 20,000 docs) raises an alert rather than silently blocking.

### Remote MCP (josh-313)

`POST /mcp` (streamable HTTP transport). Exposes a subset of the local tools,
backed directly by the shared store: `memory_recall`, `memory_store`,
`task_list`, `task_search`, `task_create`, `task_update`, `task_complete`,
`collection_list`. Same authz matrix; private collections do not exist here
(no local store), and `global` is the caller's own. Write tools compute
embeddings server-side. Destructive tools (`memory_forget`, `task_delete`) are
not exposed in v1.

## 6. Data model

Schema v2 (current is v1):

```sql
-- users: identity mapping
CREATE TABLE users (
  username     TEXT PRIMARY KEY CHECK (username ~ '^[A-Za-z0-9_-]{1,64}$'),
  email        TEXT NOT NULL UNIQUE,
  active       BOOLEAN NOT NULL DEFAULT true,
  share_global BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at  TIMESTAMPTZ
);

-- documents: keep v1 columns, add
ALTER TABLE documents
  ADD COLUMN last_editor TEXT,
  ADD COLUMN last_device TEXT,
  ALTER COLUMN embedding TYPE vector(384);
-- metadata JSONB keeps origin_device (echo rules) and every client field.
CREATE INDEX idx_docs_coll_synced ON documents (collection, synced_at, id);
CREATE INDEX idx_docs_embedding ON documents USING hnsw (embedding vector_cosine_ops);
DROP INDEX IF EXISTS idx_docs_synced_at;  -- superseded by the composite

-- deletions: lets teammates' clients drop deleted rows (optional in v1)
CREATE TABLE deletions (
  id TEXT NOT NULL, collection TEXT NOT NULL,
  deleted_by TEXT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, deleted_at)
);

-- audit_log: append-only record of every write
CREATE TABLE audit_log (
  seq          BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor        TEXT NOT NULL,          -- username
  actor_email  TEXT NOT NULL,
  device       TEXT,
  request_id   TEXT NOT NULL,
  action       TEXT NOT NULL,          -- insert|update|archive|move|delete|link|retract
  doc_id       TEXT NOT NULL,
  collection   TEXT NOT NULL,
  prev_collection TEXT,
  row_owner    TEXT NOT NULL,
  change_class TEXT NOT NULL,          -- own|teammate (teammate = ADP candidate)
  content_sha256 TEXT,                 -- hash, not content
  changed_keys TEXT[]                  -- metadata keys that changed
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY, username TEXT NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `audit_log` lives in Postgres (not only Cloud Logging) because josh-323 needs
  to query "changes by non-owners to shared rows" and because it should be
  restorable with the data. Request logs (method, route, status, latency,
  actor, request id, never content) go to Cloud Logging. The runtime role has
  `INSERT` but not `UPDATE`/`DELETE` on `audit_log`.
- Row-level security as defense in depth: enable RLS on `documents` with
  policies keyed on `current_setting('yapa.user')`, set per transaction by the
  service (`SET LOCAL`). The service is still the primary enforcement point;
  RLS catches a missing `WHERE` clause.
- `embedding` validation at the type level (`vector(384)`) rejects mixed
  models (fireworks/openai/voyage providers produce other dimensions).
- **Schema version plan:** v2 is applied by a migration job in the deploy
  pipeline, before the new service revision takes traffic. It is additive
  except the `vector(384)` change, which needs a pre-check that every existing
  row has 384 dimensions (rows with other dimensions are reported and
  re-embedded by the service from `content`). Old direct-DB clients at v1 keep
  working against v2 (they ignore new columns), which makes the cutover
  reversible until the shared login is revoked. Clients in service mode never
  run DDL; `migrateSchema` stays only in the self-host adapter.

## 7. Threat model (STRIDE)

Assets: shared memories/tasks (customer context, internal decisions),
personal `global` rows, embeddings (invertible enough to treat as content),
user mapping, audit trail. Actors: active member, former member, outsider on
the internet, compromised laptop, buggy/runaway client, malicious content
author (prompt injection via shared memories), compromised routine.

| Threat | Example | Mitigation |
|--------|---------|------------|
| **S** Impersonate a teammate | Set `YAPA_USERNAME=bob` (works today) | Username comes from `users` via verified email; body `origin_user` ignored |
| **S** Stolen token | ID token copied from a laptop | 1 h lifetime, `aud` and `hd` checks, refresh token only in OS keychain, offboarding disables mapping immediately |
| **S** Token for another app replayed | Google ID token minted for some other OAuth client | Strict `aud` allowlist; gcloud audience off unless explicitly enabled |
| **S** Spoofed device id | Forge `X-Yapa-Device` | Device only drives echo suppression; spoofing just makes the attacker miss or re-pull their own rows. Not trusted for authz |
| **T** Overwrite a teammate's row | Push same id with new content | Allowed by design but attributed (`last_editor`), audited, ADP-reviewable; `origin_user`/`created_at` immutable |
| **T** Hijack via collection move | Move a teammate's doc into own `global` to hide it | Matrix forbids moving teammate rows into personal collections |
| **T** Task id squatting | Push `bob-999` to block bob's next ids | Namespace check on insert |
| **T** Mass deletion | Delete everything | Owner-only delete; per-user write rate and daily caps; PITR |
| **T** Direct DB writes | Old URL still works | Revoke shared login at cutover; Cloud SQL private IP only, no authorized networks; runtime SA has DML only, no DDL |
| **T** Data in transit | MITM on a network | HTTPS only (Cloud Run managed TLS); private IP + connector TLS to Cloud SQL |
| **R** "I didn't change that" | Disputed teammate edit | `audit_log` with actor email, device, request id; Cloud Logging request logs; append-only for runtime role |
| **I** Read someone's personal `global` | Query the table directly with the shared DB login (works today) | Owner-side `share_global` flag, enforced on every read path including similarity, counts and id lookups |
| **I** Existence oracle | Probe ids/owners/counts | Unreadable rows omitted; 404 for both missing and unreadable |
| **I** Private data sent to server | Bug pushes `private-*` | Rejected before parse of content; request bodies never logged; client also filters |
| **I** Secrets stored in shared memories | API key pasted into a `customer-*` memory | Server-side secret pattern scan on insert/update (warn + flag in v1; see open questions); docs keep pointing users to `private-*` |
| **I** Logs leak content | Content in error logs | Structured logging with an allowlist of fields; content and embeddings never logged |
| **I** Former member keeps data | Laptop still has local copies | Out of scope technically (local-first); covered by device policy. Access to new data ends at offboarding |
| **D** Runaway client | Push loop, huge pulls | Rate limits, batch limits, pagination, `statement_timeout` (5 s), Cloud Run max instances, alert on per-user write spikes |
| **D** Expensive similarity | Many large queries | HNSW index, limit clamp, similarity rate class |
| **D** Connection exhaustion | Many instances x pool | Pool size x max instances < Cloud SQL `max_connections` minus headroom |
| **E** Unauthenticated route | New route forgets auth | Deny-by-default middleware, test that enumerates routes |
| **E** SQL injection | Username in regex (today `getRemoteMaxTaskNumber` builds a pattern from it) | Username from DB only, validated by `CHECK`; parameterized queries everywhere |
| **E** Over-privileged service account | SA can alter schema or read secrets | Separate runtime SA (DML), migrator SA (DDL, used only by the job), admin SA (users table) |
| **E** Prompt injection through shared content | Malicious memory instructs other users' Claude sessions | Content is untrusted data: recall output already attributes `by <user>`; ADP review of teammate edits; size limits. Hooks should keep framing injected memories as data |
| **E** Compromised routine via `/mcp` | Routine token abused | Separate routine identity with narrow scope (no delete tools, rate class), revocable independently of the human |

## 8. Embeddings

- Today clients compute embeddings in-process with
  `Xenova/all-MiniLM-L6-v2` (q8 ONNX, mean pooling, L2-normalized, 384
  dimensions) via `@huggingface/transformers` v4. Other providers
  (fireworks/openai/voyage/ollama) produce different vectors and already break
  cross-user similarity if mixed.
- The server validates every incoming embedding: exactly 384 finite floats,
  L2 norm within `1 +/- 0.01`, and `embedding_model` equal to
  `Xenova/all-MiniLM-L6-v2:q8`. Otherwise `400 embedding_model` /
  `embedding_dimension`.
- The service bundles the same model and library version (pinned in the
  container image, weights baked in, no download at start). Uses:
  - `/mcp` queries and writes (routines have no embedder).
  - Upserts that omit `embedding` (lets non-local providers sync by having the
    server embed `content`, and removes the empty-embedding push path).
  - Re-embedding rows that fail the v2 dimension pre-check.
- Optional integrity check: re-embed a small sample of client-supplied vectors
  and compare (cosine > 0.99). A mismatch flags the row and the user. This
  catches poisoning (a vector chosen to surface a memory for unrelated
  queries) at low cost.
- Model changes are a coordinated migration (new column, dual write, backfill,
  switch), never a silent swap.
- Sizing: the q8 model is small (tens of MB); a 1 GiB / 1 vCPU instance
  embeds short texts in milliseconds. Cold start adds model load time, which is
  one reason for `min-instances=1`.

## 9. Operations

### Deployment

- Terraform under `infra/` (preferred; gcloud scripts acceptable for a first
  cut): Cloud Run service, service accounts, Cloud SQL instance (private IP
  only, PITR on), database and IAM users, Direct VPC egress, Artifact Registry
  repo, Secret Manager entries for OAuth client config, monitoring policies,
  log bucket.
- CI builds the image, runs unit tests plus the existing integration suite
  against a throwaway database, runs the migration job, then deploys a new
  revision with gradual traffic (10% -> 100%).
- Cloud Run settings: `min-instances=1`, `max-instances=5`, concurrency 40,
  1 vCPU / 1 GiB, request timeout 60 s.

### Secrets and DB credentials

- **IAM database authentication** for the runtime service account through the
  Cloud SQL Node.js connector (`ipType: PRIVATE`, `authType: IAM`). No
  database password exists for the service. Recommended over Secret Manager
  passwords: nothing to rotate or leak, and access dies with the SA binding.
- Secret Manager only for the OAuth client secret used by the `/mcp` OAuth
  flow (the desktop client id is public by nature).
- The legacy `yapa` password login is removed at cutover.

### Monitoring and alerting

- Metrics: request rate/latency/error by route, auth failures by reason,
  authz denials by code, per-user write volume, pull lag (now - max
  `synced_at` returned), DB CPU/connections/storage, embedder latency.
- Alerts: 5xx rate > 2% for 10 min; p95 pull latency > 1 s; any
  `private_collection` rejection (indicates a client bug); auth failure spike;
  per-user write spike; Cloud SQL storage > 80%; backup failure.
- Uptime check on `/healthz`.

### Backups and restore

- Automated daily backups (14 retained) and PITR (7 days of logs).
- Restore drill quarterly: PITR clone to a new instance, point a staging
  revision at it, run a verification script (row counts per collection and
  owner, sample checksum of content), record time to restore. Target RPO 5
  minutes, RTO 2 hours.
- Second line of recovery: every client's local store holds its subscribed
  collections; the existing recovery pull and a restore-from-clients script
  can rebuild rows if the database is lost beyond PITR.

### Rough cost (monthly, list prices, small team)

| Item | Estimate |
|------|----------|
| Cloud SQL, 1 vCPU / 3.75 GB dedicated core, 20 GB SSD, backups + PITR | $55-75 |
| Cloud Run, 1 min instance (CPU only during requests) plus traffic | $10-25 |
| Logging, monitoring, Artifact Registry | < $10 |
| **Total** | **~ $75-110** |

A shared-core tier (`db-g1-small`) cuts the database to ~$25-30 but has no
SLA; acceptable for a pilot.

### Migration and cutover (details in josh-310)

1. Provision Cloud SQL and the service; apply schema v2.
2. Copy data from the current database (dump/restore or Database Migration
   Service); verify counts.
3. Seed `users` from distinct `origin_user` values with each person's email.
4. Pilot: a few users switch to service mode. Either the service fronts the
   old database during the pilot (both paths write the same tables), or the
   old database is frozen before anyone writes to the new one. Never two
   writable copies.
5. Cutover: freeze old database (read-only), final sync, switch all clients,
   revoke the shared login, remove IP allowlist.
6. Rollback until step 5 completes: point clients back at the direct URL.

### Client rollout (josh-312)

- New config: `sync_service_url` (plugin) / `YAPA_SYNC_SERVICE_URL` (MCP), and
  a `yapa login` command for the OAuth loopback flow.
- `sync_database_url` stays for self-hosting but is documented as advanced;
  the installer stops offering it for team setups.
- `sync status` reports which adapter is active, the signed-in email, and the
  mapped username; it warns if `YAPA_USERNAME` disagrees with the mapping (the
  local username must match, since task ids are prefixed with it).
- Client releases that still use the direct URL keep working until cutover
  step 5; after that they get connection errors and `sync status` explains
  how to migrate.

## 10. Open questions

1. **Cloud Run IAM in addition to app auth.** Can `/v1` keep
   `roles/run.invoker` (with custom audiences for the desktop client id) while
   `/mcp` stays reachable for OAuth, e.g. two services or a path split? Needs a
   quick spike.
2. **Routine identity for `/mcp`.** Does a scheduled routine act as the human
   who created it (delegated OAuth token) or as a separate `routine-<name>`
   user? Affects attribution, offboarding, and which `global` it can read.
3. **MCP OAuth implementation.** Does the service act as its own OAuth
   authorization server (proxying Google sign-in, issuing short-lived tokens)
   or can a Google-issued token be used directly by the connector?
4. **Conflict handling.** Keep last-writer-wins, or add optimistic
   concurrency (`base_updated_at`, 409 on mismatch) so a teammate's edit is
   not silently overwritten by a stale local copy?
5. **Delete propagation.** Ship the `deletions` feed in v1 so teammates drop
   deleted rows, or keep today's behavior (copies linger) and add it later?
6. **`share_global` semantics.** Owner-side flag per user (proposed) applies
   retroactively to all of their `global` rows; is per-row opt-in needed? What
   about rows teammates already pulled before the owner turns it off?
7. **Per-collection ACLs.** Do some `customer-*` collections need a restricted
   audience (e.g. only the account team)? If yes, model as collection ->
   group bindings in v2.
8. **Secrets in shared content.** Warn-and-flag or reject on insert when a
   secret pattern matches? Rejecting breaks offline-first pushes for that doc.
9. **ADP review placement (josh-323).** Synchronous (write held as pending
   until approved) or asynchronous (applied, reviewed after, revertible from
   `audit_log`)? The data model supports either; the API would need a
   `pending` result status for the synchronous variant.
10. **Departed users' rows.** Keep attributed forever, or allow an admin to
    reassign ownership (so someone can delete/archive them)?
11. **Pull change feed.** Is the `synced_at` + overlap window good enough, or
    should v2 add a commit-ordered sequence (`BIGSERIAL` set on write) to drop
    the overlap entirely?
12. **Embedding integrity sampling.** Worth the CPU, and what sample rate?
13. **Self-host story.** Should the service image also be the recommended
    self-host path (with a generic OIDC issuer), retiring direct DB sync
    entirely in a later major version?
