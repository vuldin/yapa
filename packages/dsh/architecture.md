# YAPA × DSH — Architecture

How the `yapa` plugin integrates into the DeepSeek Harness, how the storage
layer works, how to run it, and how to verify it. For install steps see
[install.md](install.md); for the MCP frontend see the root README.

## Overview

```
┌──────────────────────────── DeepSeek Harness process ───────────────────────────┐
│                                                                                 │
│  yapa plugin (cordis, effect-scoped)                                            │
│  ├── 46 yapa_* tools .............. ctx.tools.register(defineTool(...))         │
│  ├── rules prompt section ......... ctx.systemPrompt.section (order 190)        │
│  ├── promoted-memories section .... ctx.systemPrompt.section (order 50, cached) │
│  ├── pre-step injector ............ ctx.on('agent/pre-step', ...) waterfall     │
│  ├── session lifecycle ............ session/disposed → journal consolidate      │
│  ├── skills ....................... ctx.skills.register ('yapa-standup')        │
│  ├── settings namespace ........... ctx.settings.register('yapa', hot-reload)   │
│  ├── LLM bridge ................... aux calls (curation/judge) via ctx.llm      │
│  ├── schedule bridge .............. due tasks → schedule_create reminders       │
│  ├── compaction capture ........... compaction/summary → memory                 │
│  ├── approval gate ................ tools/pre-execute → ask (ask-policy only)   │
│  └── timers ....................... cordis interval: decay sweep, sync cycle    │
│                          │                                                      │
│                    @yapa/core (harness-neutral)                                 │
│                          │                                                      │
│                VectorStore port                                                 │
│              ┌───────────┴───────────┐                                          │
│         chroma adapter          local adapter                                   │
└──────────────┼───────────────────────┼──────────────────────────────────────────┘
               ▼                       ▼
        ChromaDB server (opt.)   ~/.local/share/yapa/store/*.json
```

## Integration points (what DSH gives yapa)

| YAPA need | DSH seam | Notes |
|---|---|---|
| Tools | `ctx.tools.register(defineTool)` | Structured outputs validated against `output.schema`; `render()` projects to model-facing markdown (parity with the MCP server's text); `presentCall`/`presentResult` give GUI cards; `timeoutMs`, `isConcurrencySafe` opt into scheduling. |
| Standing behavioral rules | `ctx.systemPrompt.section({name: 'yapa:rules', order: 190, text})` | Replaces the CLAUDE.md/AGENTS.md install block. Includes the boundary rules vs `todo_write` / `create_goal` / `schedule_create`. |
| Promoted memories in the system prompt | second section, `yapa:promoted`, order 50 | Sections render synchronously, so content comes from a cache refreshed on activation, every 5 min, and after bucket tool calls (`tools/result` observer). |
| Per-prompt recall + task surfacing | `agent/pre-step` waterfall | Runs after the inbox claim with the turn's actual messages. Splice position: immediately after the last claimed message (same pattern as `dsh-agent-instructions`). Injected as a durable `source: {kind: 'plugin', plugin: 'yapa', form: 'recall'}` message. Fail-open: store errors degrade to no context. **Not** `system-prompt/assemble` — the loop assembles before appending `user/message`, so the current prompt is invisible there (found in acceptance testing). |
| Session lifecycle | `session/created` / `session/disposed` | Journal drafts are keyed by DSH session id (`exec.agent.id`); consolidation runs automatically on dispose. |
| Background loops | `ctx.interval` (cordis timer, effect-scoped) | Decay (hourly due-check) and sync replace the MCP server's process-level `setInterval`; they die cleanly with the plugin (HMR-safe). |
| User config | `ctx.settings.register('yapa', Config, {base, applies: 'live'})` | Three layers: env (`YAPA_*`) < cordis row `config:` < `~/.dsh/settings.yaml` `yapa:` (hot-reloaded; watchers re-resolve and re-apply store/sync). |
| Auxiliary LLM (curation, synthesis, judge) | `ctx.llm.stream()` | `setHostLLMCaller` in core funnels every aux call through one override; the plugin routes to `auxProvider`/`auxModel` or the harness default model. No separate API keys. |
| Durable reminders | `schedule_create` tool dispatch | `tools/result` observer on `yapa_task_create`/`yapa_task_update` bridges due dates. Best-effort: absent schedule plugin or non-root agent → silent skip. |
| Knowledge surviving context compaction | `session/event` → `compaction/summary` | The harness's own distilled summary is stored as an episodic memory (salience 1.5, tagged `compaction`). |
| Destructive-op safety | `tools/pre-execute` → `{kind: 'ask'}` | Gated list; only fires when the session's effective approval policy is `ask` (danger-full-access = `never` = no prompts). Headless without an answerer fails closed. |

## Storage layer

### The port (`packages/core/src/store/`)

Every core module talks to `VectorStore` via free-function delegates in
`store/index.js` (`addDocument`, `queryDocuments`, `getDocumentsByFilter`, …).
`getStore()` returns the installed store or resolves `STORAGE` from config;
hosts install explicitly with `setStore()`.

### Embedding (shared by both backends)

Embeddings are always computed **in-process** by the configured embedder —
default MiniLM-L6-v2 on `onnxruntime-web` (WASM, no native build), cached under
the HF cache dir. No storage backend performs server-side embedding. HTTP
providers (Fireworks/OpenAI/Voyage/Ollama) are config-selectable.

### cosine distance contract

Distances are cosine, in `[0, 2]`, on both backends. ChromaDB 1.x defaults
collections to L2, which silently breaks yapa's tuned thresholds (a weak match
measured 2.058 under L2) — the chroma adapter pins `hnsw.space: 'cosine'` at
collection creation, and the local store computes cosine directly (norm-safe).

### The local (embedded) adapter

- **Layout**: one JSON file per collection, `~/.local/share/yapa/store/<name>.json`
  (configurable via `localStorePath` / `YAPA_LOCAL_STORE_PATH`).
- **Writes**: atomic tmp-file + rename; serialized per collection through a
  promise chain; each `updateDocumentsBatch` flushes once (decay sweeps no
  longer rewrite per document).
- **Reads**: whole collection in memory; brute-force cosine scan. Measured at
  1,000 docs: ~3ms median query including embedding; exact (no ANN error).
- **Vector-space partition**: each document records `embedding_model`;
  queries skip mismatched docs, so switching embedders never corrupts recall.
- **Multi-process freshness**: every operation stats the collection file and
  reloads when another process rewrote it (GUI + headless share safely).
  Atomic renames prevent torn reads; the residual same-instant writer race is
  accepted for the single-user design point (a lockfile is listed in
  [future work](../../docs/future-work.md)).
- **Metadata shape** round-trips through the same `toChroma`/`fromChroma`
  adapter as the Chroma backend, so records are interchangeable for import
  and sync.

### Topology decision (2026-08-19)

The local store is the single-user working set (bounded count, one user,
possibly concurrent sessions). **PostgreSQL+pgvector is exclusively the
multi-user sharing layer** (team merge point), reached through the sync
subsystem — which reads through the same `VectorStore` port, so sync works
identically from either backend. ChromaDB remains available for large shared
corpora.

## Startup

DSH plugin (web profile shown):

```sh
# once:
dsh plugin --profile web add yapa        # or the symlink route in install.md
# cordis.patch.yml row:
#   - insert: [{ id: yapa, name: 'yapa', config: { username: …, projectRoots: […], storage: local } }]

dsh web                                   # everything starts with the harness
```

No database to start under `storage: local`. Under `storage: chroma`, start
ChromaDB first (see install.md). The MCP server is unchanged:
`node packages/mcp/dist/index.js` (health-gates on ChromaDB unless
`YAPA_STORAGE=local`).

## Verification

1. `yapa_status` → reports the embedded store path (or ChromaDB health).
2. `yapa_memory_store` a fact → **new session** → ask about the topic → the
   memory appears automatically in the injected `# YAPA Context` block (look
   for the `plugin/yapa` recall message in the transcript).
3. `yapa_task_create` with `due: tomorrow` → `schedule_list` shows the bridged
   reminder; `yapa_task_list` shows the task in any later session.
4. `yapa_collection_delete` (or another gated tool) → an approval prompt in
   ask-mode sessions; a clear fail-closed error headless.
5. Settings hot reload: edit `~/.dsh/settings.yaml` `yapa:` (e.g.
   `recallResults: 5`) → next prompt picks it up without a restart.
6. Data on disk: `~/.local/share/yapa/store/<collection>.json` is
   human-readable JSON (ids, content, metadata, 384-dim vectors).
7. Tests: `npm test` at the repo root (core + plugin suites).

## Tested acceptance history (branch `dsh-plugin`)

- Headless store → fresh-process auto-recall; task surfacing; skill load;
  LLM bridge through the harness route; approval-gate denial without an
  answerer; Chroma→local import with recall at cosine 0.354; all with
  ChromaDB stopped. The `system-prompt/assemble` → `agent/pre-step` injector
  fix and the chroma-adapter recursion bug were both caught by this loop.
