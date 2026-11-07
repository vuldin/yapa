# Configuration

Folder rules (project roots, customers, folder → collection mappings) aren't options: they live in one file on this machine, edited with `yapa scope`. See [Collections and folder rules](collections.md#folder-rules).

## Claude Code plugin options

Set at install (`claude plugin install yapa@yapa --config key=value`, repeatable), or later with `/plugin` → Configure options, or `echo '{"remote_name":"acme"}' | claude plugin configure yapa@yapa --values-stdin`.

| Option | Default | Meaning |
|---|---|---|
| `username` | OS login name | Name on task IDs and on everything you sync (with the sync service it comes from your Google account; this is then informational) |
| `storage` | `local` | `local` embedded store (no server) or `chroma` |
| `chroma_url` | `http://localhost:8000` | ChromaDB server when `storage` is `chroma` |
| `sync_enabled`, `sync_service_url` | off | Team sync with a remote that serves the Sync API over HTTP, such as the YAPA sync service, signed in with a Google ID token (`gcloud auth login`) |
| `sync_mcp_url`, `sync_mcp_token_cmd`, `sync_mcp_tool` | empty | Team sync with a remote that serves the Sync API as an MCP tool, signed in with the token the command prints ([Connecting to a remote](connecting-to-a-remote.md#a-remote-served-over-mcp)) |
| `sync_database_url`, `sync_ca_cert` | _(empty)_ | Advanced/self-host: direct PostgreSQL+pgvector URL (ignored when a service or MCP URL is set; stored in the system credential store) |
| `remote_name` | _(empty)_ | Your team's sync remote's name on the status line: `yapa@v<version> <-> <name>` (see [The status line](sync.md#the-status-line)) |
| `statusline` | on | Add YAPA's status line to `~/.claude/settings.json` at session start (an existing one is kept; removing YAPA's keeps it removed) |
| `status_label` | _(empty)_ | Deprecated: use `remote_name` (still read when that is empty) |
| `response_capture` | on | After each turn: capture durable findings (typed: finding, decision made, limitation, question, idea) and record what the turn settles in open decisions, questions and findings (see hooks below) |

## Environment variables

All options use the `YAPA_` prefix and are set as environment variables in your MCP host config. Under the DSH plugin, the same values live in the cordis row `config:` or the hot-reloaded `yapa:` section of `~/.dsh/settings.yaml` (camelCase: `chromaUrl`, `syncEnabled`, …). See `.env.example` for the full list.

| Variable | Description | Default |
|----------|-------------|---------|
| `YAPA_STORAGE` | `chroma` \| `local` (embedded store, no server) | `chroma` for MCP; the DSH plugin defaults to `local` |
| `YAPA_LOCAL_STORE_PATH` | Root dir for the embedded store | `~/.local/share/yapa/store` |
| `YAPA_CHROMA_URL` | ChromaDB server URL (when `YAPA_STORAGE=chroma`) | `http://localhost:8000` |
| `YAPA_USERNAME` | Username for task ID prefixes and sync attribution | OS login name |
| `YAPA_SCOPE_FILE` | The [folder rules](collections.md#folder-rules) file | `~/.local/share/yapa/scope.json` |
| `YAPA_EMBEDDING_PROVIDER` | Embedding provider — `chromadb` is in-process MiniLM (zero-config, no server call); `fireworks`/`openai`/`voyage`/`ollama` use HTTP APIs | `chromadb` |
| `YAPA_SALIENCE_DECAY_RATE` | Per-day decay multiplier for episodic memories (semantic: its square root) | `0.98` |
| `YAPA_SALIENCE_RANKING_WEIGHT` | How much salience influences retrieval ranking (0.0 = pure distance, higher = salience-dominant) | `0.15` |
| `YAPA_SALIENCE_BOOST_MAX_DISTANCE` | Recall hits closer than this cosine distance count as a use and boost salience | `0.5` |
| `YAPA_SALIENCE_MAX_BOOSTS_PER_DAY` | Max boosts per memory per UTC day | `3` |
| `YAPA_SESSION_SUMMARY_RETENTION_DAYS` | Days your own compaction summaries are kept; the daily decay sweep archives older ones (still reachable with `memory_list` `include_archived`, or `memory_recall` with `include_archived` and `include_sessions`). `0` keeps them forever. "Your own" means written under your username: set `YAPA_USERNAME` to the name the sync service gives you | `90` |
| `YAPA_TRAINING_PIPELINE` | Expose the 18 ML-ops tools (curation/buckets/training/eval/adapter) | `false` |
| `YAPA_SYNC_ENABLED` | Enable remote sync | `false` |
| `YAPA_SYNC_SERVICE_URL` | YAPA sync service URL (wins over the database URL) | _(none)_ |
| `YAPA_SYNC_ID_TOKEN_CMD` | Command printing a Google ID token for the service | `gcloud auth print-identity-token` |
| `YAPA_SYNC_MCP_URL` | MCP server that serves the Sync API as its `yapa_sync` tool, usually through an MCP gateway (wins over the service URL) | _(none)_ |
| `YAPA_SYNC_MCP_TOKEN_CMD` | Command printing the bearer token for `YAPA_SYNC_MCP_URL` (required with it) | _(none)_ |
| `YAPA_SYNC_MCP_TOOL` | The sync tool's exact name, when it is neither `yapa_sync` nor one prefixed name like `remote__yapa_sync` | _(found with tools/list)_ |
| `YAPA_SYNC_HTTP_TIMEOUT_MS` | Per-request timeout for the sync service | `15000` |
| `YAPA_SYNC_DATABASE_URL` | Advanced/self-host: direct PostgreSQL connection string (ignored when a service or MCP URL is set) | _(none)_ |
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
[docs/training-pipeline.md](training-pipeline.md#configuration).
