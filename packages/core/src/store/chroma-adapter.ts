/**
 * ChromaDB-backed VectorStore: delegates to the long-standing chroma.ts
 * HTTP client. Unchanged behavior; distances follow each collection's
 * configured space (yapa pins cosine at creation).
 *
 * @module @yapa/core/store/chroma-adapter
 */
import * as chroma from '../chroma.js';
import type { VectorStore } from './types.js';

export const chromaStore: VectorStore = {
  kind: 'chroma',

  listCollections: () => chroma.listCollections(),
  createCollection: (name, metadata) => chroma.createCollection(name, metadata),
  deleteCollection: name => chroma.deleteCollection(name),
  getCollectionCount: name => chroma.getCollectionCount(name),
  getOrCreateCollection: name => chroma.getOrCreateCollection(name),

  addDocument: (col, id, content, metadata) => chroma.addDocument(col, id, content, metadata),
  addDocumentsBatch: (col, docs) => chroma.addDocumentsBatch(col, docs),

  queryDocuments: (col, q, n, filter) => chroma.queryDocuments(col, q, n, filter),
  queryAllCollections: (q, n, filter) => chroma.queryAllCollections(q, n, filter),

  getDocumentsByFilter: (col, filter, limit) => chroma.getDocumentsByFilter(col, filter, limit),
  getDocumentsByIds: (col, ids) => chroma.getDocumentsByIds(col, ids),

  updateDocument: (col, id, metadata) => chroma.updateDocument(col, id, metadata),
  updateDocumentsBatch: (col, entries) => chroma.updateDocumentsBatch(col, entries),
  deleteDocument: (col, id) => chroma.deleteDocument(col, id),
  findAndDeleteDocument: id => chroma.findAndDeleteDocument(id),
};
