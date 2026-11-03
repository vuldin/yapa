/**
 * Active-store holder plus free-function delegates. Core modules import from
 * here (not `../chroma.js`) so the backend is swappable: the ChromaDB HTTP
 * adapter by default, the embedded local store when `YAPA_STORAGE=local` or a
 * host calls `setStore()` (the DSH plugin does, from its resolved config).
 *
 * @module @yapa/core/store
 */
import { getConfig } from '../config.js';
import { chromaStore } from './chroma-adapter.js';
import { createLocalStore } from './local-adapter.js';
import type {
  Collection,
  CrossCollectionResult,
  DocumentResult,
  QueryResult,
  VectorStore,
} from './types.js';

export * from './types.js';
export { chromaStore } from './chroma-adapter.js';
export { createLocalStore } from './local-adapter.js';

let active: VectorStore | undefined;

/** Install the active store (host harnesses call this at startup). */
export function setStore(store: VectorStore): void {
  active = store;
}

/** Active store: an installed one, else resolved from config (lazy). */
export function getStore(): VectorStore {
  if (!active) {
    active = getConfig().STORAGE === 'local'
      ? createLocalStore(getConfig().LOCAL_STORE_PATH)
      : chromaStore;
  }
  return active;
}

/** Test hook: drop the active store so the next read re-resolves config. */
export function resetStore(): void {
  active = undefined;
}

// --- Free-function delegates (historic call-site shape) ---------------------

export const listCollections = (): Promise<Collection[]> => getStore().listCollections();
export const createCollection = (name: string, metadata?: Record<string, any>): Promise<void> =>
  getStore().createCollection(name, metadata);
export const deleteCollection = (name: string): Promise<void> => getStore().deleteCollection(name);
export const getCollectionCount = (name: string): Promise<number> => getStore().getCollectionCount(name);
export const getOrCreateCollection = (name: string): Promise<string> => getStore().getOrCreateCollection(name);

export const addDocument = (collection: string, id: string, content: string, metadata: Record<string, any>): Promise<void> =>
  getStore().addDocument(collection, id, content, metadata);
export const addDocumentsBatch = (
  collection: string,
  documents: Array<{ id: string; content: string; metadata: Record<string, any> }>,
): Promise<void> => getStore().addDocumentsBatch(collection, documents);

export const queryDocuments = (
  collection: string, queryText: string, nResults?: number, filter?: Record<string, any>,
): Promise<QueryResult[]> => getStore().queryDocuments(collection, queryText, nResults, filter);
export const queryAllCollections = (
  queryText: string, nResults?: number, filter?: Record<string, any>,
): Promise<CrossCollectionResult[]> => getStore().queryAllCollections(queryText, nResults, filter);

export const getDocumentsByFilter = (
  collection: string, filter: Record<string, any>, limit?: number,
): Promise<DocumentResult[]> => getStore().getDocumentsByFilter(collection, filter, limit);
export const getDocumentsByIds = (collection: string, ids: string[]): Promise<DocumentResult[]> =>
  getStore().getDocumentsByIds(collection, ids);

export const updateDocument = (collection: string, id: string, metadata: Record<string, any>): Promise<void> =>
  getStore().updateDocument(collection, id, metadata);
export const updateDocumentsBatch = (
  collection: string,
  entries: Array<{ id: string; metadata: Record<string, any> }>,
): Promise<void> => getStore().updateDocumentsBatch(collection, entries);
export const patchDocuments = (collection: string, entries: Array<{ id: string; patch: Record<string, any> }>): Promise<void> =>
  entries.length ? getStore().patchDocuments(collection, entries) : Promise.resolve();
export const patchDocument = (collection: string, id: string, patch: Record<string, any>): Promise<void> =>
  patchDocuments(collection, [{ id, patch }]);

/** The patch that turns `before` into `after`: changed or added keys, and removed keys as `null`. */
export function metadataDelta(before: Record<string, any>, after: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const [k, v] of Object.entries(after)) if (!same(before[k], v)) out[k] = v ?? null;
  for (const k of Object.keys(before)) if (!(k in after) && before[k] != null) out[k] = null;
  return out;
}

export const deleteDocument = (collection: string, id: string): Promise<void> =>
  getStore().deleteDocument(collection, id);
export const findAndDeleteDocument = (id: string): Promise<string> => getStore().findAndDeleteDocument(id);
