import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getDocumentsByIds } from '../store/index.js';
import { storeMemory } from './store.js';
import { recallMemory } from './recall.js';

let dir: string;
let portId: string;
let lunchId: string;
const sal = async (id: string) => (await getDocumentsByIds('global', [id]))[0].metadata.salience;
const settle = () => new Promise(r => setTimeout(r, 50)); // boosts are written fire-and-forget

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-recall-'));
  setConfig(createConfig({}));
  setStore(createLocalStore(dir));
  portId = (await storeMemory('The billing API listens on port 8443 behind the internal load balancer', { collection: 'global', salience: 2 })).ids[0];
  lunchId = (await storeMemory('Team lunch is on Fridays at the taco place', { collection: 'global', salience: 2 })).ids[0];
});

afterAll(() => {
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
