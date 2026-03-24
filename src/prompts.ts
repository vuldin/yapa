import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTasks, getDueTasks } from './tasks/list.js';
import { listMemories } from './memory/list.js';
import { formatTaskDate } from './tasks/dates.js';
import { listCollectionsWithCounts } from './collections/manage.js';

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'daily_standup',
    'Show overdue, due today, in-progress, and blocked tasks',
    async () => {
      const [due, inProgress, blocked] = await Promise.all([
        getDueTasks(true),
        listTasks({ status: 'in_progress' }),
        listTasks({ status: 'blocked' }),
      ]);

      const overdue = due.filter(t => t.daysUntil < 0);
      const dueToday = due.filter(t => t.daysUntil === 0);

      const lines: string[] = ['# Daily Standup\n'];

      if (overdue.length) {
        lines.push('## Overdue');
        overdue.forEach(t => lines.push(`- [ ] **${t.id}** ${t.title} (${Math.abs(t.daysUntil)}d overdue)`));
        lines.push('');
      }

      if (dueToday.length) {
        lines.push('## Due Today');
        dueToday.forEach(t => lines.push(`- [ ] **${t.id}** ${t.title}`));
        lines.push('');
      }

      if (inProgress.length) {
        lines.push('## In Progress');
        inProgress.forEach(t => lines.push(`- [ ] **${t.id}** ${t.title} [${t.collection}]`));
        lines.push('');
      }

      if (blocked.length) {
        lines.push('## Blocked');
        blocked.forEach(t => lines.push(`- [ ] **${t.id}** ${t.title} [${t.collection}]`));
        lines.push('');
      }

      if (!overdue.length && !dueToday.length && !inProgress.length && !blocked.length) {
        lines.push('All clear — no urgent tasks today.');
      }

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );

  server.prompt(
    'task_planning',
    'Plan tasks for a project, showing current state',
    { project: z.string().optional().describe('Project or collection to focus on') },
    async ({ project }) => {
      const [tasks, collections] = await Promise.all([
        listTasks({ collection: project }),
        listCollectionsWithCounts(),
      ]);

      const lines: string[] = ['# Task Planning\n'];

      lines.push('## Collections');
      collections.forEach(c => lines.push(`- **${c.name}**: ${c.documentCount} documents`));
      lines.push('');

      if (tasks.length) {
        lines.push('## Current Tasks');
        tasks.forEach(t => {
          let line = `- [${t.metadata.status === 'complete' ? 'x' : ' '}] **${t.id}** [${t.metadata.priority}] ${t.title}`;
          if (t.metadata.due_date) line += ` (due: ${formatTaskDate(t.metadata.due_date)})`;
          lines.push(line);
        });
      } else {
        lines.push('No tasks found. What should we work on?');
      }

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );

  server.prompt(
    'memory_review',
    'Review low-salience memories for cleanup',
    { threshold: z.string().optional().describe('Salience threshold (default: 0.5)') },
    async ({ threshold }) => {
      const memories = await listMemories({ limit: 100 });
      const th = parseFloat(threshold ?? '0.5');

      const lowSalience = memories.filter(m => (m.metadata.salience ?? 1.0) < th);

      const lines: string[] = [`# Memory Review (salience < ${th})\n`];

      if (lowSalience.length) {
        lines.push(`Found ${lowSalience.length} low-salience memories:\n`);
        lowSalience.forEach(m => {
          lines.push(`- **${m.id}** [${m.collection}] (salience: ${m.metadata.salience?.toFixed(2) ?? '?'})`);
          lines.push(`  ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''}`);
        });
        lines.push('\nShould I delete any of these? Use `memory_forget` with the ID to remove them.');
      } else {
        lines.push('No low-salience memories found. Everything looks healthy.');
      }

      return {
        messages: [{
          role: 'user' as const,
          content: { type: 'text' as const, text: lines.join('\n') },
        }],
      };
    },
  );
}

// Import zod for prompt argument schemas
import { z } from 'zod';
