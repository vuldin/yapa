/**
 * Storage backend port for yapa: the operations every store must provide.
 * Two implementations exist — the ChromaDB HTTP server (`chroma-adapter`)
 * and the embedded, serverless store (`local-adapter`).
 *
 * Embedding is the store's job: document/query text goes in, the store embeds
 * internally via the configured embedder (see embeddings.ts). Local stores
 * record `embedding_model` per document and refuse mixed-model scans.
 *
 * @module @yapa/core/store/types
 */
/** A store collection (id == backend handle; name == yapa collection name). */
export interface Collection {
  id: string;
  name: string;
  metadata?: Record<string, any>;
}

export interface DocumentResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

export interface QueryResult extends DocumentResult {
  /** Cosine distance (0..2) on both backends. */
  distance: number;
}

export interface CrossCollectionResult extends QueryResult {
  collection: string;
}

export interface VectorStore {
  /** Human-readable backend name ('chroma' | 'local'). */
  readonly kind: string;

  listCollections(): Promise<Collection[]>;
  createCollection(name: string, metadata?: Record<string, any>): Promise<void>;
  deleteCollection(name: string): Promise<void>;
  getCollectionCount(name: string): Promise<number>;
  /** Returns the store's collection handle (name for local stores). */
  getOrCreateCollection(name: string): Promise<string>;

  addDocument(collection: string, id: string, content: string, metadata: Record<string, any>): Promise<void>;
  addDocumentsBatch(
    collection: string,
    documents: Array<{ id: string; content: string; metadata: Record<string, any> }>,
  ): Promise<void>;

  /** Semantic query. Distances are cosine (0..2) regardless of backend. */
  queryDocuments(
    collection: string,
    queryText: string,
    nResults?: number,
    filter?: Record<string, any>,
  ): Promise<QueryResult[]>;
  queryAllCollections(
    queryText: string,
    nResults?: number,
    filter?: Record<string, any>,
  ): Promise<CrossCollectionResult[]>;

  getDocumentsByFilter(collection: string, filter: Record<string, any>, limit?: number): Promise<DocumentResult[]>;
  getDocumentsByIds(collection: string, ids: string[]): Promise<DocumentResult[]>;

  /** Replace a document's metadata wholesale (callers merge first). */
  updateDocument(collection: string, id: string, metadata: Record<string, any>): Promise<void>;
  /**
   * Batch metadata replacement. Chroma sends one request; the local store
   * flushes once per collection. Sweep-style maintenance (decay) must use
   * this instead of per-document `updateDocument` loops.
   */
  updateDocumentsBatch(
    collection: string,
    entries: Array<{ id: string; metadata: Record<string, any> }>,
  ): Promise<void>;
  /**
   * Merge each `patch` into its document's metadata as it is now: named keys
   * are set, a `null` value removes the key, every other key is kept. Ids
   * that don't exist are skipped. For writers that change a few fields
   * (salience boosts, archiving, tags): unlike `updateDocument` with a copy
   * read earlier, it can't revert another session's change to other fields.
   * One request (Chroma) or one flush (local store).
   */
  patchDocuments(collection: string, entries: Array<{ id: string; patch: Record<string, any> }>): Promise<void>;
  deleteDocument(collection: string, id: string): Promise<void>;
  /** Cross-collection delete; resolves to the collection that held the id. */
  findAndDeleteDocument(id: string): Promise<string>;
}
