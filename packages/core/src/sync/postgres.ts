import { getConfig } from '../config.js';
import pg from 'pg';


const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getConfig().SYNC_DATABASE_URL, max: 5 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export interface RemoteDocument {
  id: string;
  collection: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  origin_user: string;
  related_ids: string[];
  synced_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** Insert or update a document in the remote database. */
export async function upsertRemoteDocument(doc: {
  id: string;
  collection: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  origin_user: string;
  created_at: number;
  updated_at: number;
}): Promise<void> {
  const p = getPool();
  const embeddingStr = `[${doc.embedding.join(',')}]`;

  await p.query(
    `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at)
     VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, to_timestamp($7), to_timestamp($8))
     ON CONFLICT (id) DO UPDATE SET
       collection = EXCLUDED.collection,
       content = EXCLUDED.content,
       embedding = EXCLUDED.embedding,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at,
       synced_at = now()`,
    [doc.id, doc.collection, doc.content, embeddingStr, JSON.stringify(doc.metadata), doc.origin_user, doc.created_at, doc.updated_at],
  );
}

/** created_at (unix seconds) of the remote row with this id, or undefined if none. */
export async function getRemoteCreatedAt(id: string): Promise<number | undefined> {
  const p = getPool();
  const result = await p.query('SELECT extract(epoch from created_at)::bigint AS c FROM documents WHERE id = $1', [id]);
  return result.rows[0] ? Number(result.rows[0].c) : undefined;
}

/** Remote collection currently holding each of these ids (ids absent remotely are omitted). */
export async function getRemoteCollectionsByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const p = getPool();
  const result = await p.query('SELECT id, collection FROM documents WHERE id = ANY($1::text[])', [ids]);
  return new Map(result.rows.map(r => [r.id as string, r.collection as string]));
}

/** Highest `<user>-<n>` task number on the remote for this user (0 if none). */
export async function getRemoteMaxTaskNumber(user: string): Promise<number> {
  const p = getPool();
  const result = await p.query(
    `SELECT COALESCE(MAX(substring(id from $2)::bigint), 0) AS n FROM documents WHERE id ~ $1`,
    [`^${user.replace(/[^A-Za-z0-9_-]/g, '')}-[0-9]+$`, `^${user.replace(/[^A-Za-z0-9_-]/g, '')}-([0-9]+)$`],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Find documents similar to the given embedding in a collection. */
export async function findSimilarRemote(
  collection: string,
  embedding: number[],
  threshold: number = getConfig().SYNC_SIMILARITY_THRESHOLD,
): Promise<Array<{ id: string; similarity: number }>> {
  const p = getPool();
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await p.query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
     FROM documents
     WHERE collection = $2
       AND 1 - (embedding <=> $1::vector) > $3
     ORDER BY similarity DESC
     LIMIT 5`,
    [embeddingStr, collection, threshold],
  );

  return result.rows.map(r => ({ id: r.id, similarity: parseFloat(r.similarity) }));
}

/** Add related_ids to a remote document. */
export async function addRemoteRelatedIds(id: string, newRelatedIds: string[]): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE documents
     SET related_ids = array_cat(related_ids, $1::text[]),
         synced_at = now()
     WHERE id = $2`,
    [newRelatedIds, id],
  );
}

/** Who is pulling: rows last written by this user+device are this device's own echoes. */
export interface PullIdentity {
  user: string;
  device: string;
}

export interface RemoteDocsQuery {
  /** Only rows originally written by this user (personal collections, e.g. `global`). */
  onlyOwnRows?: boolean;
  /**
   * Also return rows this device wrote (normally skipped as echoes). Used once,
   * by a store's first-ever pull, to rebuild a wiped or brand-new store.
   */
  includeOwnDevice?: boolean;
}

/**
 * Build the pull query. Skips this device's own writes (`origin_device` is the
 * LAST writer's device) and legacy rows from this user that predate device
 * stamping (they came from this install before the upgrade). Everything else,
 * including this user's rows from other devices, is returned.
 */
export function buildRemoteDocsSinceQuery(
  collection: string,
  sinceTimestamp: number,
  self: PullIdentity,
  opts: RemoteDocsQuery = {},
): { text: string; values: unknown[] } {
  // Bind only the parameters the final SQL references: Postgres rejects a
  // query whose bind count differs from its placeholders.
  const values: unknown[] = [collection, sinceTimestamp];
  const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
  let text = `SELECT id, collection, content, embedding::text, metadata, origin_user, related_ids, synced_at, created_at, updated_at
     FROM documents
     WHERE collection = $1
       AND synced_at > to_timestamp($2)`;
  let userParam: string | undefined;
  if (!opts.includeOwnDevice) {
    userParam = param(self.user);
    const deviceParam = param(self.device);
    text += `
       AND COALESCE(metadata->>'origin_device', '') <> ${deviceParam}
       AND NOT (origin_user = ${userParam} AND metadata->>'origin_device' IS NULL)`;
  }
  if (opts.onlyOwnRows) text += `\n       AND origin_user = ${userParam ?? param(self.user)}`;
  text += `\n     ORDER BY synced_at ASC`;
  return { text, values };
}

/** Get remote documents synced after a timestamp, minus this device's own writes. */
export async function getRemoteDocsSince(
  collection: string,
  sinceTimestamp: number,
  self: PullIdentity,
  opts: RemoteDocsQuery = {},
): Promise<RemoteDocument[]> {
  const p = getPool();
  const query = buildRemoteDocsSinceQuery(collection, sinceTimestamp, self, opts);
  const result = await p.query(query.text, query.values);

  return result.rows.map(r => ({
    id: r.id,
    collection: r.collection,
    content: r.content,
    embedding: parseEmbedding(r.embedding),
    metadata: r.metadata,
    origin_user: r.origin_user,
    related_ids: r.related_ids ?? [],
    synced_at: r.synced_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/**
 * Delete documents from remote by IDs — only rows `owner` originally wrote.
 * Forgetting a teammate's memory is a local decision (see deletes.ts
 * tombstones); it must never remove the shared row for everyone.
 */
export async function deleteRemoteDocuments(ids: string[], owner: string): Promise<number> {
  if (ids.length === 0) return 0;
  const p = getPool();
  const result = await p.query(
    'DELETE FROM documents WHERE id = ANY($1::text[]) AND origin_user = $2',
    [ids, owner],
  );
  return result.rowCount ?? 0;
}

/** Remote collections holding rows this user wrote (recovery: what to re-subscribe). */
export async function getRemoteCollectionsForUser(user: string): Promise<string[]> {
  const p = getPool();
  const result = await p.query('SELECT DISTINCT collection FROM documents WHERE origin_user = $1 ORDER BY collection', [user]);
  return result.rows.map(r => r.collection);
}

/** Get distinct collection names (with doc counts) from the remote database. */
export async function getRemoteCollections(): Promise<Array<{ name: string; count: number }>> {
  const p = getPool();
  const result = await p.query(
    'SELECT collection, COUNT(*) AS count FROM documents GROUP BY collection ORDER BY collection',
  );
  return result.rows.map(r => ({ name: r.collection, count: parseInt(r.count, 10) }));
}

/** Check if the remote database is reachable and has the correct schema. */
export async function checkRemoteHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = getPool();
    const result = await p.query('SELECT 1 FROM schema_version LIMIT 1');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function parseEmbedding(embeddingStr: string): number[] {
  // pgvector returns embeddings as "[0.1,0.2,...]"
  return JSON.parse(embeddingStr);
}
