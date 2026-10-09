import { getConfig } from '../config.js';
import { queueSyncDeletes, addLocalTombstones } from '../sync/deletes.js';
import { getSyncSubscriptions, updateSyncSubscriptions } from '../sync/sentinel.js';
import {
  getDocumentsByFilter,
  listCollections as chromaListCollections,
  createCollection as chromaCreateCollection,
  deleteCollection as chromaDeleteCollection,
  getCollectionCount,
  type Collection,
} from '../store/index.js';
import { isSyncableCollection } from '../sync/syncable.js';

export interface CollectionInfo {
  name: string;
  id: string;
  documentCount: number;
}

/** List all collections with document counts. */
export async function listCollectionsWithCounts(): Promise<CollectionInfo[]> {
  const collections = await chromaListCollections();

  const results = await Promise.all(
    collections.map(async (c) => {
      try {
        const count = await getCollectionCount(c.name);
        return { name: c.name, id: c.id, documentCount: count };
      } catch {
        return { name: c.name, id: c.id, documentCount: 0 };
      }
    }),
  );

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** Create a new collection. */
export async function createNewCollection(name: string): Promise<void> {
  await chromaCreateCollection(name);
}

const isSyncable = isSyncableCollection;

/**
 * Delete a collection by name — and make the deletion stick under sync.
 * Before this, deleting a collection was invisible to the shared database:
 * its rows stayed remote forever, and the still-active subscription made the
 * next pull recreate the collection and backfill everything back. Now your
 * own docs are queued for remote deletion, teammates' docs are tombstoned
 * locally (their shared rows stay), and the collection is unsubscribed.
 */
export async function removeCollection(name: string): Promise<void> {
  if (getConfig().SYNC_ENABLED && isSyncable(name)) {
    const docs = await getDocumentsByFilter(name, {}, 100_000).catch(() => []);
    const me = getConfig().USERNAME;
    const real = docs.filter(d => !d.id.startsWith('__') && d.metadata.type !== 'journal_draft');
    await queueSyncDeletes(real.filter(d => !d.metadata.origin_user || d.metadata.origin_user === me).map(d => d.id), name);
    await addLocalTombstones(real.filter(d => d.metadata.origin_user && d.metadata.origin_user !== me).map(d => d.id));
    const subs = await getSyncSubscriptions();
    if (subs.includes(name)) await updateSyncSubscriptions(subs.filter(s => s !== name));
  }
  await chromaDeleteCollection(name);
}
