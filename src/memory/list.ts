import { getDocumentsByFilter, listCollections, type DocumentResult } from '../chroma.js';

export interface ListOptions {
  collection?: string;
  tags?: string[];
  sector?: 'semantic' | 'episodic';
  limit?: number;
}

export interface ListResult extends DocumentResult {
  collection: string;
}

/**
 * List memories with optional metadata filters.
 * If no collection specified, lists from all collections.
 */
export async function listMemories(options: ListOptions = {}): Promise<ListResult[]> {
  const limit = options.limit ?? 50;
  const filter: Record<string, any> = { type: 'memory' };
  if (options.sector) filter.sector = options.sector;

  const collectionNames = options.collection
    ? [options.collection]
    : (await listCollections()).map(c => c.name);

  const allResults: ListResult[] = [];

  for (const name of collectionNames) {
    try {
      const docs = await getDocumentsByFilter(name, filter, limit);
      for (const doc of docs) {
        allResults.push({ ...doc, collection: name });
      }
    } catch {
      continue;
    }
  }

  // Client-side tag filter
  let filtered = allResults;
  if (options.tags?.length) {
    filtered = allResults.filter(r => {
      const docTags: string[] = Array.isArray(r.metadata.tags)
        ? r.metadata.tags
        : (r.metadata.tags ?? '').split(',').filter(Boolean);
      return options.tags!.some(t => docTags.includes(t));
    });
  }

  // Sort by salience descending
  return filtered
    .sort((a, b) => (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0))
    .slice(0, limit);
}
