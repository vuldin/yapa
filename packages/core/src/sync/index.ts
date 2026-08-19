
import { getConfig } from '../config.js';
import { migrateSchema, ensureVectorIndex } from './schema.js';
import { pushToRemote, PushStats } from './push.js';
import { pullFromRemote, PullStats } from './pull.js';
import { checkRemoteHealth, closePool } from './postgres.js';

export interface SyncStats {
  push: PushStats;
  pull: PullStats;
}

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;

// In-memory sync state for observability
let lastCycleAt: number | null = null;
let lastCycleError: string | null = null;
let cycleCount = 0;
let timerActive = false;

/** Get the current background sync state (in-memory, not persisted). */
export function getSyncState() {
  return { lastCycleAt, lastCycleError, cycleCount, timerActive };
}

/**
 * Run a single sync cycle: push local changes, then pull remote changes.
 * Push and pull are independent — a push failure won't block pull.
 * Returns stats, or null if skipped (previous cycle still running).
 */
export async function syncCycle(): Promise<SyncStats | null> {
  if (syncRunning) {
    process.stderr.write('[yapa-sync] Skipping cycle — previous still running\n');
    return null;
  }

  syncRunning = true;
  try {
    let pushStats: PushStats = { pushed: 0, linked: 0, deleted: 0, errors: 0 };
    let pullStats: PullStats = { pulled: 0, linked: 0, skipped: 0, errors: 0 };

    try {
      pushStats = await pushToRemote();
    } catch (e) {
      process.stderr.write(`[yapa-sync] Push phase error: ${e}\n`);
      pushStats.errors++;
    }

    try {
      pullStats = await pullFromRemote();
    } catch (e) {
      process.stderr.write(`[yapa-sync] Pull phase error: ${e}\n`);
      pullStats.errors++;
    }

    const hasPushActivity = pushStats.pushed > 0 || pushStats.linked > 0 || pushStats.deleted > 0;
    const hasPullActivity = pullStats.pulled > 0 || pullStats.linked > 0;
    const hasErrors = pushStats.errors > 0 || pullStats.errors > 0;

    if (hasPushActivity || hasPullActivity) {
      process.stderr.write(
        `[yapa-sync] Push: ${pushStats.pushed} new, ${pushStats.linked} linked, ${pushStats.deleted} deleted` +
        ` | Pull: ${pullStats.pulled} new, ${pullStats.linked} linked, ${pullStats.skipped} skipped\n`
      );
    }

    if (hasErrors) {
      process.stderr.write(
        `[yapa-sync] Errors: ${pushStats.errors} push, ${pullStats.errors} pull\n`
      );
    }

    // Try to create ivfflat index if we have enough data
    try { await ensureVectorIndex(); } catch { /* non-critical */ }

    lastCycleAt = Date.now();
    lastCycleError = null;
    cycleCount++;

    return { push: pushStats, pull: pullStats };
  } catch (e) {
    const msg = `${e}`;
    process.stderr.write(`[yapa-sync] Cycle error: ${msg}\n`);
    lastCycleAt = Date.now();
    lastCycleError = msg;
    cycleCount++;
    return null;
  } finally {
    syncRunning = false;
  }
}

/**
 * Start the background sync process.
 * Runs schema migration on first connect, then syncs on interval.
 */
export async function startSync(): Promise<void> {
  if (!getConfig().SYNC_ENABLED) return;

  if (!getConfig().SYNC_DATABASE_URL) {
    process.stderr.write('[yapa-sync] YAPA_SYNC_DATABASE_URL not set — sync disabled\n');
    return;
  }

  // Validate connection and migrate schema
  try {
    const health = await checkRemoteHealth();
    if (!health.ok) {
      // First run — try schema migration
      await migrateSchema();
      process.stderr.write(`[yapa-sync] Connected to remote database\n`);
    } else {
      process.stderr.write(`[yapa-sync] Remote database healthy\n`);
    }
  } catch (e) {
    process.stderr.write(`[yapa-sync] Failed to connect to remote database: ${e}\n`);
    process.stderr.write('[yapa-sync] Sync will retry on next interval\n');
  }

  // Run first sync immediately (non-blocking)
  syncCycle().catch(e => process.stderr.write(`[yapa-sync] Initial sync error: ${e}\n`));

  // Schedule recurring sync
  syncTimer = setInterval(() => {
    syncCycle().catch(e => process.stderr.write(`[yapa-sync] Sync error: ${e}\n`));
  }, getConfig().SYNC_INTERVAL_MS);
  timerActive = true;

  process.stderr.write(`[yapa-sync] Background sync started (interval: ${getConfig().SYNC_INTERVAL_MS / 1000}s)\n`);
}

/**
 * Stop the background sync process and close connections.
 */
export async function stopSync(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    timerActive = false;
  }
  await closePool();
  process.stderr.write('[yapa-sync] Sync stopped\n');
}
