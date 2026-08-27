import { getDocumentsByFilter, listCollections, type DocumentResult } from '../store/index.js';
import {
  passesPromotedFilter,
  passesScoreFilters,
  type RecallFilters,
} from './filters.js';

export interface ListOptions {
  collection?: string;
  tags?: string[];
  sector?: 'semantic' | 'episodic';
  limit?: number;
  include_promoted?: boolean;
  include_archived?: boolean;
  filters?: RecallFilters;
}

export interface ListResult extends DocumentResult {
  collection: string;
}

/**
 * List memories with optional metadata filters.
 * If no collection specified, lists from all collections.
 *
 * `promoted_to` memories are excluded by default; memories in the intermediate
 * `selected_for` state remain visible. Optional range filters on classifier
 * scores are applied conjunctively.
 */
export async function listMemories(options: ListOptions = {}): Promise<ListResult[]> {
  const limit = options.limit ?? 50;
  const includePromoted = options.include_promoted ?? false;
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
    filtered = filtered.filter(r => {
      const docTags: string[] = Array.isArray(r.metadata.tags)
        ? r.metadata.tags
        : (r.metadata.tags ?? '').split(',').filter(Boolean);
      return options.tags!.some(t => docTags.includes(t));
    });
  }

  // Phase 0: exclude promoted memories by default, apply optional range filters
  const includeArchived = options.include_archived ?? false;
  filtered = filtered.filter(r =>
    passesPromotedFilter(r.metadata, includePromoted) &&
    passesScoreFilters(r.metadata, options.filters) &&
    (includeArchived || r.metadata.archived !== true),
  );

  // Sort by salience descending (same as before)
  return filtered
    .sort((a, b) => (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0))
    .slice(0, limit);
}
