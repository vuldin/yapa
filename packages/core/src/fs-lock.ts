import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * A lock file shared by every YAPA process on this machine (MCP servers,
 * hooks, the CLI): the exclusion behind local leases, counters, task ids and
 * read-modify-write paths of the local store.
 *
 * Taken with O_CREAT|O_EXCL and holding `{pid, host, at}`. A holder whose pid
 * is gone, or that has held it longer than `staleMs`, is taken over by
 * renaming its lock aside (only one process can win that rename) and creating
 * a fresh one. Critical sections are short (a file read and write), so a
 * holder past `staleMs` is stuck, not slow.
 *
 * Unlike the sync-cycle lock (sync/shared-cycle.ts), this one fails closed:
 * when it cannot be had within `waitMs` the caller gets LockTimeoutError.
 */

export interface LockOptions {
  /** How long to wait for a held lock (ms). Default 5000. */
  waitMs?: number;
  /** A holder older than this is taken over (ms). Default 30000. */
  staleMs?: number;
}

export class LockTimeoutError extends Error {
  readonly code = 'lock_timeout';
  constructor(readonly path: string, readonly holder?: LockHolder) {
    super(`could not take ${path} in time${holder ? ` (held by pid ${holder.pid} on ${holder.host} since ${new Date(holder.at).toISOString()})` : ''}`);
    this.name = 'LockTimeoutError';
  }
}

export interface LockHolder {
  pid: number;
  host: string;
  /** Epoch ms. */
  at: number;
}

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_STALE_MS = 30_000;
/** A lock file without a readable holder is that young only between create and write. */
const UNREADABLE_GRACE_MS = 2000;
const HOST = hostname();

/** Is that process alive? EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Write JSON through a uniquely named temp file and a rename: readers never see half a file. */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value) + '\n', { mode });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readHolder(lock: string): LockHolder | undefined {
  try {
    const h = JSON.parse(readFileSync(lock, 'utf-8'));
    return h && typeof h.pid === 'number' && typeof h.at === 'number' ? { pid: h.pid, host: String(h.host ?? ''), at: h.at } : undefined;
  } catch {
    return undefined;
  }
}

/** Try once. Returns the holder written, or undefined when someone else holds it. */
function tryCreate(lock: string): LockHolder | undefined {
  const me: LockHolder = { pid: process.pid, host: HOST, at: Date.now() };
  let fd: number;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
      return tryCreate(lock);
    }
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(me));
  } finally {
    closeSync(fd);
  }
  return me;
}

function isStale(lock: string, staleMs: number, now: number): { stale: boolean; holder?: LockHolder } {
  const holder = readHolder(lock);
  if (!holder) {
    try {
      return { stale: now - statSync(lock).mtimeMs > UNREADABLE_GRACE_MS };
    } catch {
      return { stale: false }; // gone: the next try creates it
    }
  }
  // Another host's pid means nothing here (a shared home dir): age only.
  const dead = holder.host === HOST && !pidAlive(holder.pid);
  return { stale: dead || now - holder.at > staleMs || holder.at - now > staleMs, holder };
}

/** Move a stale lock aside; only one of several racing takers wins the rename. */
function breakStale(lock: string): void {
  const aside = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(lock, aside);
    rmSync(aside, { force: true });
  } catch {
    // someone else broke it first
  }
}

function releaseIfMine(lock: string, me: LockHolder): void {
  const h = readHolder(lock);
  if (h && h.pid === me.pid && h.at === me.at && h.host === me.host) rmSync(lock, { force: true });
}

/** One attempt to take the lock (breaking a stale one). */
function attempt(lock: string, staleMs: number): { me?: LockHolder; holder?: LockHolder } {
  const me = tryCreate(lock);
  if (me) return { me };
  const s = isStale(lock, staleMs, Date.now());
  if (s.stale) {
    breakStale(lock);
    const again = tryCreate(lock);
    if (again) return { me: again };
  }
  return { holder: s.holder };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const backoff = (i: number) => Math.min(100, 5 * 2 ** Math.min(i, 5)) * (0.5 + Math.random());

/** Run `fn` holding the lock file `lock` (created beside, dirs made as needed). */
export async function withFileLock<T>(lock: string, fn: () => Promise<T> | T, opts: LockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + waitMs;
  let holder: LockHolder | undefined;
  for (let i = 0; ; i++) {
    const a = attempt(lock, staleMs);
    if (a.me) {
      try {
        return await fn();
      } finally {
        releaseIfMine(lock, a.me);
      }
    }
    holder = a.holder;
    if (Date.now() >= deadline) throw new LockTimeoutError(lock, holder);
    await sleep(backoff(i));
  }
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** withFileLock for synchronous callers (short sections only: it blocks the event loop while waiting). */
export function withFileLockSync<T>(lock: string, fn: () => T, opts: LockOptions = {}): T {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + waitMs;
  let holder: LockHolder | undefined;
  for (let i = 0; ; i++) {
    const a = attempt(lock, staleMs);
    if (a.me) {
      try {
        return fn();
      } finally {
        releaseIfMine(lock, a.me);
      }
    }
    holder = a.holder;
    if (Date.now() >= deadline) throw new LockTimeoutError(lock, holder);
    Atomics.wait(waitCell, 0, 0, backoff(i));
  }
}

/** Remove leftovers of broken locks and failed writes in `dir` older than `olderThanMs`. */
export function sweepLockDebris(dir: string, olderThanMs = 3600_000, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!/\.(stale\.\d+\.\w+|\d+\.\w+\.tmp)$/.test(name)) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > olderThanMs) rmSync(p, { force: true });
      } catch {
        // gone
      }
    }
  } catch {
    // no dir
  }
}

/** The lock file guarding `file`. */
export const lockFileFor = (file: string): string => join(dirname(file), `${basename(file)}.lock`);
