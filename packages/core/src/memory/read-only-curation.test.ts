import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds, patchDocument } from '../store/index.js';
import { storeMemory } from './store.js';
import { applyCompaction, suggestCompaction } from './compact.js';
import { runDecaySweep } from './decay.js';
import { recallMemory, settleRecallBoosts } from './recall.js';
import { findDuplicatePairs } from '../curation/janitor.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-read-only-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_COMPACTION_MIN_GROUP_SIZE: '2' }));
  setStore(createLocalStore(dir));
});

afterAll(() => {
  resetStore();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

async function remoteOwned(collection: string, content: string, salience = 1.5): Promise<string> {
  const { ids: [id] } = await storeMemory(content, { collection, salience });
  await patchDocument(collection, id, { read_only: true });
  return id;
}

describe('curation leaves documents the remote owns alone', () => {
  it('the janitor never pairs a read-only document', async () => {
    const C = 'project-ro-janitor';
    const remote = await remoteOwned(C, 'The acme cluster runs Redpanda 26.1 on three brokers in us-east-1.');
    await storeMemory('The acme cluster runs Redpanda 26.1 on three brokers in us-east-1.', { collection: C });
    expect(await findDuplicatePairs(C, 0.5)).toEqual([]);
    const { ids: [a] } = await storeMemory('Acme rotates its TLS certificates every 90 days.', { collection: C });
    const { ids: [b] } = await storeMemory('Acme rotates its TLS certificates every 90 days.', { collection: C });
    const pairs = await findDuplicatePairs(C, 0.5);
    expect(pairs.map(p => [p.a.id, p.b.id].sort())).toEqual([[a, b].sort()]);
    expect(pairs.flatMap(p => [p.a.id, p.b.id])).not.toContain(remote);
  });

  it('compaction never suggests or archives a read-only document', async () => {
    const C = 'project-ro-compact';
    const remote = await remoteOwned(C, 'The importer retries a failed batch three times before giving up.');
    const { ids: [mine1] } = await storeMemory('The importer retries a failed batch three times before it gives up.', { collection: C });
    const { ids: [mine2] } = await storeMemory('The importer gives up after retrying a failed batch three times.', { collection: C });
    const groups = await suggestCompaction(C);
    expect(groups.flatMap(g => g.member_ids)).not.toContain(remote);
    expect(groups.flatMap(g => g.member_ids).sort()).toEqual([mine1, mine2].sort());

    const r = await applyCompaction({ collection: C, member_ids: [mine1, remote], summary: 'The importer retries a failed batch three times.' });
    expect(r.archived_ids).toEqual([mine1]);
    expect((await getDocumentsByIds(C, [remote]))[0].metadata.archived).not.toBe(true);
  });

  it('decay and the recall boost leave a read-only document\'s salience as it is', async () => {
    const C = 'project-ro-salience';
    const remote = await remoteOwned(C, 'Acme prod maintenance is on Thursdays at 02:00 UTC.', 2);
    const { ids: [mine] } = await storeMemory('Acme staging maintenance is on Tuesdays at 04:00 UTC.', { collection: C, salience: 2 });
    const now = Math.floor(Date.now() / 1000) + 30 * 86400;
    await runDecaySweep(now);
    expect((await getDocumentsByIds(C, [remote]))[0].metadata.salience).toBe(2);
    expect((await getDocumentsByIds(C, [mine]))[0].metadata.salience).toBeLessThan(2);

    const hits = await recallMemory('acme prod maintenance Thursdays 02:00 UTC', { collection: C, nResults: 2 });
    await settleRecallBoosts();
    expect(hits.map(h => h.id)).toContain(remote);
    expect((await getDocumentsByIds(C, [remote]))[0].metadata.salience).toBe(2);
  });
});
