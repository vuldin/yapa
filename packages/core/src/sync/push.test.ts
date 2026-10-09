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
  getRemoteCreatedAt: vi.fn(async () => undefined),
  getRemoteMaxTaskNumber: vi.fn(async () => 0),
}));

import { upsertRemoteDocument, findSimilarRemote, addRemoteRelatedIds, deleteRemoteDocuments, getRemoteCreatedAt, getRemoteMaxTaskNumber } from './postgres.js';
import { getNextTaskId } from '../tasks/create.js';
import { getDocumentsByIds } from '../store/index.js';
import { queueSyncDelete } from './deletes.js';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByFilter } from '../store/index.js';
import { pushToRemote } from './push.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-sync-test-'));
  setConfig(createConfig({ ...process.env, YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A' }));
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

  it('stamps the pushing device as origin_device', async () => {
    vi.mocked(upsertRemoteDocument).mockClear();
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('global', 'mem-4', 'stamped with the device', { type: 'memory', is_synced: false });

    await pushToRemote();
    const pushed = vi.mocked(upsertRemoteDocument).mock.calls.find(c => (c[0] as any).id === 'mem-4')![0] as any;
    expect(pushed.metadata.origin_device).toBe('dev-A');
  });

  it('never links a re-pushed doc to its own remote row', async () => {
    vi.mocked(addRemoteRelatedIds).mockClear();
    vi.mocked(findSimilarRemote).mockResolvedValueOnce([{ id: 'mem-5', similarity: 0.99 } as any]);
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('global', 'mem-5', 'edited after the first push', { type: 'memory', is_synced: false });

    const stats = await pushToRemote();
    expect(stats.linked).toBe(0);
    expect(stats.pushed).toBe(1);
    expect(addRemoteRelatedIds).not.toHaveBeenCalled();
  });

  it('propagates queued deletes scoped to the pushing user', async () => {
    vi.mocked(deleteRemoteDocuments).mockClear();
    await queueSyncDelete('mem-1', 'global');

    await pushToRemote();
    expect(deleteRemoteDocuments).toHaveBeenCalledWith(['mem-1'], 'tester');
  });

  it('never overwrites a different remote task that has the same id: renames the local one', async () => {
    vi.mocked(upsertRemoteDocument).mockClear();
    const store = (await import('../store/index.js')).getStore();
    await store.createCollection('customer-acme');
    await store.addDocument('customer-acme', 'tester-5', 'new task after a wipe', { type: 'task', id: 'tester-5', created_at: 2_000_000_000, is_synced: false });
    vi.mocked(getRemoteCreatedAt).mockImplementation(async (id: string) => (id === 'tester-5' ? 1_700_000_000 : undefined));
    vi.mocked(getRemoteMaxTaskNumber).mockResolvedValue(40);

    await pushToRemote();

    const pushedIds = vi.mocked(upsertRemoteDocument).mock.calls.map(c => (c[0] as any).id);
    expect(pushedIds).not.toContain('tester-5');
    expect(pushedIds).toContain('tester-41');
    expect(await getDocumentsByIds('customer-acme', ['tester-5'])).toEqual([]);
    const [renamed] = await getDocumentsByIds('customer-acme', ['tester-41']);
    expect(renamed.metadata).toMatchObject({ id: 'tester-41', rekeyed_from: 'tester-5' });
    vi.mocked(getRemoteCreatedAt).mockResolvedValue(undefined);
  });

  it('pushes a task update normally when the remote row is the same task', async () => {
    vi.mocked(upsertRemoteDocument).mockClear();
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('customer-acme', 'tester-7', 'same task, edited', { type: 'task', id: 'tester-7', created_at: 1_900_000_000, is_synced: false });
    vi.mocked(getRemoteCreatedAt).mockImplementation(async (id: string) => (id === 'tester-7' ? 1_900_000_000 : undefined));
    await pushToRemote();
    expect(vi.mocked(upsertRemoteDocument).mock.calls.map(c => (c[0] as any).id)).toContain('tester-7');
    vi.mocked(getRemoteCreatedAt).mockResolvedValue(undefined);
  });
});

describe('getNextTaskId with sync', () => {
  it('skips numbers already used on the shared database', async () => {
    setConfig(createConfig({ ...process.env, YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: 'postgres://x' }));
    vi.mocked(getRemoteMaxTaskNumber).mockResolvedValueOnce(300);
    expect(await getNextTaskId()).toBe('tester-301');
    setConfig(createConfig({ ...process.env, YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A' }));
  });
});
