import { findAndDeleteDocument } from '../chroma.js';
import { SYNC_ENABLED } from '../config.js';
import { queueSyncDelete } from '../sync/deletes.js';

/**
 * Delete a memory by ID. Searches across all collections.
 * If sync is enabled, queues the deletion for remote propagation.
 * Returns the collection it was found in.
 */
export async function forgetMemory(id: string): Promise<string> {
  const collection = await findAndDeleteDocument(id);
  if (SYNC_ENABLED && !collection.startsWith('private-') && !collection.startsWith('local-')) {
    await queueSyncDelete(id, collection);
  }
  return collection;
}
