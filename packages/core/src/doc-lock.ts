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

const held = new AsyncLocalStorage<Set<string>>();

/** Waiting longer than this means a stuck holder (fs-lock breaks it after staleMs). */
const WAIT_MS = 20_000;

export function docLockPath(collection: string, id: string): string {
  const h = createHash('sha256').update(`${collection}\u0000${id}`).digest('hex').slice(0, 32);
  return join(getConfig().LOCAL_COORD_DIR, 'locks', `${h}.lock`);
}

export async function withDocLock<T>(collection: string, id: string, fn: () => Promise<T>): Promise<T> {
  const path = docLockPath(collection, id);
  const mine = held.getStore();
  if (mine?.has(path)) return fn();
  return withFileLock(path, () => held.run(new Set([...(mine ?? []), path]), fn), { waitMs: WAIT_MS });
}
