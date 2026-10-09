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
  getRemoteOwnersByIds: vi.fn(async () => new Map()),
}));

import { upsertRemoteDocument, findSimilarRemote, addRemoteRelatedIds, deleteRemoteDocuments, getRemoteCreatedAt, getRemoteMaxTaskNumber, getRemoteOwnersByIds } from './postgres.js';
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
  it('pushes unsynced docs via the store port, skips global/private/local collections and sentinels', async () => {
    const store = (await import('../store/index.js')).getStore();
    await store.createCollection('project-acme');
    await store.createCollection('private-notes');
    await store.addDocument('project-acme', 'mem-1', 'deploy runs on port 3100', { type: 'memory', is_synced: false });
    await store.addDocument('project-acme', '__decay_sentinel__', 'sentinel', { type: 'decay_sentinel', is_synced: false });
    await store.addDocument('private-notes', 'mem-2', 'never synced', { type: 'memory', is_synced: false });
    await store.createCollection('global');
    await store.addDocument('global', 'mem-g', 'my writing style', { type: 'memory', is_synced: false });

    const stats = await pushToRemote();

    expect(stats.errors).toBe(0);
    expect(stats.pushed).toBe(1);
    expect(upsertRemoteDocument).toHaveBeenCalledTimes(1);
    expect(findSimilarRemote).toHaveBeenCalledOnce();

    const pushed = vi.mocked(upsertRemoteDocument).mock.calls[0][0] as any;
    expect(pushed.id).toBe('mem-1');
    expect(pushed.collection).toBe('project-acme');
    expect(pushed.origin_user).toBe('tester');
    expect(Array.isArray(pushed.embedding) && pushed.embedding.length).toBeGreaterThan(0);

    // The local doc was marked synced through the store port.
    const after = await getDocumentsByFilter('project-acme', { is_synced: false }, 10);
    expect(after.map(d => d.id)).toEqual(['__decay_sentinel__']); // sentinel untouched, mem-1 now synced
  });

  it('links instead of duplicating when the remote has a similar doc', async () => {
    vi.mocked(findSimilarRemote).mockResolvedValueOnce([{ id: 'remote-9' } as any]);
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('project-acme', 'mem-3', 'teammate already knows this', { type: 'memory', is_synced: false });

    const stats = await pushToRemote();
    expect(stats.linked).toBe(1);
    expect(stats.pushed).toBe(0);

    // Local doc gained the remote related_id and is synced.
    const [doc] = (await getDocumentsByFilter('project-acme', {}, 10)).filter(d => d.id === 'mem-3');
    expect(doc.metadata.is_synced).toBe(true);
    expect(String(doc.metadata.related_ids)).toContain('remote-9');
  });

  it('stamps the pushing device as origin_device', async () => {
    vi.mocked(upsertRemoteDocument).mockClear();
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('project-acme', 'mem-4', 'stamped with the device', { type: 'memory', is_synced: false });

    await pushToRemote();
    const pushed = vi.mocked(upsertRemoteDocument).mock.calls.find(c => (c[0] as any).id === 'mem-4')![0] as any;
    expect(pushed.metadata.origin_device).toBe('dev-A');
  });

  it('never links a re-pushed doc to its own remote row', async () => {
    vi.mocked(addRemoteRelatedIds).mockClear();
    vi.mocked(findSimilarRemote).mockResolvedValueOnce([{ id: 'mem-5', similarity: 0.99 } as any]);
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('project-acme', 'mem-5', 'edited after the first push', { type: 'memory', is_synced: false });

    const stats = await pushToRemote();
    expect(stats.linked).toBe(0);
    expect(stats.pushed).toBe(1);
    expect(addRemoteRelatedIds).not.toHaveBeenCalled();
  });

  it('keeps a delete queued while the remote delete is in flight', async () => {
    await queueSyncDelete('mem-early', 'project-acme');
    vi.mocked(deleteRemoteDocuments).mockImplementationOnce(async () => {
      await queueSyncDelete('mem-late', 'project-acme');
      return 1;
    });
    await pushToRemote();
    const { getPendingDeletes } = await import('./deletes.js');
    expect(await getPendingDeletes()).toEqual(['project-acme:mem-late']);
    vi.mocked(deleteRemoteDocuments).mockClear();
    await pushToRemote();
    expect(deleteRemoteDocuments).toHaveBeenCalledWith(['mem-late'], 'tester');
  });

  it('propagates queued deletes scoped to the pushing user', async () => {
    vi.mocked(deleteRemoteDocuments).mockClear();
    await queueSyncDelete('mem-1', 'project-acme');

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

describe('docs that now live in a private collection', () => {
  it('removes this user\'s old shared copies of global docs (global is local-only)', async () => {
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('global', 'mem-g-old', 'synced by an older version', { type: 'memory', created_at: 1_700_000_000, is_synced: true });
    vi.mocked(getRemoteOwnersByIds).mockResolvedValueOnce(new Map([['mem-g-old', { owner: 'tester', createdAt: 1_700_000_000 }]]));
    vi.mocked(deleteRemoteDocuments).mockClear();
    vi.mocked(deleteRemoteDocuments).mockResolvedValue(1);
    await pushToRemote();
    expect(vi.mocked(deleteRemoteDocuments).mock.calls.flatMap(c => c[0])).toContain('mem-g-old');
    vi.mocked(deleteRemoteDocuments).mockResolvedValue(0);
  });

  it('deletes this user\'s shared copy, keeps a teammate\'s row, never pushes the private doc', async () => {
    const store = (await import('../store/index.js')).getStore();
    await store.createCollection('private-moved');
    await store.addDocument('private-moved', 'tester-90', 'my task, moved private', { type: 'task', created_at: 1_800_000_000, is_synced: true });
    await store.addDocument('private-moved', 'mem-mate-1', 'copy of a teammate memory', { type: 'memory', origin_user: 'mate', created_at: 1_800_000_000 });
    vi.mocked(getRemoteOwnersByIds).mockClear();
    vi.mocked(getRemoteOwnersByIds).mockResolvedValue(new Map([['tester-90', { owner: 'tester', createdAt: 1_800_000_000 }], ['mem-mate-1', { owner: 'mate', createdAt: 1_800_000_000 }]]));
    vi.mocked(deleteRemoteDocuments).mockClear();
    vi.mocked(deleteRemoteDocuments).mockResolvedValue(1);
    vi.mocked(upsertRemoteDocument).mockClear();

    const stats = await pushToRemote();

    expect(deleteRemoteDocuments).toHaveBeenCalledWith(['tester-90'], 'tester');
    expect(stats.retracted).toBe(1);
    const pushedIds = vi.mocked(upsertRemoteDocument).mock.calls.map(c => (c[0] as any).id);
    expect(pushedIds).not.toContain('tester-90');
    expect(pushedIds).not.toContain('mem-mate-1');
  });

  it('never retracts a DIFFERENT shared task of mine that reuses the private task\'s id', async () => {
    const store = (await import('../store/index.js')).getStore();
    await store.addDocument('private-moved', 'tester-91', 'private task', { type: 'task', created_at: 1_800_000_000 });
    vi.mocked(getRemoteOwnersByIds).mockResolvedValue(new Map([['tester-91', { owner: 'tester', createdAt: 1_850_000_000 }]]));
    vi.mocked(deleteRemoteDocuments).mockClear();
    await pushToRemote();
    expect(vi.mocked(deleteRemoteDocuments).mock.calls.flatMap(c => c[0])).not.toContain('tester-91');
  });

  it('checks each version once: no remote lookups on the next cycle, again after an edit', async () => {
    vi.mocked(getRemoteOwnersByIds).mockClear();
    vi.mocked(deleteRemoteDocuments).mockClear();
    vi.mocked(deleteRemoteDocuments).mockResolvedValue(0);
    await pushToRemote();
    expect(getRemoteOwnersByIds).not.toHaveBeenCalled();

    const store = (await import('../store/index.js')).getStore();
    const [doc] = await getDocumentsByIds('private-moved', ['tester-90']);
    await store.addDocument('private-moved', 'tester-90', 'edited', { ...doc.metadata, updated_at: 1_900_000_000 });
    await pushToRemote();
    expect(vi.mocked(getRemoteOwnersByIds).mock.calls.at(-1)?.[0]).toEqual(['tester-90']);
    vi.mocked(getRemoteOwnersByIds).mockResolvedValue(new Map());
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
