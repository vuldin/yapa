#!/usr/bin/env node
// Restore YAPA documents from remote Postgres into local ChromaDB.
//
// Why this exists: YAPA's normal pull sync excludes docs where
// origin_user = current user (postgres.ts:108) — by design, to avoid
// clobbering the local source of truth. That design breaks on
// disaster recovery when the local Chroma store is empty.
//
// This script bypasses the origin_user filter and reuses the stored
// pgvector embeddings (no re-embedding needed).
//
// Usage:
//   YAPA_SYNC_DATABASE_URL=postgres://... \
//   node migrate/restore_from_remote.mjs <collection> [<collection> ...]
//
// Or restore every collection found on remote:
//   node migrate/restore_from_remote.mjs --all

import pg from 'pg';

const CHROMA_URL = process.env.CHROMA_URL || 'http://localhost:8000';
const API_BASE = `${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database`;
const SYNC_URL = process.env.YAPA_SYNC_DATABASE_URL;

if (!SYNC_URL) {
  console.error('ERROR: YAPA_SYNC_DATABASE_URL env var is required');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node restore_from_remote.mjs <collection> [<collection> ...] | --all');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: SYNC_URL, max: 3 });

function toChroma(metadata) {
  const result = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) result[key] = value.join(',');
    else if (typeof value === 'object') result[key] = JSON.stringify(value);
    else result[key] = value;
  }
  return result;
}

function parseEmbedding(s) {
  return JSON.parse(s);
}

async function chroma(path, init) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${init?.method || 'GET'} ${path}: ${body}`);
  }
  return res;
}

async function getOrCreateCollection(name) {
  const list = await (await chroma('/collections')).json();
  const found = list.find((c) => c.name === name);
  if (found) return found.id;
  await chroma('/collections', {
    method: 'POST',
    body: JSON.stringify({ name, metadata: { created: new Date().toISOString() } }),
  });
  const relist = await (await chroma('/collections')).json();
  return relist.find((c) => c.name === name).id;
}

async function existingIds(collectionId, ids) {
  const res = await chroma(`/collections/${collectionId}/get`, {
    method: 'POST',
    body: JSON.stringify({ ids, include: [] }),
  });
  const data = await res.json();
  return new Set(data.ids || []);
}

async function upsertBatch(collectionId, rows) {
  if (rows.length === 0) return;
  const body = {
    ids: rows.map((r) => r.id),
    documents: rows.map((r) => r.content),
    embeddings: rows.map((r) => r.embedding),
    metadatas: rows.map((r) => toChroma({
      ...r.metadata,
      origin_user: r.origin_user,
      related_ids: r.related_ids,
      is_synced: true,
    })),
  };
  await chroma(`/collections/${collectionId}/upsert`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function resolveCollections() {
  if (args[0] === '--all') {
    const res = await pool.query(
      'SELECT collection, COUNT(*) AS count FROM documents GROUP BY collection ORDER BY collection',
    );
    return res.rows.map((r) => ({ name: r.collection, remoteCount: parseInt(r.count, 10) }));
  }
  const names = args;
  const res = await pool.query(
    'SELECT collection, COUNT(*) AS count FROM documents WHERE collection = ANY($1::text[]) GROUP BY collection',
    [names],
  );
  const counts = new Map(res.rows.map((r) => [r.collection, parseInt(r.count, 10)]));
  return names.map((n) => ({ name: n, remoteCount: counts.get(n) ?? 0 }));
}

async function restoreCollection(name) {
  const collectionId = await getOrCreateCollection(name);
  const res = await pool.query(
    `SELECT id, collection, content, embedding::text AS embedding_text,
            metadata, origin_user, related_ids, created_at, updated_at
       FROM documents
      WHERE collection = $1
      ORDER BY created_at ASC`,
    [name],
  );
  const rows = res.rows.map((r) => ({
    id: r.id,
    content: r.content,
    embedding: parseEmbedding(r.embedding_text),
    metadata: r.metadata || {},
    origin_user: r.origin_user,
    related_ids: r.related_ids || [],
  }));

  const ids = rows.map((r) => r.id);
  const already = ids.length ? await existingIds(collectionId, ids) : new Set();
  const toInsert = rows.filter((r) => !already.has(r.id));

  const BATCH = 50;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    await upsertBatch(collectionId, toInsert.slice(i, i + BATCH));
  }

  return { fetched: rows.length, restored: toInsert.length, skipped: rows.length - toInsert.length };
}

async function main() {
  const cols = await resolveCollections();
  if (cols.length === 0) {
    console.error('No matching collections on remote.');
    process.exit(1);
  }

  console.log(`Restoring from ${SYNC_URL.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`Target Chroma: ${CHROMA_URL}`);
  console.log(`Collections: ${cols.map((c) => `${c.name} (${c.remoteCount})`).join(', ')}\n`);

  let totalRestored = 0;
  let totalSkipped = 0;
  for (const { name } of cols) {
    process.stdout.write(`${name}: `);
    try {
      const { fetched, restored, skipped } = await restoreCollection(name);
      console.log(`fetched ${fetched}, restored ${restored}, skipped ${skipped}`);
      totalRestored += restored;
      totalSkipped += skipped;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }

  console.log(`\nDone. Restored ${totalRestored}, skipped ${totalSkipped}.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
