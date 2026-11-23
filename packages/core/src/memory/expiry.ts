/**
 * Age-based expiry: archive your own ordinary notes that nobody has recalled
 * or changed for MEMORY_EXPIRY_DAYS and whose salience has decayed below
 * MEMORY_EXPIRY_MAX_SALIENCE. Typed memories, pinned ones, session summaries
 * (their own retention), read-only docs and notes an open task links to stay.
 * Archiving syncs, so teammates' copies hide too, and `memory_update` with
 * `restore` brings one back. Run by the daily decay sweep.
 */
import { getConfig } from '../config.js';
import { metadataList } from '../metadata-adapter.js';
import { getDocumentsByFilter, listCollections, metadataDelta, patchDocuments, type DocumentResult } from '../store/index.js';
import { isOwnAuthor } from '../sync/backend.js';
import { archivedMetadata } from './archive.js';
import { isCuratable } from './curatable.js';

const DAY = 86400;

export interface ExpiryCandidate {
  id: string;
  collection: string;
  salience: number;
  /** Unix seconds of the last create, change or recall. */
  last_active: number;
  preview: string;
}

export interface ExpiryResult {
  candidates: ExpiryCandidate[];
  /** Documents archived (each chunk counts); 0 on a dry run. */
  archived: number;
}

export interface ExpiryOptions {
  collection?: string;
  dryRun?: boolean;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

async function linkedFromOpenTasks(collection: string): Promise<Set<string>> {
  const tasks = await getDocumentsByFilter(collection, { type: 'task' }, 100_000).catch(() => []);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.metadata.status === 'complete') continue;
    for (const id of [...metadataList(t.metadata.memory_ids), ...metadataList(t.metadata.waits_on)]) ids.add(id);
  }
  return ids;
}

export async function sweepExpiredMemories(now: number = Math.floor(Date.now() / 1000), options: ExpiryOptions = {}): Promise<ExpiryResult> {
  const { MEMORY_EXPIRY_DAYS: days, MEMORY_EXPIRY_MAX_SALIENCE: maxSalience } = getConfig();
  const result: ExpiryResult = { candidates: [], archived: 0 };
  if (!days) return result;
  const cutoff = now - days * DAY;
  const names = options.collection ? [options.collection] : (await listCollections().catch(() => [])).map(c => c.name);

  for (const collection of names) {
    const docs = await getDocumentsByFilter(collection, { type: 'memory' }, 100_000).catch((): DocumentResult[] => []);
    if (!docs.length) continue;
    const groups = new Map<string, typeof docs>();
    for (const d of docs) {
      const key = String(d.metadata.parent_id ?? d.id);
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    const linked = await linkedFromOpenTasks(collection);
    const expired: typeof docs = [];
    for (const [id, chunks] of groups) {
      if (linked.has(id) || chunks.some(c => linked.has(c.id))) continue;
      if (!chunks.every(c => isCuratable(c.metadata) && isOwnAuthor(c.metadata))) continue;
      const lastActive = Math.max(...chunks.flatMap(c => [num(c.metadata.created_at), num(c.metadata.updated_at), num(c.metadata.accessed_at)]));
      if (!lastActive || lastActive > cutoff) continue;
      const salience = Math.max(...chunks.map(c => num(c.metadata.salience ?? 1)));
      if (salience >= maxSalience) continue;
      chunks.sort((a, b) => num(a.metadata.chunk_index) - num(b.metadata.chunk_index));
      result.candidates.push({ id, collection, salience, last_active: lastActive, preview: chunks[0].content.slice(0, 120) });
      expired.push(...chunks);
    }
    if (options.dryRun || !expired.length) continue;
    const updates = expired.map(d => ({ id: d.id, patch: metadataDelta(d.metadata, archivedMetadata(d.metadata, { expired: 'age' }, now)) }));
    try {
      await patchDocuments(collection, updates);
      result.archived += updates.length;
    } catch {
      // Best effort: the next daily sweep tries again.
    }
  }
  return result;
}
