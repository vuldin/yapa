/**
 * YAPA tool registrations for the DeepSeek Harness.
 *
 * Same tool logic as the MCP server, reshaped to the harness contract:
 * canonical structured values (validated against `output.schema`) with a pure
 * `render()` projection that preserves the MCP server's model-facing markdown,
 * plus GUI presentation hints (`presentCall`).
 *
 * @module @yapa/dsh-plugin/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  addDependency,
  applyCompaction,
  collectionSize,
  completeTask,
  createNewCollection,
  createTask,
  deleteTask,
  detectChromaVersion,
  forgetMemory,
  formatTaskDate,
  getTask,
  journalAppend,
  journalConsolidate,
  listCollections,
  listCollectionsWithCounts,
  listMemories,
  listSessionDrafts,
  listTasks,
  parseRelativeDate,
  recallMemory,
  removeCollection,
  runDecaySweep,
  searchTasks,
  storeMemory,
  suggestCompaction,
  updateTask,
  getConfig,
} from '@yapa/core';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

/** Loose object node for freeform metadata passthrough. */
const openObject = { type: 'object', additionalProperties: true } as const;

const memoryItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    content: { type: 'string', required: true },
    collection: { type: 'string' },
    distance: { type: 'number' },
    salience: { type: 'number' },
  },
} as const;

const taskItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true },
    priority: { type: 'string' },
    due_date: { type: 'number' },
    collection: { type: 'string', required: true },
  },
} as const;

/** Project a core task record onto the canonical task item. */
function toTaskItem(t: { id: string; title: string; collection: string; metadata: Record<string, any> }) {
  return {
    id: t.id,
    title: t.title,
    status: t.metadata.status ?? 'pending',
    ...(t.metadata.priority !== undefined && { priority: t.metadata.priority }),
    ...(t.metadata.due_date !== undefined && { due_date: t.metadata.due_date }),
    collection: t.collection,
  };
}

export function registerTools(ctx: Context): void {
  // --- Status -------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_status',
    description:
      'Check YAPA health and configuration: ChromaDB connectivity/version, embedding provider, '
      + 'username, sync state. Use this first when any yapa_* tool fails with a connection error.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          healthy: { type: 'boolean', required: true },
          chromaUrl: { type: 'string', required: true },
          version: { type: 'string' },
          error: { type: 'string' },
          embeddingProvider: { type: 'string', required: true },
          username: { type: 'string', required: true },
          syncEnabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, v) => {
        if (!v.healthy) {
          return text(
            `❌ YAPA cannot reach ChromaDB at ${v.chromaUrl}: ${v.error ?? 'unknown error'}\n`
            + 'Offer the user: Docker (`docker run -d --name chromadb --restart unless-stopped '
            + '-p 8000:8000 -v chromadb_data:/data chromadb/chroma`), pip (`pip install chromadb '
            + '&& chroma run`), or a NixOS service.',
          );
        }
        return text(
          `✅ ChromaDB v${v.version} at ${v.chromaUrl} (embeddings: ${v.embeddingProvider}, `
          + `user: ${v.username}, sync: ${v.syncEnabled ? 'enabled' : 'disabled'})`,
        );
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const cfg = getConfig();
      const check = await detectChromaVersion();
      return {
        healthy: check.isV2 && !check.error,
        chromaUrl: cfg.CHROMA_URL,
        ...(check.version !== undefined && { version: check.version }),
        ...(check.error !== undefined && { error: check.error }),
        embeddingProvider: cfg.EMBEDDING_PROVIDER,
        username: cfg.USERNAME,
        syncEnabled: cfg.SYNC_ENABLED,
      };
    },
    presentCall: () => ({ card: 'generic', title: 'Check YAPA status', kind: 'other' }),
  }));

  // --- Memory -------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_memory_store',
    description:
      'Store a durable memory with content, tags, salience, sector, and collection. Runs a '
      + 'contradiction check: near-duplicates already in the collection are returned as '
      + '`conflicts` — decide supersede (yapa_memory_forget the old ID) or coexist (no action; '
      + 'the new memory is already stored).',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory content to store' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      salience: { type: 'number', description: 'Importance score (0.0-5.0, default 1.0)' },
      sector: { type: 'string', enum: ['semantic', 'episodic'], description: 'Memory type (auto-detected if omitted)' },
      collection: { type: 'string', description: 'Collection name (default: global)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', required: true, items: { type: 'string' } },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                distance: { type: 'number', required: true },
                salience: { type: 'number', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines = [`Stored memory: ${v.ids.join(', ')}`];
        if (v.conflicts?.length) {
          lines.push('', `⚠ Potential conflicts (${v.conflicts.length}):`);
          for (const c of v.conflicts) {
            lines.push(`- **${c.id}** (distance ${c.distance.toFixed(3)}, salience ${c.salience.toFixed(2)}): ${c.content}`);
          }
          lines.push('', 'Decide: supersede (call `yapa_memory_forget` on the old ID) or coexist (do nothing — the new memory is already stored).');
        }
        return text(lines.join('\n'));
      },
    },
    async execute(args) {
      const result = await storeMemory(args.content, {
        tags: args.tags,
        salience: args.salience,
        sector: args.sector,
        collection: args.collection,
      });
      return {
        ids: result.ids,
        conflicts: result.potential_conflicts.map(c => ({
          id: c.id, distance: c.distance, salience: c.salience, content: c.content,
        })),
      };
    },
    presentCall: args => ({
      card: 'generic',
      title: `Store memory${args.collection ? ` in ${args.collection}` : ''}`,
      kind: 'other',
      rawInput: args.content.length > 200 ? `${args.content.slice(0, 200)}…` : args.content,
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_memory_recall',
    description:
      'Semantic search over durable memories with optional collection/tag filters, ranked by '
      + 'vector distance and salience. Promoted memories are excluded by default. NOTE: the '
      + 'current prompt already ran an automatic recall (see injected YAPA context) — call this '
      + 'only for a different or more specific query.',
    parameters: {
      query: { type: 'string', required: true, description: 'Semantic search query' },
      collection: { type: 'string', description: 'Limit search to this collection' },
      n_results: { type: 'number', description: 'Max results (default 5)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
      include_promoted: { type: 'boolean', description: 'Include promoted memories (default false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: memoryItem },
        },
      },
      render: (_args, v) => {
        if (v.results.length === 0) return text('No memories found.');
        return text(v.results.map(r =>
          `**${r.id}** (${r.collection ?? 'unknown'}, salience: ${r.salience?.toFixed(2) ?? '?'}, distance: ${r.distance?.toFixed(3) ?? '?'})\n${r.content}`,
        ).join('\n\n---\n\n'));
      },
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const results = await recallMemory(args.query, {
        collection: args.collection,
        nResults: args.n_results,
        tags: args.tags,
        include_promoted: args.include_promoted,
      });
      return {
        results: results.map(r => ({
          id: r.id,
          content: r.content,
          ...(r.collection !== undefined && { collection: r.collection }),
          distance: r.distance,
          ...(typeof r.metadata.salience === 'number' && { salience: r.metadata.salience }),
        })),
      };
    },
    presentCall: args => ({ card: 'generic', title: `Recall: ${args.query}`, kind: 'search' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_memory_forget',
    description: 'Delete a memory by ID (searches across all collections).',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory document ID to delete' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          collection: { type: 'string', required: true },
        },
      },
      render: (_args, v) => text(`Deleted ${v.id} from collection "${v.collection}"`),
    },
    async execute(args) {
      const collection = await forgetMemory(args.id);
      return { id: args.id, collection };
    },
    presentCall: args => ({ card: 'generic', title: `Forget memory ${args.id}`, kind: 'delete' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_memory_list',
    description:
      'List memories with optional metadata filters (collection, tags, sector). Promoted '
      + 'memories are excluded by default.',
    parameters: {
      collection: { type: 'string', description: 'Filter by collection' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
      sector: { type: 'string', enum: ['semantic', 'episodic'], description: 'Filter by sector' },
      limit: { type: 'number', description: 'Max results (default 50)' },
      include_promoted: { type: 'boolean', description: 'Include promoted memories (default false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: memoryItem },
        },
      },
      render: (_args, v) => {
        if (v.results.length === 0) return text('No memories found.');
        return text(v.results.map(r =>
          `- **${r.id}** [${r.collection}] (salience: ${r.salience?.toFixed(2) ?? '?'}): `
          + `${r.content.slice(0, 100)}${r.content.length > 100 ? '...' : ''}`,
        ).join('\n'));
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const results = await listMemories({
        collection: args.collection,
        tags: args.tags,
        sector: args.sector,
        limit: args.limit,
        include_promoted: args.include_promoted,
      });
      return {
        results: results.map(r => ({
          id: r.id,
          content: r.content,
          ...(r.collection !== undefined && { collection: r.collection }),
          ...(typeof r.metadata.salience === 'number' && { salience: r.metadata.salience }),
        })),
      };
    },
    presentCall: args => ({
      card: 'generic',
      title: `List memories${args.collection ? ` in ${args.collection}` : ''}`,
      kind: 'search',
    }),
  }));

  // --- Memory compaction (long-term store — NOT context-window compaction) --

  ctx.tools.register(defineTool({
    name: 'yapa_compaction_suggest',
    description:
      'Suggest groups of similar non-archived MEMORIES that could be consolidated into rolling '
      + 'summaries (long-term store maintenance, unrelated to context-window compaction). For '
      + 'each group of ≥3 similar memories, write a one-paragraph rolling summary and submit it '
      + 'via yapa_compaction_apply.',
    parameters: {
      collection: { type: 'string', required: true, description: 'Collection to scan' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collection: { type: 'string', required: true },
          groups: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seed_id: { type: 'string', required: true },
                member_ids: { type: 'array', required: true, items: { type: 'string' } },
                shared_tags: { type: 'array', required: true, items: { type: 'string' } },
                seed_content: { type: 'string', required: true },
                similar_content: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        if (v.groups.length === 0) return text(`No compaction candidates in "${v.collection}".`);
        const lines: string[] = [`Found ${v.groups.length} group(s) in "${v.collection}":`];
        v.groups.forEach((g, i) => {
          lines.push('', `## Group ${i + 1} — seed ${g.seed_id}`);
          lines.push(`Members (${g.member_ids.length}): ${g.member_ids.join(', ')}`);
          if (g.shared_tags.length) lines.push(`Shared tags: ${g.shared_tags.join(', ')}`);
          lines.push('Contents:');
          lines.push(`- ${g.seed_content.slice(0, 240)}${g.seed_content.length > 240 ? '…' : ''}`);
          for (const c of g.similar_content) lines.push(`- ${c.slice(0, 240)}${c.length > 240 ? '…' : ''}`);
        });
        lines.push('', 'For each group, draft a rolling summary, then call `yapa_compaction_apply` with the member_ids and your summary.');
        return text(lines.join('\n'));
      },
    },
    async execute(args) {
      const groups = await suggestCompaction(args.collection);
      return { collection: args.collection, groups };
    },
    presentCall: args => ({ card: 'generic', title: `Suggest memory compaction in ${args.collection}`, kind: 'search' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_compaction_apply',
    description:
      'Apply a memory compaction: writes the rolling summary as a new memory at salience 2.0 '
      + '(tagged `compacted`), then archives each member with `compacted_into` pointing at the '
      + 'summary. Archived memories are filtered from recall/list by default.',
    parameters: {
      collection: { type: 'string', required: true },
      member_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Memory IDs to archive under the summary' },
      summary: { type: 'string', required: true, description: 'Rolling summary consolidating the members' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags for the summary' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary_id: { type: 'string', required: true },
          archived: { type: 'integer', required: true },
          requested: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => text(`Compaction applied. Summary: ${v.summary_id}. Archived: ${v.archived}/${v.requested}.`),
    },
    async execute(args) {
      const result = await applyCompaction({
        collection: args.collection,
        member_ids: args.member_ids,
        summary: args.summary,
        tags: args.tags,
      });
      return { summary_id: result.summary_id, archived: result.archived_ids.length, requested: args.member_ids.length };
    },
    presentCall: args => ({ card: 'generic', title: `Compact ${args.member_ids.length} memories in ${args.collection}`, kind: 'other' }),
  }));

  // --- Journal --------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_journal_append',
    description:
      'Append a one-line draft entry to the current session\'s journal. Call when a meaningful '
      + 'step completes (decision made, finding confirmed, task closed). Drafts consolidate into '
      + 'a single journal memory when the session ends.',
    parameters: {
      entry: { type: 'string', required: true, description: 'One-line summary of what just happened' },
      collection: { type: 'string', description: 'Collection to scope the draft to (default: global)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (_args, v) => text(`Journal draft saved: ${v.id}`),
    },
    async execute(args, exec) {
      const id = await journalAppend(args.entry, args.collection, exec.agent?.id);
      return { id };
    },
    presentCall: () => ({ card: 'generic', title: 'Append journal entry', kind: 'other' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_journal_consolidate',
    description:
      'Consolidate the current session\'s journal drafts into a single memory tagged `journal` '
      + '(salience 1.5), deleting the drafts. The DSH plugin also runs this automatically when '
      + 'the session ends.',
    parameters: {
      collection: { type: 'string', description: 'Collection the drafts live in (default: global)' },
      summary: { type: 'string', description: 'Optional final summary (default: concatenated drafts)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          consolidated: { type: 'boolean', required: true },
          memory_id: { type: 'string' },
          draft_count: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => v.consolidated
        ? text(`Journal consolidated. Memory: ${v.memory_id}. Merged ${v.draft_count} draft(s).`)
        : text('No journal drafts found for this session — nothing to consolidate.'),
    },
    async execute(args, exec) {
      const result = await journalConsolidate({
        collection: args.collection,
        summary: args.summary,
        sessionId: exec.agent?.id,
      });
      if (!result) return { consolidated: false, draft_count: 0 };
      return { consolidated: true, memory_id: result.memory_id, draft_count: result.draft_count };
    },
    presentCall: () => ({ card: 'generic', title: 'Consolidate session journal', kind: 'other' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_journal_list_drafts',
    description: 'List the current session\'s pending journal drafts (inspection/debugging).',
    parameters: {
      collection: { type: 'string', description: 'Collection to scan (default: global)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          drafts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                entry: { type: 'string', required: true },
                created_at: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => v.drafts.length === 0
        ? text('No journal drafts for this session.')
        : text(v.drafts.map(d => `- **${d.id}** [${new Date(d.created_at * 1000).toISOString()}]: ${d.entry}`).join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const drafts = await listSessionDrafts(args.collection, exec.agent?.id);
      return { drafts: drafts.map(d => ({ id: d.id, entry: d.entry, created_at: d.created_at })) };
    },
    presentCall: () => ({ card: 'generic', title: 'List journal drafts', kind: 'search' }),
  }));

  // --- Tasks (durable, cross-session — see the boundary rules in the rules
  //     section: todo_write is session-scoped, goals drive continuation,
  //     schedule wakes; yapa tasks persist and sync) -------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_task_create',
    description:
      'Create a DURABLE task with title, priority, due date, tags, and collection. Survives '
      + 'sessions and syncs across machines — use for commitments that outlive this '
      + 'conversation (vs. todo_write, which is this session\'s ephemeral checklist).',
    parameters: {
      title: { type: 'string', required: true, description: 'Task title' },
      priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Priority (default: medium)' },
      due: { type: 'string', description: 'Due date: "today", "tomorrow", "next Monday", "in 3 days", "May 27"' },
      tags: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      customer: { type: 'string' },
      project: { type: 'string' },
      collection: { type: 'string', description: 'Collection (default: global)' },
      is_recurring: { type: 'boolean' },
      recurrence_pattern: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          due_date: { type: 'number' },
        },
      },
      render: (_args, v) => text(
        `Created task ${v.id}: "${v.title}"${v.due_date ? ` (due: ${formatTaskDate(v.due_date)})` : ''}`,
      ),
    },
    async execute(args) {
      const due_date = args.due ? parseRelativeDate(args.due) ?? undefined : undefined;
      const id = await createTask(args.title, {
        priority: args.priority,
        due_date,
        tags: args.tags,
        notes: args.notes,
        customer: args.customer,
        project: args.project,
        is_recurring: args.is_recurring,
        recurrence_pattern: args.recurrence_pattern,
      }, args.collection ?? 'global');
      return { id, title: args.title, ...(due_date !== undefined && { due_date }) };
    },
    presentCall: args => ({ card: 'generic', title: `Create task: ${args.title}`, kind: 'other' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_list',
    description: 'List durable tasks with optional filters (status, priority, collection, customer, project).',
    parameters: {
      status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'complete'] },
      priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      customer: { type: 'string' },
      project: { type: 'string' },
      collection: { type: 'string' },
      include_complete: { type: 'boolean', description: 'Include completed tasks (default: false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tasks: { type: 'array', required: true, items: taskItem } },
      },
      render: (_args, v) => {
        if (v.tasks.length === 0) return text('No tasks found.');
        return text(v.tasks.map(t => {
          let line = `- **${t.id}** [${t.status}] ${t.priority ?? 'medium'} | ${t.title}`;
          if (t.due_date) line += ` (due: ${formatTaskDate(t.due_date)})`;
          return `${line} [${t.collection}]`;
        }).join('\n'));
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const tasks = await listTasks({
        status: args.status,
        priority: args.priority,
        customer: args.customer,
        project: args.project,
        collection: args.collection,
        includeComplete: args.include_complete,
      });
      return { tasks: tasks.map(toTaskItem) };
    },
    presentCall: args => ({
      card: 'generic',
      title: `List tasks${args.collection ? ` in ${args.collection}` : ''}`,
      kind: 'search',
    }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_get',
    description: 'Get a single durable task by ID.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task ID (e.g., user-1)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          task: { ...openObject },
        },
      },
      render: (_args, v) => {
        if (!v.found || !v.task) return text(`Task not found.`);
        const t = v.task as Record<string, any>;
        const lines = [
          `**${t.id}**: ${t.title}`,
          `Status: ${t.metadata.status} | Priority: ${t.metadata.priority}`,
          `Collection: ${t.collection}`,
        ];
        if (t.metadata.due_date) lines.push(`Due: ${formatTaskDate(t.metadata.due_date)}`);
        if (t.metadata.notes) lines.push(`Notes: ${t.metadata.notes}`);
        const norm = (x: unknown): string[] => Array.isArray(x) ? x : (x ?? '').toString().split(',').filter(Boolean);
        const tags = norm(t.metadata.tags);
        if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
        const deps = norm(t.metadata.depends_on);
        if (deps.length) lines.push(`Depends on: ${deps.join(', ')}`);
        const blocks = norm(t.metadata.blocks);
        if (blocks.length) lines.push(`Blocks: ${blocks.join(', ')}`);
        return text(lines.join('\n'));
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const task = await getTask(args.id);
      if (!task) return { found: false };
      return { found: true, task: JSON.parse(JSON.stringify(task)) };
    },
    presentCall: args => ({ card: 'generic', title: `Get task ${args.id}`, kind: 'read' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_update',
    description: 'Update durable task fields (status, priority, notes, due, tags, blocked reason).',
    parameters: {
      id: { type: 'string', required: true },
      status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'complete'] },
      priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      notes: { type: 'string' },
      due: { type: 'string', description: 'Due date phrase' },
      tags: { type: 'array', items: { type: 'string' } },
      blocked_reason: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (_args, v) => text(`Updated task ${v.id}`),
    },
    async execute(args) {
      const updates: Record<string, any> = {};
      if (args.status) updates.status = args.status;
      if (args.priority) updates.priority = args.priority;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.tags) updates.tags = args.tags;
      if (args.blocked_reason) updates.blockedReason = args.blocked_reason;
      if (args.due) {
        const ts = parseRelativeDate(args.due);
        if (ts) updates.due_date = ts;
      }
      await updateTask(args.id, updates);
      return { id: args.id };
    },
    presentCall: args => ({ card: 'generic', title: `Update task ${args.id}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_complete',
    description: 'Mark a durable task done. Handles recurring task regeneration.',
    parameters: {
      id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          regenerated_id: { type: 'string' },
        },
      },
      render: (_args, v) => text(
        `Completed task ${v.id}${v.regenerated_id ? ` → regenerated as ${v.regenerated_id} (recurring)` : ''}`,
      ),
    },
    async execute(args) {
      const result = await completeTask(args.id);
      return { id: args.id, ...(result.regeneratedId && { regenerated_id: result.regeneratedId }) };
    },
    presentCall: args => ({ card: 'generic', title: `Complete task ${args.id}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_delete',
    description: 'Remove a durable task permanently.',
    parameters: {
      id: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          collection: { type: 'string', required: true },
        },
      },
      render: (_args, v) => text(`Deleted task ${v.id} from collection "${v.collection}"`),
    },
    async execute(args) {
      const collection = await deleteTask(args.id);
      return { id: args.id, collection };
    },
    presentCall: args => ({ card: 'generic', title: `Delete task ${args.id}`, kind: 'delete' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_search',
    description: 'Semantic search across durable tasks.',
    parameters: {
      query: { type: 'string', required: true },
      customer: { type: 'string' },
      project: { type: 'string' },
      collection: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true },
                collection: { type: 'string', required: true },
                similarity: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        if (v.results.length === 0) return text('No matching tasks found.');
        return text(v.results.map(r =>
          `- **${r.id}** [${r.status}] ${r.title} (similarity: ${r.similarity.toFixed(3)}) [${r.collection}]`,
        ).join('\n'));
      },
    },
    timeoutMs: 30_000,
    async execute(args) {
      const results = await searchTasks(args.query, {
        customer: args.customer,
        project: args.project,
        collection: args.collection,
      });
      return {
        results: results.map(r => ({
          id: r.id,
          title: r.title,
          status: r.metadata.status ?? 'pending',
          collection: r.collection,
          similarity: r.similarity,
        })),
      };
    },
    presentCall: args => ({ card: 'generic', title: `Search tasks: ${args.query}`, kind: 'search' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_add_dependency',
    description: 'Add a depends-on/blocks relationship between durable tasks.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task that depends on another' },
      depends_on_id: { type: 'string', required: true, description: 'Task that must complete first' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          depends_on_id: { type: 'string', required: true },
        },
      },
      render: (_args, v) => text(`${v.task_id} now depends on ${v.depends_on_id}`),
    },
    async execute(args) {
      await addDependency(args.task_id, args.depends_on_id);
      return { task_id: args.task_id, depends_on_id: args.depends_on_id };
    },
    presentCall: args => ({ card: 'generic', title: `${args.task_id} depends on ${args.depends_on_id}`, kind: 'edit' }),
  }));

  // --- Collections ----------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_collection_list',
    description: 'List all YAPA collections with document counts.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                documentCount: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, v) => v.collections.length === 0
        ? text('No collections found.')
        : text(v.collections.map(c => `- **${c.name}**: ${c.documentCount} documents`).join('\n')),
    },
    isConcurrencySafe: () => true,
    async execute() {
      return { collections: await listCollectionsWithCounts() };
    },
    presentCall: () => ({ card: 'generic', title: 'List collections', kind: 'search' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_collection_create',
    description:
      'Create a new collection. Confirm the name with the user first; remember that '
      + '`private-`/`local-` prefixed collections never sync to the remote database.',
    parameters: {
      name: { type: 'string', required: true, description: 'Collection name (e.g., customer-acme, project-api)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true } },
      },
      render: (_args, v) => text(`Created collection "${v.name}"`),
    },
    async execute(args) {
      await createNewCollection(args.name);
      return { name: args.name };
    },
    presentCall: args => ({ card: 'generic', title: `Create collection ${args.name}`, kind: 'other' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_collection_delete',
    description: 'Delete a collection and ALL its contents. Confirm with the user first.',
    parameters: {
      name: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true } },
      },
      render: (_args, v) => text(`Deleted collection "${v.name}"`),
    },
    async execute(args) {
      await removeCollection(args.name);
      return { name: args.name };
    },
    presentCall: args => ({ card: 'generic', title: `Delete collection ${args.name} (all contents)`, kind: 'delete' }),
  }));

  // --- Maintenance ------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'yapa_decay_sweep',
    description: 'Manually trigger salience decay across all memories (normally runs automatically).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { updated: { type: 'integer', required: true } },
      },
      render: (_args, v) => text(`Decay sweep complete. ${v.updated} documents updated.`),
    },
    async execute() {
      return { updated: await runDecaySweep() };
    },
    presentCall: () => ({ card: 'generic', title: 'Run salience decay sweep', kind: 'execute' }),
  }));
}
