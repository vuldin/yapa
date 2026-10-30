# YAPA team pilot: onboarding

For CSEs joining the YAPA team pilot. Takes about 10 minutes. YAPA gives
Claude Code persistent memory and tasks, and with team sync you see
teammates' memories and tasks for the same customer or project.

Ask the pilot admin for the sync service URL (`<SERVICE_URL>` below).
Already using YAPA, or connecting to some other remote? Read
[Connecting to a remote](connecting-to-a-remote.md) first: the first sync
pushes every shared collection on this machine to the remote.

> **How to use the prompts below:** each **Type this message** block is a plain
> message to type into Claude Code (no leading `/`). Claude calls the YAPA tools for you
> (`sync`, `memory_store`, `task_create`, ...). The `/` menu only lists slash
> commands and skills, not tools; to see the tools, run `/mcp` and open the
> `plugin:yapa:yapa` server.

## 1. Prerequisites

- Claude Code, recent version (`claude --version`).
- Node.js 20+ (`node --version`).
- gcloud CLI, signed in with your **company** Google account:

  ```sh
  gcloud auth login            # pick your @<company-domain> account
  gcloud auth list             # the company account must be ACTIVE
  gcloud auth print-identity-token >/dev/null && echo ok
  ```

  No GCP project or IAM roles are needed. YAPA only runs
  `gcloud auth print-identity-token` to get a short-lived (1 h) Google ID
  token and refreshes it before it expires. The current token is cached in a
  0600 file (`~/.local/share/yapa/id-token`; `YAPA_SYNC_ID_TOKEN_CACHE=off`
  keeps it in memory only) so hooks don't mint a new one on every prompt.

## 2. Install

```sh
claude plugin marketplace add vuldin/yapa
claude plugin install yapa@yapa
```

Pilots pinned to v1.0 add the tagged marketplace instead:
`claude plugin marketplace add vuldin/yapa#v1.0.0`.

## 3. Configure

In Claude Code run `/plugin`, pick `yapa@yapa`, then Configure options (or
from a shell: `claude plugin configure yapa@yapa`). Set:

| Option | Value |
|---|---|
| `sync_enabled` | `true` |
| `sync_service_url` | `<SERVICE_URL>` |
| `storage` | `local` (default; no server needed) |
| `project_roots` | folders whose subfolders are customers/projects, e.g. `~/work/projects` |
| `customers` | subfolder names under those roots that are customers, e.g. `acme,globex` |
| `username` | leave as is; with the sync service your name comes from your Google account |
| `response_capture` | optional; `true` auto-saves durable findings after each turn |

How scope works: with `project_roots=~/work/projects` and `customers=acme`,
starting Claude Code in `~/work/projects/acme/...` uses collection
`customer-acme`; `~/work/projects/tools/...` uses `project-tools`. Anything
else is `global` (local-only, see Privacy).

## 4. Restart and verify

Restart Claude Code (quit and start again). Then ask:

**Type this message:**
```
Is my YAPA sync working?
```

Expected: Claude checks sync status and reports lines like:

```
Backend: YAPA sync service
Service: <SERVICE_URL>
Signed in as: <your-username> (<you>@<company-domain>)
Connection: healthy
```

Your username is the local part of your company email (for example
`jane.doe@...` becomes `jane-doe`). Task ids look like `<your-username>-<n>`.

## 5. Subscribe to shared collections

Usually nothing to do: the first time you start Claude Code in a project or
customer folder, YAPA pulls that collection's full history and keeps
following it. Writing to a collection also subscribes you.

To follow a teammate's collection you have no folder for:

**Type this message:**
```
What shared YAPA collections are there?
```

**Type this message:**
```
Subscribe me to customer-acme and project-cs-team.
```

Subscribing backfills the full history of that collection. Unsubscribing
stops pulling but keeps what is already on your machine.

## 6. What you will see

On every prompt YAPA injects a `# YAPA Context` block into Claude's context
(you do not see it unless you ask Claude to show it):

- the detected scope (collection),
- the top 3 memories relevant to your prompt,
- at session start: open tasks and top memories for the collection (journal
  notes from earlier sessions are memories too, so they surface here).

Labels on injected items:

- `by <user>`: a teammate wrote it. Your own items have no label.
- `from <collection>`: the hit comes from a different collection than the
  current scope.

Before injecting, the hook pulls the active collection, so a teammate's
memory from seconds ago shows up on your next prompt. A background sync
also runs every 5 minutes.

Useful asks: "what do we know about acme's upgrade plan", "create a task to
send acme the sizing doc by Friday", `/yapa:standup` (overdue, due today, in
progress and blocked tasks; teammates' tasks marked `(by <user>)`).

## 7. Privacy rules

- `global`, `private-*` and `local-*` collections never leave your machine,
  not even to your other devices.
- Everything else (`customer-*`, `project-*`) is readable by **every
  employee** who uses YAPA. There are no per-collection ACLs in the pilot.
  Put restricted material in a `private-*` collection.
- Content that looks like a secret (keys, tokens, passwords) is refused by
  the service. It stays local and unsynced and is listed in the sync status;
  edit it out and it is retried.
- Teammates can edit shared items (last writer wins). Only the author can
  delete a shared item; deleting a teammate's item removes it from your
  machine only.

## 8. Troubleshooting

Start by asking "Is my YAPA sync working?"; the `Connection:` and `Last error:` lines
say what is wrong.

| Symptom | Cause | Fix |
|---|---|---|
| `401` / "rejected the sign-in" / "Run gcloud auth login" | no or expired gcloud login | `gcloud auth login` with the company account, then restart Claude Code |
| `403` "Cloud Run refused the request" | gcloud is signed in with a non-company account | `gcloud auth list`, `gcloud config set account <you>@<company-domain>` (or `gcloud auth login`), restart |
| "not mapped to a YAPA user" | your derived username belongs to someone else | ask the admin to map you (`scripts/yapa-user.sh rename-conflict`) |
| "your YAPA user is disabled" | admin disabled the account | ask the admin |
| "Remote sync is disabled" | `sync_enabled` not set | set it (step 3) and restart |
| A teammate's item is missing | not subscribed, or not pulled yet | ask "Subscribe me to <collection>" or "Sync YAPA now" |
| Item listed as refused in the sync status | secret check matched | remove the secret from the memory/task |

## 9. Reporting issues

Post in the pilot Slack thread and file a YAPA task using
[pilot-feedback-template.md](pilot-feedback-template.md). Always include the
answer to "Is my YAPA sync working?" (it has no secrets; trim emails if you prefer).

## 10. Rollback

```sh
claude plugin disable yapa@yapa      # stop YAPA; re-enable later with: claude plugin enable yapa@yapa
claude plugin uninstall yapa@yapa    # remove the plugin
```

Your local memories and tasks stay on disk either way, and your shared items
stay on the service, so re-enabling picks up where you left off.
