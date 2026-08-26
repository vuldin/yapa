/**
 * Janitor sweep: heals contradiction/duplicate backlog that predates (or
 * bypasses) the capture-time resolver. Scans each collection for
 * near-duplicate PAIRS of non-archived memories and runs the conservative
 * resolver over each pair:
 *
 *   skip      → the pair is the same fact; the LOWER-salience one is archived
 *               as a duplicate_of the other (no information lost)
 *   supersede → one clearly updates the other; a merged memory is stored and
 *               the stale one archived (superseded_by)
 *   add       → distinct facts that merely embed similarly; left alone
 *
 * Bounds: at most `maxPairs` resolutions per run, pairs ordered by ascending
 * distance (most-likely-duplicates first). Fail-open per pair: a resolver
 * error skips that pair and keeps both.
 *
 * @module yapa/curation/janitor
 */
import { getConfig } from '../config.js';
import { getDocumentsByFilter, getDocumentsByIds, listCollections, queryDocuments, updateDocument } from '../store/index.js';
import { storeMemory } from '../memory/store.js';
import { resolveConflict, RESOLVER_PROMPT_VERSION, type ResolverNeighbor } from './resolver.js';
import type { HostLLMCaller } from './provider.js';

export interface JanitorStats {
  collectionsScanned: number;
  pairsConsidered: number;
  skippedDuplicates: number;
  superseded: number;
  keptDistinct: number;
  errors: number;
}

export interface JanitorOptions {
  /** Hard cap on resolver calls this run. */
  maxPairs?: number;
  /** Pair distance ceiling — pairs beyond this are never presented. */
  distanceThreshold?: number;
  /** Optional injected LLM call for testing. */
  call?: HostLLMCaller;
  /** Restrict to one collection (default: all). */
  collection?: string;
}

interface Pair {
  collection: string;
  a: { id: string; content: string; metadata: Record<string, any> };
  b: ResolverNeighbor;
  distance: number;
}

/**
 * Find near-duplicate pairs within a collection. Each memory queries its own
 * neighborhood; pairs are deduped (a-b == b-a) and self-matches dropped.
 * Note this is O(N × k) store queries — fine at personal-memory scale, and
 * bounded by maxPairs at resolution time.
 */
export async function findDuplicatePairs(
  collection: string,
  distanceThreshold: number,
): Promise<Pair[]> {
  const all = (await getDocumentsByFilter(collection, { type: 'memory' }, 10000))
    .filter(d => d.metadata.archived !== true);

  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const doc of all) {
    const neighbors = await queryDocuments(collection, doc.content, 4, { type: 'memory' })
      .catch(() => []);
    for (const n of neighbors) {
      if (n.id === doc.id || n.distance >= distanceThreshold) continue;
      if (n.metadata?.archived === true) continue;
      const key = [doc.id, n.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        collection,
        a: { id: doc.id, content: doc.content, metadata: doc.metadata },
        b: { id: n.id, content: n.content, distance: n.distance, salience: n.metadata?.salience },
        distance: n.distance,
      });
    }
  }
  return pairs.sort((x, y) => x.distance - y.distance);
}

/** Archive `loserId` as a duplicate of `winnerId` (metadata-only, reversible). */
async function archiveDuplicate(collection: string, loserId: string, winnerId: string): Promise<void> {
  const existing = await getDocumentsByIds(collection, [loserId]);
  if (!existing.length) return;
  await updateDocument(collection, loserId, {
    ...existing[0].metadata,
    archived: true,
    duplicate_of: winnerId,
  });
}

/**
 * Run one janitor sweep. Returns stats; never throws per-pair failures
 * upward (counted in stats.errors).
 */
export async function janitorSweep(options: JanitorOptions = {}): Promise<JanitorStats> {
  const stats: JanitorStats = {
    collectionsScanned: 0,
    pairsConsidered: 0,
    skippedDuplicates: 0,
    superseded: 0,
    keptDistinct: 0,
    errors: 0,
  };
  const maxPairs = options.maxPairs ?? 20;
  const threshold = options.distanceThreshold ?? getConfig().CONTRADICTION_DISTANCE_THRESHOLD;

  const collections = options.collection
    ? [options.collection]
    : (await listCollections().catch(() => [])).map(c => c.name);

  for (const collection of collections) {
    if (stats.pairsConsidered >= maxPairs) break;
    let pairs: Pair[];
    try {
      pairs = await findDuplicatePairs(collection, threshold);
      stats.collectionsScanned++;
    } catch (e) {
      process.stderr.write(`[yapa-janitor] scan failed for ${collection}: ${e}\n`);
      stats.errors++;
      continue;
    }

    for (const pair of pairs) {
      if (stats.pairsConsidered >= maxPairs) break;
      stats.pairsConsidered++;
      try {
        // The resolver's candidate/neighbor framing: treat the higher-salience
        // (usually older, more-established) memory as the neighbor under
        // review and the other as the candidate. Conservative bias applies
        // either way.
        const [candidate, neighbor] =
          (pair.a.metadata.salience ?? 1) >= (pair.b.salience ?? 1)
            ? [{ id: pair.b.id, content: pair.b.content }, { id: pair.a.id, content: pair.a.content, distance: pair.distance, salience: pair.a.metadata.salience }]
            : [{ id: pair.a.id, content: pair.a.content }, { id: pair.b.id, content: pair.b.content, distance: pair.distance, salience: pair.b.salience }];

        const decision = await resolveConflict(
          candidate.content,
          [neighbor],
          options.call ? { call: options.call } : {},
        );

        if (decision.action === 'skip') {
          // Same fact twice: retire the lower-salience candidate as duplicate.
          await archiveDuplicate(collection, candidate.id, neighbor.id);
          stats.skippedDuplicates++;
        } else if (decision.action === 'supersede') {
          // Resolver targets one of the pair; store merged content and let
          // storeMemory archive the stale side.
          const target = decision.targetId === candidate.id ? candidate : neighbor;
          const other = decision.targetId === candidate.id ? neighbor : candidate;
          await storeMemory(decision.mergedContent ?? candidate.content, {
            collection,
            salience: Math.max(pair.a.metadata.salience ?? 1, pair.b.salience ?? 1),
            tags: ['janitor-merged'],
            sector: 'semantic',
            supersedes: target.id,
            metadata: {
              source: 'janitor',
              resolver_prompt_version: RESOLVER_PROMPT_VERSION,
              rationale: decision.rationale,
              related_to: other.id,
            },
          });
          stats.superseded++;
        } else {
          stats.keptDistinct++;
        }
      } catch (e) {
        process.stderr.write(`[yapa-janitor] pair resolution failed in ${collection}: ${e}\n`);
        stats.errors++;
      }
    }
  }

  if (stats.pairsConsidered > 0) {
    process.stderr.write(
      `[yapa-janitor] sweep: ${stats.pairsConsidered} pairs — `
      + `${stats.skippedDuplicates} duplicates archived, ${stats.superseded} superseded, `
      + `${stats.keptDistinct} kept distinct, ${stats.errors} error(s)\n`,
    );
  }
  return stats;
}
