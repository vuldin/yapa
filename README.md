# YAPA — Yet Another Personal Assistant

**DeepSeek Harness:** see [`packages/dsh/install.md`](packages/dsh/install.md) — the native plugin needs no wizard (and no database server under the default embedded store).

**Claude Code / Cursor / OpenCode:** give your AI agent this prompt: `install https://github.com/vuldin/yapa`

> **AGENTS — READ THIS FIRST.** Do NOT clone this repo. Do NOT run `git clone`, `npm install`, `npm run build`, or any other commands. For MCP hosts, read `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (OpenCode) from this repository FIRST — it contains a multi-phase install process that must be followed exactly. The install requires user input before cloning. For the DeepSeek Harness, follow `packages/dsh/install.md` instead (no agent-driven wizard).

YAPA is a personal assistant that gives your AI agent persistent memory and task management, so your agent remembers what you told it, tracks your tasks, and organizes knowledge by project or customer — across every session.

YAPA runs two frontends over one core:

- **Native DeepSeek Harness plugin** (`yapa`, in `packages/dsh`) — 23 tools by default (+18 gated ML-ops) with structured outputs and GUI cards, always-on recall injected at the turn seam, **automatic capture of durable findings from every agent turn** (aux-LLM extractor + conservative conflict resolver), a **daily contradiction janitor** that archives duplicates and supersedes stale memories, hot-reloaded settings, schedule-bridged due dates, compaction capture, approval gating, and an embedded zero-server storage option. Docs: [install](packages/dsh/install.md) · [architecture](packages/dsh/architecture.md) · [future work & investigation record](docs/future-work.md).
- **MCP server** (`yapa-mcp`, in `packages/mcp`) — the original stdio server plus the Claude-Code hook CLI. Everything below the "Repository layout" section primarily describes this frontend.

## Repository layout

- `packages/core` (`@yapa/core`) — all logic: memory, tasks, collections, journal, compaction, sync, curation, buckets, training. Config is a `YapaConfig` snapshot (`createConfig(env)` / `setConfig`) instead of module-level env reads, so hosts control configuration. Storage goes through the `VectorStore` port (`src/store/`): the ChromaDB HTTP adapter, or the embedded local adapter (one JSON file per collection, in-process embeddings, brute-force cosine — no server).
- `packages/mcp` (`yapa-mcp`) — the MCP server + Claude-Code hook CLI.
- `packages/dsh` (`yapa`) — the DeepSeek Harness cordis plugin.

## What it does

**Persistent memory** — Your agent remembers things across conversations. Bug fixes, preferences, decisions, configuration details, solutions to problems — stored with semantic search so the right context surfaces when you need it.

**Task management** — Create tasks with priorities, due dates, dependencies, and recurring schedules. Your agent tracks what's in progress, what's blocked, and what's overdue. Complete a recurring task and the next one is generated automatically.

**Collection-based organization** — Memories and tasks are grouped into collections: `global` for cross-cutting knowledge, `customer-acme` for client work, `project-api` for a specific codebase. The agent infers the right collection from what you're discussing.

**Data lifecycle** — Not all memories are equally important. YAPA scores each memory by salience (1.0 to 5.0), boosts it when accessed, and decays it over time. Semantic facts (preferences, configs) decay slower than episodic events (what happened Tuesday). Salience also weights retrieval ranking, so higher-salience memories surface ahead of lower-salience ones at similar vector distance. Nothing is deleted — low-salience memories just surface less often.

**Smart chunking** — Long content is split into 2000-character chunks with 200-character overlap, each independently searchable. Meeting notes, documentation, lengthy explanations — all stored and retrievable.

**Remote sync** — Optionally sync memories and tasks to a shared PostgreSQL+pgvector database. Push local data to the remote, pull teammates' data down. A background sync runs every 5 minutes automatically. The install wizard supports Docker, Neon, Supabase, AWS RDS, GCP Cloud SQL, and Azure Flexible Server.

**Deduplication** — During sync, YAPA compares document embeddings using cosine similarity (default threshold 0.95). Near-duplicates are linked via `related_ids` rather than merged or discarded, so no data is lost and you can trace where related knowledge came from.

## How it works

**Under DSH**, the plugin registers 23 `yapa_*` tools natively by default (+18 gated behind `trainingPipeline`), injects recall + open tasks into every turn at the `agent/pre-step` seam (no hooks, no wiring), judges every completed turn for durable findings via a background aux-LLM extractor (auto-stored, deduplicated, contradictions resolved by superseding stale memories), runs a daily janitor sweep over the existing store, and stores data in the embedded local store by default. See `packages/dsh/architecture.md` for the full seam map.

**Under MCP hosts**, YAPA is an MCP server with 23 tools by default (+18 gated behind `YAPA_TRAINING_PIPELINE`). Your agent connects to it through your editor's MCP configuration. Once connected:

- **Before every response**, the agent queries your memories for relevant context
- **When it learns something important**, it stores it automatically (bug fixes, preferences, decisions)
- **When work is identified**, it creates and tracks tasks
- **Collections** are inferred from conversation context — no manual filing
- **If sync is enabled**, a background cycle pushes local changes and pulls remote updates every 5 minutes

Data lives in ChromaDB (default for MCP) or the embedded local store (default for the DSH plugin; `YAPA_STORAGE=local` enables it for MCP too). Embeddings are always computed in-process (MiniLM by default, or an HTTP provider); no backend embeds server-side. When remote sync is enabled, documents are also stored in PostgreSQL with pgvector for cross-machine search and deduplication.

## Install

To install, give your AI agent this prompt: `install https://github.com/vuldin/yapa`

To uninstall later, say `uninstall yapa` in any session.

## Tools

The table below lists the **MCP** tool names. The DSH plugin exposes the same
capabilities with a `yapa_` prefix (`memory_recall` → `yapa_memory_recall`),
plus `yapa_status` and `yapa_storage_import`. `setup_instructions` and
`uninstall` are MCP-only (the plugin has nothing to write into config files).

**Tool surface, kept lean:** the 23 tools below are visible by default. The
ML-ops subsystem (curation classifier, bucket routing, system-prompt
companion, training, eval, adapter promotion — 18 more) is operator workflow,
not daily agent surface: it appears only when `trainingPipeline: true` (DSH
plugin config / settings) or `YAPA_TRAINING_PIPELINE=true` (MCP) is set. See
[docs/training-pipeline.md](docs/training-pipeline.md) for the full pipeline
walkthrough and its tools.

| Tool | Description |
|------|-------------|
| `setup_instructions` | Generate behavioral instructions for CLAUDE.md / AGENTS.md |
| `memory_store` | Store memory with content, tags, salience, sector, collection |
| `memory_recall` | Semantic search ranked by distance + salience, with optional collection/tag/score filters |
| `memory_forget` | Delete memory by ID |
| `memory_list` | List memories with metadata filters (tag, sector, classifier scores) |
| `compaction_suggest` | Group similar non-archived memories for rolling-summary consolidation |
| `compaction_apply` | Replace a group with a summary memory and archive the originals |
| `journal_append` | Append a one-line draft entry to the current session's journal |
| `journal_consolidate` | Roll session drafts into a single `journal`-tagged memory at session end |
| `janitor_now` | Run the contradiction janitor: resolve near-duplicate pairs (archive duplicates, supersede stale memories, keep distinct facts) |
| `task_create` | Create task with title, priority, due date, tags, collection |
| `task_list` | List tasks with filters; pass `id` for a single task with full detail (notes, dependencies) |
| `task_update` | Update task fields |
| `task_complete` | Mark done + handle recurring regeneration |
| `task_delete` | Remove a task |
| `task_search` | Semantic search across tasks |
| `task_add_dependency` | Add depends-on/blocks relationship |
| `collection_list` | List all collections with doc counts |
| `collection_create` | Create new collection |
| `collection_delete` | Delete a collection |
| `decay_sweep` | Manually trigger salience decay |
| `sync` | Sync control via `action`: `status` (health, last pull, pending), `now` (push+pull cycle), `collections` (remote list + subscriptions), `subscribe` / `unsubscribe` (local data preserved) |
| `uninstall` | Remove YAPA from your system |

## Always-on hooks (Claude Code / MCP frontend only)

> Under the DSH plugin this section does not apply: recall and task surfacing
> are built into the turn seam (`agent/pre-step`) with nothing to register —
> see `packages/dsh/architecture.md`.

YAPA ships a small `yapa` CLI in addition to the MCP server. It exposes four
hook entry points designed to be invoked from `~/.claude/settings.json`:

| Hook | What it does |
|------|--------------|
| `session-start` | Detects scope from `cwd`, surfaces open tasks + top memories + compaction candidates as `additionalContext` |
| `user-prompt-submit` | Runs `memory_recall` against the detected scope using the prompt as the query and injects the top 3 matches |
| `stop` | Reminds the agent to call `memory_store` / `task_create` / `journal_append` for findings from the just-finished turn |
| `session-end` | Logs the session ending; surfaces pending journal drafts at the next session start |

Register the hooks once in `~/.claude/settings.json` (point the `command` field at the absolute path of `packages/mcp/dist/cli/index.js`). After that, recall and task surfacing happen on every prompt without the agent having to remember to call the tools. This is what makes YAPA "always on" rather than best-effort.

Configuration: each hook fails open — if the call errors, the hook emits `{}` and the session continues normally.

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

The `Stop` hook prompts the agent to journal each turn; the `SessionEnd` hook prompts consolidation.

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

| Provider | Model | Dimensions | Config |
|----------|-------|------------|--------|
| ChromaDB (default) | all-MiniLM-L6-v2 | 384 | Zero-config |
| Fireworks | nomic-embed-text-v1 | 768 | `YAPA_EMBEDDING_PROVIDER=fireworks` |
| OpenAI | text-embedding-3-small | 768 | `YAPA_EMBEDDING_PROVIDER=openai` |
| Voyage AI | voyage-3-lite | 512 | `YAPA_EMBEDDING_PROVIDER=voyage` |
| Ollama | nomic-embed-text | 768 | `YAPA_EMBEDDING_PROVIDER=ollama` |

To use a non-default provider, add the relevant env vars to your MCP host config's `env` block. See `.env.example` for all options.

## Configuration

All options use the `YAPA_` prefix and are set as environment variables in your MCP host config. Under the DSH plugin, the same values live in the cordis row `config:` or the hot-reloaded `yapa:` section of `~/.dsh/settings.yaml` (camelCase: `chromaUrl`, `syncEnabled`, …). See `.env.example` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `YAPA_STORAGE` | `chroma` \| `local` (embedded store, no server) | `chroma` |
| `YAPA_LOCAL_STORE_PATH` | Root dir for the embedded store | `~/.local/share/yapa/store` |
| `YAPA_CHROMA_URL` | ChromaDB server URL (when `YAPA_STORAGE=chroma`) | `http://localhost:8000` |
| `YAPA_USERNAME` | Username for task ID prefixes | `user` |
| `YAPA_EMBEDDING_PROVIDER` | Embedding provider — `chromadb` is in-process MiniLM (zero-config, no server call); `fireworks`/`openai`/`voyage`/`ollama` use HTTP APIs | `chromadb` |
| `YAPA_SALIENCE_DECAY_RATE` | Daily decay multiplier | `0.98` |
| `YAPA_SALIENCE_RANKING_WEIGHT` | How much salience influences retrieval ranking (0.0 = pure distance, higher = salience-dominant) | `0.3` |
| `YAPA_TRAINING_PIPELINE` | Expose the 18 ML-ops tools (curation/buckets/training/eval/adapter) | `false` |
| `YAPA_SYNC_ENABLED` | Enable remote sync | `false` |
| `YAPA_SYNC_DATABASE_URL` | PostgreSQL connection string | _(none)_ |
| `YAPA_SYNC_INTERVAL_MS` | Background sync interval in ms | `300000` (5 min) |
| `YAPA_SYNC_SIMILARITY_THRESHOLD` | Cosine similarity threshold for dedup | `0.95` |

ML-ops configuration (curation models, bucket thresholds, training backend,
eval holdout, …) lives in
[docs/training-pipeline.md](docs/training-pipeline.md#configuration).

## Remote Sync

Remote sync lets multiple machines or teammates share memories and tasks through a PostgreSQL+pgvector database. It is optional — YAPA works fully offline with just ChromaDB.

### How it works

When sync is enabled, YAPA runs a background push/pull cycle every 5 minutes (configurable via `YAPA_SYNC_INTERVAL_MS`):

1. **Push** — Local documents flagged as unsynced are uploaded to the remote database. Collections you push to are automatically subscribed for pull.
2. **Pull** — Documents from subscribed remote collections are downloaded, skipping any that originated from the current user. Only documents synced after the last pull timestamp are fetched.

You can also trigger a sync manually with `sync` (`action: 'now'`), check status with `action: 'status'`, and manage subscriptions with `action: 'subscribe'` / `'unsubscribe'`.

### Deduplication

Both push and pull compare document embeddings against existing data using cosine similarity:

- **On push**: each local document's embedding is compared against the remote database. If a match exceeds the similarity threshold (default 0.95), the documents are linked via `related_ids` in both local and remote metadata. The document is still pushed — nothing is discarded.
- **On pull**: each remote document is compared against local ChromaDB data. Matches above the threshold are linked the same way. The remote document is still inserted locally.

This means near-duplicates coexist but are cross-referenced, so you can trace where related knowledge came from without losing data. Adjust the threshold with `YAPA_SYNC_SIMILARITY_THRESHOLD` — lower values link more aggressively, higher values require near-exact matches.

### Delete propagation

When a memory or task is deleted locally, the deletion is queued and propagated to the remote database on the next sync cycle. Pending deletes are processed before any new documents are pushed.

### Private collections

Collections prefixed with `private-` or `local-` are never synced. Use these for personal notes, credentials, or anything that should stay on one machine.

### Database providers

The install wizard handles PostgreSQL setup. Supported providers:

- **Docker** (local) — `pgvector/pgvector:pg17` container
- **Neon** — free serverless PostgreSQL with pgvector included
- **Supabase** — free hosted PostgreSQL with pgvector included
- **AWS RDS** — managed PostgreSQL with pgvector extension
- **GCP Cloud SQL** — managed PostgreSQL with pgvector extension
- **Azure Flexible Server** — managed PostgreSQL with pgvector extension
