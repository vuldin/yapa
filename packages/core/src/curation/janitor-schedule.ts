/**
 * The janitor as a daily background job, shared by every session on the
 * machine: one run per JANITOR_INTERVAL_MS, under a lock, with a record of
 * what it did (`yapa janitor status`).
 *
 * Runs are incremental. Only memories created or changed since the last
 * complete run look for neighbours, and pairs judged distinct are
 * remembered and not judged again. A run that hit its pair budget or had
 * errors keeps the previous starting point, so nothing is skipped.
 *
 * @module @yapa/core/curation/janitor-schedule
 */
import { getConfig } from '../config.js';
import { jobDue, jobFiles, readJobRecord, recordJob, tryAcquireJob, type JobRecord } from '../jobs.js';
import { janitorSweep, type JanitorStats } from './janitor.js';
import { useSubscriptionModelIfNoKey, type HostLLMCaller } from './provider.js';

export const JANITOR_JOB = 'janitor';
const STALE_LOCK_MS = 2 * 3600_000;
const MAX_KEPT_PAIRS = 5000;

export interface JanitorRunResult {
  stats: Omit<JanitorStats, 'keptPairs'>;
  /** Unix seconds the next run scans from (undefined: everything). */
  scan_from?: number;
  /** Pair keys judged distinct, newest last. */
  kept_pairs: string[];
}

export interface JanitorRunOptions {
  now?: number;
  version?: string;
  /** Run even when not due (still under the lock). */
  force?: boolean;
  /** Override JANITOR_ENABLED (DSH passes its own setting). */
  enabled?: boolean;
  maxPairs?: number;
  call?: HostLLMCaller;
  /** Called after a run that archived or superseded something. */
  onChange?: () => void;
}

/** Without a record file (tests, no health file), remember the last run in-process. */
let lastRunInProcess: number | undefined;

export function readJanitorRecord(): JobRecord<JanitorRunResult> | undefined {
  return readJobRecord<JanitorRunResult>(JANITOR_JOB);
}

/** Run the janitor if it's due. Returns its stats, or undefined when it didn't run. */
export async function runJanitorIfDue(opts: JanitorRunOptions = {}): Promise<JanitorStats | undefined> {
  const config = getConfig();
  if (!(opts.enabled ?? config.JANITOR_ENABLED)) return undefined;
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    if (!jobDue(JANITOR_JOB, config.JANITOR_INTERVAL_MS, now)) return undefined;
    if (!jobFiles(JANITOR_JOB) && lastRunInProcess !== undefined && now - lastRunInProcess < config.JANITOR_INTERVAL_MS) return undefined;
  }
  const release = tryAcquireJob(JANITOR_JOB, STALE_LOCK_MS, { now, version: opts.version });
  if (!release) return undefined;
  try {
    // Another session may have finished a run between the check and the lock.
    if (!opts.force && !jobDue(JANITOR_JOB, config.JANITOR_INTERVAL_MS, now)) return undefined;
    const prev = readJanitorRecord()?.result;
    const maxPairs = opts.maxPairs ?? config.JANITOR_MAX_PAIRS;
    if (!opts.call) useSubscriptionModelIfNoKey();
    const stats = await janitorSweep({
      maxPairs,
      since: prev?.scan_from,
      skipPairs: new Set(prev?.kept_pairs ?? []),
      ...(opts.call ? { call: opts.call } : {}),
    });
    const complete = stats.errors === 0 && stats.pairsConsidered < maxPairs;
    const { keptPairs, ...rest } = stats;
    const result: JanitorRunResult = {
      stats: rest,
      scan_from: complete ? Math.floor(now / 1000) : prev?.scan_from,
      kept_pairs: [...(prev?.kept_pairs ?? []), ...keptPairs].slice(-MAX_KEPT_PAIRS),
    };
    recordJob(JANITOR_JOB, { startedAt: now, ...(opts.now !== undefined ? { finishedAt: now } : {}), version: opts.version, result });
    lastRunInProcess = now;
    if (stats.skippedDuplicates || stats.superseded) opts.onChange?.();
    return stats;
  } finally {
    release();
  }
}
