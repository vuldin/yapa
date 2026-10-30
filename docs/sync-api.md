# YAPA Sync API v1

The HTTP contract between a YAPA client (the MCP server, its hooks and the DSH
plugin, all through `packages/core`) and a sync remote. Any service that
implements it can be a YAPA client's only remote. The YAPA sync service in
`packages/service` is the reference implementation; where this document and
that code disagree about what the client needs, the client code
(`packages/core/src/sync/`) wins.

The key words MUST, SHOULD and MAY are used as in RFC 2119. "The client"
means the YAPA client as shipped in this repository; statements about what it
reads or ignores describe that code, so an implementation knows what it can
safely leave out.

Contents:

1. Overview and base URL
2. Authentication and identity
3. Transport
4. Errors
5. Endpoints
6. Pull semantics
7. Documents
8. Server rules the client relies on
9. Coordination
10. Implementer hints
11. Conformance

## 1. Overview and base URL

A user configures one base URL (`sync_service_url`, env
`YAPA_SYNC_SERVICE_URL`). The client strips trailing slashes and appends the
paths below, so every request goes to `${base}/v1/...`. The base URL MAY have a
path prefix: with `https://example.com/api/yapa` the client calls
`https://example.com/api/yapa/v1/me`. The scheme MUST be `https` in
production (`http` is accepted for local testing).

Sync is a periodic push/pull of documents (memories, tasks, consolidated
journals) between the client's local store and the remote, grouped by
collection. Each cycle: push the deletes the user queued, retract shared
copies of the user's docs that moved into local-only collections, push every
changed doc, then pull every followed collection. Cycles run every 5 minutes,
shortly after each write, and on demand; the hooks also pull the active
collection before each prompt (bounded by a 4 s timeout).

Collections `global`, `private-*` and `local-*` are local-only: the client
never sends them, and a remote MUST refuse them (`403 local_only_collection`).
Every other collection name matching `^[a-z0-9][a-z0-9._-]{0,127}$` is shared:
every member of the remote can read it.

## 2. Authentication and identity

### Tokens

Every request carries a Google ID token (a JWT). The client gets it by running
`gcloud auth print-identity-token`, or the command in `YAPA_SYNC_ID_TOKEN_CMD`
(the last non-empty line of its output is the token). It reuses a token until
about 5 minutes before its `exp`, and caches it in a 0600 file
(`~/.local/share/yapa/id-token`, `YAPA_SYNC_ID_TOKEN_CACHE`).

The same token is sent twice (section 3): in `Authorization: Bearer` and in
`X-Yapa-Id-Token`. A remote MUST verify the token itself (signature against
Google's keys, `exp`, `iss` in `accounts.google.com` /
`https://accounts.google.com`, `aud` in an allow-list) and SHOULD verify the
copy in `X-Yapa-Id-Token` when present: a platform layer in front of the app
(for example Cloud Run IAM) may consume `Authorization` and forward it with
the signature stripped.

Audience: a token from `gcloud auth print-identity-token` for a user account
has `aud` = `32555940559.apps.googleusercontent.com` (the gcloud CLI's own
OAuth client id). A remote that accepts plain `gcloud` sign-in MUST put that
value in its audience allow-list. Tokens from a custom
`YAPA_SYNC_ID_TOKEN_CMD` (a service account, a desktop OAuth client) carry
whatever audience they were minted for.

Claims: the remote MUST require `email` and `email_verified: true`. It MAY
require an `hd` (Workspace domain) claim and MAY admit specific service
accounts (which have no `hd`) by exact email.

### Identity and usernames

The remote maps the verified email to a username; the client never chooses
its own. `GET /v1/me` returns it, and the client then uses it everywhere: task
ids (`<username>-<n>`), memory ids, `origin_user`, ownership checks. The
configured `YAPA_USERNAME` is ignored while syncing with a remote.

A username MUST match `^[A-Za-z0-9_-]{1,64}$` and MUST be stable for a given
person: task ids and ownership are keyed on it. The reference implementation
derives it from the email's local part (lowercased, every run of characters
outside `[a-z0-9_-]` replaced by `-`, leading/trailing `-` trimmed, at most 64
characters: `jane.doe@example.com` becomes `jane-doe`), reserves the `svc-`
prefix for service accounts, and either looks the user up in a members table
or creates the row on first sign-in for an allowed domain.

### Membership errors

| Status | code | When | Client behavior |
|---|---|---|---|
| 401 | `unauthenticated` | missing, invalid or expired token | mints a fresh token and retries the request once; a second 401 ends the cycle with "run `gcloud auth login`" |
| 403 | `not_member` | valid token, email not mapped to a user | ends the cycle; tells the user to ask an admin |
| 403 | `user_inactive` | user exists but is disabled | ends the cycle |
| 403 | `read_only_principal` | a read-only principal called a non-GET route | (not used by the client) |
| 503 | `unavailable` | token verification could not run (key fetch failed) | ends the cycle; retried next cycle |

A 401 or 403 with no JSON error code (an HTML page from a front-end IAM layer)
is treated as `cloud_run_unauthenticated` / `cloud_run_forbidden`: both end
the cycle.

## 3. Transport

### Request headers

| Header | Sent on | Value |
|---|---|---|
| `Authorization` | every request | `Bearer <ID token>` |
| `X-Yapa-Id-Token` | every request | the same token, bare |
| `X-Yapa-Device` | every request | this install's device id, `^[A-Za-z0-9._:-]{1,128}$` |
| `Idempotency-Key` | `POST /v1/documents:batchUpsert`, `POST /v1/documents:batchDelete`, `POST /v1/counters:next`, `POST /v1/me/task-ids:next` | a fresh UUID v4 per logical request |
| `Content-Type` | requests with a body | `application/json` |
| `Accept` | every request | `application/json` |

`X-Yapa-Device` identifies the device for echo suppression (section 6) and
attribution; it is not a security boundary. The reference requires it on
pulls and upserts and rejects a malformed value, both with `400
invalid_request`; a remote SHOULD do the same.

### Timeouts and retries

The client aborts a request after 15 s (`YAPA_SYNC_HTTP_TIMEOUT_MS`). It
retries only once, only after a 401, with a fresh token and the SAME
`Idempotency-Key`. Network errors and timeouts (`unreachable`) end the cycle;
everything is retried on the next cycle.

### Idempotency

A remote SHOULD honor `Idempotency-Key` on the four routes above. Upserts and
deletes are safe to repeat anyway; without it, a repeated `counters:next` or
`task-ids:next` (a proxy retry, say) hands out a second value, which leaves a
harmless gap. Reference semantics:

- The key MUST match `^[A-Za-z0-9._:-]{1,200}$` (else `400 invalid_request`).
- A key is scoped to (username, HTTP method, concrete path, key): the same key
  on another route or by another user is unrelated.
- A stored response is kept for 24 hours.
- A repeat with the same key and the same body returns the stored status and
  body, with response header `Idempotent-Replay: true`, without re-executing.
- A repeat with the same key and a DIFFERENT body is `400 invalid_request`.
- Responses with status >= 500 are not stored, so a retry re-executes.

### Response basics

Bodies are JSON objects. Timestamps are integer Unix seconds unless noted.
Unknown request fields SHOULD be ignored; the client ignores unknown response
fields. The reference returns `X-Request-Id` on every response (and accepts
one on the request).

## 4. Errors

Every non-2xx response from the app MUST be JSON:

```json
{ "error": { "code": "not_owner", "message": "human readable", "request_id": "...", "details": {} } }
```

The client reads `code`, `message` (truncated, tokens redacted),
`request_id` and `details`; `Retry-After` (seconds) is copied into
`details.retry_after`.

| HTTP | code | Meaning |
|---|---|---|
| 400 | `invalid_request` | malformed input |
| 400 | `invalid_collection` | collection name does not match the pattern |
| 401 | `unauthenticated` | see section 2 |
| 403 | `not_member`, `user_inactive`, `read_only_principal` | see section 2 |
| 403 | `not_owner` | only the owner may delete (or, for read-only docs, change) this row |
| 403 | `local_only_collection` | `global`, `private-*`, `local-*` |
| 403 | `task_namespace` | task id outside the caller's `<username>-<n>` namespace |
| 404 | `not_found` | missing document, or unknown route |
| 409 | `id_taken` | task id already used by a different task |
| 413 | `payload_too_large` | over a size or count limit |
| 422 | `embedding_dimension` | embedding is not exactly 384 numbers |
| 422 | `embedding_invalid` | not an array of finite numbers, or L2 norm outside 1 +/- 0.01 |
| 422 | `secret_detected` | content or metadata looks like a credential |
| 429 | `rate_limited` | throttled; send `Retry-After` |
| 500 | `internal` | anything else |
| 503 | `unavailable` | temporarily unable (database down, key fetch failed) |

Unknown routes MUST answer `404` with this JSON envelope and code `not_found`
(the client relies on it for coordination fallback, section 9). An HTML 404
is not a fallback: the client reports it as error `http_404`, which usually
means a wrong base URL or path prefix.

### How the client treats errors

- Cycle-fatal (stop the rest of the cycle, keep the pull point, retry next
  cycle): `unreachable` and `token_command` (client side), `unauthenticated`
  (after the one retry), `cloud_run_unauthenticated`, `cloud_run_forbidden`,
  `not_member`, `user_inactive`, `rate_limited`, `unavailable`.
- Any other whole-request error: that collection or batch is counted as an
  error, its docs stay unsynced, and the cycle continues with the next
  collection.
- Per-item permanent errors in `batchUpsert` results: `secret_detected`,
  `embedding_dimension`, `embedding_invalid`, `invalid_request`,
  `invalid_collection`, `local_only_collection`, `task_namespace`,
  `payload_too_large`, `not_owner`. The doc stays local and unsynced, is
  marked rejected, is listed in `sync status`, and is not sent again until its
  content or metadata changes.
- `id_taken` on a task: the client renames the task locally to the higher of
  its next local id and `suggested_id`, and pushes it again in the same cycle.
- Any other per-item code, or a missing result: transient, retried next cycle.

## 5. Endpoints

All paths are relative to the base URL. All need authentication. "Client
reads" lists the response fields the client uses; others are optional.

### GET /v1/me

Response: `{ "username": "jane-doe", "email": "jane.doe@example.com" }`.
Client reads `username`, `email`. The reference also returns `device` and a
`limits` object (not read).

Called at startup, before every push/pull cycle (cached per token), and for
`sync status` ("Signed in as: <username> (<email>)").

### GET /v1/collections/{collection}/documents

The pull. Query parameters (the client always sends `limit=500` and
`embeddings=false`):

| Param | Meaning |
|---|---|
| `cursor` | opaque value from a previous page's `next_cursor`; wins over `since` |
| `since` | Unix seconds (may be 0); rows with `synced_at` strictly after it |
| `limit` | max rows per page; the remote MAY cap it (reference: 1000) |
| `include_own_device` | `true` to disable echo suppression |
| `embeddings` | `false`: omit `embedding` from documents |

Response:

```json
{
  "documents": [
    { "id": "mem-jane-doe-1767225600-k3x9qa", "collection": "project-atlas",
      "content": "...", "metadata": { "type": "memory" }, "origin_user": "jane-doe",
      "last_editor": "jane-doe", "related_ids": [],
      "created_at": 1767225600, "updated_at": 1767225600, "synced_at": 1767225601 }
  ],
  "deletions": [ { "id": "jane-doe-12", "deleted_by": "jane-doe", "deleted_at": 1767225700 } ],
  "next_cursor": "opaque",
  "has_more": false
}
```

Client reads, per document: `id`, `content`, `metadata`, `origin_user`,
`related_ids`, `updated_at`. It ignores `collection` (it asked for one),
`synced_at`, `created_at` (it uses `metadata.created_at`), `last_editor` and
`embedding` (it re-embeds locally). Per deletion: `id`, `deleted_by`. Page:
`next_cursor`, `has_more`. See section 6 for the semantics.

### POST /v1/documents:batchUpsert

Request (at most 50 documents and about 1.5 MB per request from the client):

```json
{ "documents": [
  { "id": "jane-doe-12", "collection": "project-atlas", "content": "Rotate the staging certs",
    "embedding": [0.0123, "... 384 numbers ..."], "embedding_model": "Xenova/all-MiniLM-L6-v2:q8",
    "metadata": { "type": "task", "status": "pending" },
    "created_at": 1767225600, "updated_at": 1767225600 }
] }
```

The client never sends `origin_user`: the remote assigns ownership.
`embedding_model` is informational and may be absent.

Response: one result per input document, IN THE SAME ORDER (the client
matches results by position, not by id):

```json
{ "results": [
  { "id": "jane-doe-12", "status": "inserted", "synced_at": 1767225601, "similar": [] },
  { "id": "jane-doe-13", "status": "updated", "synced_at": 1767225601, "stale": true,
    "similar": [ { "id": "mem-sam-1767000000-a1b2c3", "similarity": 0.97 } ] },
  { "id": "mem-jane-doe-1767225600-x", "status": "error",
    "error": { "code": "secret_detected", "message": "content matches a secret pattern (github_token)" } },
  { "id": "jane-doe-7", "status": "error",
    "error": { "code": "id_taken", "message": "...", "suggested_id": "jane-doe-41" } }
] }
```

`status` is one of `inserted`, `updated`, `unchanged`, `pending` (accepted but
not yet visible to others; the client treats it as success) or `error`.
Client reads `status`, `stale` (informational), `similar[].id` (the first
match with a different id is linked both ways through related-ids),
`error.code`, `error.message`, `error.suggested_id`.

Whole-request errors: `400 invalid_request` (body not JSON, `documents` not an
array), `413 payload_too_large` (reference: more than 100 documents or a body
over 2 MiB). Per-item validation is listed in section 8.

### POST /v1/documents:batchDelete

Request: `{ "ids": ["jane-doe-12"], "reason": "delete" }` (at most 500 ids;
`reason` is `delete` for a user's delete or `retract` when a doc moved into a
local-only collection). Response:
`{ "results": [ { "id": "jane-doe-12", "status": "deleted" } ], "deleted": 1 }`.
Per-id status: `deleted`, `not_found`, or `error` with `not_owner`. Client
reads only `deleted`.

Only the row's owner may delete it. Each deletion MUST be recorded in the
deletions feed of its collection (section 6).

### GET /v1/collections

`{ "collections": [ { "name": "project-atlas", "count": 412 } ] }`: shared
collections with document counts (for listing and subscribing).

### GET /v1/me/collections

`{ "collections": ["project-atlas"] }`: collections holding rows the caller
owns. Used to rebuild a wiped local store: the client subscribes to all of
them on its first pull.

### POST /v1/documents:collections

Request `{ "ids": [...] }` (at most 1000). Response
`{ "collections": { "<id>": "<collection>" } }`; missing ids are absent. Used
to notice that a doc moved to another collection.

### POST /v1/documents:owners

Request `{ "ids": [...] }` (at most 1000). Response
`{ "owners": { "<id>": "<username>" }, "created_at": { "<id>": 1767225600 } }`;
missing ids are absent. Used before retracting: the client only deletes a
shared row it owns whose `created_at` is within 1 s of its local copy.

### GET /v1/me/max-task-number

`{ "max": 41 }`: the highest `n` over shared ids of the form
`<caller>-<n>` (0 if none). Fallback for task numbering when `task-ids:next`
is unavailable.

### POST /v1/documents/{id}/related-ids

Request `{ "add": ["<id>", ...] }` (at most 100). Set-union append, ignoring
the doc's own id. Response `{ "related_ids": [...] }` (not read). `404
not_found` if the doc is missing, `413 payload_too_large` if the union would
exceed 100. Any member may link any shared doc. A link MUST advance the row's
`synced_at` (so other clients pull the new links) and SHOULD NOT change its
last editor. Failures are logged and ignored by the client.

### Coordination routes

`POST /v1/leases:acquire`, `POST /v1/leases:heartbeat`,
`POST /v1/leases:release`, `GET /v1/leases`, `POST /v1/counters:next`,
`POST /v1/me/task-ids:next`: see section 9.

### Not used by the client

The reference also has `GET /health` and `GET /healthz` (no auth),
`GET /v1/health`, `PUT /v1/documents/{id}`,
`GET /v1/documents/{id}/created-at` and
`POST /v1/collections/{c}:similar`. The client has methods for some of them,
but no sync, task or hook path calls them; an implementation may omit them.

## 6. Pull semantics

### Feeds and positions

A collection has two feeds, both ordered by (time, id):

- documents: live rows, ordered by `synced_at`. `synced_at` is assigned by the
  remote's clock on EVERY write that changes what a client would pull:
  insert, update, move into the collection, and related-ids append.
- deletions: one entry per deleted row, ordered by `deleted_at`.

A page returns documents strictly after the request's documents position and
deletions strictly after its deletions position, in feed order. `since=<t>`
sets both positions to "strictly after time t". `next_cursor` encodes the
position after the last row returned in EACH feed (a feed that returned
nothing keeps its position). The cursor is opaque to the client; it MUST be
bound to its collection (a cursor for another collection is `400
invalid_request`) and SHOULD carry sub-second precision plus the id
tie-breaker, so rows sharing a timestamp are neither skipped nor repeated.

`has_more` MUST be true when either feed has rows past the returned ones.
`next_cursor` SHOULD always be present.

### Paging and budgets

The remote MAY return fewer rows than `limit` to stay under a byte budget
(the reference: 8 MiB of serialized documents per page) but MUST return at
least one row when any is available, so one huge document cannot stall
pagination.

The client stops paging a collection when `has_more` is false, when
`next_cursor` is missing, or when `next_cursor` equals the cursor it just
sent, and after at most 200 pages per call.

### Overlap

The client stores its pull point per store, not per collection: the START of
the last complete cycle minus 120 s (`YAPA_SYNC_PULL_OVERLAP_SECONDS`), and
pulls followed collections with `since=<pull point>` on the next cycle.
Collections newly subscribed in a cycle are pulled with `since=0` (full
history); a store that has never pulled also sends
`include_own_device=true` once. Rows can therefore arrive more than once; the
client deduplicates by id and applies a remote version only when its
`updated_at` is newer than the local copy's and the local copy has no
unpushed edits.

The overlap also covers rows that commit with a `synced_at` slightly in the
past (a long transaction). A remote SHOULD keep the gap between assigning
`synced_at` and the row becoming visible to pulls well below 120 s.

### Echo suppression

Unless `include_own_device=true`, a pull MUST skip rows whose LAST write was
made by the caller from the requesting device (`X-Yapa-Device`), and SHOULD
skip rows of the caller that carry no device at all (legacy rows). Matching on
the device alone is wrong: a teammate could send the owner's device id and
hide their edit from the owner. The same user's other devices still receive
the row. The deletions feed is not filtered.

### Deletions

The client applies a deletion entry by removing its local copy, unless the
copy has unpushed edits (then it keeps it and the next push re-creates the
row). A deletion of an id that the same pull already returned as a live
document (on this page or an earlier one) is ignored (delete, then re-create). Deletion entries SHOULD be
kept as long as a client may stay offline (the reference keeps them
indefinitely); a client that misses one keeps a stale copy.

## 7. Documents

### Shape

| Field | Rules |
|---|---|
| `id` | 1..200 characters, no whitespace or control characters, not starting with `__` (local sentinels) |
| `collection` | shared collection name (section 1) |
| `content` | string, at most 64 KiB UTF-8 |
| `metadata` | JSON object, at most 32 KiB serialized; opaque to the remote except for the keys in section 8 |
| `embedding` | required on upsert: exactly 384 finite numbers with L2 norm 1 +/- 0.01 (MiniLM-L6-v2, normalized) |
| `created_at`, `updated_at` | Unix seconds; the reference accepts 2024-01-01 .. now + 1 day |
| `origin_user` | owner, assigned by the remote on insert, never changed |
| `related_ids` | ids linked through related-ids |

### Id formats

- Memories: `mem-<username>-<unix seconds>-<6 random [a-z0-9]>`.
- Long memories are stored as chunks `<base id>-<i>` with metadata
  `chunk_index`, `chunk_total`, `parent_id` (= the base id).
- Tasks: `<username>-<n>`, one sequence per user across all collections.
- Journal drafts (`journal-...`, `type: journal_draft`) never leave the
  client; the consolidated journal is a memory tagged `journal`.

### Metadata keys

The remote stores metadata as given and returns it on pull. Keys the client
writes (all optional unless noted):

- All docs: `type` (`memory` | `task`; required), `username`, `created_at`,
  `updated_at`, `accessed_at`, `salience`, `sector` (`semantic` |
  `episodic`), `tags` (array), `origin_device`, `origin_user`,
  `related_ids`, `is_synced`, archive markers `archived`, `superseded_by`,
  `supersedes`, `duplicate_of`, `compacted_into`, salience bookkeeping
  `boost_day`, `boosts_today`, `decayed_at`, and provenance such as `source`,
  `session_id`.
- Tasks: `id`, `title` (also the content), `notes`, `status` (`pending` |
  `in_progress` | `blocked` | `complete`), `priority` (`critical` | `high` |
  `medium` | `low`), `due_date` (0 = none), `customer`, `project`,
  `depends_on`, `blocks`, `is_recurring`, `recurrence_pattern`,
  `completed_at`, `duration_minutes`, `blockedReason`, `rekeyed_from`.
- Set by the remote: `origin_user` (MUST be overwritten with the row's owner)
  and `origin_device` (the reference overwrites it with the writer's device).
- Reserved for the remote: `read_only` (section 10).

## 8. Server rules the client relies on

Per upsert item, in this order (the first failure is the item's error):

1. `collection` matches the pattern (`invalid_collection`) and is not
   local-only (`local_only_collection`). Checked first so local-only content
   is never inspected further.
2. `id` valid (`invalid_request`); `content` a string within 64 KiB
   (`payload_too_large`); `metadata` an object within 32 KiB
   (`invalid_request` / `payload_too_large`); `metadata.type` is not
   `journal_draft` (`invalid_request`).
3. `embedding` valid (`embedding_dimension` / `embedding_invalid`).
4. `created_at` / `updated_at` numbers in range (`invalid_request`).
5. No secret in content or metadata (`secret_detected`; report only the
   pattern name, never the match).
6. Insert of a task (`metadata.type == "task"`): the id MUST be
   `<caller>-<n>`; any insert whose id looks like `<other existing user>-<n>`
   is refused. Error `task_namespace` with `suggested_id` =
   `<caller>-<max+1>`.
7. Update of an existing task whose stored `created_at` differs from the
   incoming one by more than 1 s: a different task already owns the id.
   Error `id_taken` with `suggested_id` = `<caller>-<max+1>`.
8. Otherwise write it:
   - Ownership: `origin_user` is the inserting user and never changes.
   - Any member may update any shared row (last writer wins by arrival).
     Return `stale: true` when the stored `updated_at` is newer than the
     incoming one (the write is still applied).
   - An identical row (same content, metadata, embedding, collection) is
     `unchanged` and does not advance `synced_at`.
   - Changing `collection` moves the row (it appears in the new collection's
     feed; clients drop copies from collections they no longer follow).
   - Return up to 5 `similar` rows in the same collection above the
     similarity threshold (reference: cosine 0.95), excluding the doc itself.
     An empty array is always acceptable.

Deletes are owner-only and recorded in the deletions feed. Task numbers come
from one per-user sequence (`task-ids:next`), floored by the highest existing
`<caller>-<n>`.

## 9. Coordination

Leases (who works on what) and counters, answered synchronously. All take a
shared collection and return `local_only_collection` / `invalid_collection`
like documents do. These routes are optional for a remote: when one answers
`404` with code `not_found` (or a cycle-fatal error), the client says that
nothing was shared and falls back to local coordination; task ids fall back
to `max(local max, GET /v1/me/max-task-number) + 1`.

Validation (reference): `key` and scope entries
`^[A-Za-z0-9._:@/-]{1,200}$`; `session` `^[A-Za-z0-9._:-]{1,128}$`; at most
64 scope entries; `ttl_seconds` an integer 30..86400 (default 7200);
counter `name` `^[A-Za-z0-9._:-]{1,64}$`; `floor` a non-negative integer;
`title` at most 300 characters; `outcome` `^[A-Za-z0-9._ :-]{0,64}$`
(default `done`). Violations are `400 invalid_request`.

Lease object:

```json
{ "collection": "project-atlas", "key": "runbook-rewrite",
  "holder": { "user": "jane-doe", "session": "s-123", "device": "laptop-1" },
  "title": "Rewrite the runbook", "scope": ["doc:runbook", "key:runbook-rewrite"],
  "ttl_seconds": 7200, "acquired_at": 1767225600, "heartbeat_at": 1767225600,
  "expires_at": 1767232800, "expired": false, "took_over_from": null }
```

- `POST /v1/leases:acquire` `{ collection, key, session, scope?, ttl_seconds?, title? }`.
  The effective scope always includes `key:<key>`. Refused when a LIVE lease
  held by anyone else (including the same user's other sessions) has the same
  key or an overlapping scope:
  `{ "granted": false, "conflicts": [ { "lease": {...}, "overlap": ["key:..."] } ] }`.
  Otherwise `{ "granted": true, "lease": {...}, "renewed": <same holder re-acquired>,
  "took_over_from"?: {...} }` (`took_over_from` when an expired lease of
  someone else was replaced). Check-and-write MUST be atomic per collection.
- `POST /v1/leases:heartbeat` `{ collection?, session, keys? }` renews the
  caller's leases for that session (all collections when `collection` is
  absent; `keys` needs a collection): `{ "renewed": [lease...], "lost": [key...] }`.
  The client's hooks heartbeat automatically while a session is active.
- `POST /v1/leases:release` `{ collection, key, session, outcome? }`:
  `{ "released": true, "lease": {...} }`, or `{ "released": false, "reason": "not_held" }`,
  or `{ "released": false, "reason": "held_by_other", "lease": {...} }`.
- `GET /v1/leases?collection=<c>&include_expired=true|false`:
  `{ "leases": [...], "now": <unix seconds> }`.
- `POST /v1/counters:next` `{ collection, name, floor? }`: `{ "value": n }`,
  strictly greater than every value handed out for (collection, name) and
  greater than `floor`. Atomic; honors `Idempotency-Key`.
- `POST /v1/me/task-ids:next` `{ floor? }`: `{ "id": "<username>-<n>", "number": n }`
  with `n` greater than every number handed out to the caller, than `floor`
  (the client's local max) and than the highest existing `<caller>-<n>`. The
  client reads `id` and uses it only if it starts with `<username>-`.

## 10. Implementer hints

### Durable vs volatile metadata

Clients re-push a doc whenever its synced copy changes locally, and some
metadata changes are bookkeeping rather than edits. A remote that versions
records, audits changes or notifies on change SHOULD split metadata into:

- volatile: `salience`, `accessed_at`, `boost_day`, `boosts_today`,
  `decayed_at`, `is_synced`, `origin_device`, `remote_checked_at`,
  `sync_rejected`, `sync_rejected_fp`, `sync_rejected_message`;
- durable: everything else (content, `type`, `status`, `tags`, archive
  markers, ...).

A write that changes only volatile keys can update in place without a new
version or notification. It MUST still be stored and returned on pull
(clients compare `updated_at`, not these keys), but MAY skip advancing
`synced_at`. Never drop unknown keys: the client treats metadata as its own.

### Read-only documents

A remote MAY serve documents it owns itself (generated summaries, records
mirrored from another system) in a shared collection's pull feed, with
`metadata.read_only: true` and an `origin_user` that is not a member. The
client then:

- refuses `memory_forget`, `task_update`, `task_complete`, `task_delete`, a
  `memory_store` that supersedes it, and dependency edits on it, with the
  message `<id> is read-only: owned by the remote service`;
- never pushes it, never queues a remote delete or retract for it, and never
  sends `read_only` on docs of its own (it strips the key on store).

A remote SHOULD still reject writes to such documents per item: an upsert of
a read-only id answers `status: "error"` with code `not_owner` (a permanent
error, so the client stops resending), and a batchDelete answers `not_owner`
for it. A related-ids append MAY be accepted or refused (the client ignores
link failures).

## 11. Conformance

`npm run conformance -- <base URL>` (repository root) runs the opt-in live
suite `packages/core/src/sync/live.test.ts` against a remote with your Google
ID token (`gcloud auth login`, or `YAPA_SYNC_ID_TOKEN_CMD`). It checks:
sign-in (`/v1/me`), push from one device and pull from a second, ownership
lookups, delete and the deletions feed, leases with two sessions, counters,
task ids, and the JSON 404 for an unknown route. Coordination cases are
skipped when the remote answers them with `404 not_found`.

It uses temporary local stores (never your YAPA data), writes only to a
throwaway collection `project-yapa-it-<run>`, and deletes the rows it
created. Leases are released; the per-run counter row stays (no API removes
counters), and the task-id case consumes one of your task numbers. Without a
URL the suite is skipped, so a normal `npm test` never contacts a remote.
