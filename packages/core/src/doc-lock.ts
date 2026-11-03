import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getConfig } from './config.js';
import { withFileLock } from './fs-lock.js';

/**
 * One document's read-modify-write, exclusive across every YAPA process on
 * this machine (they all share one local store). Inside, re-read the
 * document and merge into what is there now: never into a copy read before
 * the lock, or another session's change is written back over.
 *
 * Re-entrant within one async call chain (updateTask inside addDependency
 * holding the same task's lock runs straight through). Keep network calls
 * outside: the lock is meant to cover a read and a write.
 */

/** Locks held by this call chain; `active` turns false at release, so a timer started inside can't use them after. */
interface Held { paths: Set<string>; active: boolean }
const held = new AsyncLocalStorage<Held[]>();

/** Waiting longer than this means a stuck holder (fs-lock breaks it after staleMs). */
const WAIT_MS = 20_000;

export function docLockPath(collection: string, id: string): string {
  const h = createHash('sha256').update(`${collection}\u0000${id}`).digest('hex').slice(0, 32);
  return join(getConfig().LOCAL_COORD_DIR, 'locks', `${h}.lock`);
}

export async function withDocLock<T>(collection: string, id: string, fn: () => Promise<T>): Promise<T> {
  const path = docLockPath(collection, id);
  const mine = (held.getStore() ?? []).filter(h => h.active);
  if (mine.some(h => h.paths.has(path))) return fn();
  return withFileLock(path, async () => {
    const me: Held = { paths: new Set([path]), active: true };
    try {
      return await held.run([...mine, me], fn);
    } finally {
      me.active = false;
    }
  }, { waitMs: WAIT_MS });
}
