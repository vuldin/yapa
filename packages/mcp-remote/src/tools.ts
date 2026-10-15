/**
 * MCP tools served by yapa-mcp. Phase 1 is READ-ONLY: every tool here only
 * selects, carries readOnlyHint, and is the same for people and static-key
 * principals. Names, parameters and descriptions follow the local plugin
 * (packages/mcp/src/tools.ts) where they fit; `global`, `private-*` and
 * `local-*` never exist on the service, so there is no default collection.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type pg from 'pg';
import { z } from 'zod';
import { rankScore } from '@yapa/core/ranking';
import {
  ApiError, assertCollection, decodeCursor, isUnavailableError, listCollections, log, MAX_FUTURE_SECONDS,
  posFromSince, pull, type RequestCtx,
} from '@yapa/service/lib';
import type { Caller } from './auth.js';
import type { QueryEmbedder } from './embedder.js';
import {
  author, dueDate, isoDate, isoMinute, itemContent, joinBounded, list, salience, truncateBytes,
} from './format.js';
import { getTask, listMemories, listTasks, memoryChunks, recentMemories, vectorSearch, type DocRow } from './queries.js';
import { inferCollection, resolveCollection } from './resolve.js';

export const READ_TOOLS = [
  'memory_recall', 'memory_list', 'task_list', 'task_search', 'collection_list', 'collection_changes',
] as const;

/** Exposed unless YAPA_MCP_TOOLS says otherwise: one obvious tool for ADP users. */
export const DEFAULT_TOOLS = ['memory_recall'] as const;

/** Same as core's CROSS_COLLECTION_MAX_DISTANCE default: only strong matches from other collections. */
export const CROSS_COLLECTION_MAX_DISTANCE = 0.45;
const RECALL_OVERFETCH = 4;
/** Rank bonus (in distance units) for the collection a question names. */
const INFERRED_BOOST = 0.1;
/** Open tasks appended to memory_recall: all (up to this) for a focused customer, else a few close matches. */
const RECALL_TASKS_FOCUSED = 8;
const RECALL_TASKS_UNFOCUSED = 3;
/** Tasks updated within this window lead the follow-up list. */
const RECALL_TASKS_FRESH_SECS = 14 * 86400;
/** Newest memories of the focused customer added as candidates for time-sensitive questions. */
const RECALL_RECENT_CANDIDATES = 10;

/**
 * Form-based clients (ADP's tool form, Inspector) send "" for fields left
 * blank, and sometimes numbers as strings: treat "" / null as absent and
 * coerce numeric strings, so a blank optional field means "not set".
 */
const blank = (v: unknown) => (v === '' || v === null ? undefined : v);
const optString = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s.optional());
const optNumber = <T extends z.ZodTypeAny>(s: T) =>
  z.preprocess(v => {
    const b = blank(v);
    return typeof b === 'string' && /^\s*-?[0-9]+(\.[0-9]+)?\s*$/.test(b) ? Number(b) : b;
  }, s.optional());
const optBoolean = () =>
  z.preprocess(v => {
    const b = blank(v);
    return b === 'true' ? true : b === 'false' ? false : b;
  }, z.boolean().optional());

/** Joins two overlapping chunks (core overlaps them by ~200 chars). */
function stitch(prev: string, next: string): string {
  for (let k = Math.min(400, prev.length, next.length); k >= 20; k--) {
    if (prev.endsWith(next.slice(0, k))) return prev + next.slice(k);
  }
  return `${prev}${next}`;
}

/**
 * Whole memories instead of chunk fragments: a hit on chunk `<parent>-<n>`
 * is replaced by the parent's full text under the parent id, and later hits
 * on the same parent are dropped (the list stays in rank order).
 */
async function wholeMemories(pool: pg.Pool, me: string, rows: DocRow[]): Promise<DocRow[]> {
  const parents = [...new Set(rows
    .filter(r => r.metadata.parent_id && Number(r.metadata.chunk_total) > 1)
    .map(r => String(r.metadata.parent_id)))];
  const full = new Map<string, string>();
  for (const c of await memoryChunks(pool, me, parents)) {
    const p = String(c.metadata.parent_id);
    full.set(p, full.has(p) ? stitch(full.get(p)!, c.content) : c.content);
  }
  const seen = new Set<string>();
  const out: DocRow[] = [];
  for (const r of rows) {
    const p = r.metadata.parent_id ? String(r.metadata.parent_id) : undefined;
    const id = p && full.has(p) ? p : r.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id === r.id ? r : { ...r, id, content: full.get(id)! });
  }
  return out;
}

function uniqueById(rows: DocRow[]): DocRow[] {
  const seen = new Set<string>();
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
const CHANGES_PAGE = 100;
const CHANGES_MAX_BYTES = 512 * 1024;

export interface ToolContext {
  pool: pg.Pool;
  caller: Caller;
  requestId: string;
  embedder: QueryEmbedder;
  /** Rate-limit hook for server-side embedding: 0 = allowed, else seconds to wait. */
  takeEmbed: () => number;
  /** Injectable clock (seconds) for `since` validation. */
  nowSecs?: () => number;
}

interface ToolOutput {
  text: string;
  count: number;
  collections: string[];
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/**
 * One structured line per call (never arguments, content or tokens). ApiErrors
 * and an unavailable database become tool errors the model can read; anything
 * else is logged and reported generically.
 */
function instrument<A>(ctx: ToolContext, tool: string, fn: (args: A) => Promise<ToolOutput>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    const started = performance.now();
    const base = { event: 'mcp_call', actor: ctx.caller.username, kind: ctx.caller.kind, tool, request_id: ctx.requestId };
    const latency = () => Math.round(performance.now() - started);
    try {
      const out = await fn(args);
      log('INFO', 'mcp call', { ...base, collections: out.collections, result_count: out.count, latency_ms: latency(), outcome: 'ok' });
      return { content: [{ type: 'text', text: out.text }] };
    } catch (e) {
      let code = 'internal';
      let message = 'internal error';
      if (e instanceof ApiError) {
        code = e.code;
        message = e.message;
      } else if (isUnavailableError(e)) {
        code = 'unavailable';
        message = 'service temporarily unavailable; retry later';
      } else {
        // Message and code only: pg error `detail` can echo row values.
        log('ERROR', 'mcp tool error', { request_id: ctx.requestId, tool, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code });
      }
      log('WARNING', 'mcp call', { ...base, result_count: 0, latency_ms: latency(), outcome: 'error', error_code: code });
      return { content: [{ type: 'text', text: `Error (${code}): ${message}` }], isError: true };
    }
  };
}

function requireEmbed(ctx: ToolContext): void {
  const wait = ctx.takeEmbed();
  if (wait > 0) throw new ApiError('rate_limited', `rate limit exceeded; retry in ${wait}s`);
}

function serviceCtx(ctx: ToolContext): RequestCtx {
  return { caller: { username: ctx.caller.username, email: ctx.caller.email ?? '' }, device: null, requestId: ctx.requestId };
}

/**
 * Lower is better (distance minus a salience bonus), like core's recall;
 * rows in `boost` (the collection a question names) rank a little higher.
 */
function rerank(rows: DocRow[], boost?: string, recency?: Recency): DocRow[] {
  const score = (r: DocRow) => rankScore(r.distance ?? 1, r.metadata.salience)
    - (boost && r.collection === boost ? INFERRED_BOOST : 0)
    - (recency ? recencyBonus(r.updated_at, recency) : 0);
  return [...rows].sort((a, b) => score(a) - score(b));
}

interface Recency {
  now: number;
  /** The question asks about time ("latest", "this week"): weigh recency much more. */
  temporal: boolean;
}

/**
 * Bonus (distance units) for recently updated rows. Salience is a snapshot on
 * the service and favors old, much-used memories, so without this a new
 * meeting note loses to July's highlights. Mild by default; strong (and
 * slower to fade) when the question is about what is recent.
 */
export function recencyBonus(updatedAt: number, r: Recency): number {
  const days = Math.max(0, (r.now - updatedAt) / 86400);
  return r.temporal ? 0.3 * Math.exp(-days / 14) : 0.05 * Math.exp(-days / 30);
}

const TEMPORAL_RE = /\b(recent|recently|latest|last|newest|lately|today|yesterday|this (week|month)|past (week|month|few days)|new|news|updates?)\b/i;

/** Does the question ask about what happened recently? */
export function isTemporal(query: string): boolean {
  return TEMPORAL_RE.test(query);
}

function memoryBlock(r: DocRow, extra = ''): string {
  return `**${r.id}** (${r.collection}${extra}, ${author(r)}, salience: ${salience(r.metadata)}, distance: ${(r.distance ?? 0).toFixed(3)}, updated ${isoDate(r.updated_at)})\n${itemContent(r.content)}`;
}

function taskLine(t: DocRow): string {
  const m = t.metadata;
  let line = `- **${t.id}** [${m.status ?? '?'}] ${m.priority ?? '?'} | ${truncateBytes(t.content, 512)}`;
  const due = dueDate(m);
  if (due) line += ` (due: ${due})`;
  line += ` (${author(t)}, updated ${isoDate(t.updated_at)}) [${t.collection}]`;
  return line;
}

function parseSince(v: string | number, now: number): number {
  let secs: number;
  if (typeof v === 'number' || /^[0-9]+(\.[0-9]+)?$/.test(v.trim())) {
    secs = Number(v);
    if (secs > 1e11) secs = secs / 1000; // epoch milliseconds
  } else {
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new ApiError('invalid_request', 'since must be an ISO 8601 date/time or Unix seconds');
    secs = ms / 1000;
  }
  if (!Number.isFinite(secs) || secs < 0 || secs > now + MAX_FUTURE_SECONDS) {
    throw new ApiError('invalid_request', 'since is out of range');
  }
  return secs;
}

export function registerReadTools(server: McpServer, ctx: ToolContext, enabled: ReadonlySet<string> = new Set(READ_TOOLS)): void {
  const { pool } = ctx;
  // Only the configured tools are listed (and callable); the rest are never registered.
  const tool = ((name: string, ...rest: unknown[]) =>
    enabled.has(name) ? (server.registerTool as (...a: unknown[]) => unknown)(name, ...rest) : undefined) as typeof server.registerTool;
  const me = ctx.caller.username;

  // Shared collection names, read at most once per request.
  let namesP: Promise<string[]> | undefined;
  const collectionNames = () => (namesP ??= listCollections(pool, serviceCtx(ctx)).then(cs => cs.map(c => c.name)));
  /** A collection id or a plain customer/project name ("Acme CT"); undefined when not given. */
  const pickCollection = async (input: string | undefined): Promise<string | undefined> => {
    if (input === undefined) return undefined;
    // Local-only names never exist here: refuse them before any database work.
    if (/^(global$|private-|local-)/.test(input.trim())) assertCollection(input.trim());
    return assertCollection(resolveCollection(input, await collectionNames()));
  };

  tool(
    'memory_recall',
    {
      description: 'Search the team\'s shared YAPA memory (meeting notes, decisions, cluster and config facts, contacts, follow-ups) for anything relevant to a question. Just pass the question: when it names a customer or project ("what\'s new with Acme CT?"), that customer\'s memories rank first automatically, with strongly relevant hits from other customers included and labeled. You normally do NOT need `collection`. Each result is a whole memory with its customer/project, author and date, followed by the open follow-ups (tasks) for that customer. Questions about what is recent ("latest meeting", "this week") favor the newest memories. Use it before drafting a customer status update or answering a question about an account.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('The question or topic, in plain words, e.g. "Acme CT shadow link DR status"'),
        collection: optString(z.string().max(200)).describe('Optional: restrict to one customer/project, by name ("globex", "Acme CT") or id (customer-globex). Leave empty to search everything.'),
        n_results: optNumber(z.number().int().min(1).max(20)).describe('Max results (default 5, max 20)'),
        other_collections: optNumber(z.number().int().min(0).max(5)).describe('With `collection`: max extra strongly-relevant hits from other collections (default 2; 0 = only that collection)'),
        include_tasks: optBoolean().describe('Append open follow-ups/tasks (default true): all open tasks of the customer the question names, or a few closely matching ones otherwise'),
      },
      annotations: { title: 'Recall memories', ...READ_ONLY },
    },
    instrument(ctx, 'memory_recall', async ({ query, collection, n_results, other_collections, include_tasks }) => {
      const coll = await pickCollection(collection);
      const n = n_results ?? 5;
      requireEmbed(ctx);
      const embedding = await ctx.embedder.embed(query);
      const inferred = coll === undefined ? inferCollection(query, await collectionNames()) : undefined;
      const search = (opts: { collection?: string; excludeCollection?: string; maxDistance?: number }, limit: number) =>
        vectorSearch(pool, me, { embedding, type: 'memory', limit, ...opts });

      const focusColl = coll ?? inferred;
      const now = ctx.nowSecs?.() ?? Date.now() / 1000;
      const recency: Recency = { now, temporal: isTemporal(query) };

      // Candidates: vector hits (the named customer's plus the best overall),
      // and for "latest/recent" questions that customer's newest memories too.
      const candidates: DocRow[] = [];
      if (inferred) {
        const [scoped, all] = await Promise.all([search({ collection: inferred }, n * RECALL_OVERFETCH), search({}, n * RECALL_OVERFETCH)]);
        candidates.push(...scoped, ...all); // boost, don't filter
      } else {
        candidates.push(...await search({ collection: coll }, n * RECALL_OVERFETCH));
      }
      if (recency.temporal && focusColl) candidates.push(...await recentMemories(pool, me, focusColl, embedding, RECALL_RECENT_CANDIDATES));
      let main = rerank(uniqueById(candidates), inferred, recency);
      main = (await wholeMemories(pool, me, main.slice(0, n * 2))).slice(0, n);

      const extraN = coll === undefined ? 0 : (other_collections ?? 2);
      const extras = extraN > 0
        ? (await wholeMemories(pool, me, rerank(await search({ excludeCollection: coll, maxDistance: CROSS_COLLECTION_MAX_DISTANCE }, extraN * RECALL_OVERFETCH), undefined, recency).slice(0, extraN * 2))).slice(0, extraN)
        : [];
      // Open follow-ups: for the focused customer, recently created/updated ones
      // first (new action items from the latest meeting), then the rest by
      // priority; otherwise a few close matches.
      let tasks: DocRow[] = [];
      if (include_tasks ?? true) {
        if (focusColl) {
          const open = await listTasks(pool, me, { collection: focusColl, includeComplete: false, limit: 200 });
          const fresh = open.filter(t => now - t.updated_at <= RECALL_TASKS_FRESH_SECS).sort((a, b) => b.updated_at - a.updated_at);
          tasks = uniqueById([...fresh, ...open]).slice(0, RECALL_TASKS_FOCUSED);
        } else {
          tasks = (await vectorSearch(pool, me, { embedding, type: 'task', limit: RECALL_TASKS_UNFOCUSED * 4, maxDistance: CROSS_COLLECTION_MAX_DISTANCE }))
            .filter(t => t.metadata.status !== 'complete').slice(0, RECALL_TASKS_UNFOCUSED);
        }
      }

      const collections = [...new Set([...main, ...extras, ...tasks].map(r => r.collection))];
      if (main.length + extras.length + tasks.length === 0) return { text: 'No memories found.', count: 0, collections: coll ? [coll] : [] };
      const focus = inferred ? `Focused on ${inferred} (named in the question); other collections included where relevant.` : undefined;
      const blocks = [
        ...(focus ? [focus] : []),
        ...main.map(r => memoryBlock(r, focusColl ? (r.collection === focusColl ? '' : ', other collection') : '')),
        ...extras.map(r => memoryBlock(r, ', other collection')),
      ];
      if (tasks.length) {
        const head = focusColl ? `Open follow-ups for ${focusColl} (recently updated first, then by priority):` : 'Related open follow-ups:';
        blocks.push([head, ...tasks.map(taskLine)].join('\n'));
      }
      return { text: joinBounded(blocks, '\n\n---\n\n'), count: main.length + extras.length + tasks.length, collections };
    }),
  );

  tool(
    'memory_list',
    {
      description: 'List the most recent memories for one customer or project, newest first, with author and salience (e.g. "everything recent on Globex"). Archived and promoted memories are excluded. Pass the returned `cursor` to get the next page.',
      inputSchema: {
        collection: z.string().min(1).max(200).describe('Customer or project by name ("globex", "Acme CT") or id (customer-globex)'),
        limit: optNumber(z.number().int().min(1).max(100)).describe('Max results (default 20, max 100)'),
        cursor: optString(z.string().max(1024)).describe('Cursor from a previous memory_list call'),
      },
      annotations: { title: 'List memories', ...READ_ONLY },
    },
    instrument(ctx, 'memory_list', async ({ collection, limit, cursor }) => {
      const coll = (await pickCollection(collection))!;
      const page = await listMemories(pool, me, coll, limit ?? 20, cursor);
      const rows = await wholeMemories(pool, me, page.rows);
      const next_cursor = page.next_cursor;
      if (rows.length === 0) return { text: 'No memories found.', count: 0, collections: [coll] };
      const blocks = rows.map(r =>
        `- **${r.id}** [${r.collection}] (${author(r)}, salience: ${salience(r.metadata)}, sector: ${r.metadata.sector ?? '?'}, updated ${isoDate(r.updated_at)}): ${itemContent(r.content)}`);
      const footer = next_cursor ? [`More memories: call memory_list again with cursor "${next_cursor}".`] : [];
      return { text: joinBounded(blocks, '\n', footer), count: rows.length, collections: [coll] };
    }),
  );

  tool(
    'task_list',
    {
      description: 'List the team\'s shared tasks with optional filters (collection, status, priority) — or pass `id` to fetch one task with full detail (notes, dependencies). Completed tasks are hidden unless include_complete is true.',
      inputSchema: {
        id: optString(z.string().max(200)).describe('Fetch a single task by ID (e.g., alice-12) with full detail instead of listing'),
        collection: optString(z.string().max(200)).describe('Optional customer or project, by name ("globex") or id; leave empty for all'),
        status: optString(z.enum(['pending', 'in_progress', 'blocked', 'complete'])),
        priority: optString(z.enum(['critical', 'high', 'medium', 'low'])),
        include_complete: optBoolean().describe('Include completed tasks (default: false)'),
      },
      annotations: { title: 'List tasks', ...READ_ONLY },
    },
    instrument(ctx, 'task_list', async ({ id, collection, status, priority, include_complete }) => {
      if (id) {
        const t = await getTask(pool, me, id);
        if (!t) return { text: `Task ${id} not found.`, count: 0, collections: [] };
        const m = t.metadata;
        const lines = [
          `**${t.id}**: ${itemContent(t.content)}`,
          `Status: ${m.status ?? '?'} | Priority: ${m.priority ?? '?'}`,
          `Collection: ${t.collection}`,
          `Owner: ${t.origin_user}${t.last_editor && t.last_editor !== t.origin_user ? ` (last edited by ${t.last_editor})` : ''}`,
          `Created: ${isoDate(t.created_at)} | Updated: ${isoDate(t.updated_at)}`,
        ];
        const due = dueDate(m);
        if (due) lines.push(`Due: ${due}`);
        if (Number(m.completed_at) > 0) lines.push(`Completed: ${isoDate(Number(m.completed_at))}`);
        if (m.blocked_reason) lines.push(`Blocked: ${truncateBytes(String(m.blocked_reason), 1024)}`);
        if (m.notes) lines.push(`Notes: ${itemContent(String(m.notes))}`);
        const tags = list(m.tags);
        if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);
        const deps = list(m.depends_on);
        if (deps.length) lines.push(`Depends on: ${deps.join(', ')}`);
        const blocks = list(m.blocks);
        if (blocks.length) lines.push(`Blocks: ${blocks.join(', ')}`);
        return { text: truncateBytes(lines.join('\n'), 16 * 1024), count: 1, collections: [t.collection] };
      }
      const coll = await pickCollection(collection);
      const tasks = await listTasks(pool, me, { collection: coll, status, priority, includeComplete: include_complete ?? false, limit: 200 });
      if (tasks.length === 0) return { text: 'No tasks found.', count: 0, collections: coll ? [coll] : [] };
      return {
        text: joinBounded(tasks.map(taskLine), '\n'),
        count: tasks.length,
        collections: [...new Set(tasks.map(t => t.collection))],
      };
    }),
  );

  tool(
    'task_search',
    {
      description: 'Search the team\'s shared tasks (follow-ups, action items) by meaning. Just pass the question; a customer or project it names ranks first automatically.',
      inputSchema: {
        query: z.string().min(1).max(2000).describe('What to look for, e.g. "open follow-ups for Globex"'),
        collection: optString(z.string().max(200)).describe('Optional customer or project, by name or id; leave empty to search everything'),
      },
      annotations: { title: 'Search tasks', ...READ_ONLY },
    },
    instrument(ctx, 'task_search', async ({ query, collection }) => {
      const coll = await pickCollection(collection);
      requireEmbed(ctx);
      const embedding = await ctx.embedder.embed(query);
      const inferred = coll === undefined ? inferCollection(query, await collectionNames()) : undefined;
      const rows = inferred
        ? rerank(uniqueById([
          ...await vectorSearch(pool, me, { embedding, type: 'task', collection: inferred, limit: 10 }),
          ...await vectorSearch(pool, me, { embedding, type: 'task', limit: 10 }),
        ]), inferred).slice(0, 10)
        : await vectorSearch(pool, me, { embedding, type: 'task', collection: coll, limit: 10 });
      if (rows.length === 0) return { text: 'No matching tasks found.', count: 0, collections: coll ? [coll] : [] };
      const lines = rows.map(r =>
        `- **${r.id}** [${r.metadata.status ?? '?'}] ${truncateBytes(r.content, 512)} (similarity: ${(1 - (r.distance ?? 1)).toFixed(3)}) (${author(r)}) [${r.collection}]`);
      return { text: joinBounded(lines, '\n'), count: rows.length, collections: [...new Set(rows.map(r => r.collection))] };
    }),
  );

  tool(
    'collection_list',
    {
      description: 'List all shared collections with document counts',
      inputSchema: {},
      annotations: { title: 'List collections', ...READ_ONLY },
    },
    instrument(ctx, 'collection_list', async () => {
      const cols = await listCollections(pool, serviceCtx(ctx));
      if (cols.length === 0) return { text: 'No collections found.', count: 0, collections: [] };
      return { text: joinBounded(cols.map(c => `- **${c.name}**: ${c.count} documents`), '\n'), count: cols.length, collections: [] };
    }),
  );

  tool(
    'collection_changes',
    {
      description: 'What changed for one customer or project since a point in time: new or updated memories and tasks (with author) and deletions, oldest first. Use it to draft status updates ("what happened with Globex this week"). Pass the returned `cursor` to continue.',
      inputSchema: {
        collection: z.string().min(1).max(200).describe('Customer or project by name ("globex", "Acme CT") or id (customer-globex)'),
        since: optString(z.union([z.string().max(64), z.number()])).describe('ISO 8601 date/time (e.g. 2026-10-01) or Unix seconds; required unless cursor is given'),
        cursor: optString(z.string().max(2048)).describe('Cursor from a previous collection_changes call'),
      },
      annotations: { title: 'Collection changes', ...READ_ONLY },
    },
    instrument(ctx, 'collection_changes', async ({ collection, since, cursor }) => {
      const coll = (await pickCollection(collection))!;
      const now = ctx.nowSecs?.() ?? Date.now() / 1000;
      let docsPos, delsPos;
      if (cursor) {
        const cur = decodeCursor(cursor, coll, now * 1000);
        docsPos = cur.d;
        delsPos = cur.x;
      } else {
        if (since === undefined) throw new ApiError('invalid_request', 'pass since (ISO date or Unix seconds) or cursor');
        docsPos = delsPos = posFromSince(parseSince(since, now));
      }
      const page = await pull(pool, serviceCtx(ctx), {
        collection: coll, docsPos, delsPos, limit: CHANGES_PAGE, includeOwnDevice: true, embeddings: false, maxBytes: CHANGES_MAX_BYTES,
      });
      const items = page.documents.map(d => {
        const m = d.metadata as Record<string, any>;
        const type = String(m.type ?? 'doc');
        const flags = [
          type === 'task' ? `${m.status ?? '?'}/${m.priority ?? '?'}` : '',
          m.archived === true || m.archived === 'true' ? 'archived' : '',
        ].filter(Boolean).join(', ');
        return `- ${isoMinute(d.updated_at)} ${type} **${d.id}** (${author(d)}${flags ? `, ${flags}` : ''}): ${truncateBytes(d.content, 1024)}`;
      });
      const dels = page.deletions.map(x => `- ${isoMinute(x.deleted_at)} deleted **${x.id}** by ${x.deleted_by}`);
      const header = `Changes in ${coll}: ${page.documents.length} document(s), ${page.deletions.length} deletion(s)${page.has_more ? ' (more available)' : ''}`;
      const footer = [page.has_more
        ? `More changes: call collection_changes again with cursor "${page.next_cursor}".`
        : `Up to date. To check again later, use cursor "${page.next_cursor}".`];
      return {
        text: joinBounded([header, ...items, ...dels], '\n', footer),
        count: page.documents.length + page.deletions.length,
        collections: [coll],
      };
    }),
  );
}

/**
 * WRITE PHASE HOOK (not implemented). Phase 2 registers write tools here,
 * only when YAPA_MCP_WRITES=true AND the caller is a person
 * (`caller.kind === 'user'`); static-key principals stay read-only. Phase 1
 * registers nothing, whatever the flag says.
 */
export function registerWriteTools(_server: McpServer, _ctx: ToolContext, _writesEnabled: boolean): void {
  // if (_writesEnabled && _ctx.caller.kind === 'user') { ...phase 2... }
}
