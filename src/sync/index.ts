import { SYNC_ENABLED, SYNC_DATABASE_URL, SYNC_INTERVAL_MS } from '../config.js';
import { migrateSchema, ensureVectorIndex } from './schema.js';
import { pushToRemote } from './push.js';
import { pullFromRemote } from './pull.js';
import { checkRemoteHealth, closePool } from './postgres.js';

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;

/**
 * Run a single sync cycle: push local changes, then pull remote changes.
 */
export async function syncCycle(): Promise<void> {
  if (syncRunning) {
    process.stderr.write('[yapa-sync] Skipping cycle — previous still running\n');
    return;
  }

  syncRunning = true;
  try {
    const pushStats = await pushToRemote();
    const pullStats = await pullFromRemote();

    const hasPushActivity = pushStats.pushed > 0 || pushStats.linked > 0 || pushStats.deleted > 0;
    const hasPullActivity = pullStats.pulled > 0 || pullStats.linked > 0;

    if (hasPushActivity || hasPullActivity) {
      process.stderr.write(
        `[yapa-sync] Push: ${pushStats.pushed} new, ${pushStats.linked} linked, ${pushStats.deleted} deleted` +
        ` | Pull: ${pullStats.pulled} new, ${pullStats.linked} linked, ${pullStats.skipped} skipped\n`
      );
    }

    // Try to create ivfflat index if we have enough data
    await ensureVectorIndex();
  } catch (e) {
    process.stderr.write(`[yapa-sync] Cycle error: ${e}\n`);
  } finally {
    syncRunning = false;
  }
}

/**
 * Start the background sync process.
 * Runs schema migration on first connect, then syncs on interval.
 */
export async function startSync(): Promise<void> {
  if (!SYNC_ENABLED) return;

  if (!SYNC_DATABASE_URL) {
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
  }, SYNC_INTERVAL_MS);

  process.stderr.write(`[yapa-sync] Background sync started (interval: ${SYNC_INTERVAL_MS / 1000}s)\n`);
}

/**
 * Stop the background sync process and close connections.
 */
export async function stopSync(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  await closePool();
  process.stderr.write('[yapa-sync] Sync stopped\n');
}
