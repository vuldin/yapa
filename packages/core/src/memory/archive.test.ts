import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { archivedMetadata } from './archive.js';
import { storeMemory } from './store.js';
import { applyCompaction } from './compact.js';

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-archive-'));
  setConfig(createConfig({ YAPA_SYNC_ENABLED: 'true' }));
  setStore(createLocalStore(dir));
  await getStore().createCollection('project-acme');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('archiving propagates through sync', () => {
  it('marks archived docs dirty with a fresh updated_at', () => {
    const md = archivedMetadata({ salience: 2, is_synced: true, updated_at: 100 }, { superseded_by: 'new' }, 5000);
    expect(md).toMatchObject({ archived: true, superseded_by: 'new', is_synced: false, updated_at: 5000 });
  });

  it('supersede: the stale memory is queued for push as archived', async () => {
    await getStore().addDocument('project-acme', 'old', 'acme API on 8000', { type: 'memory', salience: 2, is_synced: true, updated_at: 1 });
    await storeMemory('acme API moved to 9000', { collection: 'project-acme', supersedes: 'old' });
    const [old] = await getDocumentsByIds('project-acme', ['old']);
    expect(old.metadata).toMatchObject({ archived: true, is_synced: false });
    expect(old.metadata.updated_at).toBeGreaterThan(1);
  });

  it('compaction: archived members are queued for push', async () => {
    for (const id of ['c1', 'c2', 'c3']) {
      await getStore().addDocument('project-acme', id, `acme fact ${id}`, { type: 'memory', salience: 1, is_synced: true, updated_at: 1 });
    }
    await applyCompaction({ collection: 'project-acme', member_ids: ['c1', 'c2', 'c3'], summary: 'acme facts rolled up' } as any);
    for (const d of await getDocumentsByIds('project-acme', ['c1', 'c2', 'c3'])) {
      expect(d.metadata).toMatchObject({ archived: true, is_synced: false });
    }
  });
});
