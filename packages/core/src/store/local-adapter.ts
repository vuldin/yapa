/**
 * Embedded, serverless VectorStore: one JSON file per collection under a
 * root directory, atomic writes (tmp + rename), per-collection write chains,
 * and brute-force cosine search — sufficient well past yapa's personal-memory
 * scale (thousands of 384-dim vectors scan in single-digit milliseconds).
 *
 * Distances are cosine (1 − cos) in [0, 2], matching the chroma adapter's
 * cosine-pinned collections, so thresholds (ranking weight, contradiction)
 * behave identically on both backends.
 *
 * Metadata round-trips through the shared toChroma/fromChroma adapter, so
 * records are shape-compatible with ChromaDB in both directions (import,
 * sync, and a possible future migration).
 *
 * @module @yapa/core/store/local-adapter
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateEmbedding } from '../embeddings.js';
import { getConfig, getEmbeddingModel } from '../config.js';
import { toChroma, fromChroma } from '../metadata-adapter.js';
import type {
  Collection,
  CrossCollectionResult,
  DocumentResult,
  QueryResult,
  VectorStore,
} from './types.js';

interface LocalDoc {
  content: string;
  /** Chroma-adapted metadata (same shape the chroma adapter stores). */
  metadata: Record<string, any>;
  embedding: number[];
  embedding_model: string;
}

interface CollectionFile {
  version: 1;
  name: string;
  created: string;
  docs: Record<string, LocalDoc>;
}

/** Identity of the embedder that produced a vector; mismatches never mix. */
function embedderId(): string {
  return `${getConfig().EMBEDDING_PROVIDER}:${getEmbeddingModel() || 'default'}`;
}

/** Cosine distance (1 − cos), norm-safe for unnormalized vectors. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 2;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Flat equality plus `{$eq: value}` (the vocabulary yapa callers use). */
function matchesFilter(metadata: Record<string, any>, filter: Record<string, any> | undefined): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (expected === undefined || expected === null) continue;
    const value = metadata[key];
    if (typeof expected === 'object' && expected !== null && '$eq' in expected) {
      if (value !== expected.$eq) return false;
    } else if (Array.isArray(expected)) {
      // Chroma-adapted array fields are comma-joined strings.
      const hay = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(hay) || !expected.every(e => hay.includes(e))) return false;
    } else if (value !== expected) {
      return false;
    }
  }
  return true;
}

export function createLocalStore(rootDir: string): VectorStore {
  const cache = new Map<string, CollectionFile>();
  const writeChains = new Map<string, Promise<void>>();

  const fileFor = (name: string) => join(rootDir, `${encodeURIComponent(name)}.json`);

  async function load(name: string): Promise<CollectionFile | undefined> {
    const cached = cache.get(name);
    if (cached) return cached;
    try {
      const parsed = JSON.parse(await readFile(fileFor(name), 'utf-8')) as CollectionFile;
      if (parsed.version !== 1) throw new Error(`unsupported version ${parsed.version}`);
      cache.set(name, parsed);
      return parsed;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return undefined;
      throw new Error(`local store: collection "${name}" is unreadable: ${e.message ?? e}`);
    }
  }

  async function loadOrCreate(name: string): Promise<CollectionFile> {
    return (await load(name)) ?? {
      version: 1,
      name,
      created: new Date().toISOString(),
      docs: {},
    };
  }

  /** Serialize writes per collection; atomic publish via tmp + rename. */
  function persist(cf: CollectionFile): Promise<void> {
    const prev = writeChains.get(cf.name) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(rootDir, { recursive: true });
      const tmp = `${fileFor(cf.name)}.tmp`;
      await writeFile(tmp, JSON.stringify(cf));
      await rename(tmp, fileFor(cf.name));
    });
    writeChains.set(cf.name, next.catch(() => {}));
    return next;
  }

  async function collectionNames(): Promise<string[]> {
    await mkdir(rootDir, { recursive: true });
    return (await readdir(rootDir))
      .filter(f => f.endsWith('.json'))
      .map(f => decodeURIComponent(f.slice(0, -5)));
  }

  function toResult(cf: CollectionFile, id: string): DocumentResult {
    const doc = cf.docs[id];
    return { id, content: doc.content, metadata: fromChroma(doc.metadata) };
  }

  return {
    kind: 'local',

    async listCollections(): Promise<Collection[]> {
      const names = await collectionNames();
      return names.map(name => ({ id: name, name }));
    },

    async createCollection(name: string, metadata?: Record<string, any>): Promise<void> {
      if (await load(name)) throw new Error(`Collection "${name}" already exists`);
      const cf = await loadOrCreate(name);
      cache.set(name, cf);
      await persist(cf);
    },

    async deleteCollection(name: string): Promise<void> {
      cache.delete(name);
      writeChains.delete(name);
      await rm(fileFor(name), { force: true });
    },

    async getCollectionCount(name: string): Promise<number> {
      const cf = await load(name);
      return cf ? Object.keys(cf.docs).length : 0;
    },

    async getOrCreateCollection(name: string): Promise<string> {
      if (!(await load(name))) {
        const cf = await loadOrCreate(name);
        cache.set(name, cf);
        await persist(cf);
      }
      return name;
    },

    async addDocument(collection: string, id: string, content: string, metadata: Record<string, any>): Promise<void> {
      const cf = await loadOrCreate(collection);
      cache.set(collection, cf);
      const embedding = await generateEmbedding(content);
      cf.docs[id] = {
        content,
        metadata: toChroma(metadata),
        embedding,
        embedding_model: embedderId(),
      };
      await persist(cf);
    },

    async addDocumentsBatch(collection, documents): Promise<void> {
      const cf = await loadOrCreate(collection);
      cache.set(collection, cf);
      for (const d of documents) {
        cf.docs[d.id] = {
          content: d.content,
          metadata: toChroma(d.metadata),
          embedding: await generateEmbedding(d.content),
          embedding_model: embedderId(),
        };
      }
      await persist(cf);
    },

    async queryDocuments(collection, queryText, nResults = 5, filter): Promise<QueryResult[]> {
      const cf = await load(collection);
      if (!cf) return [];
      const qe = await generateEmbedding(queryText);
      const model = embedderId();
      const out: QueryResult[] = [];
      for (const [id, doc] of Object.entries(cf.docs)) {
        if (doc.embedding_model !== model) continue; // never mix vector spaces
        if (!matchesFilter(doc.metadata, filter)) continue;
        out.push({ ...toResult(cf, id), distance: cosineDistance(qe, doc.embedding) });
      }
      out.sort((a, b) => a.distance - b.distance);
      return out.slice(0, nResults);
    },

    async queryAllCollections(queryText, nResults = 5, filter): Promise<CrossCollectionResult[]> {
      const qe = await generateEmbedding(queryText);
      const model = embedderId();
      const out: CrossCollectionResult[] = [];
      for (const name of await collectionNames()) {
        const cf = await load(name);
        if (!cf) continue;
        for (const [id, doc] of Object.entries(cf.docs)) {
          if (doc.embedding_model !== model) continue;
          if (!matchesFilter(doc.metadata, filter)) continue;
          out.push({ ...toResult(cf, id), distance: cosineDistance(qe, doc.embedding), collection: name });
        }
      }
      out.sort((a, b) => a.distance - b.distance);
      return out.slice(0, nResults);
    },

    async getDocumentsByFilter(collection, filter, limit = 1000): Promise<DocumentResult[]> {
      const cf = await load(collection);
      if (!cf) return [];
      const out: DocumentResult[] = [];
      for (const id of Object.keys(cf.docs)) {
        if (out.length >= limit) break;
        if (matchesFilter(cf.docs[id].metadata, filter)) out.push(toResult(cf, id));
      }
      return out;
    },

    async getDocumentsByIds(collection, ids): Promise<DocumentResult[]> {
      const cf = await load(collection);
      if (!cf) return [];
      return ids.filter(id => cf.docs[id]).map(id => toResult(cf, id));
    },

    async updateDocument(collection, id, metadata): Promise<void> {
      const cf = await load(collection);
      if (!cf?.docs[id]) throw new Error(`Document "${id}" not found in collection "${collection}"`);
      cf.docs[id].metadata = toChroma(metadata);
      await persist(cf);
    },

    async deleteDocument(collection, id): Promise<void> {
      const cf = await load(collection);
      if (!cf) return;
      if (delete cf.docs[id]) await persist(cf);
    },

    async findAndDeleteDocument(id): Promise<string> {
      for (const name of await collectionNames()) {
        const cf = await load(name);
        if (cf?.docs[id]) {
          delete cf.docs[id];
          await persist(cf);
          return name;
        }
      }
      throw new Error(`Document "${id}" not found in any collection`);
    },
  };
}
