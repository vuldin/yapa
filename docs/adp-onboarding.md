# YAPA in Redpanda ADP (remote MCP, josh-313)

## What it is

`yapa-mcp` is a Cloud Run service that exposes the team's **shared** YAPA
memories and tasks (the `customer-*`, `project-*`, ... collections people sync
from their plugins) as an MCP server. ADP (Agentic Data Plane) registers it
as a **Remote (Proxied)** MCP server over **Streamable HTTP**, so an agent in
ADP can answer "what's going on with customer X" from the same notes the
team keeps in YAPA.

**It is read-only for now**, and by default exposes a single tool,
`memory_recall`: users just ask their question in plain words, and the
customer it names ("what's new with Acme?") is detected automatically, so
nobody needs to know YAPA's collection names. The deployment can also expose
`memory_list`, `task_list`, `task_search`, `collection_list` and
`collection_changes` (Terraform `tools = ["all"]`, env `YAPA_MCP_TOOLS`).
Nothing can be stored, changed or deleted through it. Personal collections (`global`,
`private-*`, `local-*`) never leave a laptop, so they are not visible here.
Every result says which collection it came from and who wrote it.

Code: `packages/mcp-remote`. Infrastructure: `infra/mcp-remote`.

## How ADP authenticates

Two modes, both supported at the same time:

| ADP auth mode | What ADP sends | Who the call runs as |
|---------------|----------------|----------------------|
| **User OAuth** (per-user delegated, Google) | the colleague's Google access token (or ID token) as `Authorization: Bearer ...` | that colleague's YAPA user (must be in the company Workspace domain, and mapped or auto-provisioned) |
| **Static Key** | a shared `yapa_sk_...` key in `Authorization: Bearer` or `X-Yapa-Key` | a service principal such as `svc-adp` |

User OAuth is preferred: results are attributed per person in logs, and a
departing colleague loses access with their Google account. The static key is
for shared agents and pipelines without a user.

## Admin setup

### 1. Google OAuth client "YAPA ADP" (User OAuth mode)

In the team GCP project, Google Auth Platform (APIs & Services -> OAuth consent screen):

1. If no consent screen exists: **Get started**, app name `YAPA`, audience
   **Internal** (Workspace users only, no verification needed).
2. **Data access**: scopes `openid` and `.../auth/userinfo.email` only.
3. **Clients -> Create client**: type **Web application**, name `YAPA ADP`.
   Under **Authorized redirect URIs** add ADP's OAuth callback URL (shown in
   ADP when you create the User OAuth provider, step 2). Create, and copy the
   client id and secret. Keep the secret out of git and out of YAPA.
4. Add the client id to `oauth_client_ids` in `infra/mcp-remote/terraform.tfvars`
   (it becomes `YAPA_MCP_OAUTH_CLIENT_IDS`) and deploy
   (`STATE_BUCKET=<bucket> infra/mcp-remote/deploy.sh`).

Why the client id matters: the service only accepts tokens whose `aud`/`azp`
is this client, so a Google token issued to any other app is refused.

### 2. ADP User OAuth provider

In ADP, create a User OAuth provider for Google with:

- authorization URL `https://accounts.google.com/o/oauth2/v2/auth`,
  token URL `https://oauth2.googleapis.com/token`;
- the client id and secret from step 1;
- scopes `openid email`.

Each colleague then connects their Google account once in ADP.

### 3. Static key (Static Key mode, optional)

Create a key (from the repo root; prints the key once and the JSON entry with
its sha256):

```sh
node packages/mcp-remote/scripts/new-static-key.mjs svc-adp
```

1. Paste the key into ADP's Static Key auth (header `Authorization` with
   `Bearer <key>`, or a custom header `X-Yapa-Key` with the bare key; another
   header name needs `key_header` in tfvars). Do not store it anywhere else.
2. Merge the JSON entry into the secret (hashes only) and roll it out:

   ```sh
   gcloud secrets versions access latest --secret yapa-mcp-static-keys > keys.json   # current entries
   # edit keys.json: add the new "<kid>": {...} entry
   gcloud secrets versions add yapa-mcp-static-keys --data-file=keys.json && rm keys.json
   # set static_keys_version = "<new version number>" in terraform.tfvars, then
   terraform -chdir=infra/mcp-remote apply -var "image=<current image>"
   ```

**Rotation:** create a new key (new kid), add its entry next to the old one,
roll out, switch ADP to the new key, then remove the old entry and roll out
again. **Revocation:** remove the entry and roll out. Principals must be
`svc-*` names; they need no `users` row and can only read.

### 4. Register the server in ADP

- Type: **Remote (Proxied)** MCP server
- Transport: **Streamable HTTP**
- URL: `<service_url>/mcp` (`terraform -chdir=infra/mcp-remote output -raw mcp_endpoint`)
- Auth: the User OAuth provider from step 2, or the static key from step 3

The service is stateless (no MCP sessions). It also publishes OAuth
protected-resource metadata at `<service_url>/.well-known/oauth-protected-resource`
for clients that discover auth automatically.

## Using it

Example prompts for an ADP agent with the YAPA server attached:

- "Draft a status update for customer X from YAPA."
  (The agent calls `memory_recall` with the question; customer X's memories
  rank first, each result is a whole memory with its author and date, and the
  customer's open follow-ups are listed after them, highest priority first.)
- "What do we know about customer X's upgrade plan?"
- "Have we seen consumer lag after an upgrade at any other customer? Search YAPA."

With `tools = ["all"]` the agent can also list open tasks (`task_list`) and
pull "what changed since Monday" (`collection_changes`).

Review drafts before sending: memories are team notes, not vetted facts, and
the content of each item is cut at 4 KiB.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| 401, log reason `wrong_audience` | the token was issued to a different OAuth client than `YAPA_MCP_OAUTH_CLIENT_IDS` |
| 401, `missing_email_scope` | the ADP provider lacks the `email` scope |
| 401, `wrong_hd` | personal Google account, or another Workspace domain |
| 403 `not_member` | no `users` row for that email and auto-provisioning is off |
| 401, `bad_key` / `unknown_key` | wrong or revoked static key, or the secret version was not rolled out |
| 503 | Google tokeninfo/userinfo or the database unreachable; retry |
| 429 | per-user rate limit (`Retry-After` seconds) |
