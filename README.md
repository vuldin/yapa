# YAPA — Yet Another Personal Assistant

To install, give your AI agent this prompt: `install https://github.com/vuldin/yapa`

> **AGENTS — READ THIS FIRST.** Do NOT clone this repo. Do NOT run `git clone`, `npm install`, `npm run build`, or any other commands. Read `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (OpenCode) from this repository FIRST — it contains a multi-phase install process that must be followed exactly. The install requires user input before cloning.

YAPA is a personal assistant that gives your AI agent persistent memory and task management. It is backed by ChromaDB, so your agent remembers what you told it, tracks your tasks, and organizes knowledge by project or customer — across every session.

Works with Claude Code, OpenCode, Cursor, and any MCP-compatible host via the MCP server (`packages/mcp`). For the DeepSeek Harness, YAPA also ships as a **native DSH plugin** (`packages/dsh`) with always-on recall injection, hot-reloaded settings, and GUI tool cards — see [`packages/dsh/install.md`](packages/dsh/install.md).

## Repository layout (branch `dsh-plugin`)

- `packages/core` (`@yapa/core`) — all logic: memory, tasks, collections, journal, compaction, sync, curation, buckets, training. Config is a `YapaConfig` snapshot (`createConfig(env)` / `setConfig`) instead of module-level env reads, so hosts control configuration.
- `packages/mcp` (`yapa-mcp`) — the MCP server + Claude-Code hook CLI.
- `packages/dsh` (`@yapa/dsh-plugin`) — the DeepSeek Harness cordis plugin.

## What it does

**Persistent memory** — Your agent remembers things across conversations. Bug fixes, preferences, decisions, configuration details, solutions to problems — stored with semantic search so the right context surfaces when you need it.

**Task management** — Create tasks with priorities, due dates, dependencies, and recurring schedules. Your agent tracks what's in progress, what's blocked, and what's overdue. Complete a recurring task and the next one is generated automatically.

**Collection-based organization** — Memories and tasks are grouped into collections: `global` for cross-cutting knowledge, `customer-acme` for client work, `project-api` for a specific codebase. The agent infers the right collection from what you're discussing.

**Data lifecycle** — Not all memories are equally important. YAPA scores each memory by salience (1.0 to 5.0), boosts it when accessed, and decays it over time. Semantic facts (preferences, configs) decay slower than episodic events (what happened Tuesday). Salience also weights retrieval ranking, so higher-salience memories surface ahead of lower-salience ones at similar vector distance. Nothing is deleted — low-salience memories just surface less often.

**Smart chunking** — Long content is split into 2000-character chunks with 200-character overlap, each independently searchable. Meeting notes, documentation, lengthy explanations — all stored and retrievable.

**Remote sync** — Optionally sync memories and tasks to a shared PostgreSQL+pgvector database. Push local data to the remote, pull teammates' data down. A background sync runs every 5 minutes automatically. The install wizard supports Docker, Neon, Supabase, AWS RDS, GCP Cloud SQL, and Azure Flexible Server.

**Deduplication** — During sync, YAPA compares document embeddings using cosine similarity (default threshold 0.95). Near-duplicates are linked via `related_ids` rather than merged or discarded, so no data is lost and you can trace where related knowledge came from.

## How it works

YAPA is an MCP server with 41 tools. Your agent connects to it through your editor's MCP configuration. Once connected:

- **Before every response**, the agent queries your memories for relevant context
- **When it learns something important**, it stores it automatically (bug fixes, preferences, decisions)
- **When work is identified**, it creates and tracks tasks
- **Collections** are inferred from conversation context — no manual filing
- **If sync is enabled**, a background cycle pushes local changes and pulls remote updates every 5 minutes

All data lives in ChromaDB. YAPA supports ChromaDB's built-in embeddings (zero-config) or external providers for higher-dimensional vectors. When remote sync is enabled, documents are also stored in PostgreSQL with pgvector for cross-machine search and deduplication.

## Install

To install, give your AI agent this prompt: `install https://github.com/vuldin/yapa`

To uninstall later, say `uninstall yapa` in any session.

## Tools

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
| `journal_list_drafts` | Inspect pending journal drafts for the current session |
| `curation_now` | Trigger an immediate curation cycle (classifies unscored memories) |
| `curation_status` | Curation status — provider, last run, cycles, memories scored |
| `curation_preview` | Dry-run the classifier on a sample without persisting |
| `bucket_route_preview` | Dry-run bucket routing — show which memories would be routed where |
| `bucket_route_now` | Route memories and write versioned system-prompt companion + training manifest |
| `bucket_status` | Counts of memories in `selected_for` vs `promoted_to` state |
| `system_prompt_activate` | Confirm a companion version is in use — promotes its memories out of RAG |
| `system_prompt_deactivate` | Rollback — restore a promoted companion's memories to RAG |
| `training_dataset_preview` | Synthesize chat-format training examples from a manifest and emit a preview JSONL + SHA-256 reference |
| `training_trigger` | Submit a training job to the configured backend (requires confirm + matching preview ref) |
| `training_status` | List all training runs in the adapter registry |
| `training_get` | Details on a single training run; polls the backend for live status |
| `training_cancel` | Cancel an in-flight training run; restores affected memories to default RAG |
| `eval_run` | Aggregate eval of a trained adapter against its manifest holdout; returns average score |
| `eval_compare` | Side-by-side eval comparison of two adapters on the same holdout |
| `eval_verify` | Per-memory verification — does the adapter actually know each memory's content? |
| `adapter_promote` | Move verified memories from `selected_for` to `promoted_to` (hide from RAG) |
| `adapter_demote` | Rollback a promotion — restore memories to default RAG |
| `task_create` | Create task with title, priority, due date, tags, collection |
| `task_list` | List tasks with filters |
| `task_get` | Get single task by ID |
| `task_update` | Update task fields |
| `task_complete` | Mark done + handle recurring regeneration |
| `task_delete` | Remove a task |
| `task_search` | Semantic search across tasks |
| `task_add_dependency` | Add depends-on/blocks relationship |
| `collection_list` | List all collections with doc counts |
| `collection_create` | Create new collection |
| `collection_delete` | Delete a collection |
| `decay_sweep` | Manually trigger salience decay |
| `sync_status` | Connection health, last pull time, pending deletes, background cycle state |
| `sync_now` | Trigger immediate push+pull sync cycle |
| `sync_remote_collections` | List remote collections with counts and subscription status |
| `sync_subscribe` | Subscribe to remote collections for pull sync |
| `sync_unsubscribe` | Remove subscription (local data preserved) |
| `uninstall` | Remove YAPA from your system |

## Always-on hooks (Claude Code)

YAPA ships a small `yapa` CLI in addition to the MCP server. It exposes four
hook entry points designed to be invoked from `~/.claude/settings.json`:

| Hook | What it does |
|------|--------------|
| `session-start` | Detects scope from `cwd`, surfaces open tasks + top memories + compaction candidates as `additionalContext` |
| `user-prompt-submit` | Runs `memory_recall` against the detected scope using the prompt as the query and injects the top 3 matches |
| `stop` | Reminds the agent to call `memory_store` / `task_create` / `journal_append` for findings from the just-finished turn |
| `session-end` | Logs the session ending; surfaces pending journal drafts at the next session start |

Register the hooks once in `~/.claude/settings.json` (point the `command` field at the absolute path of `dist/cli/index.js`). After that, recall and task surfacing happen on every prompt without the agent having to remember to call the tools. This is what makes YAPA "always on" rather than best-effort.

Configuration: each hook fails open — if the call errors, the hook emits `{}` and the session continues normally.

## Contradiction detection

`memory_store` runs a similarity check against the destination collection
before each write. Memories within `YAPA_CONTRADICTION_DISTANCE_THRESHOLD`
(default `0.25`, normalized cosine) are returned as `potential_conflicts`. The
agent decides:

- **Supersede** — call `memory_forget` on the conflicting ID, then move on.
- **Coexist** — leave the older memory in place; the new one is already stored.

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

All options use the `YAPA_` prefix and are set as environment variables in your MCP host config. See `.env.example` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `YAPA_CHROMA_URL` | ChromaDB server URL | `http://localhost:8000` |
| `YAPA_USERNAME` | Username for task ID prefixes | `user` |
| `YAPA_EMBEDDING_PROVIDER` | Embedding provider | `chromadb` (server-side) |
| `YAPA_SALIENCE_DECAY_RATE` | Daily decay multiplier | `0.98` |
| `YAPA_SALIENCE_RANKING_WEIGHT` | How much salience influences retrieval ranking (0.0 = pure distance, higher = salience-dominant) | `0.3` |
| `YAPA_CURATION_ENABLED` | Enable the background classifier | `false` |
| `YAPA_CURATION_INTERVAL_MS` | Background curation interval in ms | `604800000` (7 days) |
| `YAPA_CURATION_LLM_PROVIDER` | `fireworks` \| `openai` \| `anthropic` \| `ollama` | `anthropic` |
| `YAPA_CURATION_MODEL` | Override the default model for the chosen provider | _(provider default)_ |
| `YAPA_CURATION_BATCH_SIZE` | Memories per classifier call | `20` |
| `YAPA_ARTIFACTS_DIR` | Where bucket artifacts are written | `~/.yapa/artifacts` |
| `YAPA_SYSTEM_PROMPT_TRAINABLE_MIN` | Min trainable score for system-prompt bucket | `0.5` |
| `YAPA_SYSTEM_PROMPT_DURABILITY_MIN` | Min durability score for system-prompt bucket | `0.7` |
| `YAPA_SYSTEM_PROMPT_GENERALIZABILITY_MIN` | Min generalizability score for system-prompt bucket | `0.5` |
| `YAPA_TRAINING_TRAINABLE_MIN` | Min trainable score for training bucket | `0.7` |
| `YAPA_TRAINING_DURABILITY_MIN` | Min durability score for training bucket | `0.8` |
| `YAPA_TRAINING_GENERALIZABILITY_MIN` | Min generalizability score for training bucket | `0.7` |
| `YAPA_TRAINING_BACKEND` | Training backend — currently `fireworks` | `fireworks` |
| `YAPA_TRAINING_BASE_MODEL` | Base model to fine-tune | `accounts/fireworks/models/qwen3-coder-30b-a3b-instruct` |
| `YAPA_TRAINING_FIRECTL_PATH` | Path to the `firectl` executable | `firectl` |
| `YAPA_TRAINING_SYNTHESIS_MODEL` | Model used to synthesize chat-format training examples from memories | _(falls back to curation model)_ |
| `YAPA_VERIFICATION_ENABLED` | Opt-in gate for per-memory verification (incurs adapter inference cost) | `false` |
| `YAPA_EVAL_HOLDOUT_FRACTION` | Fraction of manifest reserved as holdout for aggregate eval | `0.15` |
| `YAPA_EVAL_HOLDOUT_MIN` | Minimum number of memories in the holdout regardless of fraction | `3` |
| `YAPA_INFERENCE_BASE_URL` | OpenAI-compatible endpoint used to query trained adapters | `https://api.fireworks.ai/inference/v1` |
| `YAPA_SYNC_ENABLED` | Enable remote sync | `false` |
| `YAPA_SYNC_DATABASE_URL` | PostgreSQL connection string | _(none)_ |
| `YAPA_SYNC_INTERVAL_MS` | Background sync interval in ms | `300000` (5 min) |
| `YAPA_SYNC_SIMILARITY_THRESHOLD` | Cosine similarity threshold for dedup | `0.95` |

## Remote Sync

Remote sync lets multiple machines or teammates share memories and tasks through a PostgreSQL+pgvector database. It is optional — YAPA works fully offline with just ChromaDB.

### How it works

When sync is enabled, YAPA runs a background push/pull cycle every 5 minutes (configurable via `YAPA_SYNC_INTERVAL_MS`):

1. **Push** — Local documents flagged as unsynced are uploaded to the remote database. Collections you push to are automatically subscribed for pull.
2. **Pull** — Documents from subscribed remote collections are downloaded, skipping any that originated from the current user. Only documents synced after the last pull timestamp are fetched.

You can also trigger a sync manually with the `sync_now` tool, check status with `sync_status`, and manage subscriptions with `sync_subscribe` / `sync_unsubscribe`.

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
