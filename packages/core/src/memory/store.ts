import { addDocument, addDocumentsBatch, getOrCreateCollection, queryDocuments } from '../store/index.js';
import { detectSector } from '../lifecycle.js';
import { chunkText } from '../chunking.js';
import { getConfig, SALIENCE_START } from '../config.js';

export interface StoreOptions {
  tags?: string[];
  salience?: number;
  sector?: 'semantic' | 'episodic';
  collection?: string;
}

export interface ConflictRecord {
  id: string;
  content: string;
  distance: number;
  salience: number;
}

export interface StoreMemoryResult {
  ids: string[];
  potential_conflicts: ConflictRecord[];
}

interface ConflictCandidate {
  id: string;
  content: string;
  distance: number;
  metadata: Record<string, any>;
}

/**
 * Pure helper — takes raw query results and returns the entries that look
 * like near-duplicates of the content being stored.
 */
export function findConflicts(
  candidates: ConflictCandidate[],
  threshold: number = getConfig().CONTRADICTION_DISTANCE_THRESHOLD,
  maxResults: number = getConfig().CONTRADICTION_MAX_RESULTS,
): ConflictRecord[] {
  return candidates
    .filter(c => c.distance < threshold)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults)
    .map(c => ({
      id: c.id,
      content: c.content.length > 200 ? c.content.slice(0, 200) + '…' : c.content,
      distance: c.distance,
      salience: c.metadata.salience ?? 1.0,
    }));
}

async function detectConflicts(collection: string, content: string): Promise<ConflictRecord[]> {
  try {
    const candidates = await queryDocuments(
      collection,
      content,
      getConfig().CONTRADICTION_MAX_RESULTS * 2,
      { type: 'memory' },
    );
    return findConflicts(candidates);
  } catch {
    // Collection may not exist yet — no conflicts to surface.
    return [];
  }
}

/**
 * Store a memory. Long content is automatically chunked.
 * Returns the ID(s) of stored documents plus any potential conflicts found
 * in the same collection (near-duplicates that the caller should consider
 * superseding via `memory_forget`).
 */
export async function storeMemory(
  content: string,
  options: StoreOptions = {},
): Promise<StoreMemoryResult> {
  const collection = options.collection ?? 'global';
  await getOrCreateCollection(collection);

  const potential_conflicts = await detectConflicts(collection, content);

  const now = Math.floor(Date.now() / 1000);
  const sector = options.sector ?? detectSector(content);
  const salience = options.salience ?? SALIENCE_START;

  const chunks = chunkText(content);

  if (chunks.length === 1) {
    const id = `mem-${getConfig().USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata: Record<string, any> = {
      type: 'memory',
      username: getConfig().USERNAME,
      tags: options.tags ?? [],
      salience,
      sector,
      created_at: now,
      accessed_at: now,
    };
    metadata.is_synced = false;
    await addDocument(collection, id, content, metadata);
    return { ids: [id], potential_conflicts };
  }

  // Multi-chunk: batch insert
  const baseId = `mem-${getConfig().USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const docs = chunks.map((chunk) => {
    const chunkMeta: Record<string, any> = {
      type: 'memory',
      username: getConfig().USERNAME,
      tags: options.tags ?? [],
      salience,
      sector,
      created_at: now,
      accessed_at: now,
      chunk_index: chunk.index,
      chunk_total: chunk.total,
      parent_id: baseId,
    };
    chunkMeta.is_synced = false;
    return {
      id: `${baseId}-${chunk.index}`,
      content: chunk.content,
      metadata: chunkMeta,
    };
  });

  await addDocumentsBatch(collection, docs);
  return { ids: docs.map(d => d.id), potential_conflicts };
}
