import { queryDocuments, listCollections, type Collection } from '../store/index.js';

export interface TaskSearchResult {
  id: string;
  title: string;
  metadata: Record<string, any>;
  similarity: number;
  collection: string;
}

/** Semantic search across tasks in all collections. */
export async function searchTasks(
  query: string,
  filters: { customer?: string; project?: string; collection?: string } = {},
): Promise<TaskSearchResult[]> {
  const collectionNames = filters.collection
    ? [filters.collection]
    : (await listCollections()).map((c: Collection) => c.name);

  const results: TaskSearchResult[] = [];

  for (const name of collectionNames) {
    try {
      const queryFilter: Record<string, any> = { type: 'task' };
      if (filters.customer) queryFilter.customer = filters.customer;
      if (filters.project) queryFilter.project = filters.project;

      const docs = await queryDocuments(name, query, 10, queryFilter);

      for (const doc of docs) {
        if (doc.metadata.type === 'task') {
          results.push({
            id: doc.id,
            title: doc.content,
            metadata: doc.metadata,
            similarity: 1 - doc.distance,
            collection: name,
          });
        }
      }
    } catch {
      continue;
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}
