# @yapa/mcp-remote (yapa-mcp)

Remote MCP service in front of the shared YAPA store (josh-313), for Redpanda
ADP's "Remote (Proxied)" MCP servers. Separate package and image from
`@yapa/service`; it imports the service's auth, DB, store and rules code
through `@yapa/service/lib` and the client embedder through
`@yapa/core/local-embedder`. Onboarding: [docs/adp-onboarding.md](../../docs/adp-onboarding.md).
Infrastructure: [infra/mcp-remote](../../infra/mcp-remote/README.md).

**Phase 1 is read-only.** No write tools exist; every tool has
`readOnlyHint: true`, and the database role (`infra/cloudsql/sql/05_mcp_runtime.sql`)
can only SELECT.

## HTTP

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /mcp` | yes | MCP Streamable HTTP, stateless (no `Mcp-Session-Id`, JSON responses, body <= 256 KiB) |
| `GET`/`DELETE /mcp` | yes | 405 (no SSE stream, no sessions) |
| `GET /health` (`/healthz`) | no | 503 until the embedding model is loaded, then 200 |
| `GET /.well-known/oauth-protected-resource[/mcp]` | no | RFC 9728 metadata: `resource` = `<base>/mcp`, authorization server `https://accounts.google.com`, scopes `openid email` |

Everything else is deny-by-default (401 without credentials, 404 with). A
401 carries `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.

## Authentication (`src/auth.ts`)

Checked in order; all callers are read-only:

1. **Static key** `yapa_sk_<kid>_<secret>` in `X-Yapa-Key` (or
   `YAPA_MCP_KEY_HEADER`) or `Authorization: Bearer`. Looked up by kid in
   `YAPA_MCP_STATIC_KEYS`, sha256 compared in constant time. Acts as its
   `svc-*` principal. Create one with `node scripts/new-static-key.mjs svc-adp`.
2. **Google ID token** (a JWT): signature, `aud` in `YAPA_MCP_OAUTH_CLIENT_IDS`,
   issuer, `email_verified`, `hd` = `YAPA_ALLOWED_HD` (the service's verifier).
3. **Google access token** (opaque, what ADP's User OAuth usually sends):
   tokeninfo (POST) must show `aud` or `azp` in `YAPA_MCP_OAUTH_CLIENT_IDS`,
   an email scope, a future `exp` and a verified email; userinfo must show
   `hd` = `YAPA_ALLOWED_HD`. Verified identities are cached by sha256(token)
   for min(exp, 5 min), up to 5,000 entries. Google 4xx -> 401, 5xx/timeout -> 503.

People then map to an active `users` row by email (auto-provisioned with
`YAPA_AUTO_PROVISION=true`, never as `svc-*`), exactly like yapa-service.
Rejections log `{"event":"auth_failure","reason":...}` (no tokens, no emails).

## Tools (`src/tools.ts`)

| Tool | Arguments | Notes |
|------|-----------|-------|
| `memory_recall` | `query`, `collection?`, `n_results` (<= 20), `other_collections` (<= 5) | server-side embedding, pgvector cosine, overfetch x4, reranked with core's `rankScore` (distance - salience bonus); archived/superseded/promoted hidden; cross-collection extras only below distance 0.45, labeled "other collection" |
| `memory_list` | `collection`, `limit` (<= 100), `cursor?` | newest first, keyset cursor |
| `task_list` | `id?`, `collection?`, `status?`, `priority?`, `include_complete?` | `id` returns full detail (notes, deps, owner) |
| `task_search` | `query`, `collection?` | top 10 by similarity |
| `collection_list` | | shared collections with counts |
| `collection_changes` | `collection`, `since` (ISO or Unix seconds) or `cursor` | the sync pull feed (own device included, no embeddings): compact items + deletions + next cursor, for status digests |

`global`, `private-*` and `local-*` never exist on the service and are
refused. Results name the collection and author (`by alice, edited by bob`);
content is cut at 4 KiB per item and 64 KiB per result. Rate limits per
username (per instance): `read` 10/s burst 60 per request (429 +
`Retry-After`), `embed` 2/s burst 20 per embedding tool call (tool error).
One log line per call: `{"event":"mcp_call","actor","kind","tool","collections","result_count","latency_ms","request_id","outcome"}`;
arguments are never logged.

Write tools: `registerWriteTools` in `src/tools.ts` is the hook for phase 2
(gated by `YAPA_MCP_WRITES=true` and `caller.kind === 'user'`); it registers
nothing today.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8080` | listen port |
| `YAPA_ALLOWED_HD` | (required) | Workspace domain people must belong to |
| `YAPA_MCP_OAUTH_CLIENT_IDS` | | comma-separated OAuth client ids accepted as `aud`/`azp` (the "YAPA ADP" web client) |
| `YAPA_MCP_STATIC_KEYS` | | JSON `{"<kid>": {"principal": "svc-adp", "sha256": "<hex>"}}` (Secret Manager); at least one of this and the client ids is required |
| `YAPA_MCP_KEY_HEADER` | `x-yapa-key` | extra header for static keys |
| `YAPA_MCP_PUBLIC_URL` | request origin | https base URL for the metadata and `WWW-Authenticate` |
| `YAPA_AUTO_PROVISION` | `false` | create users rows on first sign-in |
| `YAPA_MCP_MODEL_DIR` | library default | model cache dir (`/app/models` in the image) |
| `YAPA_MCP_ALLOW_REMOTE_MODELS` | `true` | `false` in the image: never download |
| `YAPA_MCP_TOOLS` | `memory_recall` | read tools to expose: comma-separated names, or `all` (others are never registered) |
| `YAPA_MCP_WRITES` | `false` | reserved for phase 2; no effect yet |
| `YAPA_RATE_LIMITS` | `on` | `off` for local tests |
| `YAPA_AUTH_MODE` | `google` | `insecure-test` accepts `Bearer test:<email>` unverified; refused on Cloud Run |
| `YAPA_DATABASE_URL` / `YAPA_INSTANCE_CONNECTION_NAME` + `YAPA_DB_USER` + `YAPA_DB_NAME`, `YAPA_DB_IP_TYPE`, `YAPA_DB_POOL_MAX`, `YAPA_STATEMENT_TIMEOUT_MS` | | as for yapa-service |

## Local run and tests

```sh
npm run build                     # repo root: core -> service -> mcp-remote
YAPA_AUTH_MODE=insecure-test YAPA_DATABASE_URL=postgres://... node packages/mcp-remote/dist/server.js
npx @modelcontextprotocol/inspector   # Streamable HTTP, http://localhost:8080/mcp, header Authorization: Bearer test:you@<domain>
npm test -w packages/mcp-remote
YAPA_SERVICE_IT_DATABASE_URL=postgres://postgres:it@localhost:55432/postgres npm run test:integration -w packages/mcp-remote
```

The integration suite reuses `packages/service/test/pgsetup.ts` (schema
00-04) and applies `05_mcp_runtime.sql` for a separate non-owner login.
The image (`Dockerfile`, build from the repo root) downloads the model at
build time (`scripts/fetch-model.mjs`) into a read-only `/app/models`.
