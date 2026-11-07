# Tools and hooks

## Tools

The table below lists the **MCP** tool names. The DSH plugin has the same
tools with a `yapa_` prefix (`memory_recall` → `yapa_memory_recall`), 30 by
default: all but `lease`, `counter_next`, `setup_instructions` and `uninstall`,
plus `yapa_status` and `yapa_storage_import`.

**Tool surface, kept lean:** the 32 tools below are visible by default. The
ML-ops subsystem (curation classifier, bucket routing, system-prompt
companion, training, eval, adapter promotion — 18 more) is operator workflow,
not daily agent surface: it appears only when `trainingPipeline: true` (DSH
plugin config / settings) or `YAPA_TRAINING_PIPELINE=true` (MCP) is set. See
[training-pipeline.md](training-pipeline.md) for the full pipeline
walkthrough and its tools.

| Tool | Description |
|------|-------------|
| `setup_instructions` | Generate behavioral instructions for CLAUDE.md / AGENTS.md |
| `memory_store` | Store memory with content, tags, salience, sector, collection; optionally typed (`kind`: finding, decision, limitation, question, idea, with status, owner, options, links; see [Findings, decisions and what waits on people](tasks.md#findings-decisions-and-what-waits-on-people)) |
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
| `task_update` | Update task fields (including renaming via `title`); `status: in_progress` claims a task in a shared collection (see [Task claims](tasks.md#task-claims)); `decision_needed` records a person's choice the task then waits on; `learned` / `follow_ups` record what it produced |
| `task_next` | The ready queue for a collection: what to start next (skipping tasks that wait on an open decision or need a person), why other tasks were skipped, cleanup items when nothing is ready; `claim: true` claims the first; `auto_only` for unattended work |
| `task_complete` | Mark done + handle recurring regeneration; `learned` (typed memories linked to the task) and `follow_ups` (new tasks) record what it produced in the same call |
| `task_delete` | Remove a task |
| `task_search` | Semantic search across tasks |
| `task_add_dependency` | Add depends-on/blocks relationship |
| `task_remove_dependency` | Remove a depends-on/blocks relationship (both sides, dangling edges too) |
| `lease` | Bare leases for non-task resources (on the sync service in a shared collection, on this machine in a local-only one or with sync off): `acquire` / `heartbeat` / `release` / `list` (also `yapa coord`) |
| `counter_next` | Next value of a shared counter (ids that must not collide across people) |
| `collection_list` | List all collections with doc counts |
| `scope` | This machine's [folder rules](collections.md#folder-rules): `show` them and what they mean for this session's folder, or change one (`add_root`, `remove_root`, `add_customer`, `remove_customer`, `map`, `unmap`), only when the user asks |
| `collection_create` | Create a new collection (a new shared one only from a session under a project root; see [folder rules](collections.md#folder-rules)) |
| `collection_merge` | Move every document of one collection into another (ids and metadata kept, synced as a move), then remove the empty source |
| `collection_delete` | Remove a collection from this machine (`scope: "local"`, the default: a shared one stays with teammates, everything only this machine has is pushed first, and writes to it are refused until `sync subscribe` follows it again), or delete your documents in it for everyone (`scope: "everyone"`, needs `confirm: "<name>"`). A non-empty collection with no other copy (local-only, or sync off) needs `confirm` too. Not a merge |
| `trash` | Deleted documents: `list` them, `restore` your own on the sync service, `keep` a copy someone else deleted, or `purge` one of yours for good (a leaked secret); see [Deleting, restoring and purging](sync.md#deleting-restoring-and-purging) |
| `decay_sweep` | Manually trigger salience decay |
| `sync` | Sync control via `action`: `status` (health, last pull, pending), `now` (push+pull cycle), `collections` (remote list + subscriptions), `subscribe` / `unsubscribe` (local data preserved) |
| `uninstall` | Remove YAPA from your system |

## Always-on hooks (Claude Code)

> Under the DSH plugin this section does not apply: recall and task surfacing
> are built into the turn seam (`agent/pre-step`) with nothing to register —
> see `packages/dsh/architecture.md`. Cursor and OpenCode have no hooks.

The `yapa` CLI (`plugin/dist/yapa.mjs`, or `packages/mcp/dist/cli/index.js`)
implements YAPA's Claude Code hooks. The plugin registers them automatically;
`yapa hooks install` registers the same set for `claude mcp add` installs.

| Hook | What it does |
|------|--------------|
| `SessionStart` | Detects scope from `cwd` and the [folder rules](collections.md#folder-rules), pulls teammates' latest writes for that collection, injects open tasks + what waits on you (decisions, questions, person-only steps, across collections) + top memories + compaction candidates (plus the standing rules under the plugin, or with `YAPA_HOOK_INJECT_RULES=true`). Re-injects after context compaction (`source: compact`). Rolls up journal drafts left by crashed sessions. |
| `UserPromptSubmit` | Pulls the active collection from the shared DB (bounded by `YAPA_HOOK_PULL_TIMEOUT_MS`, fail-open), then injects the top 3 recall matches for the prompt. Teammates' items are marked `by <user>`; hits from other collections `from <collection>`. |
| `Stop` (async) | Unless `YAPA_RESPONSE_CAPTURE=false`: judges the finished turn (the buffered prompt + Claude Code's `last_assistant_message`) with an aux model: it stores durable findings as `auto-capture` memories (salience ≤ 2.0, deduplicated, typed when they are a finding, a decision made, a limitation, a question or an idea, and linked to the task the session holds), and it records what the turn settles in the open items it touches (a person's choice on a needed decision, an answer to a question, a finding's disposition), so a task waiting on a decision comes back by itself. Uses `claude -p --model haiku` when no curation API key is configured, so subscription users need no key. The result shows as a one-line notice on the next prompt. |
| `PostCompact` (async) | Stores Claude Code's compaction summary as an episodic `compaction` memory, so it outlives the context window. Recall and session start's top memories leave these summaries out unless asked (`memory_recall` with `include_sessions: true`), and they don't count toward memory compaction. |
| `SessionEnd` | Cleans up the session's hook state. Journal consolidation and the final sync push happen in the MCP server's own shutdown (it owns the journal session). |

Every hook fails open: on error it emits `{}` and the session continues.
