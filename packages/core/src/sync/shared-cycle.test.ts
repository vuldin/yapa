import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfig, resetConfig, setConfig } from '../config.js';
import {
  pidAlive, readCycleRecord, recordCycle, recordPull, shouldPull, shouldRunCycle, syncTargetKey, tryAcquireCycle,
} from './shared-cycle.js';

const root = mkdtempSync(join(tmpdir(), 'yapa-shared-'));
let dir: string;
let n = 0;
const INTERVAL = 300_000;
const env = (extra: Record<string, string> = {}) => ({
  YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json'),
  YAPA_SYNC_SERVICE_URL: 'https://sync.example.com',
  YAPA_USERNAME: 'ada',
  YAPA_SYNC_INTERVAL_MS: String(INTERVAL),
  ...extra,
});

beforeEach(() => {
  dir = join(root, String(n++));
  setConfig(createConfig(env()));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  resetConfig();
});

describe('shouldRunCycle', () => {
  it('runs when nothing is recorded, skips after a recent cycle, runs once due', () => {
    expect(shouldRunCycle(1_000_000)).toBe(true);
    recordCycle({ startedAt: 999_000, finishedAt: 1_000_000, ok: true, version: '1.8.0' });
    expect(shouldRunCycle(1_000_000 + 60_000)).toBe(false);
    expect(shouldRunCycle(1_000_000 + INTERVAL * 0.9)).toBe(true);
    expect(readCycleRecord()).toMatchObject({ cycles: 1, pid: process.pid, version: '1.8.0', ok_at: 1_000_000 });
  });

  it('counts cycles and keeps the last OK time across a failed one', () => {
    recordCycle({ startedAt: 1, finishedAt: 10, ok: true });
    recordCycle({ startedAt: 11, finishedAt: 20, ok: false });
    expect(readCycleRecord()).toMatchObject({ cycles: 2, finished_at: 20, ok_at: 10 });
  });

  it('fails open: a corrupt record, a clock that went back, or coordination off', () => {
    recordCycle({ startedAt: 1, finishedAt: 1_000_000, ok: true });
    const file = readdirSync(dir).find(f => f.startsWith('sync-cycle-') && f.endsWith('.json'))!;
    writeFileSync(join(dir, file), '{oops');
    expect(shouldRunCycle(1_000_001)).toBe(true);
    recordCycle({ startedAt: 1, finishedAt: 10_000_000, ok: true });
    expect(shouldRunCycle(1_000_000)).toBe(true); // recorded "in the future"
    setConfig(createConfig(env({ YAPA_SYNC_COORDINATE: 'false' })));
    recordCycle({ startedAt: 1, finishedAt: 2_000_000, ok: true });
    expect(shouldRunCycle(2_000_001)).toBe(true);
  });
});

describe('tryAcquireCycle', () => {
  it('lets one holder in at a time and releases', () => {
    const release = tryAcquireCycle({ now: 1000 });
    expect(release).toBeTypeOf('function');
    expect(tryAcquireCycle({ now: 1001, alive: () => true })).toBeUndefined();
    release!();
    const again = tryAcquireCycle({ now: 1002 });
    expect(again).toBeTypeOf('function');
    again!();
  });

  it('takes over a lock whose holder died, or that is too old', () => {
    const held = tryAcquireCycle({ now: 1000 })!;
    expect(held).toBeTypeOf('function');
    // The holder (this pid, as far as the file says) is dead:
    const takeover = tryAcquireCycle({ now: 2000, alive: () => false });
    expect(takeover).toBeTypeOf('function');
    // The old holder's release must not remove the new holder's lock.
    held();
    expect(tryAcquireCycle({ now: 2001, alive: () => true })).toBeUndefined();
    takeover!();

    tryAcquireCycle({ now: 0 });
    expect(tryAcquireCycle({ now: 2 * INTERVAL + 1, alive: () => true })).toBeTypeOf('function'); // stale by age
  });

  it('always succeeds with coordination off', () => {
    setConfig(createConfig(env({ YAPA_SYNC_COORDINATE: 'false' })));
    expect(tryAcquireCycle()).toBeTypeOf('function');
    expect(tryAcquireCycle()).toBeTypeOf('function');
    expect(existsSync(dir)).toBe(false);
  });
});

describe('syncTargetKey', () => {
  it('differs by remote, store and username, and never includes a password', () => {
    const base = syncTargetKey(createConfig(env()));
    expect(syncTargetKey(createConfig(env({ YAPA_USERNAME: 'bob' })))).not.toBe(base);
    expect(syncTargetKey(createConfig(env({ YAPA_SYNC_SERVICE_URL: 'https://other.example.com' })))).not.toBe(base);
    expect(syncTargetKey(createConfig(env({ YAPA_CHROMA_URL: 'http://localhost:9000' })))).not.toBe(base);
    const pg = (pw: string) => syncTargetKey(createConfig(env({ YAPA_SYNC_SERVICE_URL: '', YAPA_SYNC_DATABASE_URL: `postgres://u:${pw}@db:5432/yapa` })));
    expect(pg('one')).toBe(pg('two'));
    expect(pg('one')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('two targets keep separate records', () => {
    recordCycle({ startedAt: 1, finishedAt: 1_000_000, ok: true });
    setConfig(createConfig(env({ YAPA_USERNAME: 'bob' })));
    expect(readCycleRecord()).toBeUndefined();
    expect(shouldRunCycle(1_000_001)).toBe(true);
  });
});

describe('shouldPull', () => {
  it('skips a collection pulled within the window, by any session', () => {
    expect(shouldPull('project-x', 100_000)).toBe(true);
    recordPull('project-x', 100_000);
    expect(shouldPull('project-x', 110_000)).toBe(false);
    expect(shouldPull('project-y', 110_000)).toBe(true);
    expect(shouldPull('project-x', 130_000)).toBe(true);
  });

  it('a full cycle that finished OK counts as a pull of everything', () => {
    recordCycle({ startedAt: 1, finishedAt: 100_000, ok: true });
    expect(shouldPull('project-z', 110_000)).toBe(false);
    recordCycle({ startedAt: 1, finishedAt: 200_000, ok: false });
    expect(shouldPull('project-z', 210_000)).toBe(true); // failed cycles don't count
  });

  it('a window of 0 always pulls', () => {
    setConfig(createConfig(env({ YAPA_HOOK_PULL_WINDOW_MS: '0' })));
    recordPull('project-x', 100_000);
    expect(shouldPull('project-x', 100_001)).toBe(true);
  });
});

describe('pidAlive', () => {
  it('knows this process and rejects nonsense', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
