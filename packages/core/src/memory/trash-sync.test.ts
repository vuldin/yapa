import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { setSyncBackend, UnsupportedByRemoteError, type SyncBackend } from '../sync/backend.js';
import { getPendingPurges } from '../sync/deletes.js';
import { pushToRemote } from '../sync/push.js';
import { purgeDocuments, restoreDeleted, listTrash, stillQueuedForPurge } from './trash.js';

let dir: string;
const calls: { purge: string[][]; delete: string[][]; restore: string[][] } = { purge: [], delete: [], restore: [] };
let supportsPurge = true;
let reused = new Set<string>();
let failing = new Map<string, { code: string; permanent: boolean }>();
let remoteDeleted: Array<{ id: string; metadata: Record<string, unknown> }> = [];

const stub = (): SyncBackend => ({
  kind: 'service', target: 'stub',
  pull: async () => ({ documents: [], deletions: [], hasMore: false }) as any,
  upsertMany: async () => [],
  delete: async ids => { calls.delete.push(ids); return ids.length; },
  purge: async ids => {
    if (!supportsPurge) throw new UnsupportedByRemoteError('purge');
    calls.purge.push(ids);
    return ids.map(id => {
      const f = failing.get(id);
      if (f) return { id, status: 'error' as const, code: f.code, message: f.code, permanent: f.permanent };
      return { id, status: reused.has(id) ? 'purged_copies' as const : 'purged' as const };
    });
  },
  restore: async ids => { calls.restore.push(ids); return ids.map(id => ({ id, status: 'restored' as const, synced_at: 1 })); },
  listDeleted: async () => [
    { id: 'tester-9', collection: 'project-acme', content: 'old', metadata: {}, deleted_at: 1_800_000_000, reason: 'delete' },
    ...remoteDeleted.map(d => ({ ...d, collection: 'project-acme', content: 'x', deleted_at: 1_800_000_000, reason: 'delete' })),
  ],
  collections: async () => [], collectionsForUser: async () => [], collectionsByIds: async () => new Map(), ownersByIds: async () => new Map(),
  createdAt: async () => undefined, maxTaskNumber: async () => 0, similar: async () => [], addRelatedIds: async () => {},
  health: async () => ({ ok: true }), prepare: async () => {},
}) as unknown as SyncBackend;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-trash-sync-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_SERVICE_URL: 'https://sync.example.test', YAPA_LOCAL_COORD_DIR: join(dir, 'coord') }));
  setStore(createLocalStore(join(dir, 'store')));
  setSyncBackend(stub());
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  setSyncBackend(undefined);
  resetStore();
  resetConfig();
});
beforeEach(() => { calls.purge = []; calls.delete = []; calls.restore = []; supportsPurge = true; reused = new Set(); failing = new Map(); remoteDeleted = []; });

describe('purge', () => {
  it('removes your document here at once and purges it on the next push; refuses a teammate\'s; a local-only one just goes', async () => {
    const s = getStore();
    await s.createCollection('project-acme');
    await s.createCollection('private-acme');
    await s.addDocument('project-acme', 'mem-leak', 'token=abc', { type: 'memory', origin_user: 'tester', is_synced: true });
    await s.addDocument('project-acme', 'mem-theirs', 'their note', { type: 'memory', origin_user: 'dana', is_synced: true });
    await s.addDocument('private-acme', 'mem-priv', 'private secret', { type: 'memory' });
    const r = await purgeDocuments(['mem-leak', 'mem-theirs', 'mem-priv']);
    expect(r).toEqual({ queued: ['mem-leak'], local: ['mem-priv'], refused: [{ id: 'mem-theirs', collection: 'project-acme', owner: 'dana' }] });
    expect(await getDocumentsByIds('project-acme', ['mem-leak'])).toEqual([]);
    expect(await getDocumentsByIds('project-acme', ['mem-theirs'])).toHaveLength(1);
    expect(await getPendingPurges()).toEqual(['mem-leak']);
    const stats = await pushToRemote();
    expect(calls.purge).toEqual([['mem-leak']]);
    expect(stats.purged).toBe(1);
    expect(await getPendingPurges()).toEqual([]);
  });

  it('an id another user reused counts as purged when the service removed only our deleted copies', async () => {
    reused = new Set(['mem-reused']);
    await purgeDocuments(['mem-reused']);
    const stats = await pushToRemote();
    expect(calls.purge).toEqual([['mem-reused']]);
    expect(stats.purged).toBe(1);
    expect(await getPendingPurges()).toEqual([]);
  });

  it('a chunked memory goes whole, by any chunk\'s id or its base id, and every chunk is queued', async () => {
    const s = getStore();
    for (const base of ['mem-long', 'mem-long2']) {
      for (let i = 0; i < 4; i++) {
        await s.addDocument('project-acme', `${base}-${i}`, i === 2 ? 'token=abc' : `part ${i}`, { type: 'memory', origin_user: 'tester', is_synced: true, parent_id: base, chunk_index: i });
      }
    }
    const byChunk = await purgeDocuments(['mem-long-0']);
    expect(byChunk.queued).toEqual(['mem-long-0', 'mem-long-1', 'mem-long-2', 'mem-long-3']);
    const byBase = await purgeDocuments(['mem-long2']);
    expect(byBase.queued).toEqual(['mem-long2-0', 'mem-long2-1', 'mem-long2-2', 'mem-long2-3']);
    const left = await s.getDocumentsByFilter('project-acme', { type: 'memory' }, 100);
    expect(left.filter(d => d.id.startsWith('mem-long'))).toEqual([]);
    expect((await getPendingPurges()).filter(id => id.startsWith('mem-long'))).toHaveLength(8);
    await pushToRemote();
  });

  it('an id no longer here is expanded to its chunks from your deleted rows on the service', async () => {
    remoteDeleted = [0, 1, 2].map(i => ({ id: `mem-gone-${i}`, metadata: { parent_id: 'mem-gone', chunk_index: i } }));
    expect((await purgeDocuments(['mem-gone-1'])).queued).toEqual(['mem-gone-0', 'mem-gone-1', 'mem-gone-2']);
    await pushToRemote();
    expect(calls.purge.at(-1)).toEqual(['mem-gone-0', 'mem-gone-1', 'mem-gone-2']);
  });

  it('a temporary purge failure stays queued and is retried; a permanent one is not', async () => {
    failing = new Map([['mem-busy', { code: 'internal', permanent: false }], ['mem-bad', { code: 'not_owner', permanent: true }]]);
    await purgeDocuments(['mem-busy', 'mem-bad', 'mem-fine']);
    const first = await pushToRemote();
    expect(first.purged).toBe(1);
    expect(await getPendingPurges()).toEqual(['mem-busy']);
    expect(await stillQueuedForPurge(['mem-busy', 'mem-bad', 'mem-fine'])).toEqual(['mem-busy']);
    failing = new Map();
    await pushToRemote();
    expect(calls.purge.at(-1)).toEqual(['mem-busy']);
    expect(await getPendingPurges()).toEqual([]);
  });

  it('an older service without purge gets a delete instead', async () => {
    supportsPurge = false;
    await purgeDocuments(['mem-gone-anyway']);
    await pushToRemote();
    expect(calls.delete).toEqual([['mem-gone-anyway']]);
    expect(await getPendingPurges()).toEqual([]);
  });
});

describe('restore and listing', () => {
  it('restores on the service and lists both kinds of deleted documents', async () => {
    expect(await restoreDeleted(['tester-9', 'tester-9'])).toEqual([{ id: 'tester-9', status: 'restored', synced_at: 1 }]);
    expect(calls.restore).toEqual([['tester-9']]);
    const t = await listTrash();
    expect(t.remote.map(d => d.id)).toEqual(['tester-9']);
    expect(t.remoteUnavailable).toBeUndefined();
  });
});
