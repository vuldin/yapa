import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * A lock file shared by every YAPA process on this machine (MCP servers,
 * hooks, the CLI): the exclusion behind local leases, counters, task ids and
 * read-modify-write paths of the local store.
 *
 * Taken with O_CREAT|O_EXCL and holding `{pid, host, at}`, where host is the
 * hostname plus this process's pid namespace (containers sharing a home dir
 * and hostname don't judge each other's pids). A holder is stale when its
 * pid is gone (same host), when it has held the lock longer than `maxHoldMs`
 * (a reused pid, or a stuck process), or, for a holder on another host,
 * longer than `staleMs`.
 *
 * Breaking a stale lock happens only under a second lock, `<lock>.break`,
 * and only after checking, under it, that the lock file is still the very
 * one judged stale (same inode and holder). Without that, two breakers that
 * judged the same stale file could each move one aside, the second moving
 * the live lock the first had just created, and both would hold it.
 *
 * It fails closed: when the lock cannot be had within `waitMs` the caller
 * gets LockTimeoutError. (Unlike the sync-cycle lock in sync/shared-cycle.ts,
 * which only paces sync timers.)
 */

export interface LockOptions {
  /** How long to wait for a held lock (ms). Default 5000. */
  waitMs?: number;
  /** A holder on another host older than this is taken over (ms). Default 30000. */
  staleMs?: number;
  /** A live holder on this host older than this is taken over (ms). Default 600000. */
  maxHoldMs?: number;
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
const DEFAULT_MAX_HOLD_MS = 600_000;
/** A lock file without a readable holder is that young only between create and write. */
const UNREADABLE_GRACE_MS = 2000;
/** Breaking takes microseconds: a break guard older than this was left by a crash. */
const BREAK_GUARD_STALE_MS = 5000;

function pidNamespace(): string {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return '';
  }
}
/** How this process names its host in a lock: hostname plus pid namespace. */
export const LOCK_HOST = `${hostname()}${pidNamespace() ? `#${pidNamespace()}` : ''}`;
const HOST = LOCK_HOST;

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

/**
 * Write JSON through a uniquely named temp file, flushed to disk, and a
 * rename: readers never see half a file, and a crash right after leaves the
 * old or the new file, not an empty one.
 */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      writeSync(fd, JSON.stringify(value) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The lock file as it is: its inode, holder (if readable) and mtime. */
interface LockState {
  ino: number;
  mtimeMs: number;
  holder?: LockHolder;
}

function readState(lock: string): LockState | undefined {
  let fd: number;
  try {
    fd = openSync(lock, 'r');
  } catch {
    return undefined; // gone
  }
  try {
    const st = fstatSync(fd);
    let holder: LockHolder | undefined;
    try {
      const h = JSON.parse(readFileSync(fd, 'utf-8'));
      if (h && typeof h.pid === 'number' && typeof h.at === 'number') holder = { pid: h.pid, host: String(h.host ?? ''), at: h.at };
    } catch {
      // mid-create, or garbage
    }
    return { ino: st.ino, mtimeMs: st.mtimeMs, holder };
  } finally {
    closeSync(fd);
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

interface StaleRules {
  staleMs: number;
  maxHoldMs: number;
}

function stale(s: LockState, rules: StaleRules, now: number): boolean {
  if (!s.holder) return now - s.mtimeMs > UNREADABLE_GRACE_MS;
  const h = s.holder;
  if (h.at - now > rules.staleMs) return true; // dated in the future: a broken clock or file
  if (h.host === HOST) return !pidAlive(h.pid) || now - h.at > rules.maxHoldMs;
  return now - h.at > rules.staleMs;
}

const sameState = (a: LockState, b: LockState) =>
  a.ino === b.ino && (a.holder?.pid ?? -1) === (b.holder?.pid ?? -1) && (a.holder?.at ?? -1) === (b.holder?.at ?? -1) && (a.holder?.host ?? '') === (b.holder?.host ?? '');

/**
 * Remove `lock` if it is still exactly the stale file `judged`, under the
 * break guard. Returns false when another process is breaking it right now.
 */
function breakStale(lock: string, judged: LockState, rules: StaleRules): boolean {
  const guard = `${lock}.break`;
  const me = tryCreate(guard);
  if (!me) {
    // A guard left by a breaker that crashed mid-break is removed by age.
    const g = readState(guard);
    if (g && stale(g, { staleMs: BREAK_GUARD_STALE_MS, maxHoldMs: BREAK_GUARD_STALE_MS }, Date.now())) rmIfSame(guard, g);
    return false;
  }
  try {
    const now = readState(lock);
    if (now && sameState(now, judged) && stale(now, rules, Date.now())) rmSync(lock, { force: true });
    return true;
  } finally {
    releaseIfMine(guard, me);
  }
}

/** Remove `path` if it still has the inode and holder of `s` (best effort). */
function rmIfSame(path: string, s: LockState): void {
  const now = readState(path);
  if (now && sameState(now, s)) rmSync(path, { force: true });
}

function releaseIfMine(lock: string, me: LockHolder): void {
  const h = readState(lock)?.holder;
  if (h && h.pid === me.pid && h.at === me.at && h.host === me.host) rmSync(lock, { force: true });
}

/** One attempt to take the lock (breaking a stale one). */
function attempt(lock: string, rules: StaleRules): { me?: LockHolder; holder?: LockHolder } {
  const me = tryCreate(lock);
  if (me) return { me };
  const s = readState(lock);
  if (!s) return {}; // released meanwhile: the next try creates it
  if (stale(s, rules, Date.now()) && breakStale(lock, s, rules)) {
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
  const rules = { staleMs: opts.staleMs ?? DEFAULT_STALE_MS, maxHoldMs: opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS };
  const deadline = Date.now() + waitMs;
  let holder: LockHolder | undefined;
  for (let i = 0; ; i++) {
    const a = attempt(lock, rules);
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
  const rules = { staleMs: opts.staleMs ?? DEFAULT_STALE_MS, maxHoldMs: opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS };
  const deadline = Date.now() + waitMs;
  let holder: LockHolder | undefined;
  for (let i = 0; ; i++) {
    const a = attempt(lock, rules);
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
      if (!/\.(stale\.\d+\.\w+|\d+\.\w+\.tmp|break)$/.test(name)) continue;
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
