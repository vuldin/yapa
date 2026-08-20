import { findAndDeleteDocument } from '../store/index.js';

/** Delete a task by ID. Searches across all collections. Returns the collection it was in. */
export async function deleteTask(id: string): Promise<string> {
  return await findAndDeleteDocument(id);
}
