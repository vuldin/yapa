/**
 * Machine-wide bookkeeping for background jobs that every session's MCP
 * server would otherwise run on its own: a record of the last run and a
 * lock, beside the sync health file. A lost race, a corrupt file or a
 * missing folder only means an extra run; anything unreadable means "go
 * ahead". With no health file (tests), there are no files and every check
 * passes.
 *
 * Files are keyed by local store and username, so two installs with
 * different settings on one machine never share a record.
 *
 * @module @yapa/core/jobs
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig, type YapaConfig } from './config.js';
import { pidAlive } from './fs-lock.js';

export type Release = () => void;

export interface JobRecord<T = unknown> {
  /** Epoch ms. */
  started_at: number;
  finished_at: number;
  pid: number;
  version?: string;
  runs: number;
  result?: T;
}

interface LockFile {
  pid: number;
  started_at: number;
  version?: string;
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // best effort: a missing record only means an extra run
  }
}

/**
 * Create `lockPath` exclusively. Returns a release function, or undefined
 * when another live process holds it. A lock whose holder died, or older
 * than `staleAfterMs`, is taken over. A folder that can't be written
 * behaves as unlocked.
 */
export function tryAcquireFileLock(
  lockPath: string,
  staleAfterMs: number,
  opts: { now?: number; version?: string; alive?: (pid: number) => boolean } = {},
): Release | undefined {
  const now = opts.now ?? Date.now();
  const alive = opts.alive ?? pidAlive;
  const body: LockFile = { pid: process.pid, started_at: now, ...(opts.version ? { version: opts.version } : {}) };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify(body));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const held = readJson<LockFile>(lockPath);
        if (held?.pid === process.pid && held.started_at === now) rmSync(lockPath, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return () => {};
      const held = readJson<LockFile>(lockPath);
      const stale = !held || !alive(held.pid) || now - held.started_at > staleAfterMs || held.started_at > now + 60_000;
      if (!stale || attempt > 0) return undefined;
      rmSync(lockPath, { force: true }); // two takers may both get here: both run, which is harmless
    }
  }
  return undefined;
}

function storeKey(config: YapaConfig): string {
  const store = config.STORAGE === 'local' ? `local:${config.LOCAL_STORE_PATH}` : `chroma:${config.CHROMA_URL}`;
  return createHash('sha256').update(JSON.stringify([store, config.USERNAME])).digest('hex').slice(0, 12);
}

/** The record and lock files for job `name`, or undefined when there's no health file. */
export function jobFiles(name: string, config: YapaConfig = getConfig()): { record: string; lock: string } | undefined {
  if (!config.SYNC_HEALTH_FILE) return undefined;
  const dir = dirname(config.SYNC_HEALTH_FILE);
  const key = storeKey(config);
  return { record: join(dir, `job-${name}-${key}.json`), lock: join(dir, `job-${name}-${key}.lock`) };
}

export function readJobRecord<T = unknown>(name: string, config: YapaConfig = getConfig()): JobRecord<T> | undefined {
  const f = jobFiles(name, config);
  if (!f) return undefined;
  const r = readJson<JobRecord<T>>(f.record);
  return r && typeof r.finished_at === 'number' ? r : undefined;
}

/** True when the job hasn't finished within `intervalMs` (or there's no record). */
export function jobDue(name: string, intervalMs: number, now: number = Date.now(), config: YapaConfig = getConfig()): boolean {
  const r = readJobRecord(name, config);
  if (!r) return true;
  return now - r.finished_at >= intervalMs || r.finished_at > now + 60_000; // clock went back
}

export function tryAcquireJob(
  name: string,
  staleAfterMs: number,
  opts: { now?: number; version?: string; alive?: (pid: number) => boolean } = {},
  config: YapaConfig = getConfig(),
): Release | undefined {
  const f = jobFiles(name, config);
  if (!f) return () => {};
  return tryAcquireFileLock(f.lock, staleAfterMs, opts);
}

export function recordJob<T>(
  name: string,
  run: { startedAt: number; finishedAt?: number; version?: string; result?: T },
  config: YapaConfig = getConfig(),
): void {
  const f = jobFiles(name, config);
  if (!f) return;
  const prev = readJson<JobRecord<T>>(f.record);
  const next: JobRecord<T> = {
    started_at: run.startedAt,
    finished_at: run.finishedAt ?? Date.now(),
    pid: process.pid,
    runs: (typeof prev?.runs === 'number' ? prev.runs : 0) + 1,
    ...(run.version ? { version: run.version } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
  };
  writeJson(f.record, next);
}
