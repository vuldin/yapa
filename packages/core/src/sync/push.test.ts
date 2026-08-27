import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the Postgres seam: assert what the push would write, without a server.
vi.mock('./postgres.js', () => ({
  upsertRemoteDocument: vi.fn(async () => {}),
  findSimilarRemote: vi.fn(async () => []),
  addRemoteRelatedIds: vi.fn(async () => {}),
  deleteRemoteDocuments: vi.fn(async () => 0),
}));

import { upsertRemoteDocument, findSimilarRemote } from './postgres.js';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByFilter } from '../store/index.js';
import { pushToRemote } from './push.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-sync-test-'));
  process.env.YAPA_USERNAME = 'tester';
  setConfig(createConfig(process.env));
  setStore(createLocalStore(dir));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('pushToRemote over the local store', () => {
  it('pushes unsynced docs via the store port, skips private/local collections and sentinels', async () => {
    const store = (await import('../store/index.js')).getStore();
    await store.createCollection('global');
    await store.createCollection('private-notes');
    await store.addDocument('global', 'mem-1', 'deploy runs on port 3100', { type: 'memory', is_synced: false });
    await store.addDocument('global', '__decay_sentinel__', 'sentinel', { type: 'decay_sentinel', is_synced: false });
    await store.addDocument('private-notes', 'mem-2', 'never synced', { type: 'memory', is_synced: false });

    const stats = await pushToRemote();

    expect(stats.errors).toBe(0);
    expect(stats.pushed).toBe(1);
    expect(upsertRemoteDocument).toHaveBeenCalledTimes(1);
    expect(findSimilarRemote).toHaveBeenCalledOnce();

    const pushed = vi.mocked(upsertRemoteDocument).mock.calls[0][0] as any;
    expect(pushed.id).toBe('mem-1');
    expect(pushed.collection).toBe('global');
    expect(pushed.origin_user).toBe('tester');
    expect(Array.isArray(pushed.embedding) && pushed.embedding.length).toBeGreaterThan(0);

    // The local doc was marked synced through the store port.
    const after = await getDocumentsByFilter('global', { is_synced: false }, 10);
    expect(after.map(d => d.id)).toEqual(['__decay_sentinel__']); // sentinel untouched, mem-1 now synced
  });

  it('links instead of duplicating when the remote has a similar doc', async () => {
    vi.mocked(findSimilarRemote).mockResolvedValueOnce([{ id: 'remote-9' } as any]);
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('global', 'mem-3', 'teammate already knows this', { type: 'memory', is_synced: false });

    const stats = await pushToRemote();
    expect(stats.linked).toBe(1);
    expect(stats.pushed).toBe(0);

    // Local doc gained the remote related_id and is synced.
    const [doc] = (await getDocumentsByFilter('global', {}, 10)).filter(d => d.id === 'mem-3');
    expect(doc.metadata.is_synced).toBe(true);
    expect(String(doc.metadata.related_ids)).toContain('remote-9');
  });
});
