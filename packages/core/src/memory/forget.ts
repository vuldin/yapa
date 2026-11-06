import { getConfig } from '../config.js';
import { deleteDocument } from '../store/index.js';
import { findDocGroup } from './chunks.js';

import { addLocalTombstone, queueSyncDelete } from '../sync/deletes.js';
import { assertWritable } from '../sync/syncable.js';

function isSyncable(collection: string): boolean {
  return !collection.startsWith('private-') && !collection.startsWith('local-');
}

/**
 * Delete a document by ID from whichever collection holds it, and propagate
 * the decision to sync: your own docs are queued for remote deletion; a
 * teammate's doc is only removed here (tombstoned so pull won't re-insert it),
 * never from the shared database. A memory stored in chunks goes whole,
 * addressed by its base id or any chunk's id (each chunk is its own row).
 * Returns the collection it was found in.
 */
export async function deleteDocumentEverywhere(id: string): Promise<string> {
  const group = await findDocGroup(id);
  if (!group) throw new Error(`Document '${id}' not found in any collection`);
  for (const d of group.docs) assertWritable(d.id, d.metadata);
  const { collection, docs } = group;
  for (const d of docs) await deleteDocument(collection, d.id);
  if (getConfig().SYNC_ENABLED && isSyncable(collection)) {
    for (const d of docs) {
      const owner = d.metadata.origin_user;
      if (!owner || owner === getConfig().USERNAME) await queueSyncDelete(d.id, collection);
      else await addLocalTombstone(d.id);
    }
  }
  return collection;
}

/** Delete a memory by ID. Searches across all collections. */
export async function forgetMemory(id: string): Promise<string> {
  return deleteDocumentEverywhere(id);
}
