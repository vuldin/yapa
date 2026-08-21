import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalStore } from './local-adapter.js';
import type { VectorStore } from './types.js';

let dir: string;
let store: VectorStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-local-store-'));
  store = createLocalStore(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('local store', () => {
  it('creates, lists, and counts collections', async () => {
    await store.createCollection('alpha');
    const cols = await store.listCollections();
    expect(cols.map(c => c.name)).toContain('alpha');
    expect(await store.getCollectionCount('alpha')).toBe(0);
  });

  it('rejects duplicate collection creation', async () => {
    await expect(store.createCollection('alpha')).rejects.toThrow('already exists');
  });

  it('stores and retrieves documents by filter and id', async () => {
    await store.addDocument('alpha', 'doc-1', 'the sky is blue', { type: 'memory', salience: 2.0, tags: ['a', 'b'] });
    await store.addDocument('alpha', 'doc-2', 'rust ownership rules', { type: 'memory', salience: 1.0, tags: ['c'] });
    await store.addDocument('alpha', 'task-1', 'a task body', { type: 'task', status: 'pending' });

    expect(await store.getCollectionCount('alpha')).toBe(3);

    const memories = await store.getDocumentsByFilter('alpha', { type: 'memory' });
    expect(memories.map(d => d.id).sort()).toEqual(['doc-1', 'doc-2']);
    // metadata round-trips through the chroma adapter shape (arrays rejoin)
    expect(memories.find(d => d.id === 'doc-1')?.metadata.tags).toEqual(['a', 'b']);

    const byId = await store.getDocumentsByIds('alpha', ['doc-2', 'missing']);
    expect(byId.map(d => d.id)).toEqual(['doc-2']);

    const eqOp = await store.getDocumentsByFilter('alpha', { type: { $eq: 'task' } });
    expect(eqOp.map(d => d.id)).toEqual(['task-1']);
  });

  it('answers semantic queries with cosine distances in [0, 2], best first', async () => {
    const results = await store.queryDocuments('alpha', 'what color is the sky', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('doc-1');
    for (const r of results) {
      expect(r.distance).toBeGreaterThanOrEqual(0);
      expect(r.distance).toBeLessThanOrEqual(2);
    }
    // ascending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('filters during vector queries', async () => {
    const results = await store.queryDocuments('alpha', 'sky', 5, { type: 'task' });
    expect(results.every(r => r.metadata.type === 'task')).toBe(true);
  });

  it('updates metadata wholesale and deletes documents', async () => {
    await store.updateDocument('alpha', 'doc-2', { type: 'memory', salience: 4.5 });
    const [doc] = await store.getDocumentsByIds('alpha', ['doc-2']);
    expect(doc.metadata.salience).toBe(4.5);
    expect(doc.metadata.tags).toBeUndefined(); // replacement, not merge

    await store.deleteDocument('alpha', 'task-1');
    expect(await store.getCollectionCount('alpha')).toBe(2);
  });

  it('persists across store instances (reopen from disk)', async () => {
    const reopened = createLocalStore(dir);
    const doc = (await reopened.getDocumentsByIds('alpha', ['doc-1']))[0];
    expect(doc.content).toBe('the sky is blue');
    const results = await reopened.queryDocuments('alpha', 'blue sky', 1);
    expect(results[0]?.id).toBe('doc-1');
  });

  it('findAndDeleteDocument resolves the owning collection', async () => {
    await store.createCollection('beta');
    await store.addDocument('beta', 'shared-id', 'in beta', { type: 'memory' });
    const owner = await store.findAndDeleteDocument('shared-id');
    expect(owner).toBe('beta');
    expect(await store.getCollectionCount('beta')).toBe(0);
  });

  it('never mixes vector spaces (embedding_model partition)', async () => {
    // Tamper one document's embedding_model on disk, then query: it must be skipped.
    const file = join(dir, 'alpha.json');
    const raw = JSON.parse(await readFile(file, 'utf-8'));
    raw.docs['doc-1'].embedding_model = 'other-provider:other-model';
    await writeFile(file, JSON.stringify(raw));

    const fresh = createLocalStore(dir);
    const results = await fresh.queryDocuments('alpha', 'what color is the sky', 5);
    expect(results.map(r => r.id)).not.toContain('doc-1');
  });

  it('supports queryAllCollections across stores on disk', async () => {
    const fresh = createLocalStore(dir);
    const results = await fresh.queryAllCollections('rust ownership', 10, { type: 'memory' });
    const cols = new Set(results.map(r => r.collection));
    expect(cols.has('alpha')).toBe(true);
  });

  it('batch-updates metadata in one flush, skipping unknown ids', async () => {
    await store.addDocument('alpha', 'b1', 'batch one', { type: 'memory', salience: 1 });
    await store.addDocument('alpha', 'b2', 'batch two', { type: 'memory', salience: 1 });
    await store.updateDocumentsBatch('alpha', [
      { id: 'b1', metadata: { type: 'memory', salience: 3 } },
      { id: 'b2', metadata: { type: 'memory', salience: 4 } },
      { id: 'missing', metadata: { type: 'memory' } }, // unknown ids are skipped
    ]);
    const docs = await store.getDocumentsByIds('alpha', ['b1', 'b2']);
    expect(docs.map(d => d.metadata.salience).sort()).toEqual([3, 4]);
  });

  it('sees another process\'s writes (mtime freshness)', async () => {
    // Two store instances over one directory simulate two DSH processes.
    const procA = createLocalStore(dir);
    const procB = createLocalStore(dir);
    await procA.createCollection('shared');
    await procA.addDocument('shared', 'from-a', 'written by process A', { type: 'memory' });

    // B has never loaded 'shared' — reads straight from disk.
    expect((await procB.getDocumentsByIds('shared', ['from-a'])).length).toBe(1);

    // A writes again while B holds a warm cache; B must notice via mtime.
    await procB.getDocumentsByIds('shared', ['from-a']); // populate B's cache
    await procA.addDocument('shared', 'from-a2', 'second write by A', { type: 'memory' });
    expect((await procB.getDocumentsByIds('shared', ['from-a2'])).length).toBe(1);

    // A's deletion is visible to B as well.
    await procA.deleteCollection('shared');
    expect(await procB.getCollectionCount('shared')).toBe(0);
  });
});
