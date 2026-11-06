import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds, getDocumentsByFilter } from '../store/index.js';
import { listDeletedUpstream, sweepDeletedUpstream, keepDeletedUpstream } from './trash.js';
import { listTasks } from '../tasks/list.js';
import { nextTasks } from '../tasks/next.js';

let dir: string;
const NOW = 1_900_000_000;
const gone = (at: number) => ({ archived: true, deleted_upstream_by: 'mate', deleted_upstream_at: at, deleted_upstream_reason: 'delete', is_synced: true, origin_user: 'mate' });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-trash-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_DELETED_RETENTION_DAYS: '30', YAPA_LOCAL_COORD_DIR: join(dir, 'coord') }));
  setStore(createLocalStore(join(dir, 'store')));
  const s = getStore();
  await s.createCollection('project-acme');
  await s.addDocument('project-acme', 'mate-1', 'deploy uses blue/green', { type: 'memory', ...gone(NOW - 86400) });
  await s.addDocument('project-acme', 'mate-2', 'rotate the staging token', { type: 'task', status: 'pending', priority: 'high', ...gone(NOW - 40 * 86400) });
  await s.addDocument('project-acme', 'live-1', 'a live note', { type: 'memory', origin_user: 'mate' });
  await s.addDocument('project-acme', 'mate-3', 'an archived task still listed?', { type: 'task', status: 'pending', ...gone(NOW - 3600) });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('copies deleted upstream', () => {
  it('are listed with who deleted them and when they expire', async () => {
    const l = await listDeletedUpstream('project-acme');
    expect(l.map(x => x.id)).toEqual(['mate-3', 'mate-1', 'mate-2']);
    expect(l[1]).toMatchObject({ deleted_by: 'mate', reason: 'delete', expires_at: NOW - 86400 + 30 * 86400 });
  });

  it('are hidden from task lists and the ready queue', async () => {
    expect((await listTasks({ collection: 'project-acme' })).map(t => t.id)).toEqual([]);
    expect((await listTasks({ collection: 'project-acme', includeArchived: true })).map(t => t.id).sort()).toEqual(['mate-2', 'mate-3']);
    expect((await nextTasks({ collection: 'project-acme' })).ready).toEqual([]);
  });

  it('can be kept as a new document of your own', async () => {
    const r = await keepDeletedUpstream('mate-3', 'project-acme');
    expect(r.type).toBe('task');
    expect(await getDocumentsByIds('project-acme', ['mate-3'])).toEqual([]);
    const [mine] = await getDocumentsByIds('project-acme', [r.id]);
    expect(mine.content).toBe('an archived task still listed?');
    expect(mine.metadata).toMatchObject({ status: 'pending', is_synced: false });
    expect(mine.metadata.archived).not.toBe(true);
    await expect(keepDeletedUpstream('live-1', 'project-acme')).rejects.toThrow(/not a deleted copy/);
  });

  it('go after the retention period; live docs never do', async () => {
    expect(await sweepDeletedUpstream(NOW)).toBe(1); // mate-2, 40 days old
    const ids = (await getDocumentsByFilter('project-acme', {}, 100)).map(d => d.id);
    expect(ids).toContain('mate-1');
    expect(ids).toContain('live-1');
    expect(ids).not.toContain('mate-2');
  });
});
