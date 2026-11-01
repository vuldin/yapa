import { deleteDocumentEverywhere } from '../memory/forget.js';
import { releaseTaskClaim } from './claim.js';
import { getTask } from './update.js';

/**
 * Delete a task by ID. Searches across all collections. Returns the collection
 * it was in. Sync-aware like memory_forget (previously a deleted task lingered
 * in the shared database forever). A task this session had claimed is released.
 */
export async function deleteTask(id: string, session?: string): Promise<string> {
  const task = await getTask(id).catch(() => null);
  const collection = await deleteDocumentEverywhere(id);
  if (task?.metadata.status === 'in_progress') {
    await releaseTaskClaim(id, task.collection, 'deleted', session).catch(() => undefined);
  }
  return collection;
}
