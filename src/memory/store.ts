import { addDocument, addDocumentsBatch, getOrCreateCollection } from '../chroma.js';
import { detectSector } from '../lifecycle.js';
import { chunkText } from '../chunking.js';
import { SALIENCE_START, USERNAME } from '../config.js';

export interface StoreOptions {
  tags?: string[];
  salience?: number;
  sector?: 'semantic' | 'episodic';
  collection?: string;
}

/**
 * Store a memory. Long content is automatically chunked.
 * Returns the ID(s) of stored documents.
 */
export async function storeMemory(
  content: string,
  options: StoreOptions = {},
): Promise<string[]> {
  const collection = options.collection ?? 'global';
  await getOrCreateCollection(collection);

  const now = Math.floor(Date.now() / 1000);
  const sector = options.sector ?? detectSector(content);
  const salience = options.salience ?? SALIENCE_START;

  const chunks = chunkText(content);

  if (chunks.length === 1) {
    const id = `mem-${USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const metadata: Record<string, any> = {
      type: 'memory',
      username: USERNAME,
      tags: options.tags ?? [],
      salience,
      sector,
      created_at: now,
      accessed_at: now,
    };
    metadata.is_synced = false;
    await addDocument(collection, id, content, metadata);
    return [id];
  }

  // Multi-chunk: batch insert
  const baseId = `mem-${USERNAME}-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const docs = chunks.map((chunk) => {
    const chunkMeta: Record<string, any> = {
      type: 'memory',
      username: USERNAME,
      tags: options.tags ?? [],
      salience,
      sector,
      created_at: now,
      accessed_at: now,
      chunk_index: chunk.index,
      chunk_total: chunk.total,
      parent_id: baseId,
    };
    chunkMeta.is_synced = false;
    return {
      id: `${baseId}-${chunk.index}`,
      content: chunk.content,
      metadata: chunkMeta,
    };
  });

  await addDocumentsBatch(collection, docs);
  return docs.map(d => d.id);
}
