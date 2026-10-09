/**
 * Metadata for archiving a document (compaction, supersede, janitor dedupe).
 * Archiving is a real change other copies must see: it bumps `updated_at` and
 * flags the doc for push, so teammates and the user's other machines stop
 * surfacing the stale version too (pull applies newer remote versions).
 */
export function archivedMetadata(
  metadata: Record<string, any>,
  extra: Record<string, any>,
  now: number = Math.floor(Date.now() / 1000),
): Record<string, any> {
  return { ...metadata, ...extra, archived: true, updated_at: now, is_synced: false };
}
