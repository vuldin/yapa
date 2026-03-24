import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { setupInstructions } from './instructions.js';
import { storeMemory } from './memory/store.js';
import { recallMemory } from './memory/recall.js';
import { forgetMemory } from './memory/forget.js';
import { listMemories } from './memory/list.js';
import { runDecaySweep } from './memory/decay.js';
import { createTask } from './tasks/create.js';
import { listTasks, getDueTasks } from './tasks/list.js';
import { getTask, updateTask, completeTask } from './tasks/update.js';
import { searchTasks } from './tasks/search.js';
import { deleteTask } from './tasks/delete.js';
import { addDependency } from './tasks/dependencies.js';
import { parseRelativeDate, formatTaskDate } from './tasks/dates.js';
import { listCollectionsWithCounts, createNewCollection, removeCollection } from './collections/manage.js';

export function registerTools(server: McpServer): void {
  // --- Setup ---
  server.tool(
    'setup_instructions',
    'Auto-detect CLAUDE.md vs AGENTS.md and generate behavioral instructions for YAPA',
    {
      target: z.enum(['auto', 'claude', 'opencode']).optional().describe('Override target detection'),
      cwd: z.string().optional().describe('Working directory to check (defaults to process.cwd())'),
      scope: z.enum(['project', 'global']).optional().describe('project = cwd only, global = home dir (all sessions). Default: project'),
    },
    async ({ target, cwd, scope }) => {
      const result = setupInstructions(cwd ?? process.cwd(), target ?? 'auto', scope ?? 'project');
      return {
        content: [{
          type: 'text' as const,
          text: `Instructions ${result.action} at ${result.file} (target: ${result.target}, scope: ${scope ?? 'project'})\n\n${result.instructions}`,
        }],
      };
    },
  );

  // --- Memory ---
  server.tool(
    'memory_store',
    'Store a memory with content, tags, salience, sector, and collection',
    {
      content: z.string().describe('The memory content to store'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      salience: z.number().optional().describe('Importance score (0.0-5.0, default 1.0)'),
      sector: z.enum(['semantic', 'episodic']).optional().describe('Memory type (auto-detected if omitted)'),
      collection: z.string().optional().describe('Collection name (default: global)'),
    },
    async ({ content, tags, salience, sector, collection }) => {
      const ids = await storeMemory(content, { tags, salience, sector, collection });
      return {
        content: [{ type: 'text' as const, text: `Stored memory: ${ids.join(', ')}` }],
      };
    },
  );

  server.tool(
    'memory_recall',
    'Semantic search for memories with optional collection/tag filters',
    {
      query: z.string().describe('Semantic search query'),
      collection: z.string().optional().describe('Limit search to this collection'),
      n_results: z.number().optional().describe('Max results (default 5)'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
    },
    async ({ query, collection, n_results, tags }) => {
      const results = await recallMemory(query, { collection, nResults: n_results, tags });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const text = results.map(r =>
        `**${r.id}** (${r.collection ?? 'unknown'}, salience: ${r.metadata.salience?.toFixed(2) ?? '?'}, distance: ${r.distance.toFixed(3)})\n${r.content}`
      ).join('\n\n---\n\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'memory_forget',
    'Delete a memory by ID (searches across all collections)',
    {
      id: z.string().describe('Memory document ID to delete'),
    },
    async ({ id }) => {
      const collection = await forgetMemory(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted ${id} from collection "${collection}"` }],
      };
    },
  );

  server.tool(
    'memory_list',
    'List memories with optional metadata filters',
    {
      collection: z.string().optional().describe('Filter by collection'),
      tags: z.array(z.string()).optional().describe('Filter by tags'),
      sector: z.enum(['semantic', 'episodic']).optional().describe('Filter by sector'),
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async ({ collection, tags, sector, limit }) => {
      const results = await listMemories({ collection, tags, sector, limit });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
      }
      const text = results.map(r =>
        `- **${r.id}** [${r.collection}] (salience: ${r.metadata.salience?.toFixed(2) ?? '?'}, sector: ${r.metadata.sector ?? '?'}): ${r.content.slice(0, 100)}${r.content.length > 100 ? '...' : ''}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // --- Tasks ---
  server.tool(
    'task_create',
    'Create a task with title, priority, due date, tags, and collection',
    {
      title: z.string().describe('Task title'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Priority level (default: medium)'),
      due: z.string().optional().describe('Due date: "today", "tomorrow", "next Monday", "in 3 days", "May 27"'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      notes: z.string().optional().describe('Additional notes'),
      customer: z.string().optional().describe('Customer name'),
      project: z.string().optional().describe('Project name'),
      collection: z.string().optional().describe('Collection (default: global)'),
      is_recurring: z.boolean().optional().describe('Whether task recurs'),
      recurrence_pattern: z.enum(['daily', 'weekly', 'monthly']).optional().describe('Recurrence pattern'),
    },
    async ({ title, priority, due, tags, notes, customer, project, collection, is_recurring, recurrence_pattern }) => {
      const due_date = due ? parseRelativeDate(due) ?? undefined : undefined;
      const id = await createTask(title, {
        priority, due_date, tags, notes, customer, project, is_recurring, recurrence_pattern,
      }, collection ?? 'global');

      let text = `Created task ${id}: "${title}"`;
      if (due_date) text += ` (due: ${formatTaskDate(due_date)})`;
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_list',
    'List tasks with optional filters (status, priority, collection, due)',
    {
      status: z.enum(['pending', 'in_progress', 'blocked', 'complete']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      customer: z.string().optional(),
      project: z.string().optional(),
      collection: z.string().optional(),
      include_complete: z.boolean().optional().describe('Include completed tasks (default: false)'),
    },
    async ({ status, priority, customer, project, collection, include_complete }) => {
      const tasks = await listTasks({
        status, priority, customer, project, collection,
        includeComplete: include_complete,
      });
      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
      }
      const text = tasks.map(t => {
        let line = `- **${t.id}** [${t.metadata.status}] ${t.metadata.priority} | ${t.title}`;
        if (t.metadata.due_date) line += ` (due: ${formatTaskDate(t.metadata.due_date)})`;
        line += ` [${t.collection}]`;
        return line;
      }).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_get',
    'Get a single task by ID',
    {
      id: z.string().describe('Task ID (e.g., user-1)'),
    },
    async ({ id }) => {
      const task = await getTask(id);
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task ${id} not found.` }] };
      }
      const lines = [
        `**${task.id}**: ${task.title}`,
        `Status: ${task.metadata.status} | Priority: ${task.metadata.priority}`,
        `Collection: ${task.collection}`,
      ];
      if (task.metadata.due_date) lines.push(`Due: ${formatTaskDate(task.metadata.due_date)}`);
      if (task.metadata.notes) lines.push(`Notes: ${task.metadata.notes}`);
      if (task.metadata.tags) {
        const tags = Array.isArray(task.metadata.tags) ? task.metadata.tags : (task.metadata.tags ?? '').split(',').filter(Boolean);
        if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
      }
      const deps = Array.isArray(task.metadata.depends_on) ? task.metadata.depends_on : (task.metadata.depends_on ?? '').split(',').filter(Boolean);
      if (deps.length) lines.push(`Depends on: ${deps.join(', ')}`);
      const blocks = Array.isArray(task.metadata.blocks) ? task.metadata.blocks : (task.metadata.blocks ?? '').split(',').filter(Boolean);
      if (blocks.length) lines.push(`Blocks: ${blocks.join(', ')}`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.tool(
    'task_update',
    'Update task fields (status, priority, notes, due, tags)',
    {
      id: z.string().describe('Task ID'),
      status: z.enum(['pending', 'in_progress', 'blocked', 'complete']).optional(),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      notes: z.string().optional(),
      due: z.string().optional().describe('Due date phrase'),
      tags: z.array(z.string()).optional(),
      blocked_reason: z.string().optional(),
    },
    async ({ id, status, priority, notes, due, tags, blocked_reason }) => {
      const updates: Record<string, any> = {};
      if (status) updates.status = status;
      if (priority) updates.priority = priority;
      if (notes !== undefined) updates.notes = notes;
      if (tags) updates.tags = tags;
      if (blocked_reason) updates.blockedReason = blocked_reason;
      if (due) {
        const ts = parseRelativeDate(due);
        if (ts) updates.due_date = ts;
      }

      await updateTask(id, updates);
      return { content: [{ type: 'text' as const, text: `Updated task ${id}` }] };
    },
  );

  server.tool(
    'task_complete',
    'Mark a task as done. Handles recurring task regeneration.',
    {
      id: z.string().describe('Task ID to complete'),
    },
    async ({ id }) => {
      const result = await completeTask(id);
      let text = `Completed task ${id}`;
      if (result.regeneratedId) {
        text += ` → regenerated as ${result.regeneratedId} (recurring)`;
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_delete',
    'Remove a task permanently',
    {
      id: z.string().describe('Task ID to delete'),
    },
    async ({ id }) => {
      const collection = await deleteTask(id);
      return {
        content: [{ type: 'text' as const, text: `Deleted task ${id} from collection "${collection}"` }],
      };
    },
  );

  server.tool(
    'task_search',
    'Semantic search across tasks',
    {
      query: z.string().describe('Search query'),
      customer: z.string().optional(),
      project: z.string().optional(),
      collection: z.string().optional(),
    },
    async ({ query, customer, project, collection }) => {
      const results = await searchTasks(query, { customer, project, collection });
      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching tasks found.' }] };
      }
      const text = results.map(r =>
        `- **${r.id}** [${r.metadata.status}] ${r.title} (similarity: ${r.similarity.toFixed(3)}) [${r.collection}]`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'task_add_dependency',
    'Add a depends-on/blocks relationship between tasks',
    {
      task_id: z.string().describe('Task that depends on another'),
      depends_on_id: z.string().describe('Task that must complete first'),
    },
    async ({ task_id, depends_on_id }) => {
      await addDependency(task_id, depends_on_id);
      return {
        content: [{ type: 'text' as const, text: `${task_id} now depends on ${depends_on_id}` }],
      };
    },
  );

  // --- Collections ---
  server.tool(
    'collection_list',
    'List all collections with document counts',
    {},
    async () => {
      const collections = await listCollectionsWithCounts();
      if (collections.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No collections found.' }] };
      }
      const text = collections.map(c =>
        `- **${c.name}**: ${c.documentCount} documents`
      ).join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'collection_create',
    'Create a new collection',
    {
      name: z.string().describe('Collection name (e.g., customer-acme, project-api)'),
    },
    async ({ name }) => {
      await createNewCollection(name);
      return { content: [{ type: 'text' as const, text: `Created collection "${name}"` }] };
    },
  );

  server.tool(
    'collection_delete',
    'Delete a collection and all its contents',
    {
      name: z.string().describe('Collection name to delete'),
    },
    async ({ name }) => {
      await removeCollection(name);
      return { content: [{ type: 'text' as const, text: `Deleted collection "${name}"` }] };
    },
  );

  // --- Maintenance ---
  server.tool(
    'decay_sweep',
    'Manually trigger salience decay across all memories',
    {},
    async () => {
      const count = await runDecaySweep();
      return {
        content: [{ type: 'text' as const, text: `Decay sweep complete. ${count} documents updated.` }],
      };
    },
  );

  // --- Uninstall ---
  server.tool(
    'uninstall',
    'Uninstall YAPA. Returns steps for the agent to execute.',
    {
      delete_collections: z.boolean().optional().describe('Also delete all ChromaDB collections? Default: false (preserve data)'),
    },
    async ({ delete_collections }) => {
      const repoDir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
      let step = 1;
      const steps: string[] = [
        'Execute these steps now to uninstall YAPA. Do not summarize — run them.',
        '',
        `${step++}. Remove the YAPA MCP server registration:`,
        '   - Claude Code: run `claude mcp remove yapa`',
        '   - Cursor: remove the `"yapa"` entry from `~/.cursor/mcp.json`',
        '   - OpenCode: remove the `"yapa"` entry from `.opencode/config.json`',
        '',
        `${step++}. Remove the \`## YAPA — Memory & Task Assistant\` block (and everything below it until the next \`##\` heading or end of file) from ALL of these files. Check each one and remove the block if present:`,
        '   - `./CLAUDE.md` (current project)',
        '   - `./AGENTS.md` (current project)',
        '   - `~/.claude/CLAUDE.md` (global)',
        '   - `~/.config/opencode/AGENTS.md` (global)',
        '',
        `${step++}. Clean up the YAPA repo build artifacts: \`rm -rf ${repoDir}/dist ${repoDir}/node_modules\``,
      ];

      if (delete_collections) {
        steps.push(
          '',
          `${step++}. Delete all YAPA collections from ChromaDB:`,
          '   Run `collection_list` to see all collections, then run `collection_delete` for each one.',
        );
      }

      steps.push(
        '',
        `${step++}. Tell the user to restart their editor to complete removal.`,
      );

      if (!delete_collections) {
        steps.push(
          '',
          'Note: ChromaDB collections (memories and tasks) have been preserved. To also delete them, run `uninstall` again with `delete_collections: true`.',
        );
      }

      return {
        content: [{ type: 'text' as const, text: steps.join('\n') }],
      };
    },
  );
}
