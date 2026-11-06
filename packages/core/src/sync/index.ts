
import { getConfig } from '../config.js';
import { pushToRemote, emptyPushStats, countUnpushed, type PushStats } from './push.js';
import { pullFromRemote, emptyPullStats, type PullStats } from './pull.js';
import { closeSyncBackend, getSyncBackend, isSyncConfigured, lastSyncError, noteSyncOk, syncBackendKind } from './backend.js';
import { recordSyncHealth, recordUnpushed } from './health.js';
import { readCycleRecord, recordCycle, shouldRunCycle, tryAcquireCycle } from './shared-cycle.js';
import { getSyncPullTimestamp } from './sentinel.js';
import { compareVersions } from '../update-check.js';

export interface SyncStats {
  push: PushStats;
  pull: PullStats;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncRunning = false;
/** The YAPA version running the timer (recorded with each cycle). */
let runningVersion: string | undefined;

// In-memory sync state for observability
let lastCycleAt: number | null = null;
let lastCycleError: string | null = null;
let cycleCount = 0;
/** Timer ticks this server skipped because another server synced recently or held the lock. */
let skippedCount = 0;
let timerActive = false;
let lastStats: SyncStats | null = null;

/** Get the current background sync state (in-memory, not persisted). */
export function getSyncState() {
  return { lastCycleAt, lastCycleError, cycleCount, skippedCount, timerActive, lastStats, lastError: lastSyncError() ?? null };
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
  const startedAt = Date.now();
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
    const hasPullActivity = pullStats.pulled > 0 || pullStats.updated > 0 || pullStats.moved > 0 || pullStats.linked > 0 || pullStats.deleted > 0 || pullStats.archived > 0 || pullStats.keptDirty > 0;
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

    // Claims made while offline: retry now that the remote answered.
    if (!hasErrors) {
      try {
        const { retryUnsharedClaims } = await import('../tasks/claim.js');
        await retryUnsharedClaims();
      } catch (e) {
        process.stderr.write(`[yapa-sync] Claim retry error: ${e}\n`);
      }
    }

    // Health for the status line: errors were recorded as they happened.
    const unpushed = await countUnpushed().catch(() => undefined);
    if (!hasErrors) noteSyncOk(unpushed);
    else if (unpushed !== undefined) recordUnpushed(unpushed);

    lastCycleAt = Date.now();
    lastCycleError = null;
    cycleCount++;
    lastStats = { push: pushStats, pull: pullStats };
    // Other servers on this machine skip their next tick.
    recordCycle({ startedAt, finishedAt: lastCycleAt, ok: !hasErrors, version: runningVersion });

    return lastStats;
  } catch (e) {
    const msg = `${e}`;
    process.stderr.write(`[yapa-sync] Cycle error: ${msg}\n`);
    lastCycleAt = Date.now();
    lastCycleError = msg;
    cycleCount++;
    recordCycle({ startedAt, finishedAt: lastCycleAt, ok: false, version: runningVersion });
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
 * Push this store's unpushed docs, without the pull half of a cycle: what a
 * local write needs. Pulls come from the shared interval cycle and the
 * prompt hook.
 */
export async function pushNow(): Promise<PushStats> {
  const stats = await pushToRemote();
  const unpushed = await countUnpushed().catch(() => undefined);
  if (stats.errors === 0) noteSyncOk(unpushed);
  else if (unpushed !== undefined) recordUnpushed(unpushed);
  return stats;
}

/**
 * Debounced, fire-and-forget push shortly after a local write, so teammates
 * see a new memory/task within seconds instead of on the next interval tick.
 */
export function scheduleSyncSoon(delayMs: number = getConfig().SYNC_PUSH_DEBOUNCE_MS): void {
  if (!isSyncConfigured() || delayMs <= 0) return;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    runTracked(pushNow()).catch(e => process.stderr.write(`[yapa-sync] Write-triggered push error: ${e}\n`));
  }, delayMs);
}

/**
 * One timer tick: run a full cycle unless another server on this machine
 * finished one within the interval or is running one now. `initial` (server
 * start) also runs for a store that has never pulled, and for a server newer
 * than the one that ran the last cycle.
 */
export async function syncTick(opts: { initial?: boolean; now?: number } = {}): Promise<SyncStats | null> {
  const now = opts.now ?? Date.now();
  let due = shouldRunCycle(now);
  if (!due && opts.initial) {
    const lastPull = await getSyncPullTimestamp().catch(() => 0);
    const last = readCycleRecord();
    due = lastPull === 0 || (!!runningVersion && compareVersions(runningVersion, last?.version) > 0);
  }
  if (!due) {
    skippedCount++;
    return null;
  }
  const release = tryAcquireCycle({ now, version: runningVersion });
  if (!release) {
    skippedCount++;
    return null;
  }
  try {
    return await syncCycle();
  } finally {
    release();
  }
}

/** The next tick, jittered ±10% so servers started together don't fire together. */
function scheduleTick(): void {
  const base = getConfig().SYNC_INTERVAL_MS;
  const delay = Math.max(1000, Math.round(base * (0.9 + Math.random() * 0.2)));
  syncTimer = setTimeout(() => {
    runTracked(syncTick())
      .catch(e => process.stderr.write(`[yapa-sync] Sync error: ${e}\n`))
      .finally(() => { if (timerActive) scheduleTick(); });
  }, delay);
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
export async function startSync(opts: { version?: string } = {}): Promise<void> {
  if (opts.version) runningVersion = opts.version;
  if (!getConfig().SYNC_ENABLED) {
    recordSyncHealth({ status: 'disabled' });
    return;
  }

  const kind = syncBackendKind();
  if (!kind) {
    process.stderr.write('[yapa-sync] YAPA_SYNC_SERVICE_URL not set: sync disabled\n');
    recordSyncHealth({ status: 'disabled' });
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

  // First cycle now (non-blocking), unless another server on this machine just ran one.
  runTracked(syncTick({ initial: true })).catch(e => process.stderr.write(`[yapa-sync] Initial sync error: ${e}\n`));

  // Recurring cycles, shared with the other servers on this machine.
  timerActive = true;
  scheduleTick();

  process.stderr.write(`[yapa-sync] Background sync started (interval: ${getConfig().SYNC_INTERVAL_MS / 1000}s)\n`);
}

/** One line summarizing a cycle's push and pull. */
export function formatSyncStats({ push, pull }: SyncStats): string {
  let line = `Push: ${push.pushed} new, ${push.linked} linked, ${push.deleted} deleted, ${push.retracted} retracted`;
  if (push.renamed) line += `, ${push.renamed} renamed`;
  if (push.rejected) line += `, ${push.rejected} refused (kept local)`;
  line += `, ${push.errors} errors | Pull: ${pull.pulled} new, ${pull.updated} updated, ${pull.moved} moved, ${pull.linked} linked, ${pull.deleted} deleted, ${pull.archived ?? 0} archived, ${pull.skipped} skipped`;
  if (pull.keptDirty) line += `, ${pull.keptDirty} remote deletions not applied (local edits kept)`;
  return `${line}, ${pull.errors} errors`;
}

/**
 * Stop the background sync process and close connections.
 */
export async function stopSync(): Promise<void> {
  timerActive = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  await closeSyncBackend();
  process.stderr.write('[yapa-sync] Sync stopped\n');
}
