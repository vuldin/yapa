import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { getPendingDeletes, getLocalTombstones } from '../sync/deletes.js';
import { forgetMemory } from './forget.js';
import { deleteTask } from '../tasks/delete.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-forget-test-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_ENABLED: 'true' }));
  setStore(createLocalStore(dir));
  const store = getStore();
  await store.createCollection('project-acme');
  await store.addDocument('project-acme', 'mem-mine', 'my note', { type: 'memory', origin_user: 'tester' });
  await store.addDocument('project-acme', 'mem-legacy', 'pre-sync note', { type: 'memory' });
  await store.addDocument('project-acme', 'mem-theirs', 'teammate note', { type: 'memory', origin_user: 'teammate' });
  await store.addDocument('project-acme', 'task-theirs', 'teammate task', { type: 'task', origin_user: 'teammate' });
  await store.createCollection('private-notes');
  await store.addDocument('private-notes', 'mem-private', 'never synced', { type: 'memory' });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('sync-aware deletes', () => {
  it('queues remote deletion for my own (or unattributed) docs', async () => {
    expect(await forgetMemory('mem-mine')).toBe('project-acme');
    await forgetMemory('mem-legacy');
    expect(await getPendingDeletes()).toEqual(['project-acme:mem-mine', 'project-acme:mem-legacy']);
  });

  it('only tombstones a teammate\'s doc locally, never queueing a shared delete', async () => {
    await forgetMemory('mem-theirs');
    expect(await getDocumentsByIds('project-acme', ['mem-theirs'])).toEqual([]);
    expect((await getLocalTombstones()).has('mem-theirs')).toBe(true);
    expect(await getPendingDeletes()).not.toContain('project-acme:mem-theirs');
  });

  it('applies the same rule to task deletion (previously never synced)', async () => {
    await deleteTask('task-theirs');
    expect((await getLocalTombstones()).has('task-theirs')).toBe(true);
  });

  it('leaves private collections out of sync bookkeeping', async () => {
    await forgetMemory('mem-private');
    expect((await getPendingDeletes()).some(e => e.includes('mem-private'))).toBe(false);
    expect((await getLocalTombstones()).has('mem-private')).toBe(false);
  });

  it('throws for unknown ids', async () => {
    await expect(forgetMemory('nope')).rejects.toThrow(/not found/);
  });
});
