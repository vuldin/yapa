import pg from 'pg';
import { SYNC_DATABASE_URL, SYNC_SIMILARITY_THRESHOLD } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: SYNC_DATABASE_URL, max: 5 });
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
       content = EXCLUDED.content,
       embedding = EXCLUDED.embedding,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at,
       synced_at = now()`,
    [doc.id, doc.collection, doc.content, embeddingStr, JSON.stringify(doc.metadata), doc.origin_user, doc.created_at, doc.updated_at],
  );
}

/** Find documents similar to the given embedding in a collection. */
export async function findSimilarRemote(
  collection: string,
  embedding: number[],
  threshold: number = SYNC_SIMILARITY_THRESHOLD,
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

/** Get new documents from remote that were synced after a given timestamp and not by the local user. */
export async function getRemoteDocsSince(
  collection: string,
  sinceTimestamp: number,
  excludeUser: string,
): Promise<RemoteDocument[]> {
  const p = getPool();
  const result = await p.query(
    `SELECT id, collection, content, embedding::text, metadata, origin_user, related_ids, synced_at, created_at, updated_at
     FROM documents
     WHERE collection = $1
       AND synced_at > to_timestamp($2)
       AND origin_user != $3
     ORDER BY synced_at ASC`,
    [collection, sinceTimestamp, excludeUser],
  );

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

/** Delete documents from remote by IDs. */
export async function deleteRemoteDocuments(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const p = getPool();
  const result = await p.query(
    'DELETE FROM documents WHERE id = ANY($1::text[])',
    [ids],
  );
  return result.rowCount ?? 0;
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
