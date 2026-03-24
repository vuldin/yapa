import { findAndDeleteDocument } from '../chroma.js';

/** Delete a task by ID. Searches across all collections. Returns the collection it was in. */
export async function deleteTask(id: string): Promise<string> {
  return await findAndDeleteDocument(id);
}
