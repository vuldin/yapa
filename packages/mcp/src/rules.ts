/**
 * YAPA's standing rules, served as the MCP server's `instructions`, so every
 * MCP host (Claude Code, Cursor, OpenCode) loads them at session start.
 * Claude Code cuts server instructions at 4,096 characters; a test keeps
 * this under SERVER_INSTRUCTIONS_MAX. How each tool behaves is in its own
 * description; these say when to use them. The DSH plugin has its own
 * rules section (packages/dsh/src/rules.ts).
 */
export const SERVER_INSTRUCTIONS_MAX = 3_800;

export const SERVER_INSTRUCTIONS = `YAPA gives you persistent memory (memory_*), durable tasks (task_*) and collections that scope both, so what you learn outlives this session.

Context: when a "# YAPA Context" or "# YAPA Recall" block is injected (Claude Code hooks), use it and don't repeat that recall unless you need a more specific query. Without one, call memory_recall and task_list for the active collection when work starts.

Scope: the "**Scope:**" line names the active collection. If it says AMBIGUOUS, ask the user which collection to use before storing anything. Always pass the collection explicitly. Hits marked "from <collection>" come from another project or customer: check them when troubleshooting, and say where an answer came from. private-*, local-* and global never sync. A new shared collection can only be created from a session under a project root; if a write is refused, use a private- name or ask the user. Change the folder rules (scope tool) only when the user asks. Combine or rename collections with collection_merge, never collection_delete.

Capture as you go, not at the end: memory_store (salience >= 2) when a root cause is found, a config value, endpoint or credential location is learned, the user states a preference, decision or correction, a non-obvious fact turns up, or a fix took real effort. Give it a kind: finding (a result, root cause or trap), decision (accepted; or needed, with options, a recommendation and the owner, when only a person can choose: never leave that only in chat), limitation (with exit_criteria), question (with the owner who must answer), or idea. Settle potential_conflicts before moving on: supersede (supersedes) or coexist. Don't store conversation state, or what git or an existing memory already holds. Record a person's answer with memory_update. Tell the user about items waiting on them (waiting). A project's own instructions win where they keep these records elsewhere.

Tasks: task_create before multi-step or long-lived work, for a follow-up, or when something can't finish this turn. Set in_progress when you start: it claims the task. If refused, say who holds it and offer other work; reclaim only your own other session, after the user confirms; if the claim is not shared, say others may start it too. Finish with task_complete, recording learned and follow_ups in the same call. When blocked, task_update with status blocked and a reason, or decision_needed when a person must choose. Tags: auto (an unattended session may do it), needs-human, needs:<user>. "by <user>" marks a teammate's item: coordinate before changing their tasks. Pass on any "**YAPA claim:**" line to the user.

Leases (lease, yapa coord): only when the project's own instructions call for them. Journal: journal_append a one-line note when a meaningful step completes. When a compaction candidate is listed, compaction_suggest then compaction_apply. If a yapa tool reports a storage or sync error, tell the user (sync with action status diagnoses it).`;
