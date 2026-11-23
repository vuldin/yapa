/**
 * Which memories automatic curation (compaction, the janitor, expiry) may
 * fold, archive or replace. Typed memories keep their own identity and
 * status, session summaries have their own retention, read-only docs belong
 * to the remote, a memory a project publishes (`external_ref`) is kept in
 * step by that project, and a pinned memory was marked by a person as one
 * to keep.
 */
import { isReadOnlyDoc } from '../sync/syncable.js';
import { isSessionSummary } from './filters.js';
import { isMemoryKind } from './kinds.js';

export function isPinned(metadata: Record<string, any> | undefined | null): boolean {
  return metadata?.pinned === true;
}

export function isCuratable(metadata: Record<string, any> | undefined | null): boolean {
  if (!metadata) return false;
  return metadata.archived !== true
    && !isMemoryKind(metadata.kind)
    && !isSessionSummary(metadata)
    && !isReadOnlyDoc(metadata)
    && !metadata.external_ref
    && !isPinned(metadata);
}
