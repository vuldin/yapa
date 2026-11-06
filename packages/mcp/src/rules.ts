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
The injected \`**Scope:**\` line names the active collection (\`customer-{name}\`, \`project-{name}\`, or \`global\`). If it is flagged AMBIGUOUS, ask the user which collection to use BEFORE storing anything. Always pass the collection explicitly when storing. Recall searches the active collection plus a few strongly relevant hits from other customers/projects (labeled \`from <collection>\`): when troubleshooting, check whether another account already hit the same issue, and say where an answer came from. Before creating a new collection, confirm the name with the user (\`collection_list\` shows what exists). \`private-*\`, \`local-*\` and \`global\` collections never sync (\`global\` is personal; team-wide knowledge goes in a shared collection). To combine or rename collections use \`collection_merge\` (it keeps every document), not \`collection_delete\`. \`collection_delete\` removes a collection from this machine only; pass \`scope: "everyone"\` (with \`confirm\`) only when the user explicitly asks to delete it for the whole team.

### Capture as you go (do not batch to the end)
Call \`memory_store\` (salience >= 2.0) when: a bug's root cause is identified; a config value, env var, endpoint, or credential location is learned; the user states a preference, decision, or correction; a non-obvious technical fact is discovered; a solution took real effort; a decision or commitment surfaces.
\`memory_store\` returns \`potential_conflicts\`: decide supersede (re-store with \`supersedes: "<old id>"\`) or coexist before moving on. Reserve \`memory_forget\` for memories that should never have existed (forgetting a teammate's memory only removes it for you).
Do not store ephemeral conversation state, obvious code patterns, or anything already in git history or an existing memory.

### Where what you learn goes
Give a memory a \`kind\` when it is one of these, so it can be listed and waited on:
- a result, root cause, retraction or methodology trap: \`kind: finding\` (status open; resolve it later with a \`disposition\`: decision, task, limitation, or no-action with a reason)
- a choice that was made: \`kind: decision\`, status \`accepted\`
- a choice only a person can make: \`kind: decision\`, status \`needed\`, with \`options\`, a \`recommendation\` and the \`owner\` who decides. Never leave such a choice only in chat. When it is for the task you are on, use \`task_update\` with \`decision_needed\` instead: it records the decision and the task waits on it.
- something that can't be done yet: \`kind: limitation\`, with \`exit_criteria\`
- a question for a person or another team: \`kind: question\`, with the \`owner\` who must answer
- an idea nobody has committed to: \`kind: idea\`
- follow-up work: a task
A project's own instructions win where they keep these records elsewhere. Record a person's answer with \`memory_update\` (a decision: status accepted or rejected, the choice as \`note\`; a question: status answered). Session start lists what waits on you under "Waiting on you"; \`waiting\` lists everything: tell the user about items that are theirs.

### Tasks
Call \`task_create\` in the active collection BEFORE starting multi-step or long-lived work, when a follow-up is identified, or when something can't finish this turn. On completion \`task_complete\` (pass \`duration\` for hands-on effort when known), and record what the task produced in the same call: \`learned\` (typed memories, linked to the task) and \`follow_ups\` (new tasks). If the reply says nothing was recorded, consider whether something should have been. On a blocker \`task_update\` with status \`blocked\` and a reason; when the blocker is a person's choice, \`decision_needed\` instead (then take other work: the task comes back once the decision is recorded). On scope change amend the task instead of duplicating it. Tags \`auto\` (an unattended session may do all of it), \`needs-human\` (a step only a person takes) and \`needs:<user>\` (one person must take it) triage a task; \`task_next\` never offers a \`needs-human\` task and, with \`auto_only\`, only offers \`auto\` ones. Items marked "by <user>" were written by a teammate (for their tasks, coordinate before changing them); "from <collection>" marks a hit from another customer or project.

### Journal
Call \`journal_append\` with a one-line note when a meaningful step completes. Drafts are consolidated into a \`journal\` memory automatically when the session ends.

### Task claims
Setting a task to \`in_progress\` claims it for this session (a lease on its id: on the sync service in a shared collection, on this machine in a local-only one such as \`private-*\`), so teammates and your other sessions don't start the same work; leaving \`in_progress\` (complete, blocked, pending, delete) releases it. Set \`in_progress\` when you actually start a task. If the update is refused, nothing changed: tell the user who holds it and since when, and offer other work. If it names your own other session, pass \`reclaim: true\` only after the user confirms that session is finished or theirs to take over. If the reply says the claim is NOT shared (offline, signed out), tell the user others may start it too. Task lines show "claimed by <who>"; before starting a task claimed by someone else, tell the user. A "**YAPA claim:**" line in the context means a claim was taken over or clashed: pass it on to the user.

### Shared work (leases)
For other shared resources, some projects coordinate through bare YAPA leases (the \`lease\` tool, or a project script calling \`yapa coord\`). Take one only when the project's own instructions or tooling call for it, never on your own initiative. Session start lists live leases in the active collection under "Work in progress": before starting something listed there, tell the user who holds it. If an acquire is refused, say who holds the work and since when, and offer something else; don't retry in a loop. If you took over an expired lease, say whose it was. If the service is unreachable, say the work is not shared. Heartbeats are automatic while this session is active; don't schedule them.

### Memory compaction
When the injected context lists a "compaction candidate", call \`compaction_suggest\` for it, write a rolling summary per group, and submit with \`compaction_apply\`.

### Storage errors
If a yapa tool fails with a storage or sync error, do not swallow it: tell the user, and use \`sync\` (action \`status\`) to diagnose remote problems.
`;
