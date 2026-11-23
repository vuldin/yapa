/**
 * Change a memory in place: its typed fields (status, owner, links, ...) and
 * optionally a dated note appended to its text, e.g. recording the choice on
 * a decision that was needed. Unlike `supersedes`, the id stays the same, so
 * tasks waiting on it see the new status on their next check. The remote
 * keeps the earlier state as history (a metadata change is a new revision).
 *
 * @module @yapa/core/memory/update
 */
import { addDocument, getDocumentsByFilter, getDocumentsByIds, listCollections, metadataDelta, patchDocument } from '../store/index.js';
import { getConfig, SALIENCE_FLOOR, SALIENCE_MAX } from '../config.js';
import { ARCHIVE_REASON_KEYS } from './archive.js';
import { withDocLock } from '../doc-lock.js';
import { assertWritable } from '../sync/syncable.js';
import { resolveWriteCollection } from '../sync/sentinel.js';
import { normalizeTyped, type TypedFields } from './kinds.js';
import { linkMemoryToTasks } from './links.js';
import { assertMayType } from './records-elsewhere.js';

export interface MemoryUpdate extends TypedFields {
  /** Appended to the memory's text as "<date> <user>: <note>". */
  note?: string;
  /** Replace the tags. */
  tags?: string[];
  /** Replace the text (single-chunk memories only; a long rewrite is a new memory that supersedes this one). */
  content?: string;
  /** Set the salience (clamped to the floor..max range); decay counts from now. */
  salience?: number;
  /** Pin (never decays; compaction, the janitor and expiry leave it alone) or unpin. */
  pinned?: boolean;
  /** Un-archive: the memory shows in recall and lists again. */
  restore?: boolean;
}

export interface MemoryUpdateResult {
  id: string;
  collection: string;
  metadata: Record<string, any>;
}

export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`memory ${id} not found`);
    this.name = 'MemoryNotFoundError';
  }
}

async function locate(id: string, collection?: string): Promise<{ collection: string; doc: { id: string; content: string; metadata: Record<string, any> } } | null> {
  // A collection merged away here is followed: the memory moved with it.
  const names = collection ? [(await resolveWriteCollection(collection)).collection] : (await listCollections().catch(() => [])).map(c => c.name);
  for (const name of names) {
    const [doc] = await getDocumentsByIds(name, [id]).catch(() => []);
    if (doc) return { collection: name, doc };
    // A multi-chunk memory is addressed by its base id.
    const chunks = await getDocumentsByFilter(name, { parent_id: id }, 1).catch(() => []);
    if (chunks.length) return { collection: name, doc: chunks[0] };
  }
  return null;
}

export async function updateMemory(id: string, patch: MemoryUpdate, collection?: string): Promise<MemoryUpdateResult> {
  const found = await locate(id, collection);
  if (!found || found.doc.metadata.type !== 'memory') throw new MemoryNotFoundError(id);
  assertWritable(id, found.doc.metadata);
  const { note, tags, content, salience, pinned, restore, ...typedPatch } = patch;
  if (salience !== undefined && !Number.isFinite(salience)) throw new Error(`salience must be a number between ${SALIENCE_FLOOR} and ${SALIENCE_MAX}`);
  if (restore && found.doc.metadata.deleted_upstream) {
    throw new Error(`${id} was deleted by its owner: keep a copy with trash (action keep) instead`);
  }
  if (content !== undefined && found.doc.metadata.parent_id) {
    throw new Error(`${id} is stored in several chunks: store the new text as a new memory with supersedes: "${id}"`);
  }
  const typed = normalizeTyped(typedPatch, found.doc.metadata);
  await assertMayType(found.collection, found.doc.metadata, typed);
  const now = Math.floor(Date.now() / 1000);

  const baseId = found.doc.metadata.parent_id ?? found.doc.id;
  // Under the memory's lock, over its chunks as they are now: two notes added
  // at once by two sessions both land.
  const metadata = await withDocLock(found.collection, baseId, async () => {
    const docs = found.doc.metadata.parent_id
      ? (await getDocumentsByFilter(found.collection, { parent_id: baseId }, 1000)).sort((a, b) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0))
      : await getDocumentsByIds(found.collection, [found.doc.id]);
    if (!docs.length) throw new MemoryNotFoundError(id);

    let metadata: Record<string, any> = docs[docs.length - 1].metadata;
    for (const [i, d] of docs.entries()) {
      metadata = { ...d.metadata, ...typed, ...(tags ? { tags } : {}), updated_at: now, is_synced: false };
      if (salience !== undefined) Object.assign(metadata, { salience: Math.min(Math.max(salience, SALIENCE_FLOOR), SALIENCE_MAX), decayed_at: now });
      if (pinned === true) metadata.pinned = true;
      if (pinned === false) delete metadata.pinned;
      // Decay skips a pinned memory, so its time pinned never counts later.
      if (pinned !== undefined) metadata.decayed_at = now;
      if (restore) for (const k of ARCHIVE_REASON_KEYS) delete metadata[k];
      const last = i === docs.length - 1;
      if ((note?.trim() || content !== undefined) && last) {
        const day = new Date(now * 1000).toISOString().slice(0, 10);
        const text = content ?? d.content;
        // addDocument upserts and re-embeds: the note is part of what recall finds.
        await addDocument(found.collection, d.id, note?.trim() ? `${text}\n\n${day} ${getConfig().USERNAME}: ${note.trim()}` : text, metadata);
      } else {
        // As a patch: a field written meanwhile without this lock (a recall
        // boost) is kept too.
        await patchDocument(found.collection, d.id, metadataDelta(d.metadata, metadata));
      }
    }
    return metadata;
  });
  if (typed.task_ids?.length) await linkMemoryToTasks(baseId, typed.task_ids);
  return { id: baseId, collection: found.collection, metadata };
}
