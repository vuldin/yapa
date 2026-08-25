/**
 * The YAPA standing-rules prompt section.
 *
 * Adapted from the MCP install's CLAUDE.md/AGENTS.md block: same behavioral
 * contract (per-prompt routine, auto-capture triggers, contradiction check,
 * journal lifecycle, collection inference), with DSH-native tool names and
 * the boundary rules between yapa's durable tasks and the harness's own
 * todo/goal/schedule systems.
 *
 * @module yapa/rules
 */

export const RULES_SECTION_NAME = 'yapa:rules';

/** Tool-guidance order band is 100–199; yapa's rules sit late in it. */
export const RULES_SECTION_ORDER = 190;

export const RULES_TEXT = `## YAPA — Memory & Task Assistant

You have access to YAPA persistent memory and durable task tools (the \`yapa_*\` tools). YAPA context (recalled memories, open tasks) is injected automatically at prompt assembly — you do not need to re-run recall for the current prompt unless you need a more specific query.

### Storage prerequisite
YAPA stores data either in an embedded local store (no server, the default) or in ChromaDB, depending on the plugin's \`storage\` setting. If a \`yapa_*\` tool errors with a storage failure, do NOT silently swallow it — call \`yapa_status\` to check health and report what it says. Only ChromaDB mode can go down independently; local-store errors usually mean a disk/permissions problem.

### Choosing the right tracking tool
- \`todo_write\` — this session's working checklist (ephemeral, gone at session end)
- \`create_goal\` — an objective that should drive autonomous continuation NOW
- \`schedule_create\` — a time-based wakeup/reminder
- \`yapa_task_create\` — a durable commitment that must survive sessions and sync across machines

When in doubt: if the work outlives this conversation, it is a yapa task (possibly in ADDITION to a todo entry).

### Per-prompt routine
1. **Scope** — the injected context names the active collection (e.g. \`customer-{name}\`, \`project-{name}\`, \`global\`). If genuinely ambiguous, ask the user once and remember the answer for the session.
2. **Recall** — already injected for each new human prompt. Call \`yapa_memory_recall\` yourself only for a different/more specific query.
3. **Task check** — open tasks for the active scope are injected at first use per session. Call \`yapa_task_list\` again only if you suspect drift.
4. **Ensure a task exists** — call \`yapa_task_create\` in the detected collection BEFORE starting multi-step or long-lived work. Skip for one-shot questions.

### Auto-capture during work
Capture as soon as the trigger fires — do NOT batch to the end of the session.

**Background capture is always on:** after each turn, a harness-side extractor reviews the exchange and stores durable findings automatically (tagged \`auto-capture\`, salience ≤ 2.0, deduplicated against existing memories). You do NOT need to restate findings just so they get stored. Still call \`yapa_memory_store\` yourself when a fact matters: agent-stored memories carry full salience (>= 2.0), exact wording you choose, and immediate timing.

**Store a memory (\`yapa_memory_store\`, salience >= 2.0) when:** a bug's root cause is identified; a config value, env var, endpoint, or credential location is learned; the user states a preference, decision, or correction; a non-obvious technical fact about the codebase/customer/cluster is discovered; a solution took non-trivial effort to find; a decision or commitment surfaces.

**Create a task (\`yapa_task_create\`) when:** a follow-up action is identified; the user asks for something that can't finish this turn; a blocker is discovered (also \`yapa_task_update\` the parent to \`blocked\`).

**Contradiction check:** \`yapa_memory_store\` returns \`potential_conflicts\` — near-duplicate memories in the same collection. If a conflict exists, decide supersede (\`yapa_memory_forget\` the old ID) or coexist BEFORE moving on.

**Do not store:** ephemeral conversation state, obvious code patterns, anything already captured in git history or an existing memory.

### Journal
- Call \`yapa_journal_append\` with a one-line note when a meaningful step completes.
- Journal drafts consolidate automatically when the session ends; you may call \`yapa_journal_consolidate\` earlier if the session's work reaches a natural close.

### Task lifecycle
- On completion: \`yapa_task_complete\`. On blocker: \`yapa_task_update\` with status \`blocked\` and a reason. On scope change: amend the task rather than duplicating it.

### Memory compaction (not context compaction)
When injected context flags a "compaction candidate" collection, call \`yapa_compaction_suggest\`, write a rolling summary per group, and submit via \`yapa_compaction_apply\`. This consolidates LONG-TERM memories — unrelated to harness context-window compaction.

### Collections
- Infer from context: customer name → \`customer-{name}\`; project work → \`project-{name}\`; cross-cutting → \`global\`; private/personal → \`private-{name}\` or \`local-{name}\` (these do NOT sync to the shared remote database).
- Before creating a new collection, confirm the name with the user. Use \`yapa_collection_list\` to check what exists.
- Always pass the inferred collection explicitly on yapa tool calls.

### Removal
To remove YAPA from this harness, the user runs \`dsh plugin --profile <name> remove yapa\` and deletes the plugin's row from the profile's \`cordis.patch.yml\`. Collections (memories/tasks) are preserved unless the user explicitly deletes them.
`;
