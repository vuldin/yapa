import { getConfig } from '../config.js';
import { deleteDocument, getDocumentsByIds, listCollections } from '../store/index.js';

import { addLocalTombstone, queueSyncDelete } from '../sync/deletes.js';

function isSyncable(collection: string): boolean {
  return !collection.startsWith('private-') && !collection.startsWith('local-');
}

/**
 * Delete a document by ID from whichever collection holds it, and propagate
 * the decision to sync: your own docs are queued for remote deletion; a
 * teammate's doc is only removed here (tombstoned so pull won't re-insert it),
 * never from the shared database.
 * Returns the collection it was found in.
 */
export async function deleteDocumentEverywhere(id: string): Promise<string> {
  for (const collection of await listCollections()) {
    let found;
    try {
      [found] = await getDocumentsByIds(collection.name, [id]);
    } catch {
      continue;
    }
    if (!found) continue;

    await deleteDocument(collection.name, id);
    if (getConfig().SYNC_ENABLED && isSyncable(collection.name)) {
      const owner = found.metadata.origin_user;
      if (!owner || owner === getConfig().USERNAME) {
        await queueSyncDelete(id, collection.name);
      } else {
        await addLocalTombstone(id);
      }
    }
    return collection.name;
  }
  throw new Error(`Document '${id}' not found in any collection`);
}

/** Delete a memory by ID. Searches across all collections. */
export async function forgetMemory(id: string): Promise<string> {
  return deleteDocumentEverywhere(id);
}
