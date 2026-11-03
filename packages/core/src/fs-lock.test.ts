import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_HOST, LockTimeoutError, lockFileFor, sweepLockDebris, withFileLock, withFileLockSync, writeJsonAtomic } from './fs-lock.js';

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yapa-lock-'));
  lock = join(dir, 'state.json.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const holder = (pid: number, at = Date.now(), host = LOCK_HOST) => writeFileSync(lock, JSON.stringify({ pid, host, at }));

describe('withFileLock', () => {
  it('runs the section holding the lock, and removes it after (also when the section throws)', async () => {
    expect(await withFileLock(lock, () => {
      expect(JSON.parse(readFileSync(lock, 'utf-8'))).toMatchObject({ pid: process.pid, host: LOCK_HOST });
      return 7;
    })).toBe(7);
    expect(existsSync(lock)).toBe(false);
    await expect(withFileLock(lock, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(lock)).toBe(false);
  });

  it('serializes sections in one process too', async () => {
    const order: string[] = [];
    const slow = (name: string) => withFileLock(lock, async () => {
      order.push(`${name}:in`);
      await new Promise(r => setTimeout(r, 30));
      order.push(`${name}:out`);
    });
    await Promise.all([slow('a'), slow('b')]);
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
  });

  it('takes over a lock whose holder died, or that is older than staleMs', async () => {
    holder(2 ** 30); // no such pid
    expect(await withFileLock(lock, () => 'dead holder', { waitMs: 200 })).toBe('dead holder');
    // Alive on this host: its lock holds (a long section, e.g. an embedding)...
    holder(process.ppid, Date.now() - 60_000);
    await expect(withFileLock(lock, () => 'x', { waitMs: 100 })).rejects.toBeInstanceOf(LockTimeoutError);
    // ...until it has held it longer than maxHoldMs (stuck, or a reused pid).
    expect(await withFileLock(lock, () => 'old holder', { waitMs: 200, maxHoldMs: 30_000 })).toBe('old holder');
    // A holder on another host (shared home dir) is judged by age only.
    holder(2 ** 30, Date.now(), 'other-host');
    await expect(withFileLock(lock, () => 'x', { waitMs: 100 })).rejects.toBeInstanceOf(LockTimeoutError);
    holder(2 ** 30, Date.now() - 60_000, 'other-host');
    expect(await withFileLock(lock, () => 'old foreign holder', { waitMs: 200, staleMs: 30_000 })).toBe('old foreign holder');
  });

  it('waits for a live holder, then times out naming it', async () => {
    holder(process.ppid);
    const e = await withFileLock(lock, () => 'x', { waitMs: 150 }).catch(err => err);
    expect(e).toBeInstanceOf(LockTimeoutError);
    expect(e.message).toMatch(`held by pid ${process.ppid}`);
  });

  it('an unreadable lock is broken only once it is older than a moment (it may be mid-create)', async () => {
    writeFileSync(lock, '');
    await expect(withFileLock(lock, () => 'x', { waitMs: 100 })).rejects.toBeInstanceOf(LockTimeoutError);
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(lock, old, old);
    expect(await withFileLock(lock, () => 'broken', { waitMs: 200 })).toBe('broken');
  });

  it('a lock taken over meanwhile is not removed by its previous holder', async () => {
    await withFileLock(lock, () => {
      holder(process.ppid); // someone broke ours and took it
    });
    expect(JSON.parse(readFileSync(lock, 'utf-8')).pid).toBe(process.ppid);
  });

  it('the sync variant behaves the same', () => {
    expect(withFileLockSync(lock, () => 3)).toBe(3);
    holder(process.ppid);
    expect(() => withFileLockSync(lock, () => 3, { waitMs: 50 })).toThrow(LockTimeoutError);
  });
});

describe('writeJsonAtomic and debris', () => {
  it('writes through a unique temp file, leaving only the target', () => {
    const f = join(dir, 'sub', 'a.json');
    writeJsonAtomic(f, { a: 1 });
    expect(JSON.parse(readFileSync(f, 'utf-8'))).toEqual({ a: 1 });
    expect(readdirSync(join(dir, 'sub'))).toEqual(['a.json']);
    expect(lockFileFor(f)).toBe(join(dir, 'sub', 'a.json.lock'));
  });

  it('sweeps old broken-lock and temp leftovers only', () => {
    for (const n of ['a.json.lock.stale.12.ab', 'a.json.99.zz.tmp', 'a.json.lock.break', 'a.json', 'a.json.lock']) writeFileSync(join(dir, n), '');
    const old = (Date.now() - 2 * 3600_000) / 1000;
    for (const n of readdirSync(dir)) utimesSync(join(dir, n), old, old);
    sweepLockDebris(dir);
    expect(readdirSync(dir).sort()).toEqual(['a.json', 'a.json.lock']);
  });
});
