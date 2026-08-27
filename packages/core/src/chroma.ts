import { getConfig } from './config.js';
import { toChroma, fromChroma, type RawMetadata } from './metadata-adapter.js';
import { generateEmbedding, generateEmbeddingsBatch } from './embeddings.js';
import { touchDocument } from './lifecycle.js';

// Canonical document/result types live in the store port (store/types.ts);
// re-exported here for compatibility with long-standing import paths.
export type { Collection, DocumentResult, QueryResult, CrossCollectionResult } from './store/types.js';
import type { Collection, DocumentResult, QueryResult, CrossCollectionResult } from './store/types.js';

// Read at call time (not module scope) so a host can swap the active config.
function apiBase(): string {
  return `${getConfig().CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database`;
}

// ChromaDB Version Detection
export async function detectChromaVersion(): Promise<{version: string, isV2: boolean, error?: string}> {
  try {
    // First check if v2 API is available (most reliable method)
    const v2Heartbeat = await fetch(`${getConfig().CHROMA_URL}/api/v2/heartbeat`);
    if (!v2Heartbeat.ok) {
      // v2 not available, check if it's v1
      try {
        const v1Check = await fetch(`${getConfig().CHROMA_URL}/api/v1/heartbeat`);
        if (v1Check.ok) {
          return {
            version: '1.x (legacy)',
            isV2: false,
            error: 'ChromaDB v1 API detected. YAPA requires ChromaDB v2 API. Please upgrade ChromaDB to version 0.4.0 or higher (or 1.0.0+).'
          };
        }
      } catch {
        // v1 also not available
      }
      return {
        version: 'unknown',
        isV2: false,
        error: 'ChromaDB is not responding. Ensure ChromaDB is running at ' + getConfig().CHROMA_URL
      };
    }
    
    // v2 API is available, get version for informational purposes
    let version = 'unknown';
    try {
      const versionResp = await fetch(`${getConfig().CHROMA_URL}/api/v2/version`);
      if (versionResp.ok) {
        const data = await versionResp.json();
        version = data.version || 'unknown';
      }
    } catch {
      // Version endpoint might not be available in some v2 builds
    }
    
    // If we can reach v2 API, we're compatible regardless of version number
    // ChromaDB changed from 0.x.x to 1.x.x versioning while keeping v2 API
    return { version, isV2: true };
  } catch (e) {
    return {
      version: 'unreachable',
      isV2: false,
      error: `Cannot connect to ChromaDB at ${getConfig().CHROMA_URL}. Ensure ChromaDB is running.`
    };
  }
}

// Build ChromaDB v2 compatible filter
function buildChromaFilter(filter: Record<string, any>): Record<string, any> {
  const entries = Object.entries(filter).filter(([_, v]) => v !== undefined && v !== null);
  
  if (entries.length === 0) return {};
  if (entries.length === 1) {
    // Single condition doesn't need $and
    const [key, value] = entries[0];
    return { [key]: value };
  }
  
  // Multiple conditions need $and operator for ChromaDB v2
  return {
    $and: entries.map(([key, value]) => ({ [key]: value }))
  };
}

// Cache collection name -> ID mapping
const collectionIdCache = new Map<string, string>();

async function chromaFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  return response;
}

/** Get collection UUID by name (cached). */
export async function getCollectionId(name: string): Promise<string> {
  if (collectionIdCache.has(name)) {
    return collectionIdCache.get(name)!;
  }

  const response = await chromaFetch('/collections');
  if (!response.ok) throw new Error(`Failed to list collections: ${response.status}`);

  const collections: Collection[] = await response.json();
  const match = collections.find(c => c.name === name);
  if (!match) throw new Error(`Collection '${name}' not found`);

  collectionIdCache.set(name, match.id);
  return match.id;
}

/** Get collection ID, creating the collection if it doesn't exist. */
export async function getOrCreateCollection(name: string): Promise<string> {
  try {
    return await getCollectionId(name);
  } catch {
    await createCollection(name);
    // Clear cache to force fresh lookup
    collectionIdCache.delete(name);
    return await getCollectionId(name);
  }
}

/** Add or upsert a single document. */
export async function addDocument(
  collectionName: string,
  id: string,
  content: string,
  metadata: Record<string, any>,
): Promise<void> {
  const collectionId = await getOrCreateCollection(collectionName);
  const embedding = await generateEmbedding(content);
  const adaptedMetadata = toChroma(metadata);

  const body: Record<string, any> = {
    ids: [id],
    documents: [content],
    metadatas: [adaptedMetadata],
  };
  if (embedding) body.embeddings = [embedding];

  const response = await chromaFetch(`/collections/${collectionId}/upsert`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to add document: ${response.status} - ${await response.text()}`);
  }
}

/** Add multiple documents in batch. */
export async function addDocumentsBatch(
  collectionName: string,
  documents: Array<{ id: string; content: string; metadata: Record<string, any> }>,
): Promise<void> {
  const collectionId = await getOrCreateCollection(collectionName);
  const embeddings = await generateEmbeddingsBatch(documents.map(d => d.content));
  const adaptedMetadatas = documents.map(d => toChroma(d.metadata));

  const body: Record<string, any> = {
    ids: documents.map(d => d.id),
    documents: documents.map(d => d.content),
    metadatas: adaptedMetadatas,
  };
  if (embeddings) body.embeddings = embeddings;

  const response = await chromaFetch(`/collections/${collectionId}/upsert`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to add documents batch: ${response.status} - ${await response.text()}`);
  }
}

/** Query documents by semantic similarity. Automatically boosts salience for retrieved docs. */
export async function queryDocuments(
  collectionName: string,
  queryText: string,
  nResults: number = 5,
  filter?: Record<string, any>,
): Promise<QueryResult[]> {
  const collectionId = await getCollectionId(collectionName);
  const embedding = await generateEmbedding(queryText);

  const body: Record<string, any> = {
    n_results: nResults,
    include: ['documents', 'metadatas', 'distances'],
  };

  if (embedding) {
    body.query_embeddings = [embedding];
  } else {
    // ChromaDB server-side: pass query text for server to embed
    body.query_texts = [queryText];
  }

  if (filter) {
    const where = buildChromaFilter(filter);
    if (Object.keys(where).length > 0) body.where = where;
  }

  const response = await chromaFetch(`/collections/${collectionId}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Query failed: ${response.status} - ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.ids[0]?.length) return [];

  return data.ids[0].map((id: string, i: number) => {
    const metadata = fromChroma(data.metadatas[0][i]);
    const lifecycleMeta = {
      salience: metadata.salience ?? 1.0,
      accessed_at: metadata.accessed_at ?? Math.floor(Date.now() / 1000),
      created_at: metadata.created_at ?? Math.floor(Date.now() / 1000),
      sector: metadata.sector ?? 'episodic',
    };
    return {
      id,
      content: data.documents[0][i],
      metadata: { ...metadata, ...touchDocument(lifecycleMeta) },
      distance: data.distances[0][i],
    };
  });
}

/** Get documents by metadata filter (no semantic search). */
export async function getDocumentsByFilter(
  collectionName: string,
  filter: Record<string, any>,
  limit: number = 100,
): Promise<DocumentResult[]> {
  const collectionId = await getCollectionId(collectionName);

  const body: Record<string, any> = {
    limit,
    include: ['documents', 'metadatas'],
  };
  const where = buildChromaFilter(filter);
  // ChromaDB v2 rejects an empty where clause — omit it to fetch all documents.
  if (Object.keys(where).length > 0) body.where = where;

  const response = await chromaFetch(`/collections/${collectionId}/get`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Get by filter failed: ${response.status} - ${await response.text()}`);
  }

  const data = await response.json();
  return data.ids.map((id: string, i: number) => ({
    id,
    content: data.documents[i],
    metadata: fromChroma(data.metadatas[i]),
  }));
}

/** Get documents by IDs. */
export async function getDocumentsByIds(
  collectionName: string,
  ids: string[],
): Promise<DocumentResult[]> {
  const collectionId = await getCollectionId(collectionName);

  const response = await chromaFetch(`/collections/${collectionId}/get`, {
    method: 'POST',
    body: JSON.stringify({
      ids,
      include: ['documents', 'metadatas'],
    }),
  });

  if (!response.ok) {
    throw new Error(`Get by IDs failed: ${response.status} - ${await response.text()}`);
  }

  const data = await response.json();
  return data.ids.map((id: string, i: number) => ({
    id,
    content: data.documents[i],
    metadata: fromChroma(data.metadatas[i]),
  }));
}

/** Update document metadata. */
export async function updateDocument(
  collectionName: string,
  id: string,
  metadata: Record<string, any>,
): Promise<void> {
  const collectionId = await getCollectionId(collectionName);

  const response = await chromaFetch(`/collections/${collectionId}/update`, {
    method: 'POST',
    body: JSON.stringify({
      ids: [id],
      metadatas: [toChroma(metadata)],
    }),
  });

  if (!response.ok) {
    throw new Error(`Update failed: ${response.status} - ${await response.text()}`);
  }
}

/** Batch metadata replacement in a single request. */
export async function updateDocumentsBatch(
  collectionName: string,
  entries: Array<{ id: string; metadata: Record<string, any> }>,
): Promise<void> {
  if (entries.length === 0) return;
  const collectionId = await getCollectionId(collectionName);

  const response = await chromaFetch(`/collections/${collectionId}/update`, {
    method: 'POST',
    body: JSON.stringify({
      ids: entries.map(e => e.id),
      metadatas: entries.map(e => toChroma(e.metadata)),
    }),
  });

  if (!response.ok) {
    throw new Error(`Batch update failed: ${response.status} - ${await response.text()}`);
  }
}

/** Delete a document by ID. */
export async function deleteDocument(collectionName: string, id: string): Promise<void> {
  const collectionId = await getCollectionId(collectionName);

  const response = await chromaFetch(`/collections/${collectionId}/delete`, {
    method: 'POST',
    body: JSON.stringify({ ids: [id] }),
  });

  if (!response.ok) {
    throw new Error(`Failed to delete document: ${response.status} - ${await response.text()}`);
  }
}

/** List all collections. */
export async function listCollections(): Promise<Collection[]> {
  const response = await chromaFetch('/collections');
  if (!response.ok) throw new Error(`Failed to list collections: ${response.status}`);
  return await response.json();
}

/**
 * Create a new collection. Collections are pinned to **cosine** vector space:
 * yapa's salience-weighted ranking and contradiction thresholds are tuned for
 * cosine distances in [0, 2], while the server default (L2) produces larger
 * magnitudes that silently break those thresholds.
 */
export async function createCollection(
  name: string,
  metadata: Record<string, any> = { created: new Date().toISOString() },
): Promise<void> {
  const response = await chromaFetch('/collections', {
    method: 'POST',
    body: JSON.stringify({
      name,
      metadata: toChroma(metadata),
      configuration: { hnsw: { space: 'cosine' } },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create collection: ${response.status} - ${await response.text()}`);
  }

  // Clear cache since we have a new collection
  collectionIdCache.delete(name);
}

/** Delete a collection by name. */
export async function deleteCollection(name: string): Promise<void> {
  // Chroma v2's bare `/collections/{x}` path resolves by NAME, not UUID,
  // even though sub-paths like `/collections/{x}/count` resolve by UUID.
  const response = await chromaFetch(`/collections/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(`Failed to delete collection: ${response.status} - ${await response.text()}`);
  }

  collectionIdCache.delete(name);
}

/** Get collection document count. */
export async function getCollectionCount(name: string): Promise<number> {
  const collectionId = await getCollectionId(name);

  const response = await chromaFetch(`/collections/${collectionId}/count`, {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`Failed to get count: ${response.status}`);
  }

  return await response.json();
}

/** Query across all collections in parallel. */
export async function queryAllCollections(
  queryText: string,
  nResults: number = 5,
  filter?: Record<string, any>,
): Promise<CrossCollectionResult[]> {
  const collections = await listCollections();

  const allResults = await Promise.all(
    collections.map(async (collection) => {
      try {
        const results = await queryDocuments(collection.name, queryText, nResults, filter);
        return results.map(r => ({ ...r, collection: collection.name }));
      } catch {
        return [];
      }
    }),
  );

  return allResults
    .flat()
    .sort((a, b) => a.distance - b.distance)
    .slice(0, nResults);
}

/** Find a document across all collections and delete it. Returns the collection it was in. */
export async function findAndDeleteDocument(id: string): Promise<string> {
  const collections = await listCollections();

  for (const collection of collections) {
    try {
      const results = await getDocumentsByIds(collection.name, [id]);
      if (results.length > 0) {
        await deleteDocument(collection.name, id);
        return collection.name;
      }
    } catch {
      continue;
    }
  }

  throw new Error(`Document '${id}' not found in any collection`);
}
