import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { pushToRemote, pullFromRemote } = vi.hoisted(() => ({
  pushToRemote: vi.fn(async () => ({ pushed: 1, linked: 0, deleted: 0, retracted: 0, rejected: 0, renamed: 0, errors: 0 })),
  pullFromRemote: vi.fn(async () => ({ pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, keptDirty: 0, errors: 0 })),
}));
vi.mock('./push.js', () => ({ pushToRemote, emptyPushStats: () => ({ pushed: 0, linked: 0, deleted: 0, retracted: 0, rejected: 0, renamed: 0, errors: 0 }) }));
vi.mock('./pull.js', () => ({ pullFromRemote, emptyPullStats: () => ({ pulled: 0, updated: 0, moved: 0, linked: 0, skipped: 0, deleted: 0, keptDirty: 0, errors: 0 }) }));
vi.mock('./schema.js', () => ({ migrateSchema: vi.fn(), ensureVectorIndex: vi.fn(async () => {}) }));
vi.mock('./postgres.js', () => ({ checkRemoteHealth: vi.fn(), closePool: vi.fn() }));

import { setConfig, resetConfig, createConfig } from '../config.js';
import { scheduleSyncSoon, hasPendingSync, flushPendingSync } from './index.js';

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
  it('debounces a burst of writes into one sync cycle', async () => {
    scheduleSyncSoon();
    scheduleSyncSoon();
    scheduleSyncSoon();
    expect(hasPendingSync()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pushToRemote).toHaveBeenCalledTimes(1);
    expect(pullFromRemote).toHaveBeenCalledTimes(1);
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
