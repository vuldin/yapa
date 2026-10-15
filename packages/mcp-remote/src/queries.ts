/**
 * Read-only SQL for the MCP tools (schema v2, infra/cloudsql/sql/). Narrow
 * additions next to yapa-service's store.ts, which stays untouched; pulls and
 * collection counts reuse store.ts directly. Everything runs inside
 * withUserTx, so the yapa-mcp role's RLS policy (05_mcp_runtime.sql) applies
 * on top of the filters here.
 */
import type pg from 'pg';
import { ApiError, toPgVector, withUserTx } from '@yapa/service/lib';

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
}

export async function vectorSearch(pool: pg.Pool, username: string, p: VectorSearch): Promise<DocRow[]> {
  return withUserTx(pool, username, async c => {
    await c.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(EF_SEARCH)]);
    const values: unknown[] = [toPgVector(p.embedding), p.type];
    const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
    let where = `metadata->>'type' = $2 AND ${LOCAL_ONLY_SQL}`;
    if (p.type === 'memory') where += ` AND ${ACTIVE_SQL}`;
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
export async function recentMemories(pool: pg.Pool, username: string, collection: string, embedding: number[], limit: number): Promise<DocRow[]> {
  return withUserTx(pool, username, async c => {
    const r = await c.query(
      `SELECT ${COLUMNS}, embedding <=> $1::vector AS distance
         FROM documents
        WHERE collection = $2 AND metadata->>'type' = 'memory' AND ${ACTIVE_SQL} AND ${LOCAL_ONLY_SQL}
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
  limit: number;
}

const PRIORITY_RANK = "CASE metadata->>'priority' WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";

/** Sorted like core's listTasks: priority desc, then salience desc. */
export async function listTasks(pool: pg.Pool, username: string, f: TaskFilters): Promise<DocRow[]> {
  return withUserTx(pool, username, async c => {
    const values: unknown[] = [];
    const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
    let where = `metadata->>'type' = 'task' AND ${LOCAL_ONLY_SQL}`;
    if (f.collection !== undefined) where += ` AND collection = ${param(f.collection)}`;
    if (f.status !== undefined) where += ` AND metadata->>'status' = ${param(f.status)}`;
    if (f.priority !== undefined) where += ` AND metadata->>'priority' = ${param(f.priority)}`;
    if (!f.includeComplete && f.status !== 'complete') where += " AND COALESCE(metadata->>'status', '') <> 'complete'";
    const r = await c.query(
      `SELECT ${COLUMNS} FROM documents WHERE ${where}
        ORDER BY ${PRIORITY_RANK} DESC,
                 CASE WHEN jsonb_typeof(metadata->'salience') = 'number' THEN (metadata->>'salience')::float8 ELSE 0 END DESC,
                 id
        LIMIT ${param(f.limit)}`,
      values,
    );
    return r.rows.map(toRow);
  });
}

export async function getTask(pool: pg.Pool, username: string, id: string): Promise<DocRow | undefined> {
  return withUserTx(pool, username, async c => {
    const r = await c.query(`SELECT ${COLUMNS} FROM documents WHERE id = $1 AND metadata->>'type' = 'task' AND ${LOCAL_ONLY_SQL}`, [id]);
    return r.rows[0] ? toRow(r.rows[0]) : undefined;
  });
}
