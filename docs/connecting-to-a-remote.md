# Connecting YAPA to a remote

How to point YAPA at a remote that already exists and implements
[YAPA Sync API v1](sync-api.md): the YAPA sync service your team runs, or
another service that speaks the same API. You need its base URL from whoever
runs it, and a Google account it admits.

> **WARNING: the first sync sends your shared collections to the remote.**
> When sync is enabled and a URL is set, the next sync cycle (within seconds
> of starting Claude Code) pushes every document YAPA has not synced yet in
> every shared collection on this machine, that is every collection except
> `global`, `private-*` and `local-*`. On an install that never synced, that
> is ALL of your project and customer memories and tasks. Everyone with
> access to that remote can read them.
>
> To evaluate a remote first, use the conformance runner or a fresh data
> directory (see "Evaluating a remote safely" below), not your everyday
> install. Move anything that must not leave this machine into a `private-*`
> collection before you connect.

## 1. Configure

Plugin install: in Claude Code run `/plugin`, pick `yapa@yapa`, then
Configure options (or `claude plugin configure yapa@yapa`):

| Option | Value |
|---|---|
| `sync_enabled` | `true` |
| `sync_service_url` | the remote's base URL, e.g. `https://sync.example.com` |

The URL may include a path prefix, e.g. `https://example.com/api/yapa`: YAPA
appends `/v1/...` to whatever you give it, and ignores a trailing slash. Use
`https://` (plain `http://` only works for local testing). When a service URL
is set, `sync_database_url` is ignored.

MCP server install (no plugin): set the same values as environment variables
in your MCP host config: `YAPA_SYNC_ENABLED=true` and
`YAPA_SYNC_SERVICE_URL=<base URL>`.

## 2. Sign in

```sh
gcloud auth login            # the Google account the remote admits
gcloud auth print-identity-token >/dev/null && echo ok
```

YAPA runs `gcloud auth print-identity-token` for a short-lived (1 h) Google ID
token, refreshes it before it expires, and caches the current one in a 0600
file (`~/.local/share/yapa/id-token`; `YAPA_SYNC_ID_TOKEN_CACHE` moves it,
`off` keeps it in memory only). No database credentials are involved.

If your token has to come from somewhere else (a service account, another
OAuth client), set `YAPA_SYNC_ID_TOKEN_CMD` to a command that prints one. The
remote must accept that token's audience; plain `gcloud` user tokens have the
gcloud CLI's audience, which the remote's admin has to allow.

## 3. Verify

Restart Claude Code (quit and start again), then ask:

```
Is my YAPA sync working?
```

Claude runs the `sync` tool with `action: 'status'`. Expect:

```
Backend: YAPA sync service
Service: https://sync.example.com
Signed in as: <your-username> (<you>@<domain>)
Connection: healthy
```

Your username comes from the remote (it maps your Google account to a name);
task ids look like `<your-username>-<n>`, and the `username` option is
informational while syncing.

| You see | Meaning |
|---|---|
| `rejected the sign-in (401)` | run `gcloud auth login`, or fix `YAPA_SYNC_ID_TOKEN_CMD`; or the remote does not accept your token's audience |
| `not mapped to a YAPA user` | your account is not a member; ask the remote's admin |
| `unreachable` | wrong host, network, or VPN |
| `sync service error 404 http_404` | the URL answers but is not the API: check the path prefix |

## What syncs

- Shared collections only: anything except `global`, `private-*` and
  `local-*`. Those three never leave the machine, not even to your other
  devices.
- Memories, tasks and consolidated session journals. Journal drafts stay
  local.
- A collection syncs once you write to it or follow it: starting Claude Code
  in a project folder follows that project's collection; `sync` with
  `action: 'subscribe'` follows one you have no folder for.
- The remote decides who may do what: only the owner deletes a shared row,
  content that looks like a secret is refused (it stays local, listed in
  `sync status`), and documents the remote marks read-only cannot be edited
  or deleted from YAPA.

## Evaluating a remote safely

**Conformance runner (touches no local data).** From a clone of this
repository:

```sh
npm install
gcloud auth login
npm run conformance -- https://sync.example.com/api/yapa
```

It signs in, pushes and pulls through temporary local stores, exercises
deletes and coordination, and writes only to a throwaway collection
`project-yapa-it-<run>` that it cleans up (see
[sync-api.md section 11](sync-api.md#11-conformance)).

**Fresh data directory (try it in Claude Code).** Start Claude Code from a
shell that points YAPA's local state somewhere new, so the first sync has
nothing of yours to push:

```sh
export YAPA_LOCAL_STORE_PATH=~/yapa-eval/store      # the embedded store (storage = local)
export YAPA_DEVICE_ID_PATH=~/yapa-eval/device-id    # this install's device id
export YAPA_LEASE_STATE_DIR=~/yapa-eval/leases      # lease heartbeat markers
claude
```

This relies on the `storage` option being `local` (the plugin default). With
`storage = chroma`, your data lives in the ChromaDB server instead: point
`chroma_url` at a separate, empty ChromaDB for the evaluation. Plugin options
apply to every Claude Code session, so while `sync_service_url` points at the
remote under evaluation, start Claude Code only from that shell; afterwards,
clear or restore `sync_service_url` before starting it normally.

## Switching from another remote

The local store remembers its last pull point and which docs are already
synced, and both belong to the remote it synced with before. After switching
URLs, docs already synced to the old remote are not re-sent, and collections
you already follow do not backfill the new remote's older documents. To start
clean against the new remote, use a fresh data directory (above) and let the
first pull rebuild it.

## Disconnecting

Set `sync_enabled` to `false` (or clear `sync_service_url`) and restart.
Local memories and tasks stay as they are. What was pushed stays on the
remote: delete your own documents with `memory_forget` / `task_delete` while
still connected, or ask the remote's admin.
