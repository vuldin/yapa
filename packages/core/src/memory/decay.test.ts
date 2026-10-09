import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore, getDocumentsByIds } from '../store/index.js';
import { runDecaySweep, shouldRunDecay, markDecayRun } from './decay.js';

const DAY = 86400;
const NOW = 1_800_000_000;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-decay-'));
  setConfig(createConfig({}));
  setStore(createLocalStore(dir));
  await getStore().createCollection('global');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

const add = (id: string, md: Record<string, any>) =>
  getStore().addDocument('global', id, `memory ${id}`, { type: 'memory', salience: 2, sector: 'episodic', created_at: NOW - 200 * DAY, ...md });
const sal = async (id: string) => (await getDocumentsByIds('global', [id]))[0].metadata.salience;

describe('runDecaySweep (wall-clock)', () => {
  it('decays each memory by the time since it was last decayed', async () => {
    await add('a', { decayed_at: NOW - 7 * DAY });
    await add('b', { decayed_at: NOW - 1 * DAY, sector: 'semantic' });
    await runDecaySweep(NOW);
    expect(await sal('a')).toBeCloseTo(2 * 0.98 ** 7);
    expect(await sal('b')).toBeCloseTo(2 * Math.sqrt(0.98));
  });

  it('is idempotent: an immediate re-run decays nothing more', async () => {
    await add('a', { decayed_at: NOW - 3 * DAY });
    await runDecaySweep(NOW);
    const once = await sal('a');
    await runDecaySweep(NOW);
    expect(await sal('a')).toBeCloseTo(once);
  });

  it('starts legacy memories (no decayed_at) from the previous sweep, never from creation', async () => {
    await markDecayRun(NOW - 2 * DAY);
    await add('legacy', {}); // created 200 days ago
    await runDecaySweep(NOW);
    expect(await sal('legacy')).toBeCloseTo(2 * 0.98 ** 2); // not 0.98^200
  });

  it('falls back to one day when no sweep was ever recorded', async () => {
    await add('legacy', {});
    await runDecaySweep(NOW);
    expect(await sal('legacy')).toBeCloseTo(2 * 0.98);
  });

  it('leaves tasks alone', async () => {
    await getStore().addDocument('global', 't1', 'a task', { type: 'task', salience: 3, decayed_at: NOW - 30 * DAY });
    await runDecaySweep(NOW);
    expect(await sal('t1')).toBe(3);
  });
});

describe('shouldRunDecay', () => {
  it('gates sweeps to once per 24h', async () => {
    expect(await shouldRunDecay(NOW)).toBe(true);
    await markDecayRun(NOW);
    expect(await shouldRunDecay(NOW + DAY - 1)).toBe(false);
    expect(await shouldRunDecay(NOW + DAY + 1)).toBe(true);
  });
});
