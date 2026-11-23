/**
 * One sync cycle per interval per machine, however many sessions are open.
 *
 * Every Claude Code session runs its own MCP server, and each one used to run
 * a full sync cycle on its own timer. The servers now share a small record of
 * the last cycle and a lock, beside the sync health file. A timer tick skips
 * when a cycle finished recently or another server holds the lock. The prompt
 * hook's pull of the active collection skips when any session pulled it (or a
 * full cycle finished OK) within HOOK_PULL_WINDOW_MS.
 *
 * This is an optimization, not a guarantee: a lost race, a corrupt file or a
 * server that predates it only means an extra cycle, which is how every
 * server behaved before. Anything unreadable means "go ahead".
 *
 * The files are keyed by sync target (remote, local store, username), so two
 * installs with different settings on one machine never sync for each other.
 *
 * @module @yapa/core/sync/shared-cycle
 */
import { createHash } from 'node:crypto';
import { pidAlive } from '../fs-lock.js';
import { dirname, join } from 'node:path';
import { getConfig, type YapaConfig } from '../config.js';
import { readJson, tryAcquireFileLock, writeJson, type Release } from '../jobs.js';

export interface CycleRecord {
  /** When the last full cycle started and finished (epoch ms). */
  started_at: number;
  finished_at: number;
  /** When the last cycle without errors finished. */
  ok_at?: number;
  /** Who ran it. */
  pid: number;
  version?: string;
  /** Full cycles recorded on this machine for this target. */
  cycles: number;
}

/** Fraction of the interval after which a cycle is due again (jitter absorbs the rest). */
const DUE_FRACTION = 0.9;
const MIN_STALE_LOCK_MS = 10 * 60 * 1000;

/** The sync target this process syncs: kind, remote and local store, never a password. */
export function syncTargetKey(config: YapaConfig = getConfig()): string {
  let remote = '';
  if (config.SYNC_MCP_URL) remote = `mcp:${config.SYNC_MCP_URL}`;
  else if (config.SYNC_SERVICE_URL) remote = `service:${config.SYNC_SERVICE_URL}`;
  else if (config.SYNC_DATABASE_URL) {
    try {
      const u = new URL(config.SYNC_DATABASE_URL);
      remote = `postgres:${u.hostname}:${u.port}${u.pathname}`;
    } catch {
      remote = 'postgres:unparsed';
    }
  }
  const store = config.STORAGE === 'local' ? `local:${config.LOCAL_STORE_PATH}` : `chroma:${config.CHROMA_URL}`;
  return createHash('sha256').update(JSON.stringify([remote, store, config.USERNAME])).digest('hex').slice(0, 12);
}

/** The folder the shared files live in, or undefined when coordination is off. */
function sharedDir(config: YapaConfig = getConfig()): string | undefined {
  if (!config.SYNC_COORDINATE || !config.SYNC_HEALTH_FILE) return undefined;
  return dirname(config.SYNC_HEALTH_FILE);
}

function paths(config: YapaConfig = getConfig()) {
  const dir = sharedDir(config);
  if (!dir) return undefined;
  const key = syncTargetKey(config);
  return {
    dir,
    record: join(dir, `sync-cycle-${key}.json`),
    lock: join(dir, `sync-cycle-${key}.lock`),
    pulls: join(dir, `sync-pulls-${key}.json`),
  };
}

export function readCycleRecord(config: YapaConfig = getConfig()): CycleRecord | undefined {
  const p = paths(config);
  if (!p) return undefined;
  const r = readJson<CycleRecord>(p.record);
  return r && typeof r.finished_at === 'number' ? r : undefined;
}

/** True when no cycle finished within the interval (or coordination is off). */
export function shouldRunCycle(now: number = Date.now(), config: YapaConfig = getConfig()): boolean {
  const r = readCycleRecord(config);
  if (!r) return true;
  return now - r.finished_at >= config.SYNC_INTERVAL_MS * DUE_FRACTION || r.finished_at > now + 60_000; // clock went back
}

export type { Release };

/**
 * Take the machine-wide cycle lock. Returns a release function, or undefined
 * when another live server holds it. With coordination off, always succeeds.
 */
export function tryAcquireCycle(
  opts: { now?: number; version?: string; alive?: (pid: number) => boolean } = {},
  config: YapaConfig = getConfig(),
): Release | undefined {
  const p = paths(config);
  if (!p) return () => {};
  const staleAfter = Math.max(2 * config.SYNC_INTERVAL_MS, MIN_STALE_LOCK_MS);
  return tryAcquireFileLock(p.lock, staleAfter, opts);
}

/** Note a finished full cycle (manual or timed). */
export function recordCycle(
  run: { startedAt: number; finishedAt?: number; ok: boolean; version?: string },
  config: YapaConfig = getConfig(),
): void {
  const p = paths(config);
  if (!p) return;
  const prev = readJson<CycleRecord>(p.record);
  const finished = run.finishedAt ?? Date.now();
  const next: CycleRecord = {
    started_at: run.startedAt,
    finished_at: finished,
    pid: process.pid,
    cycles: (typeof prev?.cycles === 'number' ? prev.cycles : 0) + 1,
    ...(run.version ? { version: run.version } : {}),
  };
  const okAt = run.ok ? finished : prev?.ok_at;
  if (okAt) next.ok_at = okAt;
  writeJson(p.record, next);
}

/**
 * Should the prompt hook pull this collection? False when any session pulled
 * it, or a full cycle finished OK, within HOOK_PULL_WINDOW_MS.
 */
export function shouldPull(collection: string, now: number = Date.now(), config: YapaConfig = getConfig()): boolean {
  const p = paths(config);
  const window = config.HOOK_PULL_WINDOW_MS;
  if (!p || !(window > 0)) return true;
  const pulls = readJson<Record<string, number>>(p.pulls) ?? {};
  const last = Math.max(Number(pulls[collection]) || 0, readCycleRecord(config)?.ok_at ?? 0);
  if (last > now + 60_000) return true; // clock went back
  return now - last >= window;
}

/** Note a pull of one collection (from the prompt hook). */
export function recordPull(collection: string, now: number = Date.now(), config: YapaConfig = getConfig()): void {
  const p = paths(config);
  if (!p) return;
  const pulls = readJson<Record<string, number>>(p.pulls) ?? {};
  // Drop entries old enough not to matter, so the file stays small.
  const keep = Math.max(config.HOOK_PULL_WINDOW_MS, 60_000) * 10;
  const next: Record<string, number> = {};
  for (const [c, at] of Object.entries(pulls)) if (typeof at === 'number' && now - at < keep) next[c] = at;
  next[collection] = now;
  writeJson(p.pulls, next);
}

export { pidAlive };
