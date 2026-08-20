/**
 * Programmatic skill registrations (no filesystem skill dirs needed).
 *
 * @module yapa-dsh/skills
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
}
