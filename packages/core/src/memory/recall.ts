import { queryDocuments, queryAllCollections, updateDocument } from '../store/index.js';
import { touchDocument, type LifecycleMetadata } from '../lifecycle.js';
import {
  passesPromotedFilter,
  passesScoreFilters,
  rankScore,
  type RecallFilters,
} from './filters.js';

export interface RecallOptions {
  collection?: string;
  nResults?: number;
  tags?: string[];
  include_promoted?: boolean;
  include_archived?: boolean;
  filters?: RecallFilters;
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
 *
 * Ranking combines vector distance with salience (higher salience ranks better)
 * via a configurable weight. `promoted_to` memories are excluded by default.
 * Memories in the intermediate `selected_for` state remain visible.
 */
export async function recallMemory(
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult[]> {
  const nResults = options.nResults ?? 5;
  const includePromoted = options.include_promoted ?? false;
  const filter: Record<string, any> = { type: 'memory' };

  let results: RecallResult[];

  if (options.collection) {
    const docs = await queryDocuments(options.collection, query, nResults, filter);
    results = docs.map(d => ({ ...d, collection: options.collection }));
  } else {
    const docs = await queryAllCollections(query, nResults, filter);
    results = docs;
  }

  // Client-side tag filter (ChromaDB can't match comma-separated tag strings natively)
  if (options.tags?.length) {
    results = results.filter(r => {
      const docTags: string[] = Array.isArray(r.metadata.tags)
        ? r.metadata.tags
        : (r.metadata.tags ?? '').split(',').filter(Boolean);
      return options.tags!.some(t => docTags.includes(t));
    });
  }

  // Phase 0: exclude promoted memories by default, apply optional range filters
  const includeArchived = options.include_archived ?? false;
  results = results.filter(r =>
    passesPromotedFilter(r.metadata, includePromoted) &&
    passesScoreFilters(r.metadata, options.filters) &&
    (includeArchived || r.metadata.archived !== true),
  );

  // Phase 0: re-rank by combined (distance, salience) score
  results.sort((a, b) =>
    rankScore(a.distance, a.metadata.salience) - rankScore(b.distance, b.metadata.salience),
  );

  // Boost salience asynchronously for retrieved docs (preserves existing behavior)
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
