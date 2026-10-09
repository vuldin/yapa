
import { getConfig } from '../config.js';
import { pushToRemote, emptyPushStats, type PushStats } from './push.js';
import { pullFromRemote, emptyPullStats, type PullStats } from './pull.js';
import { closeSyncBackend, getSyncBackend, isSyncConfigured, lastSyncError, syncBackendKind } from './backend.js';

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
let lastStats: SyncStats | null = null;

/** Get the current background sync state (in-memory, not persisted). */
export function getSyncState() {
  return { lastCycleAt, lastCycleError, cycleCount, timerActive, lastStats, lastError: lastSyncError() ?? null };
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
    let pushStats: PushStats = emptyPushStats();
    let pullStats: PullStats = emptyPullStats();

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

    const hasPushActivity = pushStats.pushed > 0 || pushStats.linked > 0 || pushStats.deleted > 0 || pushStats.retracted > 0;
    const hasPullActivity = pullStats.pulled > 0 || pullStats.updated > 0 || pullStats.moved > 0 || pullStats.linked > 0 || pullStats.deleted > 0 || pullStats.keptDirty > 0;
    const hasErrors = pushStats.errors > 0 || pullStats.errors > 0;

    if (hasPushActivity || hasPullActivity || pushStats.rejected > 0) {
      process.stderr.write(`[yapa-sync] ${formatSyncStats({ push: pushStats, pull: pullStats })}\n`);
    }

    if (hasErrors) {
      process.stderr.write(
        `[yapa-sync] Errors: ${pushStats.errors} push, ${pullStats.errors} pull\n`
      );
    }

    // Backend maintenance (Postgres: ivfflat index once there is enough data)
    try { await (await getSyncBackend())?.maintain(); } catch { /* non-critical */ }

    lastCycleAt = Date.now();
    lastCycleError = null;
    cycleCount++;
    lastStats = { push: pushStats, pull: pullStats };

    return lastStats;
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

let soonTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<unknown> | null = null;

function runTracked<T>(work: Promise<T>): Promise<T> {
  const tracked = work.finally(() => { if (inFlight === tracked) inFlight = null; });
  inFlight = tracked;
  return tracked;
}

/**
 * Debounced, fire-and-forget sync shortly after a local write, so teammates
 * see a new memory/task within seconds instead of on the next interval tick.
 */
export function scheduleSyncSoon(delayMs: number = getConfig().SYNC_PUSH_DEBOUNCE_MS): void {
  if (!isSyncConfigured() || delayMs <= 0) return;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    runTracked(syncCycle()).catch(e => process.stderr.write(`[yapa-sync] Write-triggered sync error: ${e}\n`));
  }, delayMs);
}

/** True while a write-triggered sync is scheduled but hasn't run yet. */
export function hasPendingSync(): boolean {
  return soonTimer !== null;
}

/**
 * Shutdown path: push any write still waiting on the debounce (and let an
 * in-flight cycle finish), bounded by `timeoutMs`. Without this, a memory
 * stored seconds before the session closed would sit unpushed until the next
 * session on this machine.
 */
export async function flushPendingSync(timeoutMs = 5000): Promise<void> {
  const work: Promise<unknown>[] = [];
  if (soonTimer) {
    clearTimeout(soonTimer);
    soonTimer = null;
    work.push(runTracked(pushToRemote()).catch(e => process.stderr.write(`[yapa-sync] Shutdown push error: ${e}\n`)));
  } else if (inFlight) {
    work.push(inFlight.catch(() => undefined));
  }
  if (work.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([Promise.all(work), timeout]);
  if (timer) clearTimeout(timer);
}

/**
 * Start the background sync process.
 * Runs schema migration on first connect, then syncs on interval.
 */
export async function startSync(): Promise<void> {
  if (!getConfig().SYNC_ENABLED) return;

  const kind = syncBackendKind();
  if (!kind) {
    process.stderr.write('[yapa-sync] YAPA_SYNC_SERVICE_URL not set: sync disabled\n');
    return;
  }
  if (kind === 'service' && getConfig().SYNC_DATABASE_URL) {
    process.stderr.write('[yapa-sync] Using the sync service; YAPA_SYNC_DATABASE_URL is ignored\n');
  }

  if (kind !== 'service' && !process.env.YAPA_USERNAME) {
    process.stderr.write(`[yapa-sync] Username defaults to the OS login '${getConfig().USERNAME}'. Set YAPA_USERNAME (plugin option username) to a name unique on your team: task ids and ownership are keyed on it.\n`);
  }

  // Validate the connection (Postgres: create the schema on first run).
  // Fail open: local memory and tasks work regardless; sync retries.
  try {
    const backend = await getSyncBackend();
    await backend?.prepare();
    process.stderr.write(`[yapa-sync] Connected to ${kind === 'service' ? 'the sync service' : 'the remote database'} (${backend?.target})\n`);
  } catch (e) {
    process.stderr.write(`[yapa-sync] Sync not connected: ${e}\n`);
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

/** One line summarizing a cycle's push and pull. */
export function formatSyncStats({ push, pull }: SyncStats): string {
  let line = `Push: ${push.pushed} new, ${push.linked} linked, ${push.deleted} deleted, ${push.retracted} retracted`;
  if (push.renamed) line += `, ${push.renamed} renamed`;
  if (push.rejected) line += `, ${push.rejected} refused (kept local)`;
  line += `, ${push.errors} errors | Pull: ${pull.pulled} new, ${pull.updated} updated, ${pull.moved} moved, ${pull.linked} linked, ${pull.deleted} deleted, ${pull.skipped} skipped`;
  if (pull.keptDirty) line += `, ${pull.keptDirty} remote deletions not applied (local edits kept)`;
  return `${line}, ${pull.errors} errors`;
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
  await closeSyncBackend();
  process.stderr.write('[yapa-sync] Sync stopped\n');
}
