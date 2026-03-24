import { addDocument, getOrCreateCollection, getDocumentsByFilter } from '../chroma.js';

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
 * Clear the pending deletes queue after successful remote deletion.
 */
export async function clearPendingDeletes(): Promise<void> {
  try {
    await addDocument('global', SYNC_DELETES_ID, 'sync delete queue', {
      type: 'sync_sentinel',
      pending_deletes: '',
    });
  } catch {
    // Sentinel may not exist yet — that's fine
  }
}
