/**
 * Embedded, serverless VectorStore: one JSON file per collection under a
 * root directory, atomic writes (a uniquely named tmp file + rename), and
 * brute-force cosine search — sufficient well past yapa's personal-memory
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
 * Several processes share one store (each Claude Code session's MCP server,
 * the hooks, the CLI). Every mutation therefore runs under the collection
 * file's lock (fs-lock.ts) against a fresh read of the file, so one process
 * never writes back a copy that lacks another's change. Embeddings are
 * computed before the lock is taken, keeping it to a read and a write.
 *
 * @module @yapa/core/store/local-adapter
 */
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateEmbedding } from '../embeddings.js';
import { getConfig, getEmbeddingModel } from '../config.js';
import { lockFileFor, withFileLock } from '../fs-lock.js';
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
  /**
   * Identity of the file as of our last read or write (per collection): its
   * inode and mtime. Every write is a rename of a new file, so a new inode
   * means someone wrote; mtime alone misses writes within one clock tick.
   */
  const cacheMtimes = new Map<string, string>();
  const identity = (st: { ino: number | bigint; mtimeMs: number; size: number }) => `${st.ino}:${st.mtimeMs}:${st.size}`;
  const writeChains = new Map<string, Promise<void>>();

  const fileFor = (name: string) => join(rootDir, `${encodeURIComponent(name)}.json`);

  async function readFromDisk(name: string): Promise<CollectionFile | undefined> {
    try {
      // Read and stat one open file: a rename in between can't pair this
      // content with the next file's identity.
      const fh = await open(fileFor(name), 'r');
      let raw: string;
      let id: string;
      try {
        id = identity(await fh.stat());
        raw = await fh.readFile('utf-8');
      } finally {
        await fh.close();
      }
      const parsed = JSON.parse(raw) as CollectionFile;
      if (parsed.version !== 1) throw new Error(`unsupported version ${parsed.version}`);
      cache.set(name, parsed);
      cacheMtimes.set(name, id);
      return parsed;
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        cache.delete(name);
        cacheMtimes.delete(name);
        return undefined;
      }
      throw new Error(`local store: collection "${name}" is unreadable: ${e.message ?? e}`);
    }
  }

  /**
   * Load a collection for reading, reloading from disk when another process
   * rewrote the file since our last read or write. Writes are atomic renames,
   * so a reader sees one whole revision or the next. Writers don't use this:
   * they go through mutate(), which re-reads under the lock.
   */
  async function load(name: string): Promise<CollectionFile | undefined> {
    const cached = cache.get(name);
    if (!cached) return readFromDisk(name);
    try {
      const st = await stat(fileFor(name));
      if (identity(st) !== cacheMtimes.get(name)) return readFromDisk(name);
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        cache.delete(name);
        cacheMtimes.delete(name);
        return undefined;
      }
      throw e;
    }
    return cached;
  }

  const fresh = (name: string): CollectionFile => ({ version: 1, name, created: new Date().toISOString(), docs: {} });

  async function writeAtomic(cf: CollectionFile): Promise<void> {
    await mkdir(rootDir, { recursive: true });
    const file = fileFor(cf.name);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(cf));
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    cache.set(cf.name, cf);
    // Our own write's mtime, taken under the lock: nobody else wrote since.
    cacheMtimes.set(cf.name, identity(await stat(file)));
  }

  /**
   * Change one collection: in this process one change at a time per
   * collection, and across processes under the file's lock, always applied
   * to the file as it is on disk now. `apply` gets the current file
   * (undefined: none yet) and returns the file to write, or false to write
   * nothing.
   */
  function mutate(name: string, apply: (cf: CollectionFile | undefined) => CollectionFile | false): Promise<void> {
    const prev = writeChains.get(name) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(rootDir, { recursive: true });
      await withFileLock(lockFileFor(fileFor(name)), async () => {
        const cur = await readFromDisk(name);
        const out = apply(cur);
        if (out) await writeAtomic(out);
      }, { waitMs: 15_000 });
    });
    writeChains.set(name, next.catch(() => {}));
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
      await mutate(name, cur => {
        if (cur) throw new Error(`Collection "${name}" already exists`);
        return fresh(name);
      });
    },

    async deleteCollection(name: string): Promise<void> {
      await mkdir(rootDir, { recursive: true });
      await withFileLock(lockFileFor(fileFor(name)), async () => {
        await rm(fileFor(name), { force: true });
      }, { waitMs: 15_000 });
      cache.delete(name);
      cacheMtimes.delete(name);
      writeChains.delete(name);
    },

    async getCollectionCount(name: string): Promise<number> {
      const cf = await load(name);
      return cf ? Object.keys(cf.docs).length : 0;
    },

    async getOrCreateCollection(name: string): Promise<string> {
      if (!(await load(name))) await mutate(name, cur => cur ?? fresh(name));
      return name;
    },

    async addDocument(collection: string, id: string, content: string, metadata: Record<string, any>): Promise<void> {
      const doc: LocalDoc = { content, metadata: toChroma(metadata), embedding: await generateEmbedding(content), embedding_model: embedderId() };
      await mutate(collection, cur => {
        const cf = cur ?? fresh(collection);
        cf.docs[id] = doc;
        return cf;
      });
    },

    async addDocumentsBatch(collection, documents): Promise<void> {
      const docs: Array<[string, LocalDoc]> = [];
      for (const d of documents) {
        docs.push([d.id, { content: d.content, metadata: toChroma(d.metadata), embedding: await generateEmbedding(d.content), embedding_model: embedderId() }]);
      }
      await mutate(collection, cur => {
        const cf = cur ?? fresh(collection);
        for (const [id, doc] of docs) cf.docs[id] = doc;
        return cf;
      });
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
      await mutate(collection, cf => {
        if (!cf?.docs[id]) throw new Error(`Document "${id}" not found in collection "${collection}"`);
        cf.docs[id].metadata = toChroma(metadata);
        return cf;
      });
    },

    async updateDocumentsBatch(collection, entries): Promise<void> {
      if (entries.length === 0) return;
      await mutate(collection, cf => {
        if (!cf) throw new Error(`Collection "${collection}" not found`);
        let changed = 0;
        for (const e of entries) {
          if (!cf.docs[e.id]) continue;
          cf.docs[e.id].metadata = toChroma(e.metadata);
          changed++;
        }
        return changed > 0 ? cf : false; // one flush for the whole sweep
      });
    },

    async deleteDocument(collection, id): Promise<void> {
      await mutate(collection, cf => (cf && cf.docs[id] && delete cf.docs[id] ? cf : false));
    },

    async findAndDeleteDocument(id): Promise<string> {
      for (const name of await collectionNames()) {
        if (!(await load(name))?.docs[id]) continue;
        let deleted = false;
        await mutate(name, cf => {
          if (!cf?.docs[id]) return false;
          delete cf.docs[id];
          deleted = true;
          return cf;
        });
        if (deleted) return name;
      }
      throw new Error(`Document "${id}" not found in any collection`);
    },
  };
}
