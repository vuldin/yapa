# YAPA — Yet Another Personal Assistant

YAPA is a personal assistant that gives your AI agent persistent memory and task management, so your agent remembers what you told it, tracks your tasks, and organizes knowledge by project or customer — across every session.

**Joining your team's YAPA pilot?** Start with
[docs/pilot-onboarding.md](docs/pilot-onboarding.md): about 10 minutes to
install the plugin, sign in with `gcloud`, set the sync service URL your
pilot admin gives you, and check it works. Then just use Claude Code in your
project folders as usual.

**Claude Code (recommended):** install the plugin — MCP server, hooks, and skills in one step:

```
claude plugin marketplace add vuldin/yapa
claude plugin install yapa@yapa --config remote_name=acme
```

`--config remote_name=<name>` names your team's sync remote on the status line
(`yapa@v1.7.0 <-> acme ● synced 2m ago`); leave it out for no name. Any option
below can be set the same way (`--config key=value`, repeatable). Change one
later without editing a file:
`echo '{"remote_name":"acme"}' | claude plugin configure yapa@yapa --values-stdin`
(or `/plugin` → Configure options).

**Claude Code via `claude mcp add` / Cursor / OpenCode:** see [Install](#install), or give your AI agent this prompt: `install https://github.com/vuldin/yapa`

**DeepSeek Harness:** see [`packages/dsh/install.md`](packages/dsh/install.md) — the native plugin needs no wizard (and no database server under the default embedded store).

> **AGENTS — READ THIS FIRST.** Do NOT clone this repo. Do NOT run `git clone`, `npm install`, `npm run build`, or any other commands. For MCP hosts, read `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (OpenCode) from this repository FIRST — it contains a multi-phase install process that must be followed exactly. The install requires user input before cloning. For the DeepSeek Harness, follow `packages/dsh/install.md` instead (no agent-driven wizard).

YAPA runs two frontends over one core:

- **Native DeepSeek Harness plugin** (`yapa`, in `packages/dsh`) — 25 tools by default (+18 gated ML-ops) with structured outputs and GUI cards, always-on recall injected at the turn seam, **automatic capture of durable findings from every agent turn** (aux-LLM extractor + conservative conflict resolver), a **daily contradiction janitor** that archives duplicates and supersedes stale memories, hot-reloaded settings, schedule-bridged due dates, compaction capture, approval gating, and an embedded zero-server storage option. Docs: [install](packages/dsh/install.md) · [architecture](packages/dsh/architecture.md) · [future work & investigation record](docs/future-work.md).
- **MCP server** (`yapa-mcp`, in `packages/mcp`) — the original stdio server plus the Claude-Code hook CLI. Everything below the "Repository layout" section primarily describes this frontend.

## Repository layout

- `packages/core` (`@yapa/core`) — all logic: memory, tasks, collections, journal, compaction, sync, curation, buckets, training. Config is a `YapaConfig` snapshot (`createConfig(env)` / `setConfig`) instead of module-level env reads, so hosts control configuration. Storage goes through the `VectorStore` port (`src/store/`): the ChromaDB HTTP adapter, or the embedded local adapter (one JSON file per collection, in-process embeddings, brute-force cosine — no server).
- `packages/mcp` (`yapa-mcp`) — the MCP server + Claude-Code hook CLI.
- `packages/dsh` (`yapa`) — the DeepSeek Harness cordis plugin.
- `plugin/` — the Claude Code plugin: a prebuilt bundle of `packages/mcp` + `@yapa/core` (`plugin/dist`), its manifest and `userConfig`, `.mcp.json`, `hooks/hooks.json`, and skills. Built by `npm run build:all`; `.claude-plugin/marketplace.json` at the repo root lists it.

## What it does

**Persistent memory** — Your agent remembers things across conversations. Bug fixes, preferences, decisions, configuration details, solutions to problems — stored with semantic search so the right context surfaces when you need it.

**Task management** — Create tasks with priorities, due dates, dependencies, and recurring schedules. Your agent tracks what's in progress, what's blocked, and what's overdue. Complete a recurring task and the next one is generated automatically.

**Collection-based organization** — Memories and tasks are grouped into collections: `global` for cross-cutting knowledge, `customer-acme` for client work, `project-api` for a specific codebase. The agent infers the right collection from what you're discussing.

**Data lifecycle** — Not all memories are equally important. YAPA scores each memory by salience (0.05 floor to 5.0 max), boosts it when it's actually used, and decays it with wall-clock time. Salience also weights retrieval ranking, so higher-salience memories surface ahead of lower-salience ones at similar vector distance. Nothing is deleted — low-salience memories just surface less often.

- **Decay** is time-based: `salience × rate^days` since the memory was last decayed (`decayed_at`), with `rate` = 0.98/day for episodic memories (half-life ~34 days) and √0.98 for semantic facts (~69 days). Sweeps run at most once per 24h (checked hourly), and re-running one decays nothing extra, so the curve doesn't depend on how often you open a session.
- **Boosts** (+0.1) happen only when a recall hit is relevant (cosine distance < `YAPA_SALIENCE_BOOST_MAX_DISTANCE`, default 0.5) — merely being surfaced by the per-prompt hook doesn't count — and at most `YAPA_SALIENCE_MAX_BOOSTS_PER_DAY` (3) times per memory per day.
- **Ranking**: `cosine distance − 0.15 × normalized salience`, so salience breaks ties between similarly relevant memories rather than overriding relevance.
- Salience is per machine: boosts and decay reflect each user's own usage and don't sync.

**Smart chunking** — Long content is split into 2000-character chunks with 200-character overlap, each independently searchable. Meeting notes, documentation, lengthy explanations — all stored and retrievable.

**Remote sync**: Optionally sync memories and tasks with your team through the YAPA sync service (Google sign-in; no database credentials on your machine), or, for self-hosting, a PostgreSQL+pgvector database you run. Push local data to the remote, pull teammates' data down. A background sync runs every 5 minutes automatically. The install wizard supports Docker, Neon, Supabase, AWS RDS, GCP Cloud SQL, and Azure Flexible Server.

**Deduplication** — During sync, YAPA compares document embeddings using cosine similarity (default threshold 0.95). Near-duplicates are linked via `related_ids` rather than merged or discarded, so no data is lost and you can trace where related knowledge came from.

## How it works

**Under DSH**, the plugin registers 25 `yapa_*` tools natively by default (+18 gated behind `trainingPipeline`), injects recall + open tasks into every turn at the `agent/pre-step` seam (no hooks, no wiring), judges every completed turn for durable findings via a background aux-LLM extractor (auto-stored, deduplicated, contradictions resolved by superseding stale memories), runs a daily janitor sweep over the existing store, and stores data in the embedded local store by default. See `packages/dsh/architecture.md` for the full seam map.

**Under MCP hosts**, YAPA is an MCP server with 25 tools by default (+18 gated behind `YAPA_TRAINING_PIPELINE`). Your agent connects to it through your editor's MCP configuration. Once connected:

- **Before every response**, the agent queries your memories for relevant context
- **When it learns something important**, it stores it automatically (bug fixes, preferences, decisions)
- **When work is identified**, it creates and tracks tasks
- **Collections** are inferred from conversation context — no manual filing
- **If sync is enabled**, a background cycle pushes local changes and pulls remote updates every 5 minutes

Data lives in ChromaDB (default for MCP) or the embedded local store (default for the DSH plugin; `YAPA_STORAGE=local` enables it for MCP too). Embeddings are always computed in-process (MiniLM by default, or an HTTP provider); no backend embeds server-side. When remote sync is enabled, documents are also stored in PostgreSQL with pgvector for cross-machine search and deduplication.

## Install

### Claude Code plugin (recommended)

```
claude plugin marketplace add vuldin/yapa
claude plugin install yapa@yapa
```

The plugin bundles the MCP server, the always-on hooks, and the `/yapa:standup`
skill, and injects YAPA's standing rules at session start, so nothing is added
to CLAUDE.md or settings.json by hand. Claude Code installs the runtime
dependencies (`@huggingface/transformers`, `pg`) from `plugin/package-lock.json`
on install. Options (prompted on enable; change later with `/plugin` →
Configure options, or `claude plugin configure yapa`):

| Option | Default | Meaning |
|---|---|---|
| `username` | OS login name | Name on task IDs and on everything you sync (with the sync service it comes from your Google account; this is then informational) |
| `storage` | `local` | `local` embedded store (no server) or `chroma` |
| `chroma_url` | `http://localhost:8000` | ChromaDB server when `storage` is `chroma` |
| `project_roots` | _(empty)_ | Comma-separated folders whose subfolders map to `project-{name}` / `customer-{name}` collections |
| `customers` | _(empty)_ | Folder names under a root that are customers |
| `collection_map` | _(empty)_ | `path=collection` entries separated by `;`, e.g. `~/work/acme=private-acme;~/work/globex=local-globex`: a session in that folder (or below) uses that collection, ahead of `project_roots` (see [Private collections](#private-collections)) |
| `sync_enabled`, `sync_service_url` | off | Team sync through the YAPA sync service, signed in with your Google account (`gcloud auth login`) |
| `sync_database_url`, `sync_ca_cert` | _(empty)_ | Advanced/self-host: direct PostgreSQL+pgvector URL (ignored when a service URL is set; stored in the system credential store) |
| `remote_name` | _(empty)_ | Your team's sync remote's name on the status line: `yapa@v<version> <-> <name>` (see [The status line](#sync-health-in-the-status-line)) |
| `statusline` | on | Add YAPA's status line to `~/.claude/settings.json` at session start (an existing one is kept; removing YAPA's keeps it removed) |
| `status_label` | _(empty)_ | Deprecated: use `remote_name` (still read when that is empty) |
| `response_capture` | on | After each turn: capture durable findings (typed: finding, decision made, limitation, question, idea) and record what the turn settles in open decisions, questions and findings (see hooks below) |

For a whole team, add the marketplace and enable the plugin in managed or
repo settings (`extraKnownMarketplaces` + `enabledPlugins: {"yapa@yapa": true}`).

### `claude mcp add` (MCP server only, plus optional hooks)

```
git clone https://github.com/vuldin/yapa && cd yapa/plugin && npm install --omit=dev
claude mcp add -s user -t stdio -e YAPA_USERNAME=you -e YAPA_STORAGE=local yapa -- node "$PWD/dist/yapa-mcp.mjs"
node dist/yapa.mjs hooks install      # adds the always-on hooks to ~/.claude/settings.json
```

The hook CLI reads the same `-e` settings from the `yapa` entry in
`~/.claude.json`, so hooks and server always agree. `yapa hooks uninstall`
removes only YAPA's entries; `yapa hooks print` shows them without writing.
Re-running `hooks install` replaces YAPA hooks from older installs instead of
duplicating them.

### Agent-driven wizard (Cursor / OpenCode / custom setups)

Give your AI agent this prompt: `install https://github.com/vuldin/yapa` — it
follows `CLAUDE.md` / `AGENTS.md`.

To uninstall later, say `uninstall yapa` in any session (or
`claude plugin uninstall yapa@yapa` for the plugin).

## Team pilot

Joining the team sync pilot:

- [docs/pilot-onboarding.md](docs/pilot-onboarding.md): install, configure, verify, privacy rules, troubleshooting, rollback.
- [docs/second-user-test.md](docs/second-user-test.md): two-person runbook that proves cross-user sync end to end.
- [docs/pilot-feedback-template.md](docs/pilot-feedback-template.md): how to report issues (Slack + YAPA task).
- Admins: `scripts/yapa-user.sh` lists, disables, enables, or maps users (header explains the IAP tunnel).

## Tools

The table below lists the **MCP** tool names. The DSH plugin exposes the same
capabilities with a `yapa_` prefix (`memory_recall` → `yapa_memory_recall`),
plus `yapa_status` and `yapa_storage_import`. `setup_instructions` and
`uninstall` are MCP-only (the plugin has nothing to write into config files).

**Tool surface, kept lean:** the 30 tools below are visible by default. The
ML-ops subsystem (curation classifier, bucket routing, system-prompt
companion, training, eval, adapter promotion — 18 more) is operator workflow,
not daily agent surface: it appears only when `trainingPipeline: true` (DSH
plugin config / settings) or `YAPA_TRAINING_PIPELINE=true` (MCP) is set. See
[docs/training-pipeline.md](docs/training-pipeline.md) for the full pipeline
walkthrough and its tools.

| Tool | Description |
|------|-------------|
| `setup_instructions` | Generate behavioral instructions for CLAUDE.md / AGENTS.md |
| `memory_store` | Store memory with content, tags, salience, sector, collection; optionally typed (`kind`: finding, decision, limitation, question, idea, with status, owner, options, links; see [Findings, decisions and what waits on people](#findings-decisions-and-what-waits-on-people)) |
| `memory_update` | Change a memory in place: status, owner, links, a dated note (records a decision, answers a question, resolves a finding) |
| `memory_recall` | Semantic search ranked by distance + salience, with optional collection/tag/score filters |
| `memory_forget` | Delete memory by ID |
| `memory_list` | List memories with metadata filters (tag, sector, kind, status, owner, classifier scores) |
| `waiting` | Everything waiting on a person: decisions to make, questions to answer, steps only a person can take, blocked tasks (default: what waits on you) |
| `compaction_suggest` | Group similar non-archived memories for rolling-summary consolidation |
| `compaction_apply` | Replace a group with a summary memory and archive the originals |
| `journal_append` | Append a one-line draft entry to the current session's journal |
| `journal_consolidate` | Roll session drafts into a single `journal`-tagged memory at session end |
| `janitor_now` | Run the contradiction janitor: resolve near-duplicate pairs (archive duplicates, supersede stale memories, keep distinct facts) |
| `task_create` | Create task with title, priority, due date, tags, collection |
| `task_list` | List tasks with filters; pass `id` for a single task with full detail (notes, dependencies) |
| `task_update` | Update task fields (including renaming via `title`); `status: in_progress` claims a task in a shared collection (see [Task claims](#task-claims)); `decision_needed` records a person's choice the task then waits on; `learned` / `follow_ups` record what it produced |
| `task_next` | The ready queue for a collection: what to start next (skipping tasks that wait on an open decision or need a person), why other tasks were skipped, cleanup items when nothing is ready; `claim: true` claims the first; `auto_only` for unattended work |
| `task_complete` | Mark done + handle recurring regeneration; `learned` (typed memories linked to the task) and `follow_ups` (new tasks) record what it produced in the same call |
| `task_delete` | Remove a task |
| `task_search` | Semantic search across tasks |
| `task_add_dependency` | Add depends-on/blocks relationship |
| `task_remove_dependency` | Remove a depends-on/blocks relationship (both sides, dangling edges too) |
| `lease` | Bare leases on the sync service for non-task resources: `acquire` / `heartbeat` / `release` / `list` (also `yapa coord`) |
| `counter_next` | Next value of a shared counter (ids that must not collide across people) |
| `collection_list` | List all collections with doc counts |
| `collection_create` | Create new collection |
| `collection_merge` | Move every document of one collection into another (ids and metadata kept, synced as a move), then remove the empty source |
| `collection_delete` | Remove a collection from this machine (`scope: "local"`, the default: a shared one stays with teammates, everything only this machine has is pushed first, and writes to it are refused until `sync subscribe` follows it again), or delete your documents in it for everyone (`scope: "everyone"`, needs `confirm: "<name>"`). A non-empty collection with no other copy (local-only, or sync off) needs `confirm` too. Not a merge |
| `decay_sweep` | Manually trigger salience decay |
| `sync` | Sync control via `action`: `status` (health, last pull, pending), `now` (push+pull cycle), `collections` (remote list + subscriptions), `subscribe` / `unsubscribe` (local data preserved) |
| `uninstall` | Remove YAPA from your system |

## Always-on hooks (Claude Code / MCP frontend only)

> Under the DSH plugin this section does not apply: recall and task surfacing
> are built into the turn seam (`agent/pre-step`) with nothing to register —
> see `packages/dsh/architecture.md`.

The `yapa` CLI (`plugin/dist/yapa.mjs`, or `packages/mcp/dist/cli/index.js`)
implements YAPA's Claude Code hooks. The plugin registers them automatically;
`yapa hooks install` registers the same set for `claude mcp add` installs.

| Hook | What it does |
|------|--------------|
| `SessionStart` | Detects scope from `cwd` and `YAPA_PROJECT_ROOTS`, pulls teammates' latest writes for that collection, injects open tasks + what waits on you (decisions, questions, person-only steps, across collections) + top memories + compaction candidates (plus the standing rules under the plugin). Re-injects after context compaction (`source: compact`). Rolls up journal drafts left by crashed sessions. |
| `UserPromptSubmit` | Pulls the active collection from the shared DB (bounded by `YAPA_HOOK_PULL_TIMEOUT_MS`, fail-open), then injects the top 3 recall matches for the prompt. Teammates' items are marked `by <user>`; hits from other collections `from <collection>`. |
| `Stop` (async) | Unless `YAPA_RESPONSE_CAPTURE=false`: judges the finished turn (the buffered prompt + Claude Code's `last_assistant_message`) with an aux model: it stores durable findings as `auto-capture` memories (salience ≤ 2.0, deduplicated, typed when they are a finding, a decision made, a limitation, a question or an idea, and linked to the task the session holds), and it records what the turn settles in the open items it touches (a person's choice on a needed decision, an answer to a question, a finding's disposition), so a task waiting on a decision comes back by itself. Uses `claude -p --model haiku` when no curation API key is configured, so subscription users need no key. The result shows as a one-line notice on the next prompt. |
| `PostCompact` (async) | Stores Claude Code's compaction summary as an episodic `compaction` memory, so it outlives the context window. |
| `SessionEnd` | Cleans up the session's hook state. Journal consolidation and the final sync push happen in the MCP server's own shutdown (it owns the journal session). |

Every hook fails open: on error it emits `{}` and the session continues.

## Contradiction detection

`memory_store` runs a similarity check against the destination collection
before each write. Memories within `YAPA_CONTRADICTION_DISTANCE_THRESHOLD`
(default `0.25`, normalized cosine) are returned as `potential_conflicts`. The
agent decides:

- **Supersede** — re-store with `supersedes: "<conflicting ID>"`: the old
  memory is **archived** (`archived: true` + a `superseded_by` link) instead
  of hard-deleted — filtered from `memory_recall`/`memory_list` by default,
  recoverable anytime with `include_archived: true`.
- **Coexist** — leave the older memory in place; the new one is already stored.

`memory_forget` (hard delete) is reserved for memories that should never have
existed.

**Under DSH**, contradiction handling is also automatic: the response-capture
pipeline routes every auto-captured candidate with near neighbors through a
conservative LLM resolver (skip / add / supersede), and a daily **janitor
sweep** resolves duplicate pairs already in the store (`yapa_janitor_now` /
`janitor_now` runs it on demand). The resolver only supersedes when a fact
clearly changed; when unsure it keeps both.

Tunables:

| Env var | Default | Meaning |
|---------|---------|---------|
| `YAPA_CONTRADICTION_DISTANCE_THRESHOLD` | `0.25` | Distance under which two memories are considered conflicting |
| `YAPA_CONTRADICTION_MAX_RESULTS` | `3` | Max conflicts surfaced per write |

## End-of-session journal

Two tools record what happened during a session so the next session has continuity:

- `journal_append({ entry, collection? })` — append a one-line note. Drafts are scoped to the current MCP server process via a per-process `SESSION_ID`.
- `journal_consolidate({ collection?, summary? })` — roll the session's drafts into a single memory tagged `journal` at salience 1.5, then delete the drafts. If no `summary` is provided, the drafts are concatenated chronologically.

Consolidation also happens automatically: the MCP server rolls up its session's drafts when it shuts down (one server process per Claude Code session), and the `SessionStart` hook rolls up drafts older than a day left behind by sessions that crashed.

## Periodic compaction

When a collection grows past `YAPA_COMPACTION_THRESHOLD` non-archived memories
(default `50`), the SessionStart hook flags it as a compaction candidate. The
agent then:

1. Calls `compaction_suggest({ collection })` — returns groups of ≥`YAPA_COMPACTION_MIN_GROUP_SIZE` similar memories (similarity gated by `YAPA_COMPACTION_SIMILARITY_DISTANCE`, default `0.30`).
2. For each group, drafts a one-paragraph rolling summary.
3. Calls `compaction_apply({ collection, member_ids, summary })` — writes the summary at salience 2.0 with tag `compacted`, then marks each member with `archived: true` and `compacted_into: <summary-id>`.

`memory_recall` and `memory_list` filter `archived: true` out by default. Pass `include_archived: true` to inspect them.

Tunables:

| Env var | Default | Meaning |
|---------|---------|---------|
| `YAPA_COMPACTION_THRESHOLD` | `50` | Collection size at which compaction is suggested |
| `YAPA_COMPACTION_MIN_GROUP_SIZE` | `3` | Minimum members a compaction group must have |
| `YAPA_COMPACTION_SIMILARITY_DISTANCE` | `0.30` | Distance under which two memories belong to the same group |

## Embedding Providers

Embeddings always run **in-process** — no storage backend embeds server-side,
and the default needs no server and no API key. (The default provider is named
`chromadb` for historical reasons: it is the quantized all-MiniLM-L6-v2 ONNX
model run by `@huggingface/transformers` — the same model the earlier
`chromadb-default-embed` package used, so existing vectors stay valid — and has
nothing to do with running a ChromaDB *server*.) Set `YAPA_MODEL_CACHE_DIR` to
keep the downloaded weights somewhere persistent (the plugin uses its data dir).

ChromaDB collections created before YAPA pinned cosine space use the server
default (squared L2). YAPA reads each collection's space and converts those
distances to cosine, so thresholds behave the same on old and new collections.

| Provider | Model | Dimensions | Config |
|----------|-------|------------|--------|
| In-process MiniLM (default) | all-MiniLM-L6-v2 | 384 | Zero-config |
| Fireworks | nomic-embed-text-v1 | 768 | `YAPA_EMBEDDING_PROVIDER=fireworks` |
| OpenAI | text-embedding-3-small | 768 | `YAPA_EMBEDDING_PROVIDER=openai` |
| Voyage AI | voyage-3-lite | 512 | `YAPA_EMBEDDING_PROVIDER=voyage` |
| Ollama | nomic-embed-text | 768 | `YAPA_EMBEDDING_PROVIDER=ollama` |

To use a non-default provider, add the relevant env vars to your MCP host config's `env` block (or the plugin's cordis `config:` under DSH). See `.env.example` for all options.

Note: the embedding provider and the **storage backend** are independent
choices — the in-process embedder pairs with both the embedded local store
(default under the DSH plugin) and a ChromaDB server (default under MCP).

## Configuration

All options use the `YAPA_` prefix and are set as environment variables in your MCP host config. Under the DSH plugin, the same values live in the cordis row `config:` or the hot-reloaded `yapa:` section of `~/.dsh/settings.yaml` (camelCase: `chromaUrl`, `syncEnabled`, …). See `.env.example` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `YAPA_STORAGE` | `chroma` \| `local` (embedded store, no server) | `chroma` for MCP; the DSH plugin defaults to `local` |
| `YAPA_LOCAL_STORE_PATH` | Root dir for the embedded store | `~/.local/share/yapa/store` |
| `YAPA_CHROMA_URL` | ChromaDB server URL (when `YAPA_STORAGE=chroma`) | `http://localhost:8000` |
| `YAPA_USERNAME` | Username for task ID prefixes and sync attribution | OS login name |
| `YAPA_PROJECT_ROOTS` | Comma/colon-separated folders whose first-level subfolders become `project-{name}` (or `customer-{name}`) scopes | _(none: everything is `global`)_ |
| `YAPA_CUSTOMERS` | Folder names under a project root that map to `customer-{name}` | _(none)_ |
| `YAPA_COLLECTION_MAP` | `path=collection` entries separated by `;` or newlines (not `,` or `:`, which occur in paths), `~` expanded; paths must be absolute. The longest path holding the cwd wins, before `YAPA_PROJECT_ROOTS`; the only way a folder gets a `private-*`/`local-*` scope | _(none)_ |
| `YAPA_EMBEDDING_PROVIDER` | Embedding provider — `chromadb` is in-process MiniLM (zero-config, no server call); `fireworks`/`openai`/`voyage`/`ollama` use HTTP APIs | `chromadb` |
| `YAPA_SALIENCE_DECAY_RATE` | Per-day decay multiplier for episodic memories (semantic: its square root) | `0.98` |
| `YAPA_SALIENCE_RANKING_WEIGHT` | How much salience influences retrieval ranking (0.0 = pure distance, higher = salience-dominant) | `0.15` |
| `YAPA_SALIENCE_BOOST_MAX_DISTANCE` | Recall hits closer than this cosine distance count as a use and boost salience | `0.5` |
| `YAPA_SALIENCE_MAX_BOOSTS_PER_DAY` | Max boosts per memory per UTC day | `3` |
| `YAPA_TRAINING_PIPELINE` | Expose the 18 ML-ops tools (curation/buckets/training/eval/adapter) | `false` |
| `YAPA_SYNC_ENABLED` | Enable remote sync | `false` |
| `YAPA_SYNC_SERVICE_URL` | YAPA sync service URL (wins over the database URL) | _(none)_ |
| `YAPA_SYNC_ID_TOKEN_CMD` | Command printing a Google ID token for the service | `gcloud auth print-identity-token` |
| `YAPA_SYNC_HTTP_TIMEOUT_MS` | Per-request timeout for the sync service | `15000` |
| `YAPA_SYNC_DATABASE_URL` | Advanced/self-host: direct PostgreSQL connection string (ignored when a service URL is set) | _(none)_ |
| `YAPA_SYNC_INTERVAL_MS` | Background sync interval in ms (one cycle per interval per machine, shared by every session) | `300000` (5 min) |
| `YAPA_SYNC_COORDINATE` | Share the interval cycle among every YAPA server on this machine; `false`: each server syncs on its own timer | `true` |
| `YAPA_SYNC_SIMILARITY_THRESHOLD` | Cosine similarity threshold for dedup | `0.95` |
| `YAPA_SYNC_PUSH_DEBOUNCE_MS` | Delay before a write-triggered push (`0` = interval only) | `2000` |
| `YAPA_SYNC_PULL_OVERLAP_SECONDS` | Re-read window on each pull so mid-pull pushes are never skipped | `120` |
| `YAPA_DEVICE_ID` | Stable id for this machine (else generated once at `YAPA_DEVICE_ID_PATH`) | _(generated)_ |
| `YAPA_HOOK_PULL_TIMEOUT_MS` | Cap on the hooks' pre-recall pull | `4000` |
| `YAPA_HOOK_PULL_WINDOW_MS` | The prompt hook skips its pull when any session pulled that collection this recently (`0` = always pull) | `30000` |
| `YAPA_RESPONSE_CAPTURE` | After each turn (Stop hook): capture typed findings and record what the turn settles in open decisions and questions | `true` |
| `YAPA_CURATION_LLM_PROVIDER` | Aux model for capture/curation: `anthropic` \| `openai` \| `fireworks` \| `ollama` \| `claude-cli` | `anthropic` (hooks fall back to `claude-cli` without a key) |
| `YAPA_MODEL_CACHE_DIR` | Where the in-process embedder caches model weights | library default |

Empty values count as unset (Claude Code substitutes `""` for plugin options you never configured).

ML-ops configuration (curation models, bucket thresholds, training backend,
eval holdout, …) lives in
[docs/training-pipeline.md](docs/training-pipeline.md#configuration).

## Remote Sync

Remote sync lets multiple machines or teammates share memories and tasks. It is optional: YAPA works fully offline, and local features keep working when the remote is unreachable.

### Setup (sync service)

1. Install the plugin (above) and enable `sync_enabled`.
2. Set `sync_service_url` to your team's YAPA sync service URL (ask your YAPA admin). Any remote that implements [YAPA Sync API v1](docs/sync-api.md) works, including one under a path prefix such as `https://example.com/api/yapa`. Read [Connecting to a remote](docs/connecting-to-a-remote.md) first: the first sync pushes every shared collection to it.
3. Sign in once: `gcloud auth login` with your company Google account. YAPA calls `gcloud auth print-identity-token` for a short-lived (1 h) ID token and refreshes it before it expires. The current token is cached in a 0600 file (`~/.local/share/yapa/id-token`, set `YAPA_SYNC_ID_TOKEN_CACHE` to another path, or `off` to keep it in memory only) so short-lived hook processes don't mint a new one each time. Other token sources: set `YAPA_SYNC_ID_TOKEN_CMD` to a command that prints an ID token.
4. Check with the `sync` tool, `action: 'status'`: it shows the backend, the service URL, who you are signed in as, the last error, and any docs the service refused.
5. The status line shows sync health under the prompt from the first session (option `statusline`), e.g. `yapa@v1.7.0 <-> acme ● synced 2m ago` or, when your sign-in lapses, `yapa@v1.7.0 <-> acme ● signed out since 09:12 · run: gcloud auth login`. See [The status line](#sync-health-in-the-status-line).

### Which collection a folder uses

`yapa scope [--cwd DIR]` prints the collection YAPA uses for a folder (from `collection_map`, then `project_roots`) as JSON, `{collection, local_only, mapped}`, or with `--text` as `private-acme (local only)`. A project's own scripts should ask it rather than name a collection themselves, so the folder's collection is set in one place, the `collection_map` option. A script that must stay private can refuse to run unless `local_only` is true.

### Sync health in the status line

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

- **Install:** automatic. With the option `statusline` on (the default), the session-start hook writes `statusLine` in `~/.claude/settings.json`, pointing at a stable copy of the script (`~/.local/share/yapa/statusline.mjs`, refreshed by the session-start hook so plugin updates reach it). A status line you already had keeps running, with the YAPA segment as a line beneath it. `node ~/.local/share/yapa/statusline.mjs --uninstall` (or `yapa statusline uninstall`) restores it, and YAPA then leaves it removed; `/yapa:statusline` or `yapa statusline install` adds it back.
- **Which YAPA this session runs:** the version is the one this session's own MCP server reported when it started (`~/.local/share/yapa/sessions/<session id>.json`), not the installed script's. A session still running an older YAPA after an update shows `yapa@v1.8.0 (restart for v1.10.1)`; one whose server never reported (older than 1.10.1, or no YAPA server) shows `yapa (restart for v1.10.1)` once it has run a minute.
- **Where this session writes:** after ` | `, the collection this session last wrote to through the YAPA tools, the `yapa memory` / `yapa task` CLI or a lease or counter (`lease`, `counter_next`, `yapa coord`); before its first write, the collection its hooks detected for the folder (`collection_map`, then `project_roots`). A collection that never leaves this machine is tagged `(local only)`, e.g. `| private-acme (local only)`. Reads, sync pulls and background sweeps never change it. Each session keeps its own, in `~/.local/share/yapa/last-write/` and `sessions/`.
- **Name:** the option `remote_name` (`YAPA_REMOTE_NAME`). The older `status_label` is still read when `remote_name` is empty.
- **New releases:** the MCP server checks once a day (the plugin manifest on `main`, `YAPA_UPDATE_SOURCE`; `YAPA_UPDATE_CHECK=false` turns it off) and keeps the answer in `~/.local/share/yapa/update-check.json`. The status line shows `(v1.8.0 available)`, and the next session start tells Claude the update command (`claude plugin marketplace update yapa && claude plugin update yapa@yapa`, then restart). The note clears itself once you run the new version.
- **Cost:** the script reads a few small local files; no network, no `gcloud`.
- **Recovery:** after `gcloud auth login`, the next request mints a new token; no restart. The segment turns green at the next sync cycle or prompt.
- While sync is down, the hooks also tell Claude, so it doesn't claim your writes reached teammates.

With the service, your username comes from your Google account (shown in `sync status`); task ids use it, and the `username` option is informational. The service enforces ownership (only the owner deletes a shared row), refuses content that looks like a secret (the doc stays local and unsynced, listed in `sync status`, and is retried only after you edit it), renames a task whose id already belongs to a different task, and sends deletions to teammates' machines (a clean copy is removed; a copy with unpushed edits is kept and reported).

### Advanced: direct database (self-host)

Instead of the service, `sync_database_url` (`YAPA_SYNC_DATABASE_URL`) connects straight to a PostgreSQL+pgvector database you run; it is ignored when a service URL is set. This mode has no server-side access control: everyone with the URL can read and write every shared collection, deletions do not propagate to other machines, and there is no secret check.

### How it works

When sync is enabled, YAPA runs a background push/pull cycle every 5 minutes (configurable via `YAPA_SYNC_INTERVAL_MS`), and two faster paths keep teammates current within seconds:

- **Push on write** — every write tool (`memory_store`, `task_update`, …) schedules a debounced push (`YAPA_SYNC_PUSH_DEBOUNCE_MS`), and the MCP server flushes pending pushes on shutdown. A write pushes only; pulls come from the cycle and the hooks.
- **Pull before recall** — the Claude Code hooks pull the active collection right before injecting context, so a teammate's memory from seconds ago shows up on your next prompt. A prompt skips the pull when any session on this machine pulled that collection in the last 30 seconds (`YAPA_HOOK_PULL_WINDOW_MS`); session start and the first visit to a collection always pull.

**One cycle per machine.** Every Claude Code session runs its own YAPA server, and all of them share one local store, so one cycle per interval is enough for all of them. The servers keep a small record of the last cycle and a lock beside the sync health file (`sync-cycle-<key>.json`, `.lock`; the key is a hash of the remote, the local store and the username, so different installs never sync for each other). A server's timer (jittered ±10%) skips when another server finished a cycle within the interval or is running one; a lock whose holder died or is older than twice the interval (at least 10 minutes) is taken over. Anything unreadable means "go ahead", so the worst case is the old behavior of every server syncing. A manual `sync now` always runs. `sync status` shows the shared record and how many ticks this server skipped. Servers older than 1.8.0 don't take part: restart old sessions after updating.

The cycle itself:

1. **Push** — Local documents flagged as unsynced are uploaded, stamped with this machine's `origin_device`. Collections you push to are automatically subscribed for pull. Journal drafts stay local; only consolidated journals sync.
2. **Pull** — Documents from subscribed collections are downloaded, skipping only rows **last written by this device** (so your other machines still receive your work). A newly subscribed collection backfills its full history. The stored pull point is the cycle *start* minus an overlap window, so a document pushed while a pull is running is never skipped.
3. **Updates** — When a remote document is newer than the local copy and the local copy has no unpushed edits, the remote version replaces it (a teammate completing a task, a corrected memory). A local copy with unpushed edits wins and is pushed on the next cycle.

### Multi-user semantics

- **Attribution** — documents keep their original author (`origin_user`); injected context marks teammates' items `by <user>`.
- **`global` is local-only** — like `private-`/`local-` collections it never leaves your machine (not even to your other devices). Put team-wide knowledge in a shared collection such as `project-cs-team`.
- **Same user, several machines**: sign in with the same Google account (direct database: use the same `YAPA_USERNAME`) everywhere; each install has its own device id.
- **Access control**: with the sync service, the server checks every request against your Google identity; with a direct database, everyone with the URL can read every shared collection. Either way, use `private-`/`local-` collections for anything that must not leave your machine.

You can also trigger a sync manually with `sync` (`action: 'now'`), check status with `action: 'status'`, and manage subscriptions with `action: 'subscribe'` / `'unsubscribe'`.

### Task claims

Writes reach the remote seconds after they happen, but a status change is still an ordinary last-writer-wins write: two people could both mark the same task `in_progress` and neither would know. So setting a task to `in_progress` **claims** it first, through a lease on its id that is granted atomically: by the sync service in a shared collection, and by this machine in a local-only one (`private-*`, `local-*`, `global`) or with sync off (see [Local-only collections](#local-only-collections-on-this-machine)):

- **Granted:** the status changes and is pushed at once. Teammates' task lists, session-start context and `task_next` show `claimed by you (this session) since 09:12 UTC`.
- **Refused:** someone else (or another of your own sessions) holds it. Nothing changes, and the reply names the holder and since when. For your own other session (after `--resume`, say), `task_update` with `reclaim: true` takes it over once you confirm.
- **Not shared** (a shared collection while offline or signed out): the status changes locally and the reply says others may start it too. The claim is retried when sync is back; if someone claimed the task meanwhile, the next prompt says so.

Completing, blocking, resetting to pending or deleting the task releases the claim. The hooks renew this session's claims while it is active, and a claim lapses one TTL (2 h by default) after the session goes quiet. Its task then shows `no live claim` and is offered again by `task_next`. If another session takes a claim over, the next prompt says so.

`task_next` is the ready queue: pending tasks whose dependencies are complete and that nobody holds, best first (priority, due date, how many tasks each unblocks, age). A task's `claim_scope` (soft scope such as `repo:infra`) ranks it last while something overlapping is claimed. Scripts get the same through `yapa task list|next|claim|release|show` (JSON output; exit 0 done, 3 refused, 4 not shared). For resources that are not tasks, use bare leases (`lease` / `yapa coord`).

### Local-only collections on this machine

`private-*`, `local-*` and `global` never leave your machine, and every collection stays local while sync is off. Coordination works there too, served by this machine instead of the sync service, with the same rules and answers:

- **Claims** (`task_update` to `in_progress`, `task_next` with `claim`, `yapa task claim`): a second session is refused with the holder and since when, and a claim that lapsed is offered again by `task_next`.
- **Leases** (`lease`, `yapa coord acquire|heartbeat|release|list`): keys, scope overlap, TTLs, reclaim and takeovers behave as on the service. The hooks renew this session's local leases too.
- **Counters** (`counter_next`, `yapa coord counter-next`) never hand out a value twice, and **task ids** never repeat between sessions on this machine, online or not.

The state lives in `~/.local/share/yapa/coord/` (`YAPA_LOCAL_COORD_DIR`), one small file per collection, changed under a lock file that every YAPA process on the machine respects. A grant from this machine says `(this machine)`; `yapa coord` adds `"local": true` to its JSON. Shared collections with sync on still go to the service, and when it can't be reached their claims are "not shared", because a teammate may hold the work.

Turning sync on or off moves shared collections between the two: a lease taken on this machine while sync was off isn't known to the service after you turn sync on (and the reverse), so finish or release claims before switching. An `in_progress` task with no claim on record (one started before 1.10, or by an older YAPA process still running) is offered again only after it has been untouched for two hours.

### Findings, decisions and what waits on people

A memory can say what kind of knowledge it holds, so it can be listed, waited on and kept current:

| `kind` | statuses | for |
|---|---|---|
| `finding` | open, resolved (with a `disposition`: decision, task, limitation, or no-action and a reason) | a result, root cause, retraction or trap |
| `decision` | needed, proposed, accepted, superseded, rejected | a choice; `needed` (with `options`, a `recommendation` and the `owner` who decides) is one only a person can make |
| `limitation` | open, mitigated, accepted, closed (with `exit_criteria`) | something that can't be done yet |
| `question` | open, answered (with the `owner` who must answer) | a question for a person or another team |
| `idea` | proposed, adopted, dropped | a change nobody has committed to |

They are created and kept current in the normal course of work:
- **When work closes.** `task_complete` takes `learned` (typed memories linked to the task) and `follow_ups` (new tasks); the reply says when nothing was recorded. `task_update` with `decision_needed` records a choice only a person can make, and the task waits on it (pending, `waits_on`): `task_next` skips it until the decision is recorded, then offers it again by itself.
- **After each turn** (`response_capture`, on by default; always on in DSH). The aux model types what it captures, and it judges the open decisions, questions and findings the turn touches (those the session's task waits on or recorded, and those near the turn). When the person chose, answered or settled one, it is updated with a dated note. Only an item's owner settles a decision that names one; a move the rules don't allow (a finding resolved without a disposition, reopening an item) is dropped.
- **By hand.** `memory_update` records a decision (`status: accepted`, the choice as `note`) or an answer.

`waiting` (and `yapa waiting`) lists everything waiting on people; session start lists what waits on you. Triage tags on tasks: `auto` (an unattended session may do all of it), `needs-human` (a step only a person takes), `needs:<user>`; `task_next` never offers `needs-human` tasks, and `auto_only` offers only `auto` ones. When nothing is ready it offers cleanup items (`cleanup:triage`, `cleanup:findings`, `cleanup:compaction`), each claimable like a task. The `/yapa:work` skill runs the loop: take the next task, do it, record what it produced, complete it, repeat.

Projects that keep their records elsewhere can publish the ones that matter to these views with `yapa memory put --ref <key>` (created once, updated in place afterwards); `yapa memory list` reads them back as JSON.

### Deduplication

Both push and pull compare document embeddings against existing data using cosine similarity:

- **On push**: each local document's embedding is compared against the remote database. If a match exceeds the similarity threshold (default 0.95), the documents are linked via `related_ids` in both local and remote metadata. The document is still pushed — nothing is discarded.
- **On pull**: each remote document is compared against local ChromaDB data. Matches above the threshold are linked the same way. The remote document is still inserted locally.

This means near-duplicates coexist but are cross-referenced, so you can trace where related knowledge came from without losing data. Adjust the threshold with `YAPA_SYNC_SIMILARITY_THRESHOLD` — lower values link more aggressively, higher values require near-exact matches.

### Delete propagation

Deleting **your own** memory or task queues the deletion for the remote database; it's processed on the next push, before new documents. Deleting a **teammate's** document only removes it from your machine: it's tombstoned locally so pull won't re-insert it, and the shared row stays for everyone else (the remote delete is also guarded by owner).

### Private collections

Collections prefixed with `private-` or `local-`, and `global`, are never synced. Use these for personal notes, credentials, or anything that should stay on one machine.

A doc in a private collection never keeps a shared copy: if one of **your** docs ends up there (moved, restored, or synced by an older YAPA version), the next sync deletes its shared row. Only the same doc is removed (matched by id and creation time), never a different shared task that happens to reuse the id. A private copy of a **teammate's** doc is just a personal copy; their shared row stays. Each private doc is checked once per version, so steady-state syncs make no extra remote lookups.

**A folder with a private collection.** `project_roots` only produces `project-*` and `customer-*` scopes. To give a folder a private one, map it with `collection_map` (`YAPA_COLLECTION_MAP`): `~/work/acme=private-acme;~/work/acme/shared-docs=project-acme`. A session in a mapped folder, or anywhere below it, uses that collection; the longest matching path wins, and the map is checked before `project_roots`. The hooks (session start, prompt recall, response capture, compaction capture) and the DSH plugin all follow it, and the scope line says so: ``**Scope:** `private-acme` (local only, never synced)``.

- Separate entries with `;` (or newlines in an env file). Commas and colons are part of the path, so `C:\work\acme=private-acme` and `/srv/a:b=local-ab` work.
- Paths must be absolute or start with `~`. Paths are compared after resolving `..` and through symlinks (a folder reached through a link matches its real path, and the other way round), on separator boundaries (`~/work/acme` never claims `~/work/acme-old`), and case-insensitively on Windows.
- A relative entry, or one without `=`, is ignored with a warning on stderr. A collection name that looks meant to be private but is not (`Private-acme`, `privat-acme`, `local_acme`) is used as written and syncs, so YAPA warns on stderr and the scope line says `(shared: this name syncs ...)`. Local-only names start with lowercase `private-` or `local-`.
- A map entry beats `project_roots` for its whole subtree. A broad entry such as `~=local-me` therefore overrides every project root under your home folder; put specific entries next to it (the longest path wins) for folders that should stay shared.

**The recall fence.** The prompt hook adds a few strongly relevant hits from other collections. Those extras never come from a `private-*` or `local-*` collection, so a private note does not surface while you work in a shared project. Recall in the private collection itself (its folder, or `memory_recall` with that `collection`) finds it as usual. Session start's "Waiting on you" is fenced the same way: in a shared scope, decisions, questions and tasks from private collections are only counted, not listed (the `waiting` tool still lists them).

What is not fenced: `memory_recall` with no collection (an explicit search of everything, private collections included), `global` (your personal cross-cutting scope, surfaced everywhere), and tools you call with a private collection by name. None of these reaches the sync service, but each can put private text in front of an agent working in a shared project; keep secrets out of `global`.

**Moving a shared collection into a private one.** `collection_merge from=project-acme into=private-acme` moves every doc. At the next push your own shared rows are retracted; teammates' docs stay shared in `project-acme`, and you keep a private copy. The merge also unsubscribes `project-acme` (with sync off too) and leaves a local redirect `project-acme -> private-acme` (in `global`, never synced):

- A session in the old folder scopes to `private-acme` (the scope line notes "merged from `project-acme`").
- A write that names `project-acme` (`memory_store`, `task_create`, `journal_append`, `memory_update`, `compaction_apply`, `yapa memory put`) lands in `private-acme`, and the reply says so. A CLAUDE.md or script that still names the old collection never recreates it.
- Neither the prompt hook, a pull (recovery or a leftover subscription) nor push auto-subscribe brings `project-acme` back from teammates' rows.
- `sync subscribe project-acme` follows it again and drops the redirect; so does `collection_create project-acme`.
- `global` itself can't be merged into anything: it holds the sync state and these redirects.

**The redirect is per machine.** Your other devices still follow `project-acme` until you run the same merge on each of them. Until then such a device drops its unedited copies of your docs when the retraction reaches it (your private copy exists only where you merged), and a copy it had edited is pushed back into the shared `project-acme`. The machine that merged checks each private doc once per version, so it does not retract that pushed-back row again. Merge on every device, ideally before it syncs again.

### Testing sync

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

### Database providers

The install wizard handles PostgreSQL setup. Supported providers:

- **Docker** (local) — `pgvector/pgvector:pg17` container
- **Neon** — free serverless PostgreSQL with pgvector included
- **Supabase** — free hosted PostgreSQL with pgvector included
- **AWS RDS** — managed PostgreSQL with pgvector extension
- **GCP Cloud SQL** — managed PostgreSQL with pgvector extension
- **Azure Flexible Server** — managed PostgreSQL with pgvector extension
