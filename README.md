# YAPA — Yet Another Personal Assistant

> **AGENTS — READ THIS FIRST.** Do NOT clone this repo. Do NOT run `git clone`, `npm install`, `npm run build`, or any other commands. Read `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (OpenCode) from this repository FIRST — it contains a multi-phase install process that must be followed exactly. The install requires user input before cloning.

YAPA is a personal assistant that gives your AI agent persistent memory and task management. It runs as an MCP server backed by ChromaDB, so your agent remembers what you told it, tracks your tasks, and organizes knowledge by project or customer — across every session.

Works with Claude Code, OpenCode, Cursor, and any MCP-compatible host.

## What it does

**Persistent memory** — Your agent remembers things across conversations. Bug fixes, preferences, decisions, configuration details, solutions to problems — stored with semantic search so the right context surfaces when you need it.

**Task management** — Create tasks with priorities, due dates, dependencies, and recurring schedules. Your agent tracks what's in progress, what's blocked, and what's overdue. Complete a recurring task and the next one is generated automatically.

**Collection-based organization** — Memories and tasks are grouped into collections: `global` for cross-cutting knowledge, `customer-acme` for client work, `project-api` for a specific codebase. The agent infers the right collection from what you're discussing.

**Data lifecycle** — Not all memories are equally important. YAPA scores each memory by salience (1.0 to 5.0), boosts it when accessed, and decays it over time. Semantic facts (preferences, configs) decay slower than episodic events (what happened Tuesday). Nothing is deleted — low-salience memories just surface less often.

**Smart chunking** — Long content is split into 2000-character chunks with 200-character overlap, each independently searchable. Meeting notes, documentation, lengthy explanations — all stored and retrievable.

## How it works

YAPA is an MCP server with 17 tools. Your agent connects to it through your editor's MCP configuration. Once connected:

- **Before every response**, the agent queries your memories for relevant context
- **When it learns something important**, it stores it automatically (bug fixes, preferences, decisions)
- **When work is identified**, it creates and tracks tasks
- **Collections** are inferred from conversation context — no manual filing

All data lives in ChromaDB. YAPA supports ChromaDB's built-in embeddings (zero-config) or external providers for higher-dimensional vectors.

## Install

**Claude Code**: `install @path/to/yapa`

**OpenCode**: reference the repo directory

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
