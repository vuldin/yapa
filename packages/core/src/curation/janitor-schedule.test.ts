import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setConfig, resetConfig, createConfig } from '../config.js';
import { setStore, resetStore, createLocalStore, getStore } from '../store/index.js';
import { jobFiles } from '../jobs.js';
import { readJanitorRecord, runJanitorIfDue } from './janitor-schedule.js';

const HOUR = 3600_000;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-janitor-job-'));
  setConfig(createConfig({ YAPA_USERNAME: 'tester', YAPA_SYNC_HEALTH_FILE: join(dir, 'state', 'sync-health.json'), YAPA_CONTRADICTION_DISTANCE_THRESHOLD: '2' }));
  setStore(createLocalStore(join(dir, 'store')));
  await getStore().createCollection('global');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetStore();
  resetConfig();
});

const add = (id: string, content: string, created = 100) =>
  getStore().addDocument('global', id, content, { type: 'memory', username: 'tester', salience: 1, created_at: created });
const distinct = async () => '{"action":"add","rationale":"different"}';

describe('runJanitorIfDue', () => {
  it('runs once per interval and records what it did', async () => {
    await add('a', 'The broker count is three.');
    await add('b', 'There are three brokers.');
    const t0 = Date.now();
    const first = await runJanitorIfDue({ now: t0, call: distinct });
    expect(first?.keptDistinct).toBe(1);
    expect(await runJanitorIfDue({ now: t0 + HOUR, call: distinct })).toBeUndefined();
    const r = readJanitorRecord();
    expect(r?.result?.stats.keptDistinct).toBe(1);
    expect(r?.result?.kept_pairs).toEqual(['a|b']);
    expect(r?.result?.scan_from).toBe(Math.floor(t0 / 1000));
  });

  it('does not judge a kept pair again, and scans only what changed', async () => {
    await add('a', 'The broker count is three.');
    await add('b', 'There are three brokers.');
    const t0 = Date.now();
    await runJanitorIfDue({ now: t0, call: distinct });
    const again = await runJanitorIfDue({ now: t0 + 25 * HOUR, call: distinct });
    expect(again?.pairsConsidered).toBe(0);
  });

  it('keeps the starting point after an incomplete run', async () => {
    await add('a', 'The broker count is three.');
    await add('b', 'There are three brokers.');
    const t0 = Date.now();
    await runJanitorIfDue({ now: t0, call: async () => { throw new Error('model down'); } });
    expect(readJanitorRecord()?.result?.scan_from).toBeUndefined();
    const retry = await runJanitorIfDue({ now: t0 + 25 * HOUR, call: distinct });
    expect(retry?.keptDistinct).toBe(1);
  });

  it('skips while another live process holds the lock, and when turned off', async () => {
    const f = jobFiles('janitor')!;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(f.lock, JSON.stringify({ pid: process.pid, started_at: Date.now() }));
    expect(await runJanitorIfDue({ call: distinct })).toBeUndefined();
    rmSync(f.lock);
    expect(await runJanitorIfDue({ enabled: false, call: distinct })).toBeUndefined();
    expect(await runJanitorIfDue({ call: distinct })).toBeDefined();
  });
});
