import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds } from '../store/index.js';
import { storeMemory } from './store.js';
import { recallMemory, settleRecallBoosts } from './recall.js';
import { updateMemory } from './update.js';

let dir: string;
let portId: string;
let lunchId: string;
const sal = async (id: string) => (await getDocumentsByIds('global', [id]))[0].metadata.salience;
const settle = () => settleRecallBoosts(); // boosts are written fire-and-forget

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-recall-'));
  setConfig(createConfig({}));
  setStore(createLocalStore(dir));
  portId = (await storeMemory('The billing API listens on port 8443 behind the internal load balancer', { collection: 'global', salience: 2 })).ids[0];
  lunchId = (await storeMemory('Team lunch is on Fridays at the taco place', { collection: 'global', salience: 2 })).ids[0];
});

afterAll(async () => {
  await settleRecallBoosts();
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

describe('recallMemory salience boost', () => {
  it('boosts only hits that are actually relevant', async () => {
    const results = await recallMemory('what port does the billing API use?', { collection: 'global', nResults: 2 });
    const byId = Object.fromEntries(results.map(r => [r.id, r.distance]));
    expect(byId[portId]).toBeLessThan(0.5);
    expect(byId[lunchId]).toBeGreaterThanOrEqual(0.5);
    await settle();
    expect(await sal(portId)).toBeCloseTo(2.1);
    expect(await sal(lunchId)).toBe(2); // surfaced, but not a use
  });

  it('can be told not to boost at all', async () => {
    const before = await sal(portId);
    await recallMemory('billing API port', { collection: 'global', boost: false });
    await settle();
    expect(await sal(portId)).toBe(before);
  });
});

describe('recallMemory cross-collection', () => {
  it('adds strongly relevant hits from other collections, labeled, and skips weak or archived ones', async () => {
    const other = (await storeMemory('Billing API port 8443 is also used by the acme gateway behind the internal load balancer', { collection: 'customer-acme', salience: 2 })).ids[0];
    await storeMemory('Acme prefers Thursday maintenance windows', { collection: 'customer-acme', salience: 2 });
    const archived = (await storeMemory('Billing API port 8443 behind the internal load balancer (old note)', { collection: 'customer-globex', salience: 2 })).ids[0];
    const { getStore } = await import('../store/index.js');
    const [a] = await getDocumentsByIds('customer-globex', [archived]);
    await getStore().updateDocument('customer-globex', archived, { ...a.metadata, archived: true });

    const scoped = await recallMemory('what port does the billing API use?', { collection: 'global', nResults: 2, boost: false });
    expect(scoped.every(r => r.collection === 'global')).toBe(true);

    const withOthers = await recallMemory('what port does the billing API use?', { collection: 'global', nResults: 2, crossCollection: 2, boost: false });
    const foreign = withOthers.filter(r => r.collection !== 'global');
    expect(foreign.map(r => r.id)).toEqual([other]);
    expect(foreign[0].collection).toBe('customer-acme');
    expect(foreign[0].distance).toBeLessThan(0.45);
  });
});

describe('recallMemory recall fence', () => {
  it('never draws cross-collection extras from private-*/local-* collections; naming them, or no collection, still finds them', async () => {
    const priv = (await storeMemory('Billing API port 8443 sits behind the internal load balancer (private acme note)', { collection: 'private-acme', salience: 2 })).ids[0];
    const loc = (await storeMemory('Billing API port 8443 behind the internal load balancer, local scratch', { collection: 'local-scratch', salience: 2 })).ids[0];
    const q = 'what port does the billing API use?';

    const fromGlobal = await recallMemory(q, { collection: 'global', nResults: 2, crossCollection: 5, boost: false });
    expect(fromGlobal.map(r => r.id)).not.toContain(priv);
    expect(fromGlobal.map(r => r.id)).not.toContain(loc);

    // global stays visible to other scopes.
    const fromShared = await recallMemory(q, { collection: 'customer-acme', nResults: 1, crossCollection: 5, boost: false });
    expect(fromShared.some(r => r.collection === 'global')).toBe(true);
    expect(fromShared.some(r => r.collection === 'private-acme' || r.collection === 'local-scratch')).toBe(false);

    // The active (named) collection is searched as usual; its extras are fenced too.
    const inPrivate = await recallMemory(q, { collection: 'private-acme', nResults: 2, crossCollection: 5, boost: false });
    expect(inPrivate.map(r => r.id)).toContain(priv);
    expect(inPrivate.map(r => r.id)).not.toContain(loc);

    // No collection: the caller asked for everything.
    const everything = await recallMemory(q, { nResults: 20, boost: false });
    expect(everything.map(r => r.id)).toEqual(expect.arrayContaining([priv, loc]));
  });
});

describe('recall boost and concurrent edits', () => {
  it('a boost written after another session edited the memory keeps the edit', async () => {
    const id = (await storeMemory('The staging cluster runs three brokers in one zone', { collection: 'global', salience: 2 })).ids[0];
    await recallMemory('The staging cluster runs three brokers in one zone', { collection: 'global', nResults: 1 });
    // The boost is still being written: another session edits the memory meanwhile.
    await updateMemory(id, { tags: ['edited-elsewhere'] }, 'global');
    await settleRecallBoosts();
    const [d] = await getDocumentsByIds('global', [id]);
    expect(d.metadata.tags).toEqual(['edited-elsewhere']);
    expect(d.metadata.salience).toBeGreaterThan(2);
  });
});


describe('compaction summaries in recall', () => {
  it('are left out by default, without shrinking the result, and returned on request', async () => {
    const C = 'project-sessions';
    for (let i = 0; i < 4; i++) {
      await storeMemory(`# Conversation compaction summary\n\nThe shard rebalance session ${i}: we moved partitions and watched the leader balancer.`, {
        collection: C, tags: ['compaction', 'journal'], sector: 'episodic', metadata: { source: 'compaction' },
      });
    }
    const facts: string[] = [];
    for (const t of ['The leader balancer moves partitions off a shard over 80% CPU.', 'Partition moves are throttled to 50 MB/s per broker.', 'Rebalancing pauses while a broker is in maintenance mode.']) {
      facts.push((await storeMemory(t, { collection: C })).ids[0]);
    }
    const q = 'shard rebalance session moving partitions with the leader balancer';
    const plain = await recallMemory(q, { collection: C, nResults: 3, boost: false });
    expect(plain.map(r => r.id).sort()).toEqual([...facts].sort());
    const all = await recallMemory(q, { nResults: 3, boost: false });
    expect(all.every(r => r.metadata.source !== 'compaction')).toBe(true);

    const withSessions = await recallMemory(q, { collection: C, nResults: 7, boost: false, include_sessions: true });
    expect(withSessions.filter(r => r.metadata.source === 'compaction')).toHaveLength(4);
    expect(await recallMemory(q, { collection: C, nResults: 3, boost: false, tags: ['compaction'] })).toEqual([]);
    const tagged = await recallMemory(q, { collection: C, nResults: 3, boost: false, tags: ['compaction'], include_sessions: true });
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.every(r => r.metadata.source === 'compaction')).toBe(true);
  });

  it('fetches more until enough are left when summaries crowd the nearest hits', async () => {
    const C = 'project-sessions-crowd';
    for (let i = 0; i < 12; i++) {
      await storeMemory(`# Conversation compaction summary\n\nConsumer group lag session ${i}: the consumer group lag grew during rebalances.`, {
        collection: C, tags: ['compaction', 'journal'], metadata: { source: 'compaction' },
      });
    }
    for (const t of ['Lag alerts fire at 10,000 messages.', 'The billing consumer commits offsets every 5 seconds.', 'Static membership avoids rebalances on restart.']) {
      await storeMemory(t, { collection: C });
    }
    const r = await recallMemory('consumer group lag during rebalances session', { collection: C, nResults: 3, boost: false });
    expect(r).toHaveLength(3);
    expect(r.every(x => !x.metadata.source)).toBe(true);
  });

  it('knows a summary by its tags too, and keeps an ordinary memory about log compaction', async () => {
    const C = 'project-sessions-tags';
    await storeMemory('# Conversation compaction summary\n\nSession about topic retention and log compaction settings.', { collection: C, tags: ['compaction', 'journal'] });
    const { ids: [kafka] } = await storeMemory('Log compaction keeps the latest value per key; cleanup.policy=compact enables it.', { collection: C, tags: ['compaction', 'kafka'] });
    const r = await recallMemory('log compaction settings', { collection: C, nResults: 5, boost: false });
    expect(r.map(x => x.id)).toEqual([kafka]);
  });

  it('are not counted or grouped for memory compaction', async () => {
    const C = 'project-sessions-size';
    const { collectionSize, suggestCompaction } = await import('./compact.js');
    for (let i = 0; i < 3; i++) {
      await storeMemory(`# Conversation compaction summary\n\nSession ${i} about the importer retry loop.`, { collection: C, tags: ['compaction'], metadata: { source: 'compaction' } });
    }
    await storeMemory('The importer retries a failed batch three times.', { collection: C });
    expect(await collectionSize(C)).toBe(1);
    expect((await suggestCompaction(C)).flatMap(g => g.member_ids)).toEqual([]);
  });
});
