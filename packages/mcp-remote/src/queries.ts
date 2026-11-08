/**
 * Read-only SQL for the MCP tools (schema v2, infra/cloudsql/sql/). Narrow
 * additions next to yapa-service's store.ts, which stays untouched; pulls and
 * collection counts reuse store.ts directly. Everything runs inside
 * withUserTx, so the yapa-mcp role's RLS policy (05_mcp_runtime.sql) applies
 * on top of the filters here.
 */
import type pg from 'pg';
import { ApiError, toPgVector, withUserTx } from '@yapa/service/lib';
import { DEFAULT_LEAD_DAYS, NUMERIC_PATTERN, RECURRENCE_PATTERNS } from '@yapa/core/recurrence';

export interface DocRow {
  id: string;
  collection: string;
  content: string;
  metadata: Record<string, any>;
  origin_user: string;
  last_editor: string | null;
  created_at: number;
  updated_at: number;
  /** Cosine distance (vector searches only). */
  distance?: number;
}

// Same rule as store.ts (and the RLS policy): local-only collections never qualify.
const LOCAL_ONLY_SQL = "collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%'";
// Mirrors core's recall/list defaults: archived (incl. superseded and
// compacted) and promoted memories are hidden. `->>` reads true and "true" alike.
const ACTIVE_SQL = "COALESCE(metadata->>'archived', '') <> 'true' AND metadata->>'promoted_to' IS NULL";
// Compaction summaries of past sessions: recalled only on request, as in core.
const NO_SESSIONS_SQL = "NOT (COALESCE(metadata->>'source', '') = 'compaction'"
  + " OR (COALESCE(metadata->>'tags', '') ~ '(^|[\\[\",\\s])compaction([\\]\",\\s]|$)' AND COALESCE(metadata->>'tags', '') ~ '(^|[\\[\",\\s])journal([\\]\",\\s]|$)'))";
const COLUMNS = `id, collection, content, metadata, origin_user, last_editor,
  floor(extract(epoch from created_at))::bigint AS created_at, floor(extract(epoch from updated_at))::bigint AS updated_at`;

/** HNSW candidate list size; the default (40) can starve filtered searches. */
const EF_SEARCH = 200;

function toRow(r: Record<string, any>): DocRow {
  const out: DocRow = {
    id: r.id,
    collection: r.collection,
    content: r.content,
    metadata: r.metadata ?? {},
    origin_user: r.origin_user,
    last_editor: r.last_editor ?? null,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
  if (r.distance !== undefined) out.distance = Number(r.distance);
  return out;
}

export interface VectorSearch {
  embedding: number[];
  type: 'memory' | 'task';
  /** Only this collection. */
  collection?: string;
  /** Every collection except this one (cross-collection extras). */
  excludeCollection?: string;
  limit: number;
  /** Drop hits at or beyond this cosine distance. */
  maxDistance?: number;
  /** Include compaction summaries of past sessions (memories). */
  includeSessions?: boolean;
}

export async function vectorSearch(pool: pg.Pool, username: string, p: VectorSearch): Promise<DocRow[]> {
  return withUserTx(pool, username, async c => {
    await c.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)]);
    const values: unknown[] = [toPgVector(p.embedding), p.type];
    const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
    let where = `metadata->>'type' = $2 AND ${LOCAL_ONLY_SQL}`;
    if (p.type === 'memory') where += ` AND ${ACTIVE_SQL}${p.includeSessions ? '' : ` AND ${NO_SESSIONS_SQL}`}`;
    if (p.collection !== undefined) where += ` AND collection = ${param(p.collection)}`;
    if (p.excludeCollection !== undefined) where += ` AND collection <> ${param(p.excludeCollection)}`;
    if (p.maxDistance !== undefined) where += ` AND (embedding <=> $1::vector) < ${param(p.maxDistance)}`;
    const r = await c.query(
      `SELECT ${COLUMNS}, embedding <=> $1::vector AS distance
         FROM documents WHERE ${where}
        ORDER BY embedding <=> $1::vector
        LIMIT ${param(p.limit)}`,
      values,
    );
    return r.rows.map(toRow);
  });
}

/**
 * The newest memories of one collection (by updated_at), with their cosine
 * distance to `embedding` so they can be ranked with vector hits. Recall adds
 * them as candidates for time-sensitive questions ("latest meeting"), which a
 * pure similarity search can rank below older, higher-salience memories.
 */
export async function recentMemories(pool: pg.Pool, username: string, collection: string, embedding: number[], limit: number, includeSessions = false): Promise<DocRow[]> {
  return withUserTx(pool, username, async c => {
    const r = await c.query(
      `SELECT ${COLUMNS}, embedding <=> $1::vector AS distance
         FROM documents
        WHERE collection = $2 AND metadata->>'type' = 'memory' AND ${ACTIVE_SQL} AND ${LOCAL_ONLY_SQL}${includeSessions ? '' : ` AND ${NO_SESSIONS_SQL}`}
        ORDER BY updated_at DESC, id DESC
        LIMIT $3`,
      [toPgVector(embedding), collection, limit],
    );
    return r.rows.map(toRow);
  });
}

/**
 * Every chunk of the given multi-chunk memories (core stores long content as
 * `<parent_id>-<n>` docs with parent_id/chunk_index metadata), in order.
 */
export async function memoryChunks(pool: pg.Pool, username: string, parentIds: string[]): Promise<DocRow[]> {
  if (parentIds.length === 0) return [];
  return withUserTx(pool, username, async c => {
    const r = await c.query(
      `SELECT ${COLUMNS} FROM documents
        WHERE metadata->>'parent_id' = ANY($1::text[]) AND metadata->>'type' = 'memory' AND ${LOCAL_ONLY_SQL}
        ORDER BY metadata->>'parent_id',
                 CASE WHEN metadata->>'chunk_index' ~ '^[0-9]+$' THEN (metadata->>'chunk_index')::int ELSE 0 END`,
      [parentIds],
    );
    return r.rows.map(toRow);
  });
}

// ------------------------------------------------------------ memory_list

interface ListCursor {
  c: string;
  /** updated_at in microseconds (decimal string). */
  u: string;
  id: string;
}

export function encodeListCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeListCursor(raw: string, collection: string): ListCursor {
  let v: ListCursor;
  try {
    v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError('invalid_request', 'malformed cursor');
  }
  if (!v || typeof v.u !== 'string' || !/^[0-9]{1,20}$/.test(v.u) || typeof v.id !== 'string' || v.id.length > 200) {
    throw new ApiError('invalid_request', 'malformed cursor');
  }
  if (v.c !== collection) throw new ApiError('invalid_request', 'cursor belongs to a different collection');
  return v;
}

/** Newest first by updated_at, keyset-paginated. */
export async function listMemories(
  pool: pg.Pool, username: string, collection: string, limit: number, cursor?: string,
): Promise<{ rows: DocRow[]; next_cursor?: string }> {
  const after = cursor ? decodeListCursor(cursor, collection) : undefined;
  return withUserTx(pool, username, async c => {
    const values: unknown[] = [collection, limit + 1];
    let where = `collection = $1 AND metadata->>'type' = 'memory' AND ${ACTIVE_SQL} AND ${LOCAL_ONLY_SQL}`;
    if (after) {
      values.push(after.u, after.id);
      where += ` AND (updated_at, id) < ('epoch'::timestamptz + $3::bigint * interval '1 microsecond', $4)`;
    }
    const r = await c.query(
      `SELECT ${COLUMNS}, (extract(epoch from updated_at) * 1000000)::bigint::text AS updated_us
         FROM documents WHERE ${where}
        ORDER BY documents.updated_at DESC, documents.id DESC
        LIMIT $2`,
      values,
    );
    const page = r.rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map(toRow),
      next_cursor: r.rows.length > limit && last ? encodeListCursor({ c: collection, u: last.updated_us, id: last.id }) : undefined,
    };
  });
}

// ------------------------------------------------------------------ tasks

export interface TaskFilters {
  collection?: string;
  status?: string;
  priority?: string;
  includeComplete: boolean;
  /** Also recurring occurrences that haven't opened yet. */
  includeUpcoming?: boolean;
  /** Unix seconds that decide what is upcoming (default: now). */
  now?: number;
  limit: number;
}

// Core's isUpcoming (tasks/recurrence.ts, with format.ts endOfDayOpening as the fallback), the one copy that has to be SQL:
// it filters before LIMIT. Patterns and lead-time defaults come from core (literals checked here).
const sqlWord = (w: string) => { if (!/^[a-z]+$/.test(w)) throw new Error(`unexpected recurrence pattern ${w}`); return `'${w}'`; };
const sqlInt = (n: number) => { if (!Number.isInteger(n)) throw new Error(`unexpected lead time ${n}`); return String(n); };
const DEFAULT_LEAD_SQL = `CASE metadata->>'recurrence_pattern' ${Object.entries(DEFAULT_LEAD_DAYS).map(([p, n]) => `WHEN ${sqlWord(p)} THEN ${sqlInt(n)}`).join(' ')} ELSE 0 END`;
/**
 * A metadata number as core's metaNumber reads it: a JSON number, or a string
 * holding a decimal number; else NULL, with no cast tried. A JSON number too
 * small for float8 is 0, as JSON.parse reads it. A value core reads as
 * non-finite counts as missing: a JSON number past 1e300, and a string
 * longer than 20 digits on either side of the point or with an exponent of
 * more than two digits (bounds under which float8 can't overflow).
 */
if (NUMERIC_PATTERN.includes("'")) throw new Error('NUMERIC_PATTERN must not contain a quote');
const NUMERIC_RE = NUMERIC_PATTERN;
const metaNumber = (key: 'due_date' | 'lead_days' | 'opens_at') => `CASE jsonb_typeof(metadata->'${key}')
    WHEN 'number' THEN CASE WHEN abs((metadata->'${key}')::numeric) < 1e-300 THEN 0
      WHEN abs((metadata->'${key}')::numeric) < 1e300 THEN (metadata->>'${key}')::float8 END
    WHEN 'string' THEN CASE WHEN metadata->>'${key}' ~ '${NUMERIC_RE}' THEN (metadata->>'${key}')::float8 END END`;
/**
 * Per row, once: the due date, the lead time (core's leadDays), the opening
 * time (core's storedOpensAt, else the end-of-day assumption) and whether the
 * task is upcoming. `now` is a query parameter.
 */
const upcomingLaterals = (now: string) => `
  CROSS JOIN LATERAL (SELECT ${metaNumber('due_date')} AS due, ${metaNumber('lead_days')} AS lead_raw, ${metaNumber('opens_at')} AS opens_raw) n
  CROSS JOIN LATERAL (SELECT CASE WHEN n.lead_raw >= 0 AND n.lead_raw = floor(n.lead_raw) THEN n.lead_raw ELSE ${DEFAULT_LEAD_SQL} END AS lead) l
  CROSS JOIN LATERAL (SELECT CASE WHEN n.opens_raw > 0 AND n.opens_raw <= n.due - 86400 * l.lead + 3600 AND n.opens_raw > n.due - 86400 * (l.lead + 1) - 3600
    THEN n.opens_raw ELSE n.due - 86399 - 86400 * l.lead END AS opens) o
  CROSS JOIN LATERAL (SELECT COALESCE(metadata->>'is_recurring' = 'true'
    AND metadata->>'recurrence_pattern' IN (${RECURRENCE_PATTERNS.map(sqlWord).join(', ')})
    AND COALESCE(metadata->>'status', 'pending') = 'pending'
    AND n.due > 0 AND ${now} < o.opens, false) AS upcoming) u`;

const PRIORITY_RANK = "CASE metadata->>'priority' WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";
const SALIENCE_RANK = "CASE WHEN jsonb_typeof(metadata->'salience') = 'number' THEN (metadata->>'salience')::float8 ELSE 0 END";

/**
 * Tasks sorted like core's listTasks (priority desc, then salience desc),
 * upcoming occurrences left out unless includeUpcoming, and with `count`
 * how many were left out, in the same query. Nothing is computed for
 * upcoming when it can't apply (includeUpcoming, or a status other than pending).
 */
async function queryTasks(pool: pg.Pool, username: string, f: TaskFilters, count: boolean): Promise<{ rows: DocRow[]; hiddenUpcoming: number }> {
  return withUserTx(pool, username, async c => {
    const values: unknown[] = [];
    const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
    let where = `metadata->>'type' = 'task' AND ${LOCAL_ONLY_SQL}`;
    if (f.collection !== undefined) where += ` AND collection = ${param(f.collection)}`;
    if (f.status !== undefined) where += ` AND metadata->>'status' = ${param(f.status)}`;
    if (f.priority !== undefined) where += ` AND metadata->>'priority' = ${param(f.priority)}`;
    if (!f.includeComplete && f.status !== 'complete') where += " AND COALESCE(metadata->>'status', '') <> 'complete'";
    const order = 'ORDER BY rank_p DESC, rank_s DESC, id';
    const ranked = `${COLUMNS}, ${PRIORITY_RANK} AS rank_p, ${SALIENCE_RANK} AS rank_s`;
    if (f.includeUpcoming || (f.status !== undefined && f.status !== 'pending')) {
      const r = await c.query(`SELECT ${ranked} FROM documents WHERE ${where} ${order} LIMIT ${param(f.limit)}`, values);
      return { rows: r.rows.map(toRow), hiddenUpcoming: 0 };
    }
    const from = `documents ${upcomingLaterals(param(Math.floor(f.now ?? Date.now() / 1000)))}`;
    if (!count) {
      const r = await c.query(`SELECT ${ranked} FROM ${from} WHERE ${where} AND NOT u.upcoming ${order} LIMIT ${param(f.limit)}`, values);
      return { rows: r.rows.map(toRow), hiddenUpcoming: 0 };
    }
    // One row even when every task is upcoming: the page joins onto the count.
    const r = await c.query(
      `WITH base AS (SELECT ${ranked}, u.upcoming FROM ${from} WHERE ${where}),
            page AS (SELECT * FROM base WHERE NOT upcoming ${order} LIMIT ${param(f.limit)})
       SELECT page.*, h.hidden FROM (SELECT count(*) FILTER (WHERE upcoming)::int AS hidden FROM base) h
       LEFT JOIN page ON true ORDER BY page.rank_p DESC, page.rank_s DESC, page.id`,
      values,
    );
    return { rows: r.rows.filter(row => row.id != null).map(toRow), hiddenUpcoming: r.rows[0]?.hidden ?? 0 };
  });
}

export async function listTasks(pool: pg.Pool, username: string, f: TaskFilters): Promise<DocRow[]> {
  return (await queryTasks(pool, username, f, false)).rows;
}

/** listTasks, plus how many upcoming occurrences it left out. */
export async function listTasksCounted(pool: pg.Pool, username: string, f: TaskFilters): Promise<{ rows: DocRow[]; hiddenUpcoming: number }> {
  return queryTasks(pool, username, f, true);
}

export async function getTask(pool: pg.Pool, username: string, id: string): Promise<DocRow | undefined> {
  return withUserTx(pool, username, async c => {
    const r = await c.query(`SELECT ${COLUMNS} FROM documents WHERE id = $1 AND metadata->>'type' = 'task' AND ${LOCAL_ONLY_SQL}`, [id]);
    return r.rows[0] ? toRow(r.rows[0]) : undefined;
  });
}

// ---------------------------------------------------------------- waiting

/** Upper bound on rows read per kind for the `waiting` tool. */
export const WAITING_MAX_ROWS = 5000;

/**
 * Decision and question memories (not archived) for the `waiting` tool. A
 * memory's `status` is its kind's status, not a task status, so it is not
 * filtered here: buildWaiting applies the per-kind open statuses (and the
 * kind defaults when status is absent), as core does.
 */
export async function typedMemoriesForWaiting(pool: pg.Pool, username: string, collection?: string): Promise<DocRow[]> {
  return withUserTx(pool, username, async c => {
    const values: unknown[] = [WAITING_MAX_ROWS];
    let where = `metadata->>'type' = 'memory' AND metadata->>'kind' IN ('decision', 'question')
      AND COALESCE(metadata->>'archived', '') <> 'true' AND ${LOCAL_ONLY_SQL}`;
    if (collection !== undefined) {
      values.push(collection);
      where += ' AND collection = $2';
    }
    const r = await c.query(
      `SELECT ${COLUMNS} FROM documents WHERE ${where}
        ORDER BY updated_at, id
        LIMIT $1`,
      values,
    );
    return r.rows.map(toRow);
  });
}
