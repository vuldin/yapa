import { getConfig } from '../config.js';
import { getDocumentsByFilter, listCollections, metadataDelta, patchDocuments } from '../store/index.js';
import { isReadOnlyDoc } from '../sync/syncable.js';
import { isOwnAuthor } from '../sync/backend.js';
import { archivedMetadata } from './archive.js';
import { isSessionSummary } from './filters.js';

const DAY = 86400;

/**
 * Archive your own compaction summaries older than SESSION_SUMMARY_RETENTION_DAYS
 * (0: never). A chunked summary goes whole. Run by the daily decay sweep.
 * Returns the number of documents archived.
 */
export async function sweepSessionSummaries(now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  const days = getConfig().SESSION_SUMMARY_RETENTION_DAYS;
  if (!days) return 0;
  const cutoff = now - days * DAY;
  let n = 0;
  for (const c of (await listCollections().catch(() => [])).map(x => x.name)) {
    const docs = await getDocumentsByFilter(c, { type: 'memory' }, 100_000).catch(() => []);
    const expired = new Set<string>();
    for (const d of docs) {
      const m = d.metadata;
      if (!isSessionSummary(m) || m.archived === true || isReadOnlyDoc(m)) continue;
      if (!isOwnAuthor(m)) continue;
      if (Number(m.created_at ?? now) > cutoff) continue;
      expired.add(String(m.parent_id ?? d.id));
    }
    if (!expired.size) continue;
    const updates = docs
      .filter(d => expired.has(String(d.metadata.parent_id ?? d.id)) && d.metadata.archived !== true)
      .map(d => ({ id: d.id, patch: metadataDelta(d.metadata, archivedMetadata(d.metadata, { expired: 'session_summary_retention' }, now)) }));
    try {
      await patchDocuments(c, updates);
      n += updates.length;
    } catch {
      // Best effort: the next daily sweep tries again.
    }
  }
  return n;
}
