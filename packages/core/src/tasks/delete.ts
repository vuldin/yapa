import { deleteDocumentEverywhere } from '../memory/forget.js';

/**
 * Delete a task by ID. Searches across all collections. Returns the collection
 * it was in. Sync-aware like memory_forget (previously a deleted task lingered
 * in the shared database forever).
 */
export async function deleteTask(id: string): Promise<string> {
  return deleteDocumentEverywhere(id);
}
