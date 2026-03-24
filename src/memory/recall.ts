import { queryDocuments, queryAllCollections, updateDocument, type QueryResult, type CrossCollectionResult } from '../chroma.js';
import { touchDocument, type LifecycleMetadata } from '../lifecycle.js';

export interface RecallOptions {
  collection?: string;
  nResults?: number;
  tags?: string[];
}

export interface RecallResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  distance: number;
  collection?: string;
}

/**
 * Semantic search for memories. Boosts salience on access.
 * If no collection specified, searches all collections.
 */
export async function recallMemory(
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult[]> {
  const nResults = options.nResults ?? 5;
  const filter: Record<string, any> = { type: 'memory' };
  if (options.tags?.length) {
    // ChromaDB doesn't support array contains natively on comma-separated strings,
    // so we filter client-side after retrieval
  }

  let results: RecallResult[];

  if (options.collection) {
    const docs = await queryDocuments(options.collection, query, nResults, filter);
    results = docs.map(d => ({ ...d, collection: options.collection }));
  } else {
    const docs = await queryAllCollections(query, nResults, filter);
    results = docs;
  }

  // Client-side tag filter
  if (options.tags?.length) {
    results = results.filter(r => {
      const docTags: string[] = Array.isArray(r.metadata.tags)
        ? r.metadata.tags
        : (r.metadata.tags ?? '').split(',').filter(Boolean);
      return options.tags!.some(t => docTags.includes(t));
    });
  }

  // Boost salience asynchronously for retrieved docs
  for (const r of results) {
    if (r.collection) {
      const lifecycleMeta: LifecycleMetadata = {
        salience: r.metadata.salience ?? 1.0,
        accessed_at: r.metadata.accessed_at ?? Math.floor(Date.now() / 1000),
        created_at: r.metadata.created_at ?? Math.floor(Date.now() / 1000),
        sector: r.metadata.sector ?? 'episodic',
      };
      const boosted = touchDocument(lifecycleMeta);
      updateDocument(r.collection, r.id, { ...r.metadata, ...boosted }).catch(() => {});
    }
  }

  return results;
}
