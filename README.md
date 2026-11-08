# YAPA — Yet Another Personal Assistant

YAPA gives your AI agent memory and tasks that last across sessions. It remembers what you decided, what you found and what's left to do, keeps that knowledge organized by project or customer, and can share it with your team. It works offline first: everything lives on your machine, and sync is optional.

- **Memory** — findings, decisions, preferences and fixes, stored with semantic search and surfaced when they're relevant.
- **Tasks** — priorities, due dates, dependencies, recurring tasks, and claims so two sessions (or two people) don't start the same work.
- **Collections by folder** — a session's folder decides where its notes go (`project-api`, `customer-acme`, `private-notes`, `global`), from rules you set once.
- **Capture as you work** — after each turn YAPA stores what was learned, and records answers to open decisions and questions.
- **Team sync** (optional) — shared collections sync with a remote; private ones never leave your machine.

YAPA has two frontends over the same core:

- **Claude Code plugin** — the MCP server, the always-on hooks, the status line and skills in one install. The same server also runs under other MCP hosts (Cursor, OpenCode, `claude mcp add`).
- **DeepSeek Harness (DSH) plugin** — a native cordis plugin: the tools with a `yapa_` prefix (all but leases and counters, plus status and storage import), context injected at the turn seam, capture of every turn, and a daily contradiction janitor. No hooks and no MCP subprocess.

## Install

### Claude Code

```
claude plugin marketplace add vuldin/yapa
claude plugin install yapa@yapa
```

That's all: Claude Code installs the runtime dependencies, and the plugin brings the MCP server (with YAPA's standing rules as its instructions), the hooks, the status line and the `/yapa:standup`, `/yapa:work` and `/yapa:statusline` skills. Storage is the embedded local store, so no database server is needed. Options can be set at install with `--config key=value` (for example `--config remote_name=acme`), or later with `/plugin` → Configure options. See [Configuration](docs/configuration.md).

For a whole team, add the marketplace and enable the plugin in managed or repo settings (`extraKnownMarketplaces` and `enabledPlugins: {"yapa@yapa": true}`).

### DeepSeek Harness

Add the package to a DSH profile and register the plugin row; the embedded store is the default, so there's nothing else to run. Steps and settings: [packages/dsh/install.md](packages/dsh/install.md). How it plugs into DSH: [packages/dsh/architecture.md](packages/dsh/architecture.md).

### Other MCP hosts (`claude mcp add`, Cursor, OpenCode)

Run the prebuilt server from a clone:

```
git clone https://github.com/vuldin/yapa && cd yapa/plugin && npm install --omit=dev
claude mcp add -s user -t stdio -e YAPA_USERNAME=you -e YAPA_STORAGE=local yapa -- node "$PWD/dist/yapa-mcp.mjs"
node dist/yapa.mjs hooks install      # Claude Code only: the always-on hooks, in ~/.claude/settings.json
```

- Set `YAPA_STORAGE=local` as shown: outside the plugin, the default storage is a ChromaDB server at `localhost:8000`.
- The hooks read the same `-e` settings from the `yapa` entry in `~/.claude.json`, so they always agree with the server. YAPA's standing rules come with the server, as its MCP instructions, so every host that loads them gets them. `hooks install` replaces YAPA hooks from an older install instead of adding a second set, and `hooks uninstall` removes only YAPA's.
- **Cursor and OpenCode:** register the same command, `node <clone>/plugin/dist/yapa-mcp.mjs`, as a local (stdio) MCP server in their config, with `YAPA_STORAGE=local` and `YAPA_USERNAME` in its environment. These hosts have no hooks, so the per-prompt recall, the capture after each turn and the session-start context don't run there. The agent works from the standing rules (the server's instructions, where the host loads them) and the tools. YAPA takes the session's folder from the server's working directory, so if the host starts the server somewhere else, every folder is `global` and new shared collections are refused.

## Getting started

1. **Tell YAPA where your projects are.** A project root is a folder whose subfolders are projects. Ask the agent ("make `~/work` a YAPA project root"), or run `yapa scope add-root ~/work`. Until you add one, every folder uses `global`.
2. **Work as usual.** A session in `~/work/api` reads and writes `project-api`. The scope line at the top of the injected context names the collection.
3. **Keep a folder private** if it needs to be: `yapa scope map ~/work/acme-notes private-acme`.
4. **Connect a team remote** (optional): see [Sync](#sync).

## How it works

### Collections and folder rules

A session's folder decides its collection, from three rules in one file on this machine, `~/.local/share/yapa/scope.json`:

- **Project roots:** `~/work` makes `~/work/api` use `project-api` (or `customer-api`, when that collection exists or `api` is a listed customer). The root itself, and anything outside every root, uses `global`.
- **Customers:** folder names under a root that are customers.
- **Folder mappings:** a folder and everything below it uses one named collection, ahead of the roots. This is how a folder gets a `private-*` collection.

The file is the only place these are set. The Claude Code hooks and tools, the CLI and DSH all read it, and a change applies on the next hook or tool call, with no restart. Edit it with `yapa scope`, or ask the agent, which uses its `scope` tool only when you ask:

```
yapa scope list                          # the rules, and what they mean for this folder
yapa scope add-root ~/work               # its subfolders are projects
yapa scope add-customer acme             # ~/work/acme uses customer-acme
yapa scope map ~/notes/acme private-acme # this folder (and below) uses private-acme
yapa scope unmap ~/notes/acme            # also: remove-root, remove-customer
yapa scope records-elsewhere add private-acme  # its project keeps its own records
```

**Projects with their own records.** A project that keeps its findings, decisions and questions in its own files can mark its collection with `yapa scope records-elsewhere add`. There, only what the project publishes with `yapa memory put --ref` is typed. Capture, `learned` items and other writes are stored as plain notes, so "Waiting on you" shows the project's items, not copies of them. See [Projects with their own records](docs/collections.md#projects-with-their-own-records).

**New shared collections only come from project roots.** An agent can name any collection on a write. One that would create a new shared collection is refused unless the session's folder is under a project root, or is mapped to exactly that collection, and the refusal suggests a `private-` name. Shared collections that already exist here can be written from anywhere. With no project roots and no folder mapped to a shared collection, nothing new is shared.

More, including symlinks, mappings inside roots and merging a shared collection into a private one: [Collections and folder rules](docs/collections.md).

### Each turn

In Claude Code the hooks do this; in DSH the plugin does it at the turn seam, with its standing rules in the system prompt.

- **Session start** injects the open tasks, what waits on you (decisions to make, questions to answer, steps only a person can take) and the top memories. It's kept under Claude Code's 10,000-character limit for hook context (longer, and the model would see only a 2,000-character preview): when a store is crowded, the least useful sections shrink (to fewer items, a pointer to the tool that lists them, or nothing for the top memories and compaction candidates). `YAPA_SESSION_START_MAX_CHARS` sets the budget (default 9,000). The standing rules aren't part of it: they're the MCP server's instructions, loaded once with the tools.
- **Every prompt** gets the top recall matches for what you asked, from the active collection plus a few strongly relevant hits from other collections, each labeled with where it came from. Those extra hits never come from a `private-*` or `local-*` collection. A hit already shown earlier in the session is named by its id with a short preview instead of being repeated, since it's still in context. It's shown again if it was edited (its end, where edits and notes land), and in full after a compaction or `/clear` and in a new session; a resumed session keeps the list, since it keeps the conversation. In Claude Code the hooks first pull the collection from the remote, so a teammate's write from seconds ago is included; DSH gets it from its background sync.
- **After each turn** an aux model judges the turn. It stores durable findings as typed memories (finding, decision, limitation, question, idea), deduplicated and linked to the task the session holds, and it records what the turn settled in open decisions and questions. A task waiting on a decision comes back by itself once it's made. In Claude Code, without a curation API key it uses `claude -p --model haiku`; DSH uses its own model routing. `yapa capture status` shows whether this is working.
- **Context compaction** stores Claude Code's or DSH's compaction summary as a memory, so it outlives the context window.

Every hook fails open: on error the session continues without YAPA's context.

### Memory

Each memory has a salience score that rises when it's used and decays with time, and it weights recall ranking. Nothing is deleted by decay; low-salience memories just surface less. Long content is split into overlapping chunks that are searched on their own. A write that comes close to an existing memory returns it as a possible conflict, and the agent supersedes it (the old one is archived, recoverable) or keeps both. When a collection grows large, YAPA suggests compacting groups of similar memories into rolling summaries. Embeddings run in-process (MiniLM by default, no API key), or through an HTTP provider. Details: [Memory](docs/memory.md).

### Tasks and what waits on people

- **Claims:** setting a task to `in_progress` claims it. In a shared collection the claim is a lease on the sync service, so a teammate's session is refused with who holds it and since when. In a local-only collection, or with sync off, this machine coordinates, so your own sessions don't collide. A claim lapses two hours after its session goes quiet.
- **The ready queue:** `task_next` offers what to start next: tasks that are pending, unblocked and unclaimed, ranked by priority, due date and how much each unblocks. `/yapa:work` runs the loop: take the next task, do it, record what it produced, complete it, repeat.
- **Closing work records it:** `task_complete` takes `learned` (typed memories linked to the task) and `follow_ups` (new tasks). A choice only a person can make is recorded with `decision_needed`, and the task waits on it.
- **`waiting`** lists everything waiting on a person, and session start shows what waits on you.
- **Recurring tasks** (daily, weekly, monthly, quarterly, yearly, or every N of those) come back in their calendar slot when completed, start from the series' notes, and stay out of task lists until a few days before they are due.

Details: [Tasks, claims, and what waits on people](docs/tasks.md).

### Sync

Shared collections can sync with a remote that implements [YAPA Sync API v1](docs/sync-api.md), reached over HTTP (`sync_service_url`) or as an MCP tool (`sync_mcp_url`). This repo includes one, the YAPA sync service ([`packages/service`](packages/service/README.md)). Turn on `sync_enabled`, set the remote, and sign in. Then:

- Writes push within seconds.
- In Claude Code, the hooks pull the active collection before each prompt, so a teammate's memory from a minute ago shows up on your next one.
- A background cycle runs every 5 minutes, one per machine.

Teammates' items are labeled `by <user>`. With the sync service, only the owner can delete a shared row, and deletes are restorable for 30 days.

The status line under the prompt shows the version, the remote and sync health, for example `yapa@v1.16.0 <-> acme ● synced 2m ago | project-api`. When your sign-in lapses it says so, with the command to fix it.

Before connecting, read [Connecting to a remote](docs/connecting-to-a-remote.md): the first sync pushes every shared collection on this machine. How sync works: [Sync](docs/sync.md).

### Token cost

In one user's measured sessions, YAPA added about 4.5–5% to a session's token cost. That's mostly the recall hits and tool results that stay in context, plus a few cents an hour of Haiku for the capture after each turn. Finding relevant memories costs no tokens, since semantic search runs locally with MiniLM. It can save more than it costs when work keeps returning to the same projects and problems, because a recalled memory replaces re-discovering it, but the data can't show how much each reuse saved. The measurements and their limits: [Token cost](docs/cost.md).

### Privacy

- `private-*`, `local-*` and `global` collections never sync, not even to your other machines.
- A private collection's notes stay out of the extra hits other collections' recall adds, and session start in a shared collection only counts its open items. A search with no collection, or one that names the private collection, still finds them, and `global` shows up everywhere: keep secrets out of it.
- Nothing reaches a remote unless you turn sync on, and then only shared collections do.
- When one of your documents moves into a private collection, it's retracted from the remote; teammates' documents stay shared.

## The `yapa` CLI

The CLI ships with the plugin as `dist/yapa.mjs` (Claude Code keeps the plugin under `~/.claude/plugins/cache/yapa/yapa/<version>/`; in a clone it's `plugin/dist/yapa.mjs`). Run it with `node`, or alias it: `alias yapa='node <path>/dist/yapa.mjs'`. Inside a session you rarely need it, since the agent has the same operations as tools.

| Command | What it does |
|---|---|
| `yapa scope …` | Show or change the folder rules; `yapa scope --cwd DIR --text` prints the collection a folder uses (for scripts) |
| `yapa task list\|next\|claim\|release\|show` | Tasks and claims for scripts, as JSON (exit 0 done, 3 refused, 4 not shared, 5 completed but its next occurrence wasn't created) |
| `yapa memory list\|put\|update\|sweep-findings\|untype` | Typed memories for scripts; `put --ref` publishes a record kept elsewhere; `untype` turns earlier copies into notes |
| `yapa waiting` | Decisions, questions and steps waiting on a person |
| `yapa coord …` | Bare leases and counters for resources that aren't tasks |
| `yapa capture status` | Whether the per-turn capture is working |
| `yapa statusline install\|uninstall\|show` | The status line |
| `yapa hooks install\|uninstall\|print` | The Claude Code hooks, for a `claude mcp add` install |

## Configuration

The settings most people touch:

| Plugin option (env var) | Default | Meaning |
|---|---|---|
| `storage` (`YAPA_STORAGE`) | `local` in the plugins; `chroma` for a server registered by hand | The embedded store, or `chroma` for a ChromaDB server |
| `sync_enabled`, `sync_service_url` or `sync_mcp_url` | off | Team sync with a remote (see [Sync](#sync)) |
| `remote_name` | empty | Your remote's name on the status line |
| `response_capture` | on | Capture and record after each turn |
| `statusline` | on | Add YAPA's status line to Claude Code |
| `username` (`YAPA_USERNAME`) | OS login | Your name on task ids and synced documents (with a remote, the remote's name for you) |

Folder rules aren't options: they're in the scope file above. Everything else, including the DSH settings: [Configuration](docs/configuration.md).

## Upgrading and uninstalling

- **Upgrade:** `claude plugin marketplace update yapa && claude plugin update yapa@yapa`, then restart Claude Code. The status line says when a new release is out, and when a session still runs an older one. [CHANGELOG.md](CHANGELOG.md) lists what changed and any upgrade steps.
- **Uninstall:** first `node ~/.local/share/yapa/statusline.mjs --uninstall`, which removes YAPA's status line (and restores one it wrapped). Then `claude plugin uninstall yapa@yapa`; for a `claude mcp add` install, `node <clone>/plugin/dist/yapa.mjs hooks uninstall`, `claude mcp remove yapa`, then delete the clone. Your data stays in `~/.local/share/yapa` unless you delete it.

## Documentation

- [Collections and folder rules](docs/collections.md): folder rules, private collections, the recall fence, merging and redirects
- [Memory](docs/memory.md): salience, chunking, contradictions, journals, compaction, embedding providers
- [Tasks, claims, and what waits on people](docs/tasks.md): claims, the ready queue, recurring tasks, local coordination, typed memories
- [Sync](docs/sync.md): connecting, the status line, how a cycle works, deletes and purges, a direct database, testing
- [Connecting to a remote](docs/connecting-to-a-remote.md) and the [Sync API](docs/sync-api.md)
- [Tools and hooks](docs/tools.md): every tool and hook
- [Configuration](docs/configuration.md): every option and variable
- [Token cost](docs/cost.md): what YAPA adds to a session's tokens, and what it can save
- [Training pipeline](docs/training-pipeline.md): the optional ML-ops tools
- Team pilot: [onboarding](docs/pilot-onboarding.md), [two-person test](docs/second-user-test.md), [feedback](docs/pilot-feedback-template.md)
- DSH: [install](packages/dsh/install.md), [architecture](packages/dsh/architecture.md), [session flow](docs/dsh-session-flow.md), [future work](docs/future-work.md)

## Repository layout

- `packages/core` (`@yapa/core`): all the logic (memory, tasks, collections, folder rules, capture, sync, curation), behind a storage port with a ChromaDB adapter and the embedded local store.
- `packages/mcp` (`yapa-mcp`): the MCP server and the `yapa` CLI, which also runs the Claude Code hooks.
- `packages/dsh` (`yapa`): the DeepSeek Harness plugin.
- `packages/service` (`@yapa/service`): the YAPA sync service, Sync API v1 over HTTP ([README](packages/service/README.md)).
- `packages/mcp-remote`: a read-only remote MCP server over a sync service's shared store, for agents that don't run YAPA locally.
- `plugin/`: the Claude Code plugin, a prebuilt bundle of `packages/mcp` (`plugin/dist`), its manifest, hooks and skills, built by `npm run build:all`.

Building, testing and releasing: [CLAUDE.md](CLAUDE.md).
