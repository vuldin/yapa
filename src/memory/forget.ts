import { findAndDeleteDocument } from '../chroma.js';

/**
 * Delete a memory by ID. Searches across all collections.
 * Returns the collection it was found in.
 */
export async function forgetMemory(id: string): Promise<string> {
  return await findAndDeleteDocument(id);
}
