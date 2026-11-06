/**
 * A long memory is stored as chunks `<base>-0..n-1`, each with
 * `parent_id: <base>`; no document has the base id itself, and each chunk
 * syncs as its own row. Deleting or purging one must take all of them.
 *
 * @module @yapa/core/memory/chunks
 */
import { getDocumentsByFilter, getDocumentsByIds, listCollections, type DocumentResult } from '../store/index.js';

export interface DocGroup {
  collection: string;
  /** The id the group is locked and addressed by: the base id for chunks, else the doc's own id. */
  baseId: string;
  /** Every document in the group, chunks in order. */
  docs: DocumentResult[];
}

const byChunk = (a: DocumentResult, b: DocumentResult) => (a.metadata.chunk_index ?? 0) - (b.metadata.chunk_index ?? 0);

/** The documents in `collection` that make up `id`: itself, or (for a chunk or a base id) every chunk. */
export async function docGroupIn(collection: string, id: string): Promise<DocGroup | undefined> {
  const [doc] = await getDocumentsByIds(collection, [id]).catch(() => []);
  const baseId = doc ? (doc.metadata.parent_id ?? doc.id) : id;
  const chunks = await getDocumentsByFilter(collection, { parent_id: baseId }, 10_000).catch(() => []);
  if (!doc && !chunks.length) return undefined;
  const docs = doc && !chunks.some(c => c.id === doc.id) ? [doc, ...chunks] : chunks;
  return { collection, baseId, docs: docs.sort(byChunk) };
}

/** {@link docGroupIn} across every local collection (the first that has it). */
export async function findDocGroup(id: string, collections?: string[]): Promise<DocGroup | undefined> {
  for (const c of collections ?? (await listCollections().catch(() => [])).map(x => x.name)) {
    const g = await docGroupIn(c, id);
    if (g) return g;
  }
  return undefined;
}
