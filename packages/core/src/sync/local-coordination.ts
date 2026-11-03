import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { lockFileFor, withFileLockSync, writeJsonAtomic } from '../fs-lock.js';
import type { Coordination, Lease, LeaseAcquireRequest, LeaseAcquireResult, LeaseReleaseResult } from './backend.js';
import { getDeviceId } from './device.js';

/**
 * Leases and counters served on this machine: what the sync service does for
 * shared collections (packages/service/src/coord.ts), for collections the
 * service never sees (`private-*`, `local-*`, `global`) and for every
 * collection when sync is off. Same rules and answers, so callers (claims,
 * the `lease` tool, `yapa coord`, project scripts) need no second path.
 *
 * One JSON file per collection in LOCAL_COORD_DIR holding its leases and
 * counters; every operation reads, changes and rewrites it under that file's
 * lock (fs-lock.ts), so two sessions can never both be granted overlapping
 * work or the same counter value. Holders are this user's sessions, so the
 * "other user" cases of the service only arise for a shared home directory.
 */

export const LEASE_TTL_MIN = 30;
export const LEASE_TTL_MAX = 24 * 3600;
export const LEASE_TTL_DEFAULT = 2 * 3600;
export const MAX_SCOPE = 64;
export const EXPIRED_KEEP_SECONDS = 7 * 24 * 3600;
/** Counters collection for task ids (name = username), as on the service. */
export const TASK_COUNTER_COLLECTION = '@tasks';

const KEY_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const COUNTER_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const OUTCOME_RE = /^[A-Za-z0-9._ :-]{0,64}$/;
const COLLECTION_RE = /^[A-Za-z0-9@._-]{1,200}$/;

/** A bad request, reported like the service's 400 (exit 2 from `yapa coord`). */
export class LocalCoordinationError extends Error {
  readonly status = 400;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LocalCoordinationError';
  }
}

const bad = (message: string) => new LocalCoordinationError('invalid_request', message);

function assertMatch(v: unknown, re: RegExp, what: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(`${what} must match ${re.source}`);
  return v;
}

function assertScope(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_SCOPE) throw bad(`scope must be an array of at most ${MAX_SCOPE} strings`);
  return [...new Set(v.map(s => assertMatch(s, KEY_RE, 'scope entries')))].sort();
}

function assertTtl(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < LEASE_TTL_MIN || v > LEASE_TTL_MAX) {
    throw bad(`ttl_seconds must be an integer from ${LEASE_TTL_MIN} to ${LEASE_TTL_MAX}`);
  }
  return v;
}

function assertFloor(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw bad('floor must be a non-negative integer');
  return v;
}

export function effectiveScope(key: string, scope: string[]): string[] {
  return [...new Set([`key:${key}`, ...scope])].sort();
}

interface StoredLease {
  key: string;
  user: string;
  session: string;
  device: string | null;
  title: string | null;
  scope: string[];
  ttl_seconds: number;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  took_over_from: Record<string, unknown> | null;
}

interface CollectionState {
  leases: Record<string, StoredLease>;
  counters: Record<string, number>;
}

export interface LocalCoordinationOptions {
  /** Where the state files live (default LOCAL_COORD_DIR). */
  dir?: string;
  /** Who holds (default USERNAME). */
  user?: string;
  /** Unix seconds (tests). */
  now?: () => number;
}

export function localCoordinationDir(): string {
  return getConfig().LOCAL_COORD_DIR;
}

function stateFile(dir: string, collection: string): string {
  return join(dir, `${encodeURIComponent(collection)}.json`);
}

function readState(file: string): CollectionState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf-8'));
    return { leases: s?.leases ?? {}, counters: s?.counters ?? {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { leases: {}, counters: {} };
    // A corrupt file would silently drop every lease: refuse instead.
    throw new Error(`local coordination state ${file} is unreadable: ${(e as Error).message}`);
  }
}

const isMine = (l: StoredLease, user: string, session: string) => l.user === user && l.session === session;

function toLease(collection: string, l: StoredLease, now: number): Lease {
  return {
    collection,
    key: l.key,
    holder: { user: l.user, session: l.session, device: l.device },
    title: l.title,
    scope: l.scope,
    ttl_seconds: l.ttl_seconds,
    acquired_at: l.acquired_at,
    heartbeat_at: l.heartbeat_at,
    expires_at: l.expires_at,
    expired: l.expires_at <= now,
    took_over_from: l.took_over_from,
  };
}

/** The Coordination interface, answered from files on this machine. */
export function createLocalCoordination(opts: LocalCoordinationOptions = {}): Coordination & { readonly local: true } {
  const dir = () => opts.dir ?? localCoordinationDir();
  const user = () => opts.user ?? getConfig().USERNAME;
  const clock = () => (opts.now ? opts.now() : Math.floor(Date.now() / 1000));

  /** Read, change and write one collection's state under its lock. */
  function update<T>(collection: string, fn: (s: CollectionState, now: number) => { result: T; changed: boolean }): T {
    assertMatch(collection, COLLECTION_RE, 'collection');
    const file = stateFile(dir(), collection);
    return withFileLockSync(lockFileFor(file), () => {
      const s = readState(file);
      const { result, changed } = fn(s, clock());
      if (changed) writeJsonAtomic(file, s);
      return result;
    });
  }

  function collections(): string[] {
    try {
      return readdirSync(dir()).filter(f => f.endsWith('.json')).map(f => decodeURIComponent(f.slice(0, -5)));
    } catch {
      return [];
    }
  }

  const prune = (s: CollectionState, now: number): boolean => {
    let changed = false;
    for (const [k, l] of Object.entries(s.leases)) {
      if (l.expires_at < now - EXPIRED_KEEP_SECONDS) {
        delete s.leases[k];
        changed = true;
      }
    }
    return changed;
  };

  const api = {
    local: true as const,

    async leaseAcquire(req: LeaseAcquireRequest): Promise<LeaseAcquireResult> {
      const key = assertMatch(req.key, KEY_RE, 'key');
      const session = assertMatch(req.session, SESSION_RE, 'session');
      const reqScope = assertScope(req.scope);
      const reqTtl = assertTtl(req.ttlSeconds);
      if (req.title !== undefined && req.title !== null && (typeof req.title !== 'string' || req.title.length > 300)) {
        throw bad('title must be a string of at most 300 characters');
      }
      const me = user();
      return update<LeaseAcquireResult>(req.collection, (s, now) => {
        prune(s, now);
        const prev = s.leases[key];
        const renewed = prev !== undefined && isMine(prev, me, session);
        const scope = reqScope !== undefined ? effectiveScope(key, reqScope)
          : renewed ? effectiveScope(key, prev.scope)
            : effectiveScope(key, []);
        const ttl = reqTtl ?? (renewed ? prev.ttl_seconds : LEASE_TTL_DEFAULT);

        const live = Object.values(s.leases).filter(l => l.expires_at > now && (l.key === key || l.scope.some(x => scope.includes(x))));
        const conflicts = live
          .filter(l => !isMine(l, me, session) && !(req.reclaim && l.user === me))
          .map(l => ({ lease: toLease(req.collection, l, now), overlap: l.key === key ? [`key:${key}`] : l.scope.filter(x => scope.includes(x)) }));
        if (conflicts.length) return { result: { granted: false as const, conflicts }, changed: false };

        const reclaimed = !renewed && live.some(l => l.key === key);
        const takeover = prev !== undefined && !renewed
          ? {
            user: prev.user, session: prev.session, device: prev.device,
            expired_at: prev.expires_at, acquired_at: prev.acquired_at, ...(reclaimed ? { reclaim: true } : {}),
          }
          : undefined;
        const lease: StoredLease = {
          key, user: me, session, device: safeDeviceId(),
          title: req.title ?? (renewed ? prev.title : null),
          scope, ttl_seconds: ttl,
          acquired_at: renewed ? prev.acquired_at : now,
          heartbeat_at: now,
          expires_at: now + ttl,
          took_over_from: renewed ? prev.took_over_from : takeover ?? null,
        };
        s.leases[key] = lease;
        return {
          result: { granted: true as const, lease: toLease(req.collection, lease, now), renewed, ...(takeover ? { took_over_from: takeover } : {}) },
          changed: true,
        };
      });
    },

    async leaseHeartbeat(collection: string | undefined, session: string, keys?: string[]) {
      assertMatch(session, SESSION_RE, 'session');
      if (keys && collection === undefined) throw bad('keys needs a collection');
      const me = user();
      const renewed: Lease[] = [];
      for (const c of collection !== undefined ? [collection] : collections()) {
        renewed.push(...update(c, (s, now) => {
          const out: Lease[] = [];
          for (const l of Object.values(s.leases)) {
            if (!isMine(l, me, session) || (keys && !keys.includes(l.key))) continue;
            l.heartbeat_at = now;
            l.expires_at = now + l.ttl_seconds;
            out.push(toLease(c, l, now));
          }
          return { result: out, changed: out.length > 0 };
        }));
      }
      const lost = (keys ?? []).filter(k => !renewed.some(l => l.key === k));
      return { renewed, lost };
    },

    async leaseRelease(collection: string, key: string, session: string, outcome?: string): Promise<LeaseReleaseResult> {
      assertMatch(key, KEY_RE, 'key');
      assertMatch(session, SESSION_RE, 'session');
      if (outcome !== undefined) assertMatch(outcome, OUTCOME_RE, 'outcome');
      const me = user();
      return update<LeaseReleaseResult>(collection, (s, now) => {
        const l = s.leases[key];
        if (!l) return { result: { released: false as const, reason: 'not_held' as const }, changed: false };
        if (!isMine(l, me, session)) return { result: { released: false as const, reason: 'held_by_other' as const, lease: toLease(collection, l, now) }, changed: false };
        delete s.leases[key];
        return { result: { released: true as const, lease: toLease(collection, l, now) }, changed: true };
      });
    },

    async leaseList(collection: string, includeExpired = false) {
      assertMatch(collection, COLLECTION_RE, 'collection');
      const now = clock();
      const s = readState(stateFile(dir(), collection));
      const leases = Object.values(s.leases)
        .filter(l => includeExpired ? l.expires_at >= now - EXPIRED_KEEP_SECONDS : l.expires_at > now)
        .sort((a, b) => a.acquired_at - b.acquired_at || a.key.localeCompare(b.key))
        .map(l => toLease(collection, l, now));
      return { leases, now };
    },

    async counterNext(collection: string, name: string, floor?: number): Promise<number> {
      assertMatch(name, COUNTER_RE, 'name');
      const f = assertFloor(floor);
      return update(collection, s => {
        const value = Math.max(s.counters[name] ?? 0, f) + 1;
        s.counters[name] = value;
        return { result: value, changed: true };
      });
    },

    async nextTaskId(floor?: number): Promise<string> {
      const me = user();
      const n = await api.counterNext(TASK_COUNTER_COLLECTION, assertMatch(me, COUNTER_RE, 'username'), floor);
      return `${me}-${n}`;
    },
  };
  return api;
}

function safeDeviceId(): string | null {
  try {
    return getDeviceId();
  } catch {
    return null;
  }
}
