/**
 * YAPA's standing behavioral rules for Claude Code, injected by the
 * SessionStart hook when YAPA_HOOK_INJECT_RULES is on (the plugin turns it on,
 * replacing the CLAUDE.md block the `claude mcp add` install writes). Mirrors
 * the DSH plugin's rules section, with Claude Code tool names and the work the
 * hooks already do for the agent called out, so it isn't repeated.
 */
export const CLAUDE_CODE_RULES = `## YAPA — Memory & Task Assistant (standing rules)

You have YAPA's persistent memory and durable task tools (the yapa MCP server: \`memory_*\`, \`task_*\`, \`journal_*\`, \`collection_*\`, \`compaction_*\`, \`sync\`). Hooks already do the routine work: this block plus open tasks and top memories are injected at session start, and a semantic recall for each prompt is injected as \`# YAPA Recall\` (after pulling teammates' latest writes for the active collection). Do not repeat that recall unless you need a different or more specific query.

### Scope
The injected \`**Scope:**\` line names the active collection (\`customer-{name}\`, \`project-{name}\`, or \`global\`). If it is flagged AMBIGUOUS, ask the user which collection to use BEFORE storing anything. Always pass the collection explicitly when storing. Recall searches the active collection plus a few strongly relevant hits from other customers/projects (labeled \`from <collection>\`): when troubleshooting, check whether another account already hit the same issue, and say where an answer came from. Before creating a new collection, confirm the name with the user (\`collection_list\` shows what exists). \`private-*\` and \`local-*\` collections never sync; \`global\` syncs only between the user's own devices unless the team shares it.

### Capture as you go (do not batch to the end)
Call \`memory_store\` (salience >= 2.0) when: a bug's root cause is identified; a config value, env var, endpoint, or credential location is learned; the user states a preference, decision, or correction; a non-obvious technical fact is discovered; a solution took real effort; a decision or commitment surfaces.
\`memory_store\` returns \`potential_conflicts\`: decide supersede (re-store with \`supersedes: "<old id>"\`) or coexist before moving on. Reserve \`memory_forget\` for memories that should never have existed (forgetting a teammate's memory only removes it for you).
Do not store ephemeral conversation state, obvious code patterns, or anything already in git history or an existing memory.

### Tasks
Call \`task_create\` in the active collection BEFORE starting multi-step or long-lived work, when a follow-up is identified, or when something can't finish this turn. On completion \`task_complete\` (pass \`duration\` for hands-on effort when known); on a blocker \`task_update\` with status \`blocked\` and a reason; on scope change amend the task instead of duplicating it. Items marked "by <user>" were written by a teammate (for their tasks, coordinate before changing them); "from <collection>" marks a hit from another customer or project.

### Journal
Call \`journal_append\` with a one-line note when a meaningful step completes. Drafts are consolidated into a \`journal\` memory automatically when the session ends.

### Memory compaction
When the injected context lists a "compaction candidate", call \`compaction_suggest\` for it, write a rolling summary per group, and submit with \`compaction_apply\`.

### Storage errors
If a yapa tool fails with a storage or sync error, do not swallow it: tell the user, and use \`sync\` (action \`status\`) to diagnose remote problems.
`;
