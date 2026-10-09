import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the Postgres seam: feed the pull canned remote rows, without a server.
vi.mock('./postgres.js', () => ({
  getRemoteDocsSince: vi.fn(async () => []),
  addRemoteRelatedIds: vi.fn(async () => {}),
  getRemoteCollectionsForUser: vi.fn(async () => []),
  getRemoteCollectionsByIds: vi.fn(async () => new Map()),
}));

import { getRemoteDocsSince, getRemoteCollectionsForUser, getRemoteCollectionsByIds } from './postgres.js';
import type { RemoteDocument } from './postgres.js';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { pullFromRemote, pullCollection, isPersonalCollection } from './pull.js';
import { getSyncPullTimestamp, updateSyncPullTimestamp, updateSyncSubscriptions, getSyncSubscriptions } from './sentinel.js';
import { removeCollection } from '../collections/manage.js';
import { getPendingDeletes, getLocalTombstones } from './deletes.js';
import { addLocalTombstone } from './deletes.js';

const mockedRemote = vi.mocked(getRemoteDocsSince);
let dir: string;

function remote(id: string, collection: string, content: string, opts: Partial<RemoteDocument> = {}): RemoteDocument {
  const updated = opts.updated_at ?? new Date(2_000_000_000 * 1000);
  return {
    id,
    collection,
    content,
    embedding: [],
    metadata: { type: 'memory', salience: 2, is_synced: false, ...(opts.metadata ?? {}) },
    origin_user: opts.origin_user ?? 'teammate',
    related_ids: [],
    synced_at: updated,
    created_at: updated,
    updated_at: updated,
  };
}

function configure(env: Record<string, string> = {}) {
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true', ...env }));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-pull-test-'));
  configure();
  setStore(createLocalStore(dir));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

beforeEach(() => {
  configure();
  mockedRemote.mockReset();
  mockedRemote.mockResolvedValue([]);
});

describe('pullCollection', () => {
  it('inserts a teammate doc as synced and attributed', async () => {
    mockedRemote.mockResolvedValueOnce([remote('mem-t1', 'project-acme', 'acme deploys on fridays')]);

    const stats = await pullCollection('project-acme', 0);
    expect(stats.pulled).toBe(1);

    const [doc] = await getDocumentsByIds('project-acme', ['mem-t1']);
    expect(doc.metadata.origin_user).toBe('teammate');
    expect(doc.metadata.is_synced).toBe(true);
  });

  it('identifies itself by user AND device so the same user\'s other machines still sync', async () => {
    await pullCollection('project-acme', 0);
    expect(mockedRemote).toHaveBeenCalledWith('project-acme', 0, { user: 'tester', device: 'dev-A' }, { onlyOwnRows: false, orOwnerShared: false, includeOwnDevice: undefined });
  });

  it('applies a newer remote version over a clean local copy', async () => {
    const t0 = new Date(2_000_000_000 * 1000);
    mockedRemote.mockResolvedValueOnce([remote('task-1', 'project-acme', 'ship it', { updated_at: t0, metadata: { type: 'task', status: 'pending' } })]);
    await pullCollection('project-acme', 0);

    const t1 = new Date((2_000_000_000 + 60) * 1000);
    mockedRemote.mockResolvedValueOnce([remote('task-1', 'project-acme', 'ship it', { updated_at: t1, metadata: { type: 'task', status: 'complete' } })]);
    const stats = await pullCollection('project-acme', 0);

    expect(stats.updated).toBe(1);
    const [doc] = await getDocumentsByIds('project-acme', ['task-1']);
    expect(doc.metadata.status).toBe('complete');
    expect(doc.metadata.is_synced).toBe(true);
  });

  it('keeps a local copy with unpushed edits (it wins on the next push)', async () => {
    await getStore().addDocument('project-acme', 'task-2', 'local edit', {
      type: 'task', status: 'blocked', updated_at: 1_000, is_synced: false,
    });
    mockedRemote.mockResolvedValueOnce([remote('task-2', 'project-acme', 'remote edit', { metadata: { type: 'task', status: 'complete' } })]);

    const stats = await pullCollection('project-acme', 0);
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(1);
    const [doc] = await getDocumentsByIds('project-acme', ['task-2']);
    expect(doc.metadata.status).toBe('blocked');
  });

  it('skips an identical-version re-read (overlap window) without rewriting', async () => {
    mockedRemote.mockResolvedValueOnce([remote('mem-t1', 'project-acme', 'acme deploys on fridays')]);
    const stats = await pullCollection('project-acme', 0);
    expect(stats).toMatchObject({ pulled: 0, updated: 0, skipped: 1 });
  });

  it('never re-inserts a tombstoned teammate doc', async () => {
    await addLocalTombstone('mem-gone');
    mockedRemote.mockResolvedValueOnce([remote('mem-gone', 'project-acme', 'forgotten here')]);

    const stats = await pullCollection('project-acme', 0);
    expect(stats.pulled).toBe(0);
    expect(await getDocumentsByIds('project-acme', ['mem-gone'])).toEqual([]);
  });

  it('never imports another session\'s journal drafts', async () => {
    mockedRemote.mockResolvedValueOnce([remote('journal-josh-s1-1', 'project-acme', 'a draft line', { metadata: { type: 'journal_draft' } })]);
    const stats = await pullCollection('project-acme', 0);
    expect(stats.pulled).toBe(0);
    expect(await getDocumentsByIds('project-acme', ['journal-josh-s1-1'])).toEqual([]);
  });

  it('refuses private-/local- collections outright', async () => {
    await pullCollection('private-notes', 0);
    expect(mockedRemote).not.toHaveBeenCalled();
  });
});

describe('personal collections', () => {
  it('treats global as personal regardless of the reader\'s setting', () => {
    expect(isPersonalCollection('global')).toBe(true);
    expect(isPersonalCollection('project-acme')).toBe(false);
    configure({ YAPA_SYNC_SHARE_GLOBAL: 'true' });
    expect(isPersonalCollection('global')).toBe(true);
  });

  it('pulls only the user\'s own rows into global', async () => {
    await pullCollection('global', 0);
    expect(mockedRemote).toHaveBeenCalledWith('global', 0, { user: 'tester', device: 'dev-A' }, { onlyOwnRows: true, orOwnerShared: false, includeOwnDevice: undefined });
  });

  it('a reader who opts in also gets rows their OWNERS shared, never everyone\'s', async () => {
    configure({ YAPA_SYNC_SHARE_GLOBAL: 'true' });
    await pullCollection('global', 0);
    expect(mockedRemote).toHaveBeenCalledWith('global', 0, { user: 'tester', device: 'dev-A' }, { onlyOwnRows: true, orOwnerShared: true, includeOwnDevice: undefined });
  });
});

describe('pullFromRemote', () => {
  it('stores the cycle START minus the overlap window as the next pull point', async () => {
    configure({ YAPA_SYNC_PULL_OVERLAP_SECONDS: '120' });
    const before = Math.floor(Date.now() / 1000);
    await pullFromRemote();
    const stored = await getSyncPullTimestamp();
    expect(stored).toBeGreaterThanOrEqual(before - 121);
    expect(stored).toBeLessThanOrEqual(before - 119);
  });

  it('backfills a newly subscribed collection from the beginning', async () => {
    await updateSyncPullTimestamp(1_900_000_000);
    await updateSyncSubscriptions(['customer-newco']);

    await pullFromRemote();

    const sinceFor = (name: string) => mockedRemote.mock.calls.find(c => c[0] === name)?.[1];
    expect(sinceFor('customer-newco')).toBe(0);
    expect(sinceFor('project-acme')).toBe(1_900_000_000);
  });
});

describe('recovery after a wiped store', () => {
  it('first-ever pull re-subscribes to every collection the user wrote and accepts own-device rows once', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'yapa-pull-fresh-'));
    setStore(createLocalStore(fresh));
    try {
      vi.mocked(getRemoteCollectionsForUser).mockResolvedValueOnce(['customer-lost', 'private-x']);
      mockedRemote.mockImplementation(async (col: string) =>
        col === 'customer-lost' ? [remote('mem-lost', 'customer-lost', 'restored after the wipe', { origin_user: 'tester' })] : []);

      await pullFromRemote();

      expect(await getSyncSubscriptions()).toEqual(['customer-lost']); // private- never syncs
      const call = mockedRemote.mock.calls.find(c => c[0] === 'customer-lost')!;
      expect(call[1]).toBe(0);
      expect(call[3]).toMatchObject({ includeOwnDevice: true });
      expect((await getDocumentsByIds('customer-lost', ['mem-lost'])).length).toBe(1);

      mockedRemote.mockClear();
      await pullFromRemote(); // normal pulls skip own-device echoes again
      expect(mockedRemote.mock.calls.every(c => !c[3]?.includeOwnDevice)).toBe(true);
    } finally {
      setStore(createLocalStore(dir));
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe('removeCollection under sync', () => {
  it('queues own docs for remote delete, tombstones teammates\' docs, unsubscribes, and is not resurrected', async () => {
    const store = getStore();
    await store.createCollection('customer-gone');
    await store.addDocument('customer-gone', 'mine-1', 'my note', { type: 'memory', origin_user: 'tester' });
    await store.addDocument('customer-gone', 'theirs-1', 'their note', { type: 'memory', origin_user: 'teammate' });
    await updateSyncSubscriptions([...(await getSyncSubscriptions()), 'customer-gone']);

    await removeCollection('customer-gone');

    expect(await getPendingDeletes()).toContain('customer-gone:mine-1');
    expect((await getLocalTombstones()).has('theirs-1')).toBe(true);
    expect(await getSyncSubscriptions()).not.toContain('customer-gone');

    mockedRemote.mockImplementation(async (col: string) =>
      col === 'customer-gone' ? [remote('theirs-1', 'customer-gone', 'their note')] : []);
    await pullFromRemote();
    expect(mockedRemote.mock.calls.some(c => c[0] === 'customer-gone')).toBe(false);
    expect((await store.listCollections()).some(c => c.name === 'customer-gone')).toBe(false);
  });
});

describe('collection moves', () => {
  const moved = vi.mocked(getRemoteCollectionsByIds);
  const local = (col: string, id: string, dirty = false) =>
    getStore().addDocument(col, id, `task ${id}`, { type: 'task', id, origin_user: 'teammate', created_at: 1_800_000_000, updated_at: 1_800_000_000, is_synced: !dirty });
  const has = async (col: string, id: string) => (await getDocumentsByIds(col, [id]).catch(() => [])).length === 1;

  beforeEach(() => moved.mockReset().mockResolvedValue(new Map()));

  it('moved in: relocates the stale copy instead of keeping two', async () => {
    await getStore().createCollection('customer-old');
    await local('customer-old', 'mv-1');
    mockedRemote.mockResolvedValueOnce([remote('mv-1', 'customer-new', 'task mv-1', { metadata: { type: 'task', id: 'mv-1' } })]);

    const stats = await pullCollection('customer-new', 0);
    expect(stats.moved).toBe(1);
    expect(await has('customer-new', 'mv-1')).toBe(true);
    expect(await has('customer-old', 'mv-1')).toBe(false);
  });

  it('a personal copy in a private collection is never relocated or removed', async () => {
    await getStore().createCollection('private-keep');
    await local('private-keep', 'mv-p');
    mockedRemote.mockResolvedValueOnce([remote('mv-p', 'customer-new', 'task mv-p', { metadata: { type: 'task', id: 'mv-p' } })]);

    await pullCollection('customer-new', 0);
    expect(await has('private-keep', 'mv-p')).toBe(true);
    expect(await has('customer-new', 'mv-p')).toBe(true);
  });

  it('moved in, but the old copy has unpushed edits: keeps it (its push wins)', async () => {
    await local('customer-old', 'mv-2', true);
    mockedRemote.mockResolvedValueOnce([remote('mv-2', 'customer-new', 'task mv-2', { metadata: { type: 'task', id: 'mv-2' } })]);

    const stats = await pullCollection('customer-new', 0);
    expect(stats.moved).toBe(0);
    expect(await has('customer-old', 'mv-2')).toBe(true);
    expect(await has('customer-new', 'mv-2')).toBe(false);
  });

  it('moved out to a collection we do not follow: drops the stale copy', async () => {
    await local('customer-old', 'mv-3');
    moved.mockResolvedValue(new Map([['mv-3', 'customer-elsewhere']]));

    const stats = await pullCollection('customer-old', 0, undefined, { followedCollections: new Set(['customer-old']) });
    expect(stats.moved).toBe(1);
    expect(await has('customer-old', 'mv-3')).toBe(false);
  });

  it('moved out to a collection we follow: leaves it for that collection\'s pull to relocate', async () => {
    await local('customer-old', 'mv-4');
    moved.mockResolvedValue(new Map([['mv-4', 'customer-new']]));

    const stats = await pullCollection('customer-old', 0, undefined, { followedCollections: new Set(['customer-old', 'customer-new']) });
    expect(stats.moved).toBe(0);
    expect(await has('customer-old', 'mv-4')).toBe(true);
  });

  it('moved out, but with unpushed local edits: keeps it', async () => {
    await local('customer-old', 'mv-5', true);
    moved.mockResolvedValue(new Map([['mv-5', 'customer-elsewhere']]));

    await pullCollection('customer-old', 0, undefined, { followedCollections: new Set(['customer-old']) });
    expect(await has('customer-old', 'mv-5')).toBe(true);
  });

  it('the per-prompt hook path skips the moved-out lookup', async () => {
    await pullCollection('customer-old', 0);
    expect(moved).not.toHaveBeenCalled();
  });

  it('full cycles run the moved-out check for every followed collection', async () => {
    await pullFromRemote();
    const checked = moved.mock.calls.flatMap(c => c[0]);
    expect(checked).toEqual(expect.arrayContaining(['mv-4']));
  });
});
