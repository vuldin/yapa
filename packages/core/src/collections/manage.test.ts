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

import { upsertRemoteDocument, deleteRemoteDocuments, getRemoteOwnersByIds } from '../sync/postgres.js';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setSyncBackend } from '../sync/backend.js';
import { PostgresBackend } from '../sync/postgres-backend.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, getDocumentsByFilter } from '../store/index.js';
import { getPendingDeletes, getLocalTombstones } from '../sync/deletes.js';
import { getLeftCollections, getSyncSubscriptions, updateSyncSubscriptions, getCollectionRedirects, addCollectionRedirect, clearCollectionRedirect, resolveWriteCollection, redirectNote } from '../sync/sentinel.js';
import { pushToRemote } from '../sync/push.js';
import { mergeCollections, mergeReportLines, removeCollection, removeReport, createNewCollection, CollectionDeleteRefusedError } from './manage.js';
import { storeMemory } from '../memory/store.js';
import { createTask } from '../tasks/create.js';
import { journalAppend } from '../memory/journal.js';
import { putExternal } from '../memory/external.js';
import { updateMemory } from '../memory/update.js';

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

  it('refuses global as a source: it holds the sync sentinels and the merge redirects', async () => {
    await updateSyncSubscriptions([...(await getSyncSubscriptions()), 'customer-new']);
    await addCollectionRedirect('project-was', 'private-now');
    for (const into of ['private-scratch', 'customer-new']) {
      await expect(mergeCollections('global', into)).rejects.toThrow(/"global" cannot be merged/);
      await expect(mergeCollections('global', into, { dryRun: true })).rejects.toThrow(/"global" cannot be merged/);
    }
    expect(await names()).toContain('global');
    expect(await getSyncSubscriptions()).toContain('customer-new');
    expect((await getCollectionRedirects())['project-was']).toBe('private-now');
    await clearCollectionRedirect('project-was');
  });

  it('requires an existing target and refuses id clashes without moving anything', async () => {
    await expect(mergeCollections('customer-new', 'customer-missing')).rejects.toThrow(/does not exist/);
    await getStore().createCollection('customer-dup');
    await getStore().addDocument('customer-dup', 'mem-1', 'same id, other doc', { type: 'memory' });
    await expect(mergeCollections('customer-dup', 'customer-new')).rejects.toThrow(/already holds 1 id/);
    expect((await all('customer-dup')).map(d => d.id)).toEqual(['mem-1']);
  });
});

describe('mergeCollections: shared -> private', () => {
  const seed = async () => {
    const store = getStore();
    await store.createCollection('project-acme');
    await store.createCollection('private-acme');
    await store.addDocument('project-acme', 'sp-mine', 'acme runs 5 brokers', {
      type: 'memory', origin_user: 'tester', created_at: 1_800_000_000, is_synced: true,
    });
    await store.addDocument('project-acme', 'sp-mine-local', 'acme draft, never pushed', {
      type: 'memory', origin_user: 'tester', created_at: 1_800_000_050, is_synced: false,
    });
    await store.addDocument('project-acme', 'sp-theirs', 'teammate note on acme tiered storage', {
      type: 'memory', origin_user: 'teammate', created_at: 1_800_000_100, is_synced: true,
    });
    await updateSyncSubscriptions([...(await getSyncSubscriptions()), 'project-acme']);
  };

  it('reports what happens remotely, records a redirect, and unsubscribes the source', async () => {
    await seed();
    const dry = await mergeCollections('project-acme', 'private-acme', { dryRun: true });
    // An upper bound: every doc of yours retraction checks, pushed or not.
    expect(dry).toMatchObject({ ownRowsRetracted: 2, teammateRowsKept: 1, dryRun: true });
    expect(await getCollectionRedirects()).not.toHaveProperty('project-acme');

    const r = await mergeCollections('project-acme', 'private-acme');
    expect(r).toMatchObject({ moved: 3, ownRowsRetracted: 2, teammateRowsKept: 1, sourceRemoved: true });
    expect((await getCollectionRedirects())['project-acme']).toBe('private-acme');
    expect(await getSyncSubscriptions()).not.toContain('project-acme');

    const text = mergeReportLines(r).join('\n');
    expect(text).toMatch(/Up to 2 docs of yours will be removed from the shared copy \(retracted\) at the next push/);
    expect(text).toMatch(/1 teammates' docs stay shared in "project-acme"/);
    expect(text).toMatch(/"project-acme" won't come back here \(sync subscribe project-acme to follow it again\)/);
    expect(text).toMatch(/for this machine only\. Another device of yours still follows "project-acme"/);
    expect(text).toMatch(/a copy it edited can be pushed back into "project-acme"/);
  });

  it('the next push retracts only your shared copies', async () => {
    const remote = new Map([
      ['sp-mine', { owner: 'tester', createdAt: 1_800_000_000 }],
      ['sp-theirs', { owner: 'teammate', createdAt: 1_800_000_100 }],
    ]);
    // Every private collection is checked; answer for the ids each one asks about.
    vi.mocked(getRemoteOwnersByIds).mockImplementation(async (ids: string[]) =>
      new Map(ids.filter(id => remote.has(id)).map(id => [id, remote.get(id)!])));
    vi.mocked(deleteRemoteDocuments).mockClear();
    vi.mocked(upsertRemoteDocument).mockClear();
    await pushToRemote();
    expect(deleteRemoteDocuments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteRemoteDocuments).mock.calls[0][0]).toEqual(['sp-mine']);
    expect(vi.mocked(upsertRemoteDocument).mock.calls.map(c => (c[0] as any).id)).not.toContain('sp-theirs');
  });

  it('writes naming the merged-away name land in the target, and nothing is pushed for it', async () => {
    vi.mocked(upsertRemoteDocument).mockClear();
    const stored = await storeMemory('acme: a new note, written to the old name', { collection: 'project-acme' });
    const task = await createTask('acme: follow up', {}, 'project-acme');
    const draft = await journalAppend('acme: step done', 'project-acme');
    const ext = await putExternal('project-acme', 'acme:ADR-1', { content: 'acme ADR 1', typed: { kind: 'decision', status: 'accepted' } });
    await updateMemory(stored.ids[0], { note: 'checked' }, 'project-acme');
    expect(await names()).not.toContain('project-acme');
    const landed = (await all('private-acme')).map(d => d.id);
    for (const id of [stored.ids[0], task, draft, ext.id]) expect(landed).toContain(id);

    await pushToRemote();
    const pushed = vi.mocked(upsertRemoteDocument).mock.calls.map(c => c[0] as any);
    expect(pushed.some(d => d.collection === 'project-acme')).toBe(false);
    expect(pushed.map(d => d.id)).not.toContain(stored.ids[0]);
    expect(await getSyncSubscriptions()).not.toContain('project-acme');
    expect(await names()).not.toContain('project-acme');

    expect(await resolveWriteCollection('project-acme')).toEqual({ collection: 'private-acme', redirectedFrom: 'project-acme' });
    expect(redirectNote(await resolveWriteCollection('project-acme'))).toBe('"project-acme" was merged into "private-acme" on this machine, so this was written to "private-acme".');
    expect(await resolveWriteCollection('global')).toEqual({ collection: 'global' });
    expect(redirectNote(await resolveWriteCollection('project-other'))).toBe('');
  });

  it('a later merge of the target keeps the chain, and creating a merged name again drops its redirect', async () => {
    await addCollectionRedirect('private-acme', 'private-acme2');
    expect(await getCollectionRedirects()).toMatchObject({ 'project-acme': 'private-acme', 'private-acme': 'private-acme2' });
    await addCollectionRedirect('private-acme2', 'private-acme'); // merged back: private-acme is live again
    expect(await getCollectionRedirects()).not.toHaveProperty('private-acme');
    await createNewCollection('project-acme');
    expect(await getCollectionRedirects()).not.toHaveProperty('project-acme');
    await clearCollectionRedirect('private-acme2');
    await clearCollectionRedirect('never-there');
    expect(await getCollectionRedirects()).not.toHaveProperty('private-acme2');
  });
});

describe('removeCollection', () => {
  it('scope local (the default) removes a shared collection from this machine only: nothing is queued remotely, and it is left', async () => {
    await getStore().createCollection('project-keep');
    await getStore().addDocument('project-keep', 'k-1', 'one', { type: 'memory', origin_user: 'tester', is_synced: true });
    await getStore().addDocument('project-keep', 'k-2', 'two', { type: 'memory', origin_user: 'teammate', is_synced: true });
    await updateSyncSubscriptions([...(await getSyncSubscriptions()), 'project-keep']);

    const r = await removeCollection('project-keep');
    expect(r).toMatchObject({ scope: 'local', removed: 2, pushed: 0, deletedRemotely: 0, shared: true });
    expect(removeReport(r)).toMatch(/^Removed "project-keep" \(2 documents\) from this machine only\. Teammates and the sync service keep it/);
    expect(await names()).not.toContain('project-keep');
    expect(await getPendingDeletes()).not.toEqual(expect.arrayContaining(['project-keep:k-1']));
    expect((await getLocalTombstones()).has('k-2')).toBe(false);
    expect(await getSyncSubscriptions()).not.toContain('project-keep');
    expect(await getLeftCollections()).toContain('project-keep');
    // Creating it again (or subscribing) follows it again.
    await createNewCollection('project-keep');
    expect(await getLeftCollections()).not.toContain('project-keep');
    await removeCollection('project-keep');
  });

  it('pushes your unpushed documents before removing a shared collection here, and refuses if that push fails', async () => {
    await getStore().createCollection('project-dirty');
    await getStore().addDocument('project-dirty', 'd-1', 'not pushed yet', { type: 'memory', origin_user: 'tester', is_synced: false, created_at: 1_800_000_000 });
    vi.mocked(upsertRemoteDocument).mockClear();
    const r = await removeCollection('project-dirty');
    expect(r.pushed).toBe(1);
    expect(vi.mocked(upsertRemoteDocument).mock.calls.some(c => (c[0] as any).id === 'd-1')).toBe(true);

    await getStore().createCollection('project-dirty2');
    await getStore().addDocument('project-dirty2', 'd-2', 'cannot push', { type: 'memory', origin_user: 'tester', is_synced: false, created_at: 1_800_000_000 });
    vi.mocked(upsertRemoteDocument).mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'unreachable' }));
    const err = await removeCollection('project-dirty2').catch(e => e);
    expect(err).toBeInstanceOf(CollectionDeleteRefusedError);
    expect(err.message).toMatch(/could not be pushed .* would lose them/);
    expect(await names()).toContain('project-dirty2');
    await removeCollection('project-dirty2', { confirm: 'project-dirty2' });
  });

  it('scope everyone needs the exact name, then deletes your documents for everyone and tombstones teammates\'', async () => {
    await getStore().createCollection('project-team');
    await getStore().addDocument('project-team', 't-1', 'one', { type: 'memory', origin_user: 'tester' });
    await getStore().addDocument('project-team', 't-2', 'two', { type: 'memory', origin_user: 'teammate' });
    const err = await removeCollection('project-team', { scope: 'everyone' }).catch(e => e);
    expect(err).toBeInstanceOf(CollectionDeleteRefusedError);
    expect(err.message).toMatch(/for everyone removes your documents in it from the sync service and from every teammate's machine \(2 documents here\)/);
    expect(err.message).toMatch(/collection_merge/);
    await expect(removeCollection('project-team', { scope: 'everyone', confirm: 'project-tea' })).rejects.toThrow(/Refused/);
    const r = await removeCollection('project-team', { scope: 'everyone', confirm: 'project-team' });
    expect(r.deletedRemotely).toBe(1);
    expect(removeReport(r)).toMatch(/for everyone, your 1 document in it on the sync service/);
    expect(await getPendingDeletes()).toContain('project-team:t-1');
    expect((await getLocalTombstones()).has('t-2')).toBe(true);
    expect(await getLeftCollections()).not.toContain('project-team');
  });

  it('a collection with no other copy (local-only, or sync off) needs confirm when non-empty; an empty one does not', async () => {
    await getStore().createCollection('private-tmp');
    await getStore().addDocument('private-tmp', 'p-1', 'scratch', { type: 'memory' });
    const err = await removeCollection('private-tmp').catch(e => e);
    expect(err.message).toMatch(/local only, with 1 document and no copy anywhere else: deleting it is permanent/);
    const r = await removeCollection('private-tmp', { confirm: 'private-tmp' });
    expect(removeReport(r)).toMatch(/It was local only, so it is gone/);
    await getStore().createCollection('project-empty');
    await removeCollection('project-empty');
    const prev = createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A', YAPA_SYNC_ENABLED: 'true' });
    setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DEVICE_ID: 'dev-A' }));
    try {
      await getStore().createCollection('project-offline');
      await getStore().addDocument('project-offline', 'o-1', 'only here', { type: 'memory' });
      await expect(removeCollection('project-offline')).rejects.toThrow(/sync is off, so this machine holds the only copy/);
      await removeCollection('project-offline', { confirm: 'project-offline' });
    } finally {
      setConfig(prev);
    }
    const left = await names();
    expect(left).not.toContain('private-tmp');
    expect(left).not.toContain('project-empty');
  });
});
