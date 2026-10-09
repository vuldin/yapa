# @yapa/service

The YAPA sync service: HTTP API v1 in front of the shared Postgres+pgvector
store, as designed in [docs/service-design.md](../../docs/service-design.md)
(task josh-311). Clients reach shared data only through this API, with a
Google identity; the database enforces the same rules again with RLS
(`infra/cloudsql/sql/04_rls.sql`).

## Layout

| File | Purpose |
|------|---------|
| `src/server.ts` | entry point (`node dist/server.js`), listens on `PORT` |
| `src/app.ts` | Hono app: routes, deny-by-default auth middleware, rate limits, idempotency |
| `src/auth.ts` | Google ID token verification (`google-auth-library` `verifyIdToken`), email -> `users` mapping, test-only auth mode |
| `src/store.ts` | all SQL (pull + deletions feed, upsert, delete, lookups, similarity, related ids, audit, idempotency keys) |
| `src/rules.ts` | collection classes, id/namespace rules, embedding and size validation |
| `src/secrets.ts` | secret-pattern detection (`422 secret_detected`); dependency-free so clients can share it |
| `src/db.ts` | `pg` pool: Cloud SQL connector (IAM auth, private IP) or a plain URL; `set_config('yapa.user', ...)` per transaction |
| `src/ratelimit.ts` | per-user token buckets and the daily write alert |
| `src/log.ts` | structured JSON logs with Cloud Logging `severity` |

## Endpoints

All under `/v1` need `Authorization: Bearer <Google ID token>`; pull and
upsert also need `X-Yapa-Device`. `GET /healthz` is the only open route
(no DB access). See section 5 of the design for request/response shapes.

| Method and path | Purpose |
|-----------------|---------|
| `GET /healthz` | liveness, no auth |
| `GET /v1/health` | DB check |
| `GET /v1/me` | caller username, email, server limits |
| `GET /v1/collections/{c}/documents?since=&cursor=&limit=&include_own_device=&embeddings=` | pull (echo rules, deletions feed, cursor pagination) |
| `POST /v1/documents:batchUpsert`, `PUT /v1/documents/{id}` | upsert (per-item results; `Idempotency-Key` honored for 24 h) |
| `POST /v1/documents:batchDelete` | owner-only delete; `{"ids": [...], "reason": "delete" or "retract"}` |
| `GET /v1/collections` | shared collections with counts |
| `GET /v1/me/collections` | collections holding the caller's rows (recovery) |
| `POST /v1/documents:collections`, `POST /v1/documents:owners` | id lookups (owners also returns `created_at`) |
| `GET /v1/documents/{id}/created-at` | created_at or 404 |
| `GET /v1/me/max-task-number` | highest `<caller>-<n>` |
| `POST /v1/collections/{c}:similar` | cosine similarity search |
| `POST /v1/documents/{id}/related-ids` | set-union append |

## Environment

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `PORT` | no | `8080` | listen port (Cloud Run sets it) |
| `YAPA_AUDIENCES` | yes (google mode) | | comma-separated allow-list of accepted token `aud` values: the service URL, the YAPA desktop OAuth client id, and the gcloud client id only if gcloud user tokens are accepted |
| `YAPA_ALLOWED_HD` | yes (google mode) | | required `hd` claim (the company Google Workspace domain) |
| `YAPA_INSTANCE_CONNECTION_NAME` | prod | | Cloud SQL `project:region:instance`; enables the Cloud SQL Node connector with IAM auth |
| `YAPA_DB_USER` | with the above | | IAM database user (the runtime service account, `name@project.iam`) |
| `YAPA_DB_NAME` | with the above | | database name |
| `YAPA_DB_IP_TYPE` | no | `PRIVATE` | connector IP type: `PRIVATE`, `PUBLIC` or `PSC` |
| `YAPA_DATABASE_URL` | local/tests | | plain connection string instead of the connector (exactly one of this and `YAPA_INSTANCE_CONNECTION_NAME`) |
| `YAPA_DB_POOL_MAX` | no | `5` | pool size per instance (pool x max instances must stay below `max_connections`) |
| `YAPA_STATEMENT_TIMEOUT_MS` | no | `5000` | per-connection `statement_timeout` |
| `YAPA_SIMILARITY_THRESHOLD` | no | `0.95` | threshold for the `similar` hint in upsert results and the default for `:similar` |
| `YAPA_RATE_LIMITS` | no | `on` | `off` disables the per-user token buckets (tests/local only) |
| `YAPA_DAILY_WRITE_ALERT` | no | `20000` | per-user daily document writes that log a `daily_write_cap` warning (not a block) |
| `YAPA_AUTH_MODE` | no | `google` | `insecure-test` accepts `Bearer test:<email>` WITHOUT verification. Local tests only; the service refuses to start in this mode when `K_SERVICE` is set (Cloud Run) |

The service needs no secrets: the database login is IAM, and OAuth client ids
are public.

## Logs

One JSON line per request (`message: "request"`, `httpRequest`, `route`,
`actor`, `request_id`), one per audited write (`message: "audit"`, mirroring
the `audit_log` row), and one per rejected login
(`event: "auth_failure"`, `reason`). Bodies, content, embeddings, tokens and
unverified emails are never logged.

## Build, run, test

```sh
npm run build -w packages/service
npm test -w packages/service                    # unit tests; integration suite skips

# integration suite: a throwaway pgvector container, schema from infra/cloudsql/sql
docker run -d --rm --name yapa-it -e POSTGRES_PASSWORD=it -p 127.0.0.1:55432:5432 pgvector/pgvector:pg17
YAPA_SERVICE_IT_DATABASE_URL=postgres://postgres:it@127.0.0.1:55432/postgres \
  npm run test:integration -w packages/service
docker rm -f yapa-it

# image (build context is the repo root)
docker build -f packages/service/Dockerfile -t yapa-service .
```

The integration suite creates a fresh database, applies `00`-`04` (skipping
the `pgaudit` extension, which the image lacks), connects as a non-owner
runtime role so RLS is in force, and drops the database afterwards.
