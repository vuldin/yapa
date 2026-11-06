/**
 * Programmatic skill registrations (no filesystem skill dirs needed).
 *
 * @module yapa/skills
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-skill';
import type { ResolvedConfig } from './config.js';

const STANDUP_CONTENT = `# YAPA Daily Standup

Produce a standup from YAPA's durable task store. Steps:

1. Call \`yapa_task_list\` with status \`in_progress\` and again with status
   \`blocked\`. Call \`yapa_task_list\` with no status filter to find overdue
   and due-today items (compare \`due\` dates against today).
2. If the user named a customer or project, pass the matching \`collection\`
   (e.g. \`customer-acme\`) on those calls; otherwise aggregate across
   collections (omit \`collection\`).
3. Format as markdown sections in this order — **Overdue**, **Due today**,
   **In progress**, **Blocked** — one checkbox line per task with its ID,
   title, and (for overdue) days overdue. Omit empty sections.
4. Close with one sentence suggesting the single highest-priority next action,
   and offer to create or update tasks with \`yapa_task_create\` /
   \`yapa_task_update\` if the user wants changes.
`;

/** The work loop (plugin/skills/work/SKILL.md), with DSH tool names. */
const WORK_CONTENT = `# YAPA work loop

One pass over a collection's ready queue, alongside other sessions and teammates. If the project has its own work loop or rules for this (its CLAUDE.md or a project skill), follow those instead: they win.

Set once:
- **Collection:** the one the user named, else the \`**Scope:**\` line in the injected YAPA context. Pass it on every call.
- **Unattended?** If no person is watching (a goal or loop run, or the user said so), pass \`auto_only: true\` to \`yapa_task_next\`: only tasks tagged \`auto\` are offered.

## The loop

Repeat until step 1 finds nothing to do.

1. **Pick.** Call \`yapa_task_next\` with \`collection\` and \`claim: true\` (plus \`auto_only\` when unattended). It claims the best ready task for this session, so teammates and your other sessions don't start it too.
   - It says nothing is ready and offers no cleanup: report the skipped summary it printed (who holds what, what waits on whom), call \`yapa_waiting\`, and stop.
   - It claimed a **cleanup item** (\`cleanup:triage\`, \`cleanup:findings\`, \`cleanup:compaction\`): do it (below), then release it when done (it is a lease on its key; it lapses on its own when the session goes quiet) and go to step 1.
   - A refusal names the holder: it already tried the next task; never retry in a loop.
2. **Understand.** Read the task (\`yapa_task_list\` with its \`id\`) and any memories it links (\`memory_ids\`, recall by id). If the records don't settle how to do it and the choice is a person's, don't guess: call \`yapa_task_update\` with \`decision_needed\` (\`question\`, at least two \`options\`, your \`recommendation\`, the \`owner\` if one person decides). The task waits on that decision and comes back by itself once it is recorded. Tell the user if one is present, then go to step 1.
3. **Do it**, following the project's own rules for code, tests, commits and pushes. A step only a person can take (sending a message to people, deleting, spending money, pushing where the project says only people push): create a task tagged \`needs-human\` (and \`needs:<user>\` when one person must) with the exact command or draft in its notes, and continue with what you can do.
4. **Close and record**, in one call: \`yapa_task_complete\` with
   - \`learned\`: what the task produced, each with a \`kind\`: findings (results, root causes, traps), decisions made (\`status: accepted\`), limitations (with \`exit_criteria\`), questions for others (with \`owner\`), ideas;
   - \`follow_ups\`: new tasks for the work it uncovered (tag them \`auto\` or \`needs-human\`).
   If the reply says nothing was recorded, consider once whether something should have been.
   Set aside instead of completing? \`yapa_task_update\` with status \`pending\` (or \`blocked\` and a reason), with the same \`learned\` and \`follow_ups\`.
5. \`yapa_journal_append\` one line about what you did, then go to step 1.

## Cleanup items

- \`cleanup:triage\`: for each untriaged open task, \`yapa_task_update\` its \`tags\` (pass the full list: tags are replaced): \`auto\` if a session can do all of it unattended, otherwise \`needs-human\`, plus \`needs:<user>\` when one person must take it.
- \`cleanup:findings\`: where the \`yapa\` CLI is available, first run \`yapa memory sweep-findings --collection <collection> --save <file>\`, check its verdicts, and close the ones you agree with by \`yapa memory sweep-findings --collection <collection> --apply --from <file>\` (\`--ids a,b\` for only some). Then, for each open finding of yours left (\`yapa_memory_list\` with \`kind: finding\`, \`status: open\`; leave teammates' findings to them), decide what became of it and \`yapa_memory_update\` it to \`resolved\` with a \`disposition\` (decision, task or limitation, naming it in \`disposition_ids\`; or \`no-action\` with a \`disposition_reason\`). If that needs a person's call, record a needed decision instead.
- \`cleanup:compaction\`: \`yapa_compaction_suggest\`, write a summary per group, \`yapa_compaction_apply\`.

## Stop, and leave it for a person, when

- the next step is one only a person can take, and nothing else is ready;
- something would publish, delete or spend beyond what the project allows sessions to do.

Before stopping, finish or set aside what you hold (a claim left behind blocks others until it lapses), and print \`yapa_waiting\` so people see what is theirs.
`;

/** Register YAPA's skills. All registrations are effect-scoped. */
export function registerSkills(ctx: Context, getResolved: () => ResolvedConfig): void {
  if (!getResolved().standupSkill) return;
  ctx.skills.register({
    name: 'yapa-standup',
    description: 'Standup report from YAPA durable tasks: overdue, due today, in progress, blocked.',
    whenToUse: 'When the user asks for a standup, daily summary, or "what is on my plate".',
    content: STANDUP_CONTENT,
    source: 'runtime',
    provider: 'yapa',
  });
  ctx.skills.register({
    name: 'yapa-work',
    description: 'Work a YAPA task queue: take the next ready task, do it, record what it produced, complete it, repeat.',
    whenToUse: 'When the user asks to work the queue, pick up the next task, or run unattended over a shared collection.',
    content: WORK_CONTENT,
    source: 'runtime',
    provider: 'yapa',
  });
}
