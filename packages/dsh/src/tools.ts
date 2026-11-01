/**
 * YAPA tool registrations for the DeepSeek Harness.
 *
 * Same tool logic as the MCP server, reshaped to the harness contract:
 * canonical structured values (validated against `output.schema`) with a pure
 * `render()` projection that preserves the MCP server's model-facing markdown,
 * plus GUI presentation hints (`presentCall`).
 *
 * @module yapa/tools
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
  listTasks,
  mergeCollections,
  parseRelativeDate,
  recallMemory,
  removeCollection,
  removeDependency,
  runDecaySweep,
  searchTasks,
  storeMemory,
  suggestCompaction,
  updateTask,
  describeClaim,
  getConfig,
  DISPOSITIONS,
  MEMORY_KINDS,
  KIND_STATUSES,
  typedLabel,
  updateMemory,
  waitingOn,
  waitingCount,
  formatWaiting,
  nextTasks,
  recordForTask,
  requestDecision,
  validateLearned,
} from '@yapa/core';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

/** Typed-memory parameters (core memory/kinds.ts), shared by store and update. */
const typedParams = {
  kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'finding (a result, root cause, retraction or trap), decision (a choice made, or one a person must make), limitation, question (for a person or another team), idea. Omit for an ordinary note.' },
  status: { type: 'string', description: `Where it stands. ${Object.entries(KIND_STATUSES).map(([k, v]) => `${k}: ${v.join('|')}`).join('; ')}. Use decision "needed" for a choice only a person can make: never leave it only in chat.` },
  owner: { type: 'string', description: 'Who decides (decision) or is asked (question). Omit for anyone.' },
  task_ids: { type: 'array', items: { type: 'string' }, description: 'Tasks this came from; each lists it back' },
  options: { type: 'array', items: { type: 'string' }, description: 'decision: the options (at least two when needed)' },
  recommendation: { type: 'string', description: 'decision: what you recommend' },
  disposition: { type: 'string', enum: [...DISPOSITIONS], description: 'finding: what became of it' },
  disposition_ids: { type: 'array', items: { type: 'string' }, description: 'finding: what it led to' },
  disposition_reason: { type: 'string', description: 'finding: why no action' },
  exit_criteria: { type: 'string', description: 'limitation: what would close it' },
} as const;

const TYPED_KEYS = Object.keys(typedParams);

/** Capture-at-close parameters (core tasks/close.ts). */
const closeParams = {
  learned: {
    type: 'array',
    description: 'What this task produced, stored as typed memories linked to it (findings, decisions made, limitations, questions, ideas)',
    items: { type: 'object', additionalProperties: true, properties: { content: { type: 'string', required: true }, ...typedParams } },
  },
  follow_ups: {
    type: 'array',
    description: 'Follow-up work, created as new tasks that say where they came from',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', required: true },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
  },
} as const;

const closeSummary = (r: { recorded?: { memories: string[]; follow_ups: string[] }; nudge?: string }) => [
  r.recorded?.memories.length ? `Recorded ${r.recorded.memories.join(', ')}.` : '',
  r.recorded?.follow_ups.length ? `Follow-ups: ${r.recorded.follow_ups.join(', ')}.` : '',
  r.nudge ?? '',
].filter(Boolean).join('\n');
const pickTyped = (args: Record<string, any>) =>
  Object.fromEntries(TYPED_KEYS.filter(k => args[k] !== undefined).map(k => [k, args[k]]));

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
    label: { type: 'string' },
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
    notes: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    depends_on: { type: 'array', items: { type: 'string' } },
    blocks: { type: 'array', items: { type: 'string' } },
  },
} as const;

const normList = (x: unknown): string[] => Array.isArray(x) ? x : (x ?? '').toString().split(',').filter(Boolean);

/** Full-detail projection (notes/dependencies) for single-task fetches. */
function toTaskDetail(t: { id: string; title: string; collection: string; metadata: Record<string, any> }) {
  return {
    ...toTaskItem(t),
    ...(t.metadata.notes !== undefined && { notes: t.metadata.notes }),
    ...(normList(t.metadata.tags).length && { tags: normList(t.metadata.tags) }),
    ...(normList(t.metadata.depends_on).length && { depends_on: normList(t.metadata.depends_on) }),
    ...(normList(t.metadata.blocks).length && { blocks: normList(t.metadata.blocks) }),
  };
}

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
          storage: { type: 'string', required: true },
          chromaUrl: { type: 'string' },
          storePath: { type: 'string' },
          version: { type: 'string' },
          error: { type: 'string' },
          embeddingProvider: { type: 'string', required: true },
          username: { type: 'string', required: true },
          syncEnabled: { type: 'boolean', required: true },
        },
      },
      render: (_args, v) => {
        if (v.storage === 'local') {
          return text(
            `✅ YAPA using the embedded local store at ${v.storePath} — no ChromaDB server needed `
            + `(embeddings: ${v.embeddingProvider}, user: ${v.username}, sync: ${v.syncEnabled ? 'enabled' : 'disabled'})`,
          );
        }
        if (!v.healthy) {
          return text(
            `❌ YAPA cannot reach ChromaDB at ${v.chromaUrl}: ${v.error ?? 'unknown error'}\n`
            + 'Offer the user: Docker (`docker run -d --name chromadb --restart unless-stopped '
            + '-p 8000:8000 -v chromadb_data:/data chromadb/chroma`), pip (`pip install chromadb '
            + '&& chroma run`), a NixOS service — or switch to the embedded store '
            + '(`storage: local` in the plugin config / settings).',
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
      if (cfg.STORAGE === 'local') {
        return {
          healthy: true,
          storage: 'local',
          storePath: cfg.LOCAL_STORE_PATH,
          embeddingProvider: cfg.EMBEDDING_PROVIDER,
          username: cfg.USERNAME,
          syncEnabled: cfg.SYNC_ENABLED,
        };
      }
      const check = await detectChromaVersion();
      return {
        healthy: check.isV2 && !check.error,
        storage: 'chroma',
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
      + '`conflicts` — decide supersede or coexist (no action; the new memory is already '
      + 'stored). Prefer the `supersedes` param when this memory replaces an existing one: '
      + 'it archives the old memory (recoverable) instead of hard-deleting it.',
    parameters: {
      content: { type: 'string', required: true, description: 'The memory content to store' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      salience: { type: 'number', description: 'Importance score (0.0-5.0, default 1.0)' },
      supersedes: { type: 'string', description: 'ID of an existing memory this one corrects/replaces — the old memory is archived (filtered from recall, recoverable), never hard-deleted' },
      sector: { type: 'string', enum: ['semantic', 'episodic'], description: 'Memory type (auto-detected if omitted)' },
      collection: { type: 'string', description: 'Collection name (default: global)' },
      ...typedParams,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', required: true, items: { type: 'string' } },
          label: { type: 'string' },
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
        const lines = [`Stored memory: ${v.ids.join(', ')}${v.label ? ` ${v.label}` : ''}`];
        if (v.conflicts?.length) {
          lines.push('', `⚠ Potential conflicts (${v.conflicts.length}):`);
          for (const c of v.conflicts) {
            lines.push(`- **${c.id}** (distance ${c.distance.toFixed(3)}, salience ${c.salience.toFixed(2)}): ${c.content}`);
          }
          lines.push('', 'Decide: supersede (re-store with `supersedes: "<old ID>"` — archives, recoverable), hard-delete (`yapa_memory_forget`), or coexist (do nothing — the new memory is already stored).');
        }
        return text(lines.join('\n'));
      },
    },
    async execute(args) {
      const typed = pickTyped(args);
      const result = await storeMemory(args.content, {
        tags: args.tags,
        salience: args.salience,
        sector: args.sector,
        collection: args.collection,
        supersedes: args.supersedes,
        ...(Object.keys(typed).length ? { typed } : {}),
      });
      return {
        ids: result.ids,
        ...(typed.kind ? { label: typedLabel({ status: undefined, ...typed }) } : {}),
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
    name: 'yapa_memory_update',
    description:
      'Change a memory in place: status, owner, links or other typed fields, and optionally a dated note '
      + 'appended to its text. Record a needed decision with status "accepted" (or "rejected") and the choice '
      + 'as the note; tasks waiting on it become ready again. Answer a question with status "answered".',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory ID' },
      collection: { type: 'string', description: 'Collection (default: searched)' },
      note: { type: 'string', description: 'Appended as "<date> <user>: <note>"' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tags' },
      ...typedParams,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          collection: { type: 'string', required: true },
          label: { type: 'string' },
        },
      },
      render: (_args, v) => text(`Updated ${v.id} in ${v.collection}${v.label ? ` ${v.label}` : ''}`),
    },
    async execute(args) {
      const r = await updateMemory(args.id, {
        ...pickTyped(args),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
      }, args.collection);
      const label = typedLabel(r.metadata);
      return { id: r.id, collection: r.collection, ...(label ? { label } : {}) };
    },
    presentCall: args => ({ card: 'generic', title: `Update memory ${args.id}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_waiting',
    description:
      'Everything waiting on a person: decisions to make, questions to answer, task steps only a person '
      + 'can take (tags needs-human, needs:<user>), and blocked tasks. Defaults to what waits on you (or anyone).',
    parameters: {
      collection: { type: 'string', description: 'One collection (default: all)' },
      user: { type: 'string', description: 'Whose items (default: you); "*" for everyone' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, v) => text(v.summary),
    },
    async execute(args) {
      const who = args.user === '*' ? undefined : args.user ?? getConfig().USERNAME;
      const w = await waitingOn({ collection: args.collection, user: who });
      return { count: waitingCount(w), summary: formatWaiting(w, { collection: !args.collection }) };
    },
    presentCall: () => ({ card: 'generic', title: 'Waiting on people', kind: 'read' }),
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
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Only typed memories of this kind' },
      status: { type: 'string', description: 'Only typed memories with this status' },
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
          `**${r.id}**${r.label ? ` ${r.label}` : ''} (${r.collection ?? 'unknown'}, salience: ${r.salience?.toFixed(2) ?? '?'}, distance: ${r.distance?.toFixed(3) ?? '?'})\n${r.content}`,
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
        kind: args.kind,
        status: args.status,
        include_promoted: args.include_promoted,
      });
      return {
        results: results.map(r => ({
          id: r.id,
          content: r.content,
          ...(r.collection !== undefined && { collection: r.collection }),
          distance: r.distance,
          ...(typeof r.metadata.salience === 'number' && { salience: r.metadata.salience }),
          ...(typedLabel(r.metadata) && { label: typedLabel(r.metadata) }),
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
      kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'Only typed memories of this kind' },
      status: { type: 'string', description: 'Only typed memories with this status' },
      owner: { type: 'string', description: 'Only typed memories for this owner' },
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
          `- **${r.id}**${r.label ? ` ${r.label}` : ''} [${r.collection}] (salience: ${r.salience?.toFixed(2) ?? '?'}): `
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
        kind: args.kind,
        status: args.status,
        owner: args.owner,
        limit: args.limit,
        include_promoted: args.include_promoted,
      });
      return {
        results: results.map(r => ({
          id: r.id,
          content: r.content,
          ...(r.collection !== undefined && { collection: r.collection }),
          ...(typeof r.metadata.salience === 'number' && { salience: r.metadata.salience }),
          ...(typedLabel(r.metadata) && { label: typedLabel(r.metadata) }),
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
    description: 'List durable tasks with optional filters (status, priority, collection, customer, project) — or pass `id` to fetch one task with full detail (notes, dependencies).',
    parameters: {
      id: { type: 'string', description: 'Fetch a single task by ID (e.g., user-1) with full detail instead of listing' },
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
      render: (args, v) => {
        if (args.id) {
          const t = v.tasks[0] as Record<string, any> | undefined;
          if (!t) return text('Task not found.');
          const lines = [
            `**${t.id}**: ${t.title}`,
            `Status: ${t.status} | Priority: ${t.priority ?? 'medium'}`,
            `Collection: ${t.collection}`,
          ];
          if (t.due_date) lines.push(`Due: ${formatTaskDate(t.due_date)}`);
          if (t.notes) lines.push(`Notes: ${t.notes}`);
          if (t.tags?.length) lines.push(`Tags: ${t.tags.join(', ')}`);
          if (t.depends_on?.length) lines.push(`Depends on: ${t.depends_on.join(', ')}`);
          if (t.blocks?.length) lines.push(`Blocks: ${t.blocks.join(', ')}`);
          return text(lines.join('\n'));
        }
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
      if (args.id) {
        const task = await getTask(args.id);
        return { tasks: task ? [toTaskDetail(task)] : [] };
      }
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
      title: args.id ? `Get task ${args.id}` : `List tasks${args.collection ? ` in ${args.collection}` : ''}`,
      kind: 'search',
    }),
  }));


  ctx.tools.register(defineTool({
    name: 'yapa_task_update',
    description: 'Update durable task fields (title, status, priority, notes, due, tags, blocked reason).',
    parameters: {
      id: { type: 'string', required: true },
      title: { type: 'string', description: 'New task title (rename)' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'complete'] },
      priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      notes: { type: 'string' },
      due: { type: 'string', description: 'Due date phrase' },
      tags: { type: 'array', items: { type: 'string' } },
      blocked_reason: { type: 'string' },
      decision_needed: {
        type: 'object',
        additionalProperties: false,
        description: 'A choice only a person can make: recorded as a needed decision; the task waits on it (pending) until it is recorded with yapa_memory_update. Then take other work.',
        properties: {
          question: { type: 'string', required: true },
          options: { type: 'array', items: { type: 'string' }, required: true },
          recommendation: { type: 'string' },
          owner: { type: 'string' },
          context: { type: 'string' },
        },
      },
      ...closeParams,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true }, claim: { type: 'string' }, decision: { type: 'string' }, recorded: { type: 'string' } },
      },
      render: (_args, v) => text(`Updated task ${v.id}${v.decision ? `\nRecorded decision ${v.decision}; the task waits on it.` : ''}${v.claim ? `\n${v.claim}` : ''}${v.recorded ? `\n${v.recorded}` : ''}`),
    },
    async execute(args) {
      const updates: Record<string, any> = {};
      if (args.title?.trim()) updates.title = args.title.trim();
      if (args.status) updates.status = args.status;
      if (args.priority) updates.priority = args.priority;
      if (args.notes !== undefined) updates.notes = args.notes;
      if (args.tags) updates.tags = args.tags;
      if (args.blocked_reason) updates.blockedReason = args.blocked_reason;
      if (args.due) {
        const ts = parseRelativeDate(args.due);
        if (ts) updates.due_date = ts;
      }
      validateLearned(args.learned);
      if (args.decision_needed && args.status && args.status !== 'pending') {
        throw new Error('decision_needed sets the task to pending; leave status out');
      }
      // A move to in_progress claims the task; someone else's claim throws
      // TaskClaimedError, whose message names the holder.
      let decision: string | undefined;
      let r;
      if (args.decision_needed) {
        const { status: _s, ...rest } = updates;
        const d = await requestDecision(args.id, args.decision_needed, {}, rest);
        decision = d.decision;
        r = d;
      } else {
        r = await updateTask(args.id, updates);
      }
      const recorded = args.learned?.length || args.follow_ups?.length
        ? await recordForTask({ id: r.id, collection: (await getTask(r.id))!.collection }, { learned: args.learned, follow_ups: args.follow_ups })
        : undefined;
      const claim = r.claim ? describeClaim(r.claim) : '';
      const rec = closeSummary({ recorded });
      return { id: r.id, ...(claim && { claim }), ...(decision && { decision }), ...(rec && { recorded: rec }) };
    },
    presentCall: args => ({ card: 'generic', title: `Update task ${args.id}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_complete',
    description: 'Mark a durable task done, and record what it produced in the same call: learned (typed memories linked to the task) and follow_ups (new tasks). Handles recurring task regeneration.',
    parameters: {
      id: { type: 'string', required: true },
      ...closeParams,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          regenerated_id: { type: 'string' },
          recorded: { type: 'string' },
        },
      },
      render: (_args, v) => text(
        `Completed task ${v.id}${v.regenerated_id ? ` → regenerated as ${v.regenerated_id} (recurring)` : ''}${v.recorded ? `\n${v.recorded}` : ''}`,
      ),
    },
    async execute(args) {
      const result = await completeTask(args.id, undefined, {}, { learned: args.learned, follow_ups: args.follow_ups });
      const rec = closeSummary(result);
      return { id: args.id, ...(result.regeneratedId && { regenerated_id: result.regeneratedId }), ...(rec && { recorded: rec }) };
    },
    presentCall: args => ({ card: 'generic', title: `Complete task ${args.id}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_task_next',
    description:
      'The ready queue for a collection: pending tasks whose dependencies are complete, that wait on no open decision, '
      + 'need no person (needs-human) and that nobody has claimed, best first, with why others were skipped and cleanup '
      + 'items when nothing is ready. claim: true claims the first ready task (or cleanup item).',
    parameters: {
      collection: { type: 'string', required: true },
      tags: { type: 'array', items: { type: 'string' }, description: 'Only tasks carrying all of these tags' },
      exclude_tags: { type: 'array', items: { type: 'string' }, description: 'Skip tasks carrying any of these tags' },
      auto_only: { type: 'boolean', description: 'Only tasks tagged auto (for unattended work)' },
      claim: { type: 'boolean', description: 'Claim the first ready task' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string', required: true }, claimed: { type: 'string' } },
      },
      render: (_args, v) => text(v.summary),
    },
    async execute(args) {
      const r = await nextTasks({ collection: args.collection, tags: args.tags, excludeTags: args.exclude_tags, autoOnly: args.auto_only, claim: args.claim });
      const lines: string[] = [];
      if (args.claim) lines.push(r.claimed ? (describeClaim(r.claimed) || `Started ${r.claimed.id}.`) : 'Nothing ready to claim.');
      if (r.ready.length) {
        lines.push('', '**Ready:**', ...r.ready.slice(0, 5).map(t => `- **${t.id}** [${t.priority}] ${t.title}${t.unblocks ? ` (unblocks ${t.unblocks})` : ''}`));
      } else if (!args.claim) lines.push('No ready tasks.');
      if (r.cleanup.length) lines.push('', '**Cleanup:**', ...r.cleanup.map(c => `- **${c.key}** ${c.title}${c.held_by ? ` (held by ${c.held_by})` : ''}`));
      if (r.skipped.length) lines.push('', '**Skipped:**', ...r.skipped.slice(0, 15).map(x => `- ${x.id}: ${x.reason}`));
      return { summary: lines.join('\n').trim(), ...(r.claimed ? { claimed: r.claimed.id } : {}) };
    },
    presentCall: args => ({ card: 'generic', title: `Next task in ${args.collection}`, kind: 'read' }),
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

  ctx.tools.register(defineTool({
    name: 'yapa_task_remove_dependency',
    description: 'Remove a depends-on/blocks relationship between durable tasks (both sides; also clears a dangling edge to a deleted task).',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task that depends on another' },
      depends_on_id: { type: 'string', required: true, description: 'Task it should no longer depend on' },
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
      render: (_args, v) => text(`${v.task_id} no longer depends on ${v.depends_on_id}`),
    },
    async execute(args) {
      await removeDependency(args.task_id, args.depends_on_id);
      return { task_id: args.task_id, depends_on_id: args.depends_on_id };
    },
    presentCall: args => ({ card: 'generic', title: `${args.task_id} no longer depends on ${args.depends_on_id}`, kind: 'edit' }),
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
    name: 'yapa_collection_merge',
    description:
      'Merge collection `from` into existing collection `into`: moves EVERY document (memories, tasks, journals) '
      + 'with ids and metadata intact, syncs the move to teammates (nothing is deleted remotely), then removes the '
      + 'emptied `from`. Use this, never yapa_collection_delete, to combine or rename collections. Create `into` '
      + 'first (after confirming the name with the user). Refuses private (private-*/local-*/global) -> shared '
      + 'merges. Pass dry_run to see counts first.',
    parameters: {
      from: { type: 'string', required: true, description: 'Collection to merge (removed afterwards)' },
      into: { type: 'string', required: true, description: 'Existing collection that receives every document' },
      dry_run: { type: 'boolean', description: 'Report what would move without changing anything' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          into: { type: 'string', required: true },
          moved: { type: 'integer', required: true },
          byType: { ...openObject, required: true },
          dryRun: { type: 'boolean', required: true },
          sourceRemoved: { type: 'boolean', required: true },
          teammateRowsKept: { type: 'integer', required: true },
        },
      },
      render: (_args, v) => {
        const types = Object.entries(v.byType as Record<string, number>)
          .sort(([a], [b]) => a.localeCompare(b)).map(([t, n]) => `${n} ${t}`).join(', ') || 'none';
        const lines = v.dryRun
          ? [`Dry run: would move ${v.moved} document(s) from "${v.from}" into "${v.into}" (${types}), then remove "${v.from}". Nothing changed.`]
          : [`Moved ${v.moved} document(s) from "${v.from}" into "${v.into}" (${types}) and removed the empty "${v.from}".`];
        if (v.teammateRowsKept > 0) {
          lines.push(`${v.teammateRowsKept} of them are teammates' docs: you now have a private copy, and their shared rows stay in "${v.from}" on the sync service.`);
        }
        return text(lines.join('\n'));
      },
    },
    async execute(args) {
      return await mergeCollections(args.from, args.into, { dryRun: args.dry_run });
    },
    presentCall: args => ({ card: 'generic', title: `Merge collection ${args.from} into ${args.into}`, kind: 'edit' }),
  }));

  ctx.tools.register(defineTool({
    name: 'yapa_collection_delete',
    description:
      'Permanently delete a collection and ALL its contents. Not a merge; to combine collections use '
      + 'yapa_collection_merge. A non-empty shared collection is deleted for every teammate on the sync service, '
      + 'so it requires `confirm` set to the exact collection name, after the user explicitly asked for the deletion.',
    parameters: {
      name: { type: 'string', required: true },
      confirm: { type: 'string', description: 'Exact collection name; required to delete a non-empty shared collection' },
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
      await removeCollection(args.name, { confirm: args.confirm });
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
