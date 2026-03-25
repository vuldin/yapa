# YAPA — Yet Another Personal Assistant

To install, give your AI agent this prompt: `install https://github.com/vuldin/yapa`

> **AGENTS — READ THIS FIRST.** Do NOT clone this repo. Do NOT run `git clone`, `npm install`, `npm run build`, or any other commands. Read `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (OpenCode) from this repository FIRST — it contains a multi-phase install process that must be followed exactly. The install requires user input before cloning.

YAPA is a personal assistant that gives your AI agent persistent memory and task management. It runs as an MCP server backed by ChromaDB, so your agent remembers what you told it, tracks your tasks, and organizes knowledge by project or customer — across every session.

Works with Claude Code, OpenCode, Cursor, and any MCP-compatible host.

## What it does

**Persistent memory** — Your agent remembers things across conversations. Bug fixes, preferences, decisions, configuration details, solutions to problems — stored with semantic search so the right context surfaces when you need it.

**Task management** — Create tasks with priorities, due dates, dependencies, and recurring schedules. Your agent tracks what's in progress, what's blocked, and what's overdue. Complete a recurring task and the next one is generated automatically.

**Collection-based organization** — Memories and tasks are grouped into collections: `global` for cross-cutting knowledge, `customer-acme` for client work, `project-api` for a specific codebase. The agent infers the right collection from what you're discussing.

**Data lifecycle** — Not all memories are equally important. YAPA scores each memory by salience (1.0 to 5.0), boosts it when accessed, and decays it over time. Semantic facts (preferences, configs) decay slower than episodic events (what happened Tuesday). Nothing is deleted — low-salience memories just surface less often.

**Smart chunking** — Long content is split into 2000-character chunks with 200-character overlap, each independently searchable. Meeting notes, documentation, lengthy explanations — all stored and retrievable.

**Remote sync** — Optionally sync memories and tasks to a shared PostgreSQL+pgvector database. Push local data to the remote, pull teammates' data down. A background sync runs every 5 minutes automatically. The install wizard supports Docker, Neon, Supabase, AWS RDS, GCP Cloud SQL, and Azure Flexible Server.

**Deduplication** — During sync, YAPA compares document embeddings using cosine similarity (default threshold 0.95). Near-duplicates are linked via `related_ids` rather than merged or discarded, so no data is lost and you can trace where related knowledge came from.

## How it works

YAPA is an MCP server with 23 tools. Your agent connects to it through your editor's MCP configuration. Once connected:

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
| `memory_recall` | Semantic search with optional collection/tag filters |
| `memory_forget` | Delete memory by ID |
| `memory_list` | List memories with metadata filters |
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
