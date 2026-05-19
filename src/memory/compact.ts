import {
  getDocumentsByFilter,
  getDocumentsByIds,
  queryDocuments,
  updateDocument,
} from '../chroma.js';
import {
  COMPACTION_MIN_GROUP_SIZE,
  COMPACTION_SIMILARITY_DISTANCE,
} from '../config.js';
import { storeMemory } from './store.js';

export interface CompactionGroup {
  seed_id: string;
  member_ids: string[];
  seed_content: string;
  similar_content: string[];
  shared_tags: string[];
}

/**
 * Count non-archived memories in a collection. Returns 0 if the collection
 * doesn't exist or is empty.
 */
export async function collectionSize(collection: string): Promise<number> {
  try {
    const docs = await getDocumentsByFilter(collection, { type: 'memory' }, 10000);
    return docs.filter(d => d.metadata.archived !== true).length;
  } catch {
    return 0;
  }
}

function tagsOf(metadata: Record<string, any>): string[] {
  if (Array.isArray(metadata.tags)) return metadata.tags;
  if (typeof metadata.tags === 'string') return metadata.tags.split(',').filter(Boolean);
  return [];
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(a);
  return b.filter(t => set.has(t));
}

/**
 * Suggest groups of similar non-archived memories for compaction.
 * Greedy seeding: pick the highest-salience un-claimed memory as a seed,
 * find its neighbors below `COMPACTION_SIMILARITY_DISTANCE`, claim them all,
 * repeat. Groups smaller than `COMPACTION_MIN_GROUP_SIZE` are skipped.
 */
export async function suggestCompaction(collection: string): Promise<CompactionGroup[]> {
  const all = (await getDocumentsByFilter(collection, { type: 'memory' }, 10000))
    .filter(d => d.metadata.archived !== true);

  if (all.length < COMPACTION_MIN_GROUP_SIZE) return [];

  all.sort((a, b) => (b.metadata.salience ?? 0) - (a.metadata.salience ?? 0));

  const consumed = new Set<string>();
  const groups: CompactionGroup[] = [];

  for (const seed of all) {
    if (consumed.has(seed.id)) continue;

    const neighbors = await queryDocuments(collection, seed.content, 20, { type: 'memory' });
    const matches = neighbors.filter(n =>
      n.id !== seed.id &&
      !consumed.has(n.id) &&
      n.metadata.archived !== true &&
      n.distance < COMPACTION_SIMILARITY_DISTANCE,
    );

    if (matches.length + 1 < COMPACTION_MIN_GROUP_SIZE) continue;

    const memberIds = [seed.id, ...matches.map(m => m.id)];
    memberIds.forEach(id => consumed.add(id));

    const sharedTags = matches.reduce(
      (acc, m) => intersect(acc, tagsOf(m.metadata)),
      tagsOf(seed.metadata),
    );

    groups.push({
      seed_id: seed.id,
      member_ids: memberIds,
      seed_content: seed.content,
      similar_content: matches.map(m => m.content),
      shared_tags: sharedTags,
    });
  }

  return groups;
}

export interface ApplyCompactionInput {
  collection: string;
  member_ids: string[];
  summary: string;
  tags?: string[];
}

export interface ApplyCompactionResult {
  summary_id: string;
  archived_ids: string[];
}

/**
 * Write a summary memory at salience 2.0, then mark each member as archived
 * with a back-reference to the summary. Archived memories are filtered out of
 * `memory_recall` and `memory_list` by default.
 */
export async function applyCompaction(input: ApplyCompactionInput): Promise<ApplyCompactionResult> {
  const stored = await storeMemory(input.summary, {
    collection: input.collection,
    salience: 2.0,
    tags: ['compacted', ...(input.tags ?? [])],
    sector: 'semantic',
  });
  const summaryId = stored.ids[0];

  const archivedIds: string[] = [];
  for (const id of input.member_ids) {
    try {
      const existing = await getDocumentsByIds(input.collection, [id]);
      if (!existing.length) continue;
      await updateDocument(input.collection, id, {
        ...existing[0].metadata,
        archived: true,
        compacted_into: summaryId,
      });
      archivedIds.push(id);
    } catch (e) {
      process.stderr.write(`[yapa] compact: failed to archive ${id}: ${e}\n`);
    }
  }

  try {
    const summaryDocs = await getDocumentsByIds(input.collection, [summaryId]);
    if (summaryDocs.length) {
      await updateDocument(input.collection, summaryId, {
        ...summaryDocs[0].metadata,
        compacted_from: archivedIds,
      });
    }
  } catch (e) {
    process.stderr.write(`[yapa] compact: failed to set back-reference on summary: ${e}\n`);
  }

  return { summary_id: summaryId, archived_ids: archivedIds };
}
