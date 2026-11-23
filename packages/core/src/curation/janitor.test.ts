import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalStore } from '../store/local-adapter.js';
import { getConfig } from '../config.js';
import { setStore, resetStore } from '../store/index.js';
import { storeMemory } from '../memory/store.js';
import { recallMemory, settleRecallBoosts } from '../memory/recall.js';
import { getDocumentsByIds, getStore } from '../store/index.js';
import { janitorSweep, findDuplicatePairs, pairKey } from './janitor.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yapa-janitor-'));
  setStore(createLocalStore(dir));
});

afterEach(async () => {
  await settleRecallBoosts();
  resetStore();
  await rm(dir, { recursive: true, force: true });
});

const archivedFlag = async (id: string) =>
  (await getDocumentsByIds('global', [id]))[0]?.metadata;

describe('janitorSweep', () => {
  it('archives the lower-salience memory of a same-fact pair (skip)', async () => {
    const strong = await storeMemory('The deploy token expires every 24 hours.', { salience: 2.5 });
    const weak = await storeMemory('Deploy tokens expire every 24h.', { salience: 1.0 });

    const stats = await janitorSweep({
      collection: 'global',
      distanceThreshold: 2.0, // deterministic pair detection; LLM is stubbed
      call: async () => '{"action":"skip","rationale":"same fact"}',
    });

    expect(stats.pairsConsidered).toBe(1);
    expect(stats.skippedDuplicates).toBe(1);
    expect(await archivedFlag(weak.ids[0])).toMatchObject({ archived: true, duplicate_of: strong.ids[0] });
    expect((await archivedFlag(strong.ids[0]))!.archived).toBeUndefined();

    // Recall excludes the archived duplicate by default…
    const recalled = await recallMemory('deploy token expiry', { collection: 'global', nResults: 10 });
    expect(recalled.map(r => r.id)).toContain(strong.ids[0]);
    expect(recalled.map(r => r.id)).not.toContain(weak.ids[0]);
    // …but it is recoverable.
    const withArchived = await recallMemory('deploy token expiry', { collection: 'global', nResults: 10, include_archived: true });
    expect(withArchived.map(r => r.id)).toContain(weak.ids[0]);
  });

  it('stores merged content and archives the stale memory on supersede', async () => {
    const old = await storeMemory('Service X runs on port 8000.', { salience: 2.0 });
    const newer = await storeMemory('Service X now runs on port 9000.', { salience: 2.0 });

    const stats = await janitorSweep({
      collection: 'global',
      distanceThreshold: 2.0,
      call: async () => JSON.stringify({
        action: 'supersede',
        target_id: old.ids[0],
        merged_content: 'Service X runs on port 9000 (previously 8000).',
        rationale: 'port changed',
      }),
    });

    expect(stats.superseded).toBe(1);
    expect(await archivedFlag(old.ids[0])).toMatchObject({ archived: true });
    // The other side is folded into the merged memory too, not left beside it.
    expect(await archivedFlag(newer.ids[0])).toMatchObject({ archived: true });
    expect((await archivedFlag(newer.ids[0]))!.superseded_by).toMatch(/^mem-/);

    const recalled = await recallMemory('service X port', { collection: 'global', nResults: 10 });
    const contents = recalled.map(r => r.content).join('\n');
    expect(contents).toContain('previously 8000');
    expect(contents).not.toContain('Service X runs on port 8000.');
    // The merged memory carries provenance.
    const merged = recalled.find(r => r.content.includes('previously 8000'))!;
    expect(merged.metadata.source).toBe('janitor');
  });

  it('leaves both memories alone when the resolver says add', async () => {
    const a = await storeMemory('Python has a global interpreter lock.', { salience: 2.0 });
    const b = await storeMemory('Python 3.13 removes the GIL experimentally.', { salience: 2.0 });

    const stats = await janitorSweep({
      collection: 'global',
      distanceThreshold: 2.0,
      call: async () => '{"action":"add","rationale":"distinct facts"}',
    });

    expect(stats.keptDistinct).toBe(1);
    expect((await archivedFlag(a.ids[0]))!.archived).toBeUndefined();
    expect((await archivedFlag(b.ids[0]))!.archived).toBeUndefined();
  });

  it('keeps both when the resolver call fails (conservative failure)', async () => {
    const a = await storeMemory('Fact one about the widget.', { salience: 2.0 });
    const b = await storeMemory('Fact one about the widget, restated.', { salience: 1.0 });

    const stats = await janitorSweep({
      collection: 'global',
      distanceThreshold: 2.0,
      call: async () => { throw new Error('llm down'); },
    });

    expect(stats.errors).toBe(1);
    expect((await archivedFlag(a.ids[0]))!.archived).toBeUndefined();
    expect((await archivedFlag(b.ids[0]))!.archived).toBeUndefined();
  });

  it('respects the maxPairs bound', async () => {
    for (let i = 0; i < 4; i++) {
      await storeMemory(`Duplicate fact variant ${i} about the frobnicate setting.`, { salience: 1.0 });
    }
    const pairs = await findDuplicatePairs('global', 2.0);
    expect(pairs.length).toBeGreaterThan(1);

    const stats = await janitorSweep({
      collection: 'global',
      distanceThreshold: 2.0,
      maxPairs: 1,
      call: async () => '{"action":"add","rationale":"x"}',
    });
    expect(stats.pairsConsidered).toBe(1);
  });
});

describe('janitorSweep ownership and eligibility', () => {
  const add = (id: string, content: string, md: Record<string, any> = {}) =>
    getStore().addDocument('global', id, content, { type: 'memory', username: getConfig().USERNAME, salience: 1, created_at: 100, ...md });
  const opts = { collection: 'global', distanceThreshold: 2.0 };

  it('archives your copy, not a teammate\'s, when the same fact is in both', async () => {
    await add('theirs', 'The deploy token expires every 24 hours.', { username: 'dana', origin_user: 'dana', salience: 0.5 });
    const mine = await storeMemory('Deploy tokens expire every 24h.', { salience: 3 });
    const stats = await janitorSweep({ ...opts, call: async () => '{"action":"skip","rationale":"same fact"}' });
    expect(stats.skippedDuplicates).toBe(1);
    expect(await archivedFlag(mine.ids[0])).toMatchObject({ archived: true, duplicate_of: 'theirs' });
    expect((await archivedFlag('theirs'))!.archived).toBeUndefined();
  });

  it('leaves a teammate\'s memory alone when a supersede targets it', async () => {
    await add('theirs', 'Service X runs on port 8000.', { username: 'dana', origin_user: 'dana' });
    await storeMemory('Service X now runs on port 9000.');
    const stats = await janitorSweep({ ...opts, call: async () => '{"action":"supersede","target_id":"theirs","merged_content":"Service X runs on port 9000.","rationale":"newer"}' });
    expect(stats.skippedNotOwned).toBe(1);
    expect((await archivedFlag('theirs'))!.archived).toBeUndefined();
  });

  it('does not pair two teammates\' memories, or pinned, summary and chunked ones', async () => {
    await add('d1', 'Cluster A uses TLS.', { username: 'dana', origin_user: 'dana' });
    await add('d2', 'Cluster A has TLS on.', { username: 'dana', origin_user: 'dana' });
    expect(await findDuplicatePairs('global', 2.0)).toEqual([]);
    await add('p', 'Cluster A uses TLS everywhere.', { pinned: true });
    await add('s', 'Cluster A: TLS session summary.', { source: 'compaction' });
    await add('c-0', 'Cluster A TLS chunk.', { parent_id: 'c', chunk_index: 0 });
    expect(await findDuplicatePairs('global', 2.0)).toEqual([]);
  });

  it('only looks from memories changed since, and skips pairs judged distinct', async () => {
    await add('old1', 'Broker count is three.', { created_at: 100 });
    await add('old2', 'There are three brokers.', { created_at: 100 });
    expect(await findDuplicatePairs('global', 2.0, { since: 200 })).toEqual([]);
    await add('new', 'Three brokers in the cluster.', { created_at: 300 });
    const pairs = await findDuplicatePairs('global', 2.0, { since: 200 });
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every(p => p.a.id === 'new')).toBe(true);
    const skip = new Set(pairs.map(p => pairKey(p.a.id, p.b.id)));
    expect(await findDuplicatePairs('global', 2.0, { since: 200, skipPairs: skip })).toEqual([]);
  });
});
