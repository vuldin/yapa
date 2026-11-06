import { addDocument, getOrCreateCollection, getDocumentsByFilter } from '../store/index.js';

const SYNC_DELETES_ID = '__sync_deletes__';

/**
 * Queue a document ID for remote deletion on next sync push.
 * Stores pending deletes in a sentinel document in the global collection.
 */
export async function queueSyncDelete(docId: string, collection: string): Promise<void> {
  await getOrCreateCollection('global');

  const existing = await getPendingDeletes();
  const entry = `${collection}:${docId}`;

  if (!existing.includes(entry)) {
    existing.push(entry);
  }

  await addDocument('global', SYNC_DELETES_ID, 'sync delete queue', {
    type: 'sync_sentinel',
    pending_deletes: existing.join(','),
  });
}

/** Queue many document IDs for remote deletion with one sentinel write. */
export async function queueSyncDeletes(docIds: string[], collection: string): Promise<void> {
  if (docIds.length === 0) return;
  await getOrCreateCollection('global');
  const existing = new Set(await getPendingDeletes());
  for (const id of docIds) existing.add(`${collection}:${id}`);
  await addDocument('global', SYNC_DELETES_ID, 'sync delete queue', {
    type: 'sync_sentinel',
    pending_deletes: [...existing].join(','),
  });
}

/**
 * Get all pending delete entries (format: "collection:docId").
 */
export async function getPendingDeletes(): Promise<string[]> {
  try {
    const results = await getDocumentsByFilter('global', { type: 'sync_sentinel' }, 10);
    const sentinel = results.find(r => r.id === SYNC_DELETES_ID);
    if (!sentinel) return [];

    const raw = sentinel.metadata.pending_deletes;
    if (!raw || raw === '') return [];

    return typeof raw === 'string' ? raw.split(',').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Remove processed entries from the queue after successful remote deletion
 * (all entries when none are given). Re-reads the queue so entries added
 * while the remote delete ran are kept.
 */
export async function clearPendingDeletes(processed?: string[]): Promise<void> {
  try {
    const done = processed ? new Set(processed) : undefined;
    const remaining = done ? (await getPendingDeletes()).filter(e => !done.has(e)) : [];
    await addDocument('global', SYNC_DELETES_ID, 'sync delete queue', {
      type: 'sync_sentinel',
      pending_deletes: remaining.join(','),
    });
  } catch {
    // Sentinel may not exist yet — that's fine
  }
}

const SYNC_TOMBSTONES_ID = '__sync_tombstones__';

/**
 * Remember that this install deleted a doc it does NOT own (a teammate's
 * memory/task). The shared row stays for everyone else; the tombstone stops
 * pull from re-inserting it here when the row is touched or backfilled.
 */
export async function addLocalTombstone(docId: string): Promise<void> {
  await addLocalTombstones([docId]);
}

/** Tombstone many doc IDs with one sentinel write. */
export async function addLocalTombstones(docIds: string[]): Promise<void> {
  if (docIds.length === 0) return;
  await getOrCreateCollection('global');
  const existing = await getLocalTombstones();
  const before = existing.size;
  for (const id of docIds) existing.add(id);
  if (existing.size === before) return;
  await addDocument('global', SYNC_TOMBSTONES_ID, 'sync tombstones', {
    type: 'sync_tombstones',
    ids: [...existing].join(','),
  });
}

/** IDs this install deleted locally and must not re-pull. */
export async function getLocalTombstones(): Promise<Set<string>> {
  try {
    const results = await getDocumentsByFilter('global', { type: 'sync_tombstones' }, 1);
    const raw = results[0]?.metadata.ids;
    return new Set(typeof raw === 'string' ? raw.split(',').filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

const SYNC_PURGES_ID = '__sync_purges__';

/**
 * Queue ids for a purge on the next push (memory/trash.ts purgeDocuments):
 * the owner removing a mistake, such as a leaked secret, for good. Unlike a
 * delete, the remote keeps no restorable copy, teammates drop theirs even
 * with local edits, and the id can never be written again.
 */
export async function queueSyncPurges(docIds: string[]): Promise<void> {
  if (docIds.length === 0) return;
  await getOrCreateCollection('global');
  const existing = new Set(await getPendingPurges());
  for (const id of docIds) existing.add(id);
  await addDocument('global', SYNC_PURGES_ID, 'sync purge queue', {
    type: 'sync_sentinel',
    pending_purges: [...existing].join(','),
  });
}

export async function getPendingPurges(): Promise<string[]> {
  try {
    const results = await getDocumentsByFilter('global', { type: 'sync_sentinel' }, 10);
    const raw = results.find(r => r.id === SYNC_PURGES_ID)?.metadata.pending_purges;
    return typeof raw === 'string' ? raw.split(',').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Remove handled ids from the purge queue (re-reads it, so ids queued meanwhile stay). */
export async function clearPendingPurges(processed: string[]): Promise<void> {
  try {
    const done = new Set(processed);
    const remaining = (await getPendingPurges()).filter(id => !done.has(id));
    await addDocument('global', SYNC_PURGES_ID, 'sync purge queue', { type: 'sync_sentinel', pending_purges: remaining.join(',') });
  } catch {
    // no queue yet
  }
}
