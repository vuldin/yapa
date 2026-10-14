import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the Postgres seam: assert what the push after a merge would write.
vi.mock('../sync/postgres.js', () => ({
  upsertRemoteDocument: vi.fn(async () => {}),
  findSimilarRemote: vi.fn(async () => []),
  addRemoteRelatedIds: vi.fn(async () => {}),
  deleteRemoteDocuments: vi.fn(async () => 0),
  getRemoteCreatedAt: vi.fn(async () => undefined),
  getRemoteMaxTaskNumber: vi.fn(async () => 0),
  getRemoteOwnersByIds: vi.fn(async () => new Map()),
}));

import { upsertRemoteDocument, deleteRemoteDocuments } from '../sync/postgres.js';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setSyncBackend } from '../sync/backend.js';
import { PostgresBackend } from '../sync/postgres-backend.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, getDocumentsByFilter } from '../store/index.js';
import { getPendingDeletes, getLocalTombstones } from '../sync/deletes.js';
import { getSyncSubscriptions, updateSyncSubscriptions } from '../sync/sentinel.js';
import { pushToRemote } from '../sync/push.js';
import { mergeCollections, removeCollection, CollectionDeleteRefusedError } from './manage.js';

let dir: string;
const names = async () => (await getStore().listCollections()).map(c => c.name);
const all = (col: string) => getDocumentsByFilter(col, {}, 1000);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-manage-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true' }));
  setStore(createLocalStore(dir));
  setSyncBackend(new PostgresBackend());
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
  setSyncBackend(undefined);
});

describe('mergeCollections', () => {
  const seed = async () => {
    const store = getStore();
    await store.createCollection('customer-old');
    await store.createCollection('customer-new');
    await store.addDocument('customer-old', 'mem-1', 'cluster runs 3 brokers', {
      type: 'memory', origin_user: 'tester', created_at: 1_800_000_000, salience: 3.5, tags: ['infra', 'brokers'],
      related_ids: ['mem-x'], is_synced: true,
    });
    await store.addDocument('customer-old', 'mem-2', 'teammate note on tiered storage', {
      type: 'memory', origin_user: 'teammate', created_at: 1_800_000_100, salience: 2, is_synced: true,
    });
    await store.addDocument('customer-old', 'tester-7', 'send the upgrade plan', {
      type: 'task', id: 'tester-7', status: 'pending', origin_user: 'tester', created_at: 1_800_000_200, is_synced: true,
    });
    await store.addDocument('customer-old', 'jrnl-1', 'session journal', { type: 'journal', origin_user: 'tester', is_synced: true });
    await store.addDocument('customer-new', 'mem-9', 'already here', { type: 'memory', origin_user: 'tester', is_synced: true });
    await updateSyncSubscriptions([...(await getSyncSubscriptions()), 'customer-old', 'customer-new']);
  };

  it('dry_run reports counts and changes nothing', async () => {
    await seed();
    const before = await all('customer-old');
    const r = await mergeCollections('customer-old', 'customer-new', { dryRun: true });
    expect(r).toMatchObject({ moved: 4, dryRun: true, sourceRemoved: false, byType: { memory: 2, task: 1, journal: 1 } });
    expect(await all('customer-old')).toEqual(before);
    expect((await all('customer-new')).map(d => d.id)).toEqual(['mem-9']);
  });

  it('moves every doc with ids and metadata intact, unsynced, then removes the source', async () => {
    const before = await all('customer-old');
    const r = await mergeCollections('customer-old', 'customer-new');
    expect(r).toMatchObject({ moved: 4, dryRun: false, sourceRemoved: true, teammateRowsKept: 0 });

    const moved = await getDocumentsByIds('customer-new', before.map(d => d.id));
    expect(moved).toHaveLength(4);
    for (const b of before) {
      const m = moved.find(d => d.id === b.id)!;
      expect(m.content).toBe(b.content);
      expect(m.metadata).toEqual({ ...b.metadata, is_synced: false });
    }
    expect((await all('customer-new')).length).toBe(5);
    expect(await names()).not.toContain('customer-old');
    expect(await getSyncSubscriptions()).not.toContain('customer-old');
    // A move, not a delete: nothing is queued for remote deletion or tombstoned.
    expect((await getPendingDeletes()).filter(e => before.some(b => e.endsWith(`:${b.id}`)))).toEqual([]);
    expect([...(await getLocalTombstones())].filter(id => before.some(b => b.id === id))).toEqual([]);
  });

  it('the next push relocates each moved doc remotely under its id (upsert into the target, no deletes)', async () => {
    vi.mocked(upsertRemoteDocument).mockClear();
    vi.mocked(deleteRemoteDocuments).mockClear();
    await pushToRemote();
    const pushed = vi.mocked(upsertRemoteDocument).mock.calls.map(c => c[0] as any);
    expect(pushed.map(p => p.id).sort()).toEqual(['jrnl-1', 'mem-1', 'mem-2', 'tester-7']);
    expect(pushed.every(p => p.collection === 'customer-new')).toBe(true);
    expect(deleteRemoteDocuments).not.toHaveBeenCalled();
  });

  it('refuses private -> shared merges (privacy) and leaves both collections alone', async () => {
    await getStore().createCollection('private-scratch');
    await getStore().addDocument('private-scratch', 'p-1', 'personal note', { type: 'memory' });
    await expect(mergeCollections('private-scratch', 'customer-new')).rejects.toThrow(/private.*shared/s);
    await expect(mergeCollections('private-scratch', 'customer-new', { dryRun: true })).rejects.toThrow(/private/);
    expect((await all('private-scratch')).map(d => d.id)).toEqual(['p-1']);
    expect(await getDocumentsByIds('customer-new', ['p-1'])).toEqual([]);
  });

  it('allows private -> private', async () => {
    await getStore().createCollection('local-archive');
    const r = await mergeCollections('private-scratch', 'local-archive');
    expect(r.moved).toBe(1);
    expect((await all('local-archive')).map(d => d.id)).toEqual(['p-1']);
    expect(await names()).not.toContain('private-scratch');
  });

  it('requires an existing target and refuses id clashes without moving anything', async () => {
    await expect(mergeCollections('customer-new', 'customer-missing')).rejects.toThrow(/does not exist/);
    await getStore().createCollection('customer-dup');
    await getStore().addDocument('customer-dup', 'mem-1', 'same id, other doc', { type: 'memory' });
    await expect(mergeCollections('customer-dup', 'customer-new')).rejects.toThrow(/already holds 1 id/);
    expect((await all('customer-dup')).map(d => d.id)).toEqual(['mem-1']);
  });
});

describe('removeCollection guard', () => {
  it('refuses a non-empty shared collection without confirm, with the count and the merge pointer', async () => {
    await getStore().createCollection('project-keep');
    await getStore().addDocument('project-keep', 'k-1', 'one', { type: 'memory', origin_user: 'tester' });
    await getStore().addDocument('project-keep', 'k-2', 'two', { type: 'memory', origin_user: 'tester' });

    const err = await removeCollection('project-keep').catch(e => e);
    expect(err).toBeInstanceOf(CollectionDeleteRefusedError);
    expect(err.message).toMatch(/2 documents/);
    expect(err.message).toMatch(/EVERY teammate/);
    expect(err.message).toMatch(/collection_merge/);
    await expect(removeCollection('project-keep', { confirm: 'project-kee' })).rejects.toThrow(/Refused/);
    expect(await names()).toContain('project-keep');
    expect(await getPendingDeletes()).not.toContain('project-keep:k-1');
  });

  it('deletes it with confirm set to the exact name', async () => {
    await removeCollection('project-keep', { confirm: 'project-keep' });
    expect(await names()).not.toContain('project-keep');
    expect(await getPendingDeletes()).toEqual(expect.arrayContaining(['project-keep:k-1', 'project-keep:k-2']));
  });

  it('keeps the old behavior for local-only and empty collections', async () => {
    await getStore().createCollection('private-tmp');
    await getStore().addDocument('private-tmp', 't-1', 'scratch', { type: 'memory' });
    await removeCollection('private-tmp');
    await getStore().createCollection('project-empty');
    await removeCollection('project-empty');
    const left = await names();
    expect(left).not.toContain('private-tmp');
    expect(left).not.toContain('project-empty');
  });
});
