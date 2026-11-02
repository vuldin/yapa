import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { pushToRemote, pullFromRemote } = vi.hoisted(() => ({
  pushToRemote: vi.fn(async () => ({ pushed: 1, linked: 0, deleted: 0, retracted: 0, rejected: 0, renamed: 0, errors: 0 })),
  pullFromRemote: vi.fn(async () => ({ pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, keptDirty: 0, errors: 0 })),
}));
vi.mock('./push.js', () => ({ pushToRemote, countUnpushed: async () => 0, emptyPushStats: () => ({ pushed: 0, linked: 0, deleted: 0, retracted: 0, rejected: 0, renamed: 0, errors: 0 }) }));
vi.mock('./pull.js', () => ({ pullFromRemote, emptyPullStats: () => ({ pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, keptDirty: 0, errors: 0 }) }));
vi.mock('./schema.js', () => ({ migrateSchema: vi.fn(), ensureVectorIndex: vi.fn(async () => {}) }));
vi.mock('./postgres.js', () => ({ checkRemoteHealth: vi.fn(), closePool: vi.fn() }));
vi.mock('./sentinel.js', () => ({ getSyncPullTimestamp: vi.fn(async () => 1_700_000_000) }));

import { setConfig, resetConfig, createConfig } from '../config.js';
import { scheduleSyncSoon, hasPendingSync, flushPendingSync, syncTick, getSyncState } from './index.js';
import { recordCycle, tryAcquireCycle } from './shared-cycle.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeEach(() => {
  vi.useFakeTimers();
  pushToRemote.mockClear();
  pullFromRemote.mockClear();
  setConfig(createConfig({ YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: 'postgres://x', YAPA_SYNC_PUSH_DEBOUNCE_MS: '2000' }));
});

afterEach(() => {
  vi.useRealTimers();
  resetConfig();
});

describe('scheduleSyncSoon', () => {
  it('debounces a burst of writes into one push (pulls come from the shared cycle)', async () => {
    scheduleSyncSoon();
    scheduleSyncSoon();
    scheduleSyncSoon();
    expect(hasPendingSync()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pushToRemote).toHaveBeenCalledTimes(1);
    expect(pullFromRemote).not.toHaveBeenCalled();
    expect(hasPendingSync()).toBe(false);
  });

  it('is a no-op when sync is disabled', async () => {
    setConfig(createConfig({}));
    scheduleSyncSoon();
    expect(hasPendingSync()).toBe(false);
  });
});

describe('flushPendingSync', () => {
  it('pushes a write still waiting on the debounce at shutdown', async () => {
    scheduleSyncSoon();
    await flushPendingSync(1000);
    expect(pushToRemote).toHaveBeenCalledTimes(1);
    expect(hasPendingSync()).toBe(false);
    // The debounce timer was cancelled, not left to fire a second cycle.
    await vi.advanceTimersByTimeAsync(5000);
    expect(pushToRemote).toHaveBeenCalledTimes(1);
  });

  it('returns immediately with nothing pending', async () => {
    await flushPendingSync(1000);
    expect(pushToRemote).not.toHaveBeenCalled();
  });
});

describe('syncTick (shared with the other servers on this machine)', () => {
  let dir: string;
  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), 'yapa-tick-'));
    setConfig(createConfig({
      YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_DATABASE_URL: 'postgres://x', YAPA_SYNC_HEALTH_FILE: join(dir, 'sync-health.json'),
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a cycle when due, then skips while another server synced recently', async () => {
    expect(await syncTick()).not.toBeNull();
    expect(pullFromRemote).toHaveBeenCalledTimes(1);
    const skipped = getSyncState().skippedCount;
    expect(await syncTick()).toBeNull(); // this run's own record now says "just synced"
    expect(pullFromRemote).toHaveBeenCalledTimes(1);
    expect(getSyncState().skippedCount).toBe(skipped + 1);
  });

  it('skips while another server holds the lock, and runs once it is released', async () => {
    const release = tryAcquireCycle()!;
    // The lock file names this pid, which is alive: held.
    expect(await syncTick()).toBeNull();
    expect(pullFromRemote).not.toHaveBeenCalled();
    release();
    expect(await syncTick()).not.toBeNull();
  });

  it('at startup, a store that has never pulled syncs anyway', async () => {
    const { getSyncPullTimestamp } = await import('./sentinel.js');
    recordCycle({ startedAt: Date.now() - 1000, finishedAt: Date.now(), ok: true });
    expect(await syncTick({ initial: true })).toBeNull();
    vi.mocked(getSyncPullTimestamp).mockResolvedValueOnce(0);
    expect(await syncTick({ initial: true })).not.toBeNull();
  });
});
