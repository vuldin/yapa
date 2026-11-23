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
 * Only what automatic curation may touch is paired (memory/curatable.ts),
 * whole memories only (no chunks of long ones), and only your own memory is
 * ever archived or superseded: archiving syncs, so a teammate's stays theirs.
 * `since` limits the memories that look for neighbours to ones created or
 * changed after it, and `skipPairs` drops pairs already judged distinct.
 *
 * @module yapa/curation/janitor
 */
import { isOwnAuthor } from '../sync/backend.js';
import { isCuratable } from '../memory/curatable.js';
import { archivedMetadata } from '../memory/archive.js';
import { getConfig } from '../config.js';
import { getDocumentsByFilter, getDocumentsByIds, listCollections, metadataDelta, patchDocument, queryDocuments } from '../store/index.js';
import { storeMemory } from '../memory/store.js';
import { resolveConflict, RESOLVER_PROMPT_VERSION, type ResolverNeighbor } from './resolver.js';
import type { HostLLMCaller } from './provider.js';

export interface JanitorStats {
  collectionsScanned: number;
  pairsConsidered: number;
  skippedDuplicates: number;
  superseded: number;
  keptDistinct: number;
  /** Pairs left alone because the memory that would change is a teammate's. */
  skippedNotOwned: number;
  errors: number;
  /** Keys (pairKey) of the pairs judged distinct this run. */
  keptPairs: string[];
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
  /** Unix seconds: only memories created or changed after this look for neighbours. */
  since?: number;
  /** Memories per collection that look for neighbours, newest first (default 500). */
  maxScan?: number;
  /** Pair keys to leave out (judged distinct before). */
  skipPairs?: ReadonlySet<string>;
}

/** Order-independent key of a pair of memory ids. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

const pairable = (m: Record<string, any> | undefined | null) => !!m && isCuratable(m) && m.parent_id == null;
const changedAt = (m: Record<string, any>) => Math.max(Number(m.created_at) || 0, Number(m.updated_at) || 0);

interface Pair {
  collection: string;
  a: { id: string; content: string; metadata: Record<string, any> };
  b: ResolverNeighbor & { metadata: Record<string, any> };
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
  options: Pick<JanitorOptions, 'since' | 'maxScan' | 'skipPairs'> = {},
): Promise<Pair[]> {
  // Typed memories (findings, decisions, ...) are never merged: a merge
  // would change the id tasks wait on and drop the status. Nor are records
  // the remote owns (read_only), pinned memories or session summaries.
  const all = (await getDocumentsByFilter(collection, { type: 'memory' }, 10000))
    .filter(d => pairable(d.metadata))
    .filter(d => options.since === undefined || changedAt(d.metadata) > options.since)
    .sort((x, y) => changedAt(y.metadata) - changedAt(x.metadata))
    .slice(0, options.maxScan ?? 500);

  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const doc of all) {
    const neighbors = await queryDocuments(collection, doc.content, 4, { type: 'memory' })
      .catch(() => []);
    for (const n of neighbors) {
      if (n.id === doc.id || n.distance >= distanceThreshold || !pairable(n.metadata)) continue;
      // Neither side is ours: nothing this run could change.
      if (!isOwnAuthor(doc.metadata) && !isOwnAuthor(n.metadata)) continue;
      const key = pairKey(doc.id, n.id);
      if (seen.has(key) || options.skipPairs?.has(key)) continue;
      seen.add(key);
      pairs.push({
        collection,
        a: { id: doc.id, content: doc.content, metadata: doc.metadata },
        b: { id: n.id, content: n.content, distance: n.distance, salience: n.metadata?.salience, metadata: n.metadata ?? {} },
        distance: n.distance,
      });
    }
  }
  return pairs.sort((x, y) => x.distance - y.distance);
}

/** Archive `id` with the reason in `extra` (metadata-only, reversible). */
async function archiveAs(collection: string, id: string, extra: Record<string, any>): Promise<void> {
  const existing = await getDocumentsByIds(collection, [id]);
  if (!existing.length) return;
  await patchDocument(collection, id, metadataDelta(existing[0].metadata, archivedMetadata(existing[0].metadata, extra)));
}

/** Archive `loserId` as a duplicate of `winnerId`. */
const archiveDuplicate = (collection: string, loserId: string, winnerId: string) => archiveAs(collection, loserId, { duplicate_of: winnerId });

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
    skippedNotOwned: 0,
    errors: 0,
    keptPairs: [],
  };
  const maxPairs = options.maxPairs ?? 20;
  const threshold = options.distanceThreshold ?? getConfig().CONTRADICTION_DISTANCE_THRESHOLD;

  const collections = options.collection
    ? [options.collection]
    : (await listCollections().catch(() => [])).map(c => c.name);

  // Closest pairs first across every collection, so one large collection
  // doesn't take the whole budget while likelier duplicates wait elsewhere.
  const all: Pair[] = [];
  for (const collection of collections) {
    try {
      all.push(...await findDuplicatePairs(collection, threshold, options));
      stats.collectionsScanned++;
    } catch (e) {
      process.stderr.write(`[yapa-janitor] scan failed for ${collection}: ${e}\n`);
      stats.errors++;
    }
  }
  all.sort((x, y) => x.distance - y.distance);

  // A memory archived or replaced earlier in this run is out of later pairs.
  const changed = new Set<string>();
  for (const pair of all) {
    if (stats.pairsConsidered >= maxPairs) break;
    if (changed.has(pair.a.id) || changed.has(pair.b.id)) continue;
    const collection = pair.collection;
    stats.pairsConsidered++;
    try {
      // The resolver's candidate/neighbor framing: treat the higher-salience
      // (usually older, more-established) memory as the neighbor under
      // review and the other as the candidate. When only one side is yours,
      // it is the candidate: the one a duplicate verdict archives.
      const aOwn = isOwnAuthor(pair.a.metadata);
      const bOwn = isOwnAuthor(pair.b.metadata);
      const aIsNeighbor = aOwn !== bOwn ? bOwn : (pair.a.metadata.salience ?? 1) >= (pair.b.salience ?? 1);
      const [candidate, neighbor] = aIsNeighbor
        ? [{ id: pair.b.id, content: pair.b.content }, { id: pair.a.id, content: pair.a.content, distance: pair.distance, salience: pair.a.metadata.salience }]
        : [{ id: pair.a.id, content: pair.a.content }, { id: pair.b.id, content: pair.b.content, distance: pair.distance, salience: pair.b.salience }];
      const owns = (id: string) => (id === pair.a.id ? aOwn : bOwn);

      const decision = await resolveConflict(
        candidate.content,
        [neighbor],
        options.call ? { call: options.call } : {},
      );

      if (decision.action === 'skip') {
        // Same fact twice: retire the lower-salience candidate as duplicate.
        if (!owns(candidate.id)) { stats.skippedNotOwned++; continue; }
        await archiveDuplicate(collection, candidate.id, neighbor.id);
        changed.add(candidate.id);
        stats.skippedDuplicates++;
      } else if (decision.action === 'supersede') {
        // Resolver targets one of the pair; store merged content and let
        // storeMemory archive the stale side.
        const target = decision.targetId === candidate.id ? candidate : neighbor;
        const other = decision.targetId === candidate.id ? neighbor : candidate;
        if (!owns(target.id)) { stats.skippedNotOwned++; continue; }
        const merged = await storeMemory(decision.mergedContent ?? candidate.content, {
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
        changed.add(target.id);
        // The merged memory carries both, so the other side goes too when
        // it's yours; a teammate's stays.
        if (owns(other.id)) {
          await archiveAs(collection, other.id, { superseded_by: merged.ids[0] });
          changed.add(other.id);
        }
        stats.superseded++;
      } else {
        stats.keptDistinct++;
        stats.keptPairs.push(pairKey(pair.a.id, pair.b.id));
      }
    } catch (e) {
      process.stderr.write(`[yapa-janitor] pair resolution failed in ${collection}: ${e}\n`);
      stats.errors++;
    }
  }

  if (stats.pairsConsidered > 0) {
    process.stderr.write(
      `[yapa-janitor] sweep: ${stats.pairsConsidered} pairs — `
      + `${stats.skippedDuplicates} duplicates archived, ${stats.superseded} superseded, `
      + `${stats.keptDistinct} kept distinct, ${stats.skippedNotOwned} not yours, ${stats.errors} error(s)\n`,
    );
  }
  return stats;
}
