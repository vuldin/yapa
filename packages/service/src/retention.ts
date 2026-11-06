/**
 * Retention of soft-deleted rows (07_soft_delete.sql). Rows in
 * deleted_documents older than YAPA_DELETED_RETENTION_DAYS are removed
 * lazily: requests that touch deleted rows (batchDelete, restore, purge,
 * listDeleted, pull) call `maybeSweep()`, which starts at most one sweep per
 * interval per instance in the background. A request never waits for it, and
 * a failed sweep is logged and retried after the next interval.
 */
import { log } from './log.js';

export const RETENTION_SWEEP_INTERVAL_MS = 5 * 60_000;

export class RetentionSweeper {
  private last = Number.NEGATIVE_INFINITY;
  private running: Promise<void> | undefined;

  constructor(
    /** Removes expired rows; resolves to how many. */
    private readonly sweep: () => Promise<number>,
    private readonly intervalMs = RETENTION_SWEEP_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Start a sweep if none ran in the last interval and none is running.
   * Returns the started sweep (tests await it) or undefined; it never
   * rejects, and callers must not await it on a request path.
   */
  maybeSweep(): Promise<void> | undefined {
    const t = this.now();
    if (this.running || t - this.last < this.intervalMs) return undefined;
    // Stamp before running, so a failing database is not hit on every request.
    this.last = t;
    let started: Promise<number>;
    try {
      started = this.sweep();
    } catch (e) {
      started = Promise.reject(e);
    }
    this.running = started.then(
      n => { if (n > 0) log('INFO', 'expired soft-deleted rows removed', { event: 'retention_sweep', removed: n }); },
      e => { log('WARNING', 'retention sweep failed', { event: 'retention_sweep_failed', error: e instanceof Error ? e.message : String(e) }); },
    ).finally(() => { this.running = undefined; });
    return this.running;
  }
}
