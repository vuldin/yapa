# YAPA — Yet Another Personal Assistant

**DeepSeek Harness:** see [`packages/dsh/install.md`](packages/dsh/install.md) — the native plugin needs no wizard (and no database server under the default embedded store).

**Claude Code (recommended):** install the plugin — MCP server, hooks, and skills in one step:

```
claude plugin marketplace add vuldin/yapa
claude plugin install yapa@yapa
```

**Claude Code via `claude mcp add` / Cursor / OpenCode:** see [Install](#install), or give your AI agent this prompt: `install https://github.com/vuldin/yapa`

> **AGENTS — READ THIS FIRST.** Do NOT clone this repo. Do NOT run `git clone`, `npm install`, `npm run build`, or any other commands. For MCP hosts, read `CLAUDE.md` (Claude Code / Cursor) or `AGENTS.md` (OpenCode) from this repository FIRST — it contains a multi-phase install process that must be followed exactly. The install requires user input before cloning. For the DeepSeek Harness, follow `packages/dsh/install.md` instead (no agent-driven wizard).

YAPA is a personal assistant that gives your AI agent persistent memory and task management, so your agent remembers what you told it, tracks your tasks, and organizes knowledge by project or customer — across every session.

YAPA runs two frontends over one core:

- **Native DeepSeek Harness plugin** (`yapa`, in `packages/dsh`) — 23 tools by default (+18 gated ML-ops) with structured outputs and GUI cards, always-on recall injected at the turn seam, **automatic capture of durable findings from every agent turn** (aux-LLM extractor + conservative conflict resolver), a **daily contradiction janitor** that archives duplicates and supersedes stale memories, hot-reloaded settings, schedule-bridged due dates, compaction capture, approval gating, and an embedded zero-server storage option. Docs: [install](packages/dsh/install.md) · [architecture](packages/dsh/architecture.md) · [future work & investigation record](docs/future-work.md).
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
| `username` | OS login name | Name on task IDs and on everything you sync |
| `storage` | `local` | `local` embedded store (no server) or `chroma` |
| `chroma_url` | `http://localhost:8000` | ChromaDB server when `storage` is `chroma` |
| `project_roots` | _(empty)_ | Comma-separated folders whose subfolders map to `project-{name}` / `customer-{name}` collections |
| `customers` | _(empty)_ | Folder names under a root that are customers |
| `sync_enabled`, `sync_database_url` | off | Team sync through PostgreSQL+pgvector (the URL is stored in the system credential store) |
| `response_capture` | off | Auto-capture durable findings after each turn (see hooks below) |

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

The `yapa` CLI (`plugin/dist/yapa.mjs`, or `packages/mcp/dist/cli/index.js`)
implements YAPA's Claude Code hooks. The plugin registers them automatically;
`yapa hooks install` registers the same set for `claude mcp add` installs.

| Hook | What it does |
|------|--------------|
| `SessionStart` | Detects scope from `cwd` and `YAPA_PROJECT_ROOTS`, pulls teammates' latest writes for that collection, injects open tasks + top memories + compaction candidates (plus the standing rules under the plugin). Re-injects after context compaction (`source: compact`). Rolls up journal drafts left by crashed sessions. |
| `UserPromptSubmit` | Pulls the active collection from the shared DB (bounded by `YAPA_HOOK_PULL_TIMEOUT_MS`, fail-open), then injects the top 3 recall matches for the prompt. Teammates' items are marked `by <user>`; hits from other collections `from <collection>`. |
| `Stop` (async) | With `YAPA_RESPONSE_CAPTURE=true`: judges the finished turn (the buffered prompt + Claude Code's `last_assistant_message`) with an aux model and stores durable findings as `auto-capture` memories (salience ≤ 2.0, deduplicated; a changed fact supersedes the stale memory). Uses `claude -p --model haiku` when no curation API key is configured, so subscription users need no key. The result shows as a one-line notice on the next prompt. |
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
| `YAPA_EMBEDDING_PROVIDER` | Embedding provider — `chromadb` is in-process MiniLM (zero-config, no server call); `fireworks`/`openai`/`voyage`/`ollama` use HTTP APIs | `chromadb` |
| `YAPA_SALIENCE_DECAY_RATE` | Per-day decay multiplier for episodic memories (semantic: its square root) | `0.98` |
| `YAPA_SALIENCE_RANKING_WEIGHT` | How much salience influences retrieval ranking (0.0 = pure distance, higher = salience-dominant) | `0.15` |
| `YAPA_SALIENCE_BOOST_MAX_DISTANCE` | Recall hits closer than this cosine distance count as a use and boost salience | `0.5` |
| `YAPA_SALIENCE_MAX_BOOSTS_PER_DAY` | Max boosts per memory per UTC day | `3` |
| `YAPA_TRAINING_PIPELINE` | Expose the 18 ML-ops tools (curation/buckets/training/eval/adapter) | `false` |
| `YAPA_SYNC_ENABLED` | Enable remote sync | `false` |
| `YAPA_SYNC_DATABASE_URL` | PostgreSQL connection string | _(none)_ |
| `YAPA_SYNC_INTERVAL_MS` | Background sync interval in ms | `300000` (5 min) |
| `YAPA_SYNC_SIMILARITY_THRESHOLD` | Cosine similarity threshold for dedup | `0.95` |
| `YAPA_SYNC_PUSH_DEBOUNCE_MS` | Delay before a write-triggered push (`0` = interval only) | `2000` |
| `YAPA_SYNC_PULL_OVERLAP_SECONDS` | Re-read window on each pull so mid-pull pushes are never skipped | `120` |
| `YAPA_DEVICE_ID` | Stable id for this machine (else generated once at `YAPA_DEVICE_ID_PATH`) | _(generated)_ |
| `YAPA_HOOK_PULL_TIMEOUT_MS` | Cap on the hooks' pre-recall pull | `4000` |
| `YAPA_RESPONSE_CAPTURE` | Auto-capture durable findings after each turn (Stop hook) | `false` |
| `YAPA_CURATION_LLM_PROVIDER` | Aux model for capture/curation: `anthropic` \| `openai` \| `fireworks` \| `ollama` \| `claude-cli` | `anthropic` (hooks fall back to `claude-cli` without a key) |
| `YAPA_MODEL_CACHE_DIR` | Where the in-process embedder caches model weights | library default |

Empty values count as unset (Claude Code substitutes `""` for plugin options you never configured).

ML-ops configuration (curation models, bucket thresholds, training backend,
eval holdout, …) lives in
[docs/training-pipeline.md](docs/training-pipeline.md#configuration).

## Remote Sync

Remote sync lets multiple machines or teammates share memories and tasks through a PostgreSQL+pgvector database. It is optional — YAPA works fully offline with just ChromaDB.

### How it works

When sync is enabled, YAPA runs a background push/pull cycle every 5 minutes (configurable via `YAPA_SYNC_INTERVAL_MS`), and two faster paths keep teammates current within seconds:

- **Push on write** — every write tool (`memory_store`, `task_update`, …) schedules a debounced push (`YAPA_SYNC_PUSH_DEBOUNCE_MS`), and the MCP server flushes pending pushes on shutdown.
- **Pull before recall** — the Claude Code hooks pull the active collection right before injecting context, so a teammate's memory from seconds ago shows up on your next prompt.

The cycle itself:

1. **Push** — Local documents flagged as unsynced are uploaded, stamped with this machine's `origin_device`. Collections you push to are automatically subscribed for pull. Journal drafts stay local; only consolidated journals sync.
2. **Pull** — Documents from subscribed collections are downloaded, skipping only rows **last written by this device** (so your other machines still receive your work). A newly subscribed collection backfills its full history. The stored pull point is the cycle *start* minus an overlap window, so a document pushed while a pull is running is never skipped.
3. **Updates** — When a remote document is newer than the local copy and the local copy has no unpushed edits, the remote version replaces it (a teammate completing a task, a corrected memory). A local copy with unpushed edits wins and is pushed on the next cycle.

### Multi-user semantics

- **Attribution** — documents keep their original author (`origin_user`); injected context marks teammates' items `by <user>`.
- **`global` is local-only** — like `private-`/`local-` collections it never leaves your machine (not even to your other devices). Put team-wide knowledge in a shared collection such as `project-cs-team`.
- **Same user, several machines** — use the same `YAPA_USERNAME` everywhere; each install has its own device id.
- **No access control yet** — everyone with the database URL can read every shared collection. Use `private-`/`local-` collections for anything that must not leave your machine.

You can also trigger a sync manually with `sync` (`action: 'now'`), check status with `action: 'status'`, and manage subscriptions with `action: 'subscribe'` / `'unsubscribe'`.

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

### Testing sync against a real database

`npm test` mocks Postgres. To run the end-to-end sync suite (multi-user model,
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
