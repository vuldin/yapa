import {
  listCollections as chromaListCollections,
  createCollection as chromaCreateCollection,
  deleteCollection as chromaDeleteCollection,
  getCollectionCount,
  type Collection,
} from '../chroma.js';

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

/** Delete a collection by name. */
export async function removeCollection(name: string): Promise<void> {
  await chromaDeleteCollection(name);
}
