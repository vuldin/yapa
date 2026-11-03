import { queryDocuments, queryAllCollections, updateDocument } from '../store/index.js';
import { getConfig } from '../config.js';
import { isSyncableCollection } from '../sync/syncable.js';
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
  /** Typed memories only: kind and/or status (memory/kinds.ts). */
  kind?: string;
  status?: string;
  include_promoted?: boolean;
  include_archived?: boolean;
  filters?: RecallFilters;
  /**
   * Count relevant hits as a "use" and boost their salience (default true).
   * Only hits closer than SALIENCE_BOOST_MAX_DISTANCE are boosted either way.
   */
  boost?: boolean;
  /**
   * With `collection` set, also return up to this many strongly relevant hits
   * from OTHER collections (closer than CROSS_COLLECTION_MAX_DISTANCE): the
   * fix for one customer's issue is often already known from another.
   * Results carry their `collection`. Default 0. Never drawn from
   * `private-*`/`local-*` collections (the recall fence, below).
   */
  crossCollection?: number;
}

/**
 * Recall fence: `private-*` and `local-*` collections never surface as
 * cross-collection extras in another scope. They are still searched when
 * they are the active `collection` (the caller named them), and a search
 * with no collection still covers them. `global` is not fenced: it is the
 * personal, cross-cutting scope every session draws on.
 */
function isFenced(collection: string | undefined): boolean {
  return !!collection && collection !== 'global' && !isSyncableCollection(collection);
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
  if (options.kind) filter.kind = options.kind;
  if (options.status) filter.status = options.status;

  let results: RecallResult[];

  if (options.collection) {
    const docs = await queryDocuments(options.collection, query, nResults, filter);
    results = docs.map(d => ({ ...d, collection: options.collection }));
    const extra = options.crossCollection ?? 0;
    if (extra > 0) {
      const maxDistance = getConfig().CROSS_COLLECTION_MAX_DISTANCE;
      // Over-fetch: the scope's own hits and weak matches are dropped below.
      const others = (await queryAllCollections(query, nResults + extra * 4, filter).catch(() => []))
        .filter(r => r.collection !== options.collection && r.distance < maxDistance && r.metadata.archived !== true
          && !isFenced(r.collection))
        .slice(0, extra);
      results = [...results, ...others];
    }
  } else {
    // No collection: the caller asked to search everything, so private and
    // local collections are included. The fence only keeps them out of
    // another scope's cross-collection extras.
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

  // Boost salience for hits that were actually relevant. Surfacing a weak
  // match (e.g. the per-prompt hook's top 3 on an unrelated prompt) is not a
  // use, and boosting it fed a rich-get-richer loop: higher salience → ranked
  // higher → surfaced more → boosted more.
  const boostMaxDistance = getConfig().SALIENCE_BOOST_MAX_DISTANCE;
  for (const r of results) {
    if (options.boost === false || r.distance >= boostMaxDistance) continue;
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
