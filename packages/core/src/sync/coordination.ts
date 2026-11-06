/**
 * Leases and counters. Shared collections are coordinated by the sync
 * service; local-only collections (`private-*`, `local-*`, `global`), and
 * every collection when sync is off, by this machine (local-coordination.ts).
 * Callers get one Coordination that routes each call by its collection.
 * From the service, a CoordinationUnavailableError means "nothing was
 * shared, fall back to local coordination and say so". Other errors (bad
 * input) are real errors and are thrown as they are.
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { lockFileFor, sweepLockDebris, withFileLockSync, writeJsonAtomic } from '../fs-lock.js';
import { getSyncBackend, isCycleFatal, isSyncConfigured, type Coordination, type Lease } from './backend.js';
import { createLocalCoordination, LEASE_TTL_MIN as LEASE_TTL_FLOOR } from './local-coordination.js';
import { isSyncableCollection } from './syncable.js';

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Who holds a lease within the user. One name for the MCP tools, the
 * `yapa coord` CLI, the hooks and any script run from the agent's shell:
 * an explicit value, else YAPA_SESSION, else the Claude Code session id
 * (CLAUDE_CODE_SESSION_ID, set for the MCP server and for shell commands).
 */
export function currentSession(explicit?: string, env: Record<string, string | undefined> = process.env): string | undefined {
  for (const v of [explicit, env.YAPA_SESSION, env.CLAUDE_CODE_SESSION_ID]) {
    if (v && SESSION_RE.test(v)) return v;
  }
  return undefined;
}

// ------------------------------------------------- automatic heartbeat
//
// A lease expires TTL seconds after its last heartbeat. So that nobody (the
// person or their agent) has to remember to renew, the hooks renew this
// session's leases on every prompt and turn end, at most every
// HEARTBEAT_MAX_INTERVAL_S (or a third of the shortest TTL held). A small file
// per session marks that it holds leases, so sessions without any never make
// the call. A lease therefore lives while its session is active and lapses one
// TTL after the session goes quiet.

export const HEARTBEAT_MAX_INTERVAL_S = 300;

interface HeldMarker {
  session: string;
  /** Shortest TTL among the session's leases, seconds. */
  min_ttl: number;
  /** Unix seconds of the last successful heartbeat (or acquire). */
  last_beat: number;
  /**
   * Leases this session took through YAPA that it watches for loss
   * ("collection\u0000key"). A watched key missing from a heartbeat's
   * renewed list was taken over or released by someone else.
   */
  keys?: string[];
}

const heldKey = (collection: string, key: string) => `${collection}\u0000${key}`;

function markerPath(session: string): string {
  return join(getConfig().LEASE_STATE_DIR, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readMarker(session: string): HeldMarker | undefined {
  try {
    return JSON.parse(readFileSync(markerPath(session), 'utf-8')) as HeldMarker;
  } catch {
    return undefined;
  }
}

function writeMarker(m: HeldMarker): void {
  try {
    writeJsonAtomic(markerPath(m.session), m);
  } catch {
    // best effort: without the marker the lease simply needs explicit heartbeats
  }
}

/** Change `session`'s marker under its lock: a hook and the server acting for one session can't drop each other's keys. */
function withMarker<T>(session: string, fn: () => T, fallback: T): T {
  try {
    return withFileLockSync(lockFileFor(markerPath(session)), fn, { waitMs: 2000 });
  } catch {
    return fallback; // best effort, as before
  }
}

/** The keys `session` holds in `collection` through YAPA (its claimed tasks, cleanup items). */
export function heldKeys(session: string, collection: string): string[] {
  const prefix = heldKey(collection, '');
  return (readMarker(session)?.keys ?? []).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
}

/**
 * Record that `session` holds a lease with this TTL (call after a grant).
 * With `held`, the lease is also watched: losing it to another holder leaves
 * a notice for the next prompt (task claims pass it).
 */
export function noteLeaseHeld(session: string, ttlSeconds: number, now = Math.floor(Date.now() / 1000), held?: { collection: string; key: string }): void {
  withMarker(session, () => {
    const prev = readMarker(session);
    const keys = new Set(prev?.keys ?? []);
    if (held) keys.add(heldKey(held.collection, held.key));
    writeMarker({ session, min_ttl: Math.min(prev?.min_ttl ?? ttlSeconds, ttlSeconds), last_beat: now, ...(keys.size ? { keys: [...keys] } : {}) });
  }, undefined);
}

/** Stop watching a lease this session released (or never got). */
export function noteLeaseReleased(session: string, collection: string, key: string): void {
  withMarker(session, () => {
    const prev = readMarker(session);
    if (!prev?.keys) return;
    const keys = prev.keys.filter(k => k !== heldKey(collection, key));
    writeMarker({ ...prev, keys });
  }, undefined);
}

/**
 * Watched leases missing from `renewed` (taken over or released elsewhere).
 * `answered` says which collections the renewed list covers: a heartbeat the
 * service could not answer says nothing about the leases it holds.
 */
function noteRenewed(session: string, renewed: Lease[], now: number, answered: (collection: string) => boolean = () => true, complete = true): Array<{ collection: string; key: string }> {
  return withMarker(session, () => {
    const prev = readMarker(session);
    const have = new Set(renewed.map(l => heldKey(l.collection, l.key)));
    const split = (k: string) => {
      const [collection, key] = k.split('\u0000');
      return { collection, key };
    };
    const watched = prev?.keys ?? [];
    const lost = watched.filter(k => !have.has(k) && answered(split(k).collection)).map(split);
    const keys = watched.filter(k => have.has(k) || !answered(split(k).collection));
    if (renewed.length === 0 && keys.length === 0 && complete) {
      try { rmSync(markerPath(session), { force: true }); } catch { /* ignore */ }
      return lost;
    }
    // A beat one side could not answer keeps the shortest TTL known and the
    // last full beat, so the next prompt retries the side that failed instead
    // of waiting out the other side's (maybe much longer) interval.
    const ttls = renewed.map(l => l.ttl_seconds);
    const minTtl = complete
      ? (ttls.length ? Math.min(...ttls) : prev?.min_ttl ?? HEARTBEAT_MAX_INTERVAL_S * 3)
      : Math.min(prev?.min_ttl ?? Infinity, ...ttls, HEARTBEAT_MAX_INTERVAL_S * 3);
    writeMarker({ session, min_ttl: minTtl, last_beat: complete ? now : prev?.last_beat ?? now, ...(keys.length ? { keys } : {}) });
    return lost;
  }, []);
}

/** Sessions on this machine that hold leases (for status and tests). */
export function sessionsHoldingLeases(): string[] {
  try {
    return readdirSync(getConfig().LEASE_STATE_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  } catch {
    return [];
  }
}

// ------------------------------------------------- claim notices
//
// Things a session should hear about on its next prompt, written by whichever
// process noticed (a hook's heartbeat, the MCP server's sync cycle): a claim
// taken over, or a claim made offline that turned out to clash. One small
// JSON file beside the markers; its name does not end in .json, so it is
// never mistaken for a session marker.

interface ClaimNotice {
  at: number;
  text: string;
}

function noticesPath(): string {
  return join(getConfig().LEASE_STATE_DIR, 'notices.state');
}

/** Queue a one-line notice for the next prompt on this machine. */
export function addClaimNotice(text: string, now = Math.floor(Date.now() / 1000)): void {
  try {
    withFileLockSync(lockFileFor(noticesPath()), () => {
      let list: ClaimNotice[] = [];
      try { list = JSON.parse(readFileSync(noticesPath(), 'utf-8')); } catch { /* none yet */ }
      if (!Array.isArray(list)) list = [];
      if (list.some(n => n.text === text)) return;
      list.push({ at: now, text });
      writeJsonAtomic(noticesPath(), list.slice(-20));
    }, { waitMs: 2000 });
  } catch {
    // best effort
  }
}

/** Read and clear the queued notices. */
export function takeClaimNotices(): string[] {
  try {
    return withFileLockSync(lockFileFor(noticesPath()), () => {
      let list: ClaimNotice[] = [];
      try { list = JSON.parse(readFileSync(noticesPath(), 'utf-8')); } catch { return []; }
      rmSync(noticesPath(), { force: true });
      return Array.isArray(list) ? list.map(n => n.text) : [];
    }, { waitMs: 2000 });
  } catch {
    return [];
  }
}

/**
 * Renew the leases of `sessions` whose marker says a heartbeat is due.
 * No marker, no network. Errors are swallowed (the next prompt retries);
 * returns the number of leases renewed.
 */
export async function heartbeatIfDue(sessions: Array<string | undefined>, now = Math.floor(Date.now() / 1000)): Promise<number> {
  let n = 0;
  for (const session of new Set(sessions.filter((s): s is string => !!s && SESSION_RE.test(s)))) {
    const m = readMarker(session);
    if (!m) continue;
    const interval = Math.max(10, Math.min(HEARTBEAT_MAX_INTERVAL_S, Math.floor(m.min_ttl / 3)));
    if (now - m.last_beat < interval) continue;
    const renewed: Lease[] = [];
    let localOk = false;
    let serviceOk = !isSyncConfigured();
    try {
      renewed.push(...(await localCoordination().leaseHeartbeat(undefined, session)).renewed);
      localOk = true;
    } catch {
      // unreadable state: retry on the next prompt
    }
    if (!serviceOk) {
      try {
        renewed.push(...(await (await serviceCoordination()).leaseHeartbeat(undefined, session)).renewed);
        serviceOk = true;
      } catch {
        // offline or signed out: retry on the next prompt
      }
    }
    if (!localOk && !serviceOk) continue;
    const answered = (c: string) => (coordinatedLocally(c) ? localOk : serviceOk);
    for (const l of noteRenewed(session, renewed, now, answered, localOk && serviceOk)) {
      addClaimNotice(`Your claim on ${l.key} (${l.collection}) is no longer held: another session took it over or released it. Check \`task_list\` (id ${l.key}) or \`lease list\` before continuing that work.`, now);
    }
    n += renewed.length;
  }
  return n;
}

export type CoordinationUnavailableReason = 'not_configured' | 'unsupported' | 'unreachable';

export class CoordinationUnavailableError extends Error {
  readonly code = 'coordination_unavailable';
  constructor(readonly reason: CoordinationUnavailableReason, message: string) {
    super(message);
    this.name = 'CoordinationUnavailableError';
  }
}

/** The service's coordination API, or a CoordinationUnavailableError. */
export async function serviceCoordination(): Promise<Coordination> {
  if (!isSyncConfigured()) {
    throw new CoordinationUnavailableError('not_configured', 'leases and counters need the YAPA sync service (sync_enabled + sync_service_url or sync_mcp_url)');
  }
  const backend = await getSyncBackend();
  if (!backend?.coordination) {
    throw new CoordinationUnavailableError('unsupported', 'leases and counters need the YAPA sync service; a direct Postgres sync target has none');
  }
  return wrap(backend.coordination);
}

let local: Coordination | undefined;

/** This machine's coordination (local-coordination.ts), for collections the service does not coordinate. */
export function localCoordination(): Coordination {
  if (!local) {
    // Once per process: leftovers of crashed lock holders and failed writes.
    const dir = getConfig().LOCAL_COORD_DIR;
    sweepLockDebris(dir);
    sweepLockDebris(join(dir, 'locks'));
    sweepLockDebris(getConfig().LEASE_STATE_DIR);
    local = guardLocal(createLocalCoordination());
  }
  return local;
}

/** Tests: forget the cached local coordination (it reads LOCAL_COORD_DIR at call time anyway). */
export function resetLocalCoordination(): void {
  local = undefined;
}

/**
 * Is `collection` coordinated on this machine? Local-only collections always
 * are (the service never sees them), and every collection is when sync is
 * off. A shared collection with sync on but the service unreachable is not:
 * a teammate may hold its work, so that stays "not shared".
 */
export function coordinatedLocally(collection: string): boolean {
  return !isSyncableCollection(collection) || !isSyncConfigured();
}

/**
 * Coordination for any collection: each call goes to this machine or to the
 * service by its collection (coordinatedLocally). A heartbeat for every
 * collection renews both; task ids come from the service when sync is on.
 */
export async function requireCoordination(): Promise<Coordination> {
  const pick = async (collection: string) => (coordinatedLocally(collection) ? localCoordination() : serviceCoordination());
  return {
    leaseAcquire: async req => (await pick(req.collection)).leaseAcquire(req),
    leaseHeartbeat: async (collection, session, keys) => {
      if (collection !== undefined) return (await pick(collection)).leaseHeartbeat(collection, session, keys);
      const mine = await localCoordination().leaseHeartbeat(undefined, session);
      if (!isSyncConfigured()) return mine;
      try {
        const theirs = await (await serviceCoordination()).leaseHeartbeat(undefined, session);
        return { renewed: [...mine.renewed, ...theirs.renewed], lost: [] };
      } catch (e) {
        // This machine's leases were renewed; say the service's were not.
        if (mine.renewed.length && isCoordinationUnavailable(e)) return { ...mine, unreachable: (e as Error).message };
        throw e;
      }
    },
    leaseRelease: async (collection, key, session, outcome) => (await pick(collection)).leaseRelease(collection, key, session, outcome),
    leaseList: async (collection, includeExpired) => (await pick(collection)).leaseList(collection, includeExpired),
    counterNext: async (collection, name, floor) => (await pick(collection)).counterNext(collection, name, floor),
    nextTaskId: async floor => (isSyncConfigured() ? serviceCoordination() : Promise.resolve(localCoordination())).then(c => c.nextTaskId(floor)),
  };
}

/** True when `e` means the service could not answer (offline, signed out, throttled, an older service). */
export function isCoordinationUnavailable(e: unknown): boolean {
  if (e instanceof CoordinationUnavailableError) return true;
  const err = e as { code?: unknown; status?: unknown };
  // 404 not_found on a coordination route: the service predates schema v3.
  return isCycleFatal(e) || (err?.status === 404 && err?.code === 'not_found');
}

/** A lock this machine could not take in time reads like an unreachable service: nothing was coordinated. */
function guardLocal(c: Coordination): Coordination {
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      if ((e as { code?: unknown })?.code === 'lock_timeout') {
        throw new CoordinationUnavailableError('unreachable', `this machine's coordination is busy: ${(e as Error).message}`);
      }
      throw e;
    }
  };
  return {
    leaseAcquire: guard(c.leaseAcquire),
    leaseHeartbeat: guard(c.leaseHeartbeat),
    leaseRelease: guard(c.leaseRelease),
    leaseList: guard(c.leaseList),
    counterNext: guard(c.counterNext),
    nextTaskId: guard(c.nextTaskId),
  };
}

function wrap(c: Coordination): Coordination {
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    try {
      return await fn(...a);
    } catch (e) {
      if (isCoordinationUnavailable(e)) {
        throw new CoordinationUnavailableError('unreachable', `YAPA sync service could not coordinate: ${(e as Error).message}`);
      }
      throw e;
    }
  };
  return {
    leaseAcquire: guard(c.leaseAcquire),
    leaseHeartbeat: guard(c.leaseHeartbeat),
    leaseRelease: guard(c.leaseRelease),
    leaseList: guard(c.leaseList),
    counterNext: guard(c.counterNext),
    nextTaskId: guard(c.nextTaskId),
  };
}

export interface LeaseMoveResult {
  moved: number;
  /** Keys left in the source: the target refused them, or the move failed. */
  kept: string[];
}

/**
 * After a merge: re-acquire this user's live leases on `from` in `into` (same
 * session, key, title, scope and remaining time), release them in `from` and
 * move the sessions' held markers, so a claim on a moved task still guards it.
 * Other users' leases stay where they are. Best effort: never throws.
 */
export async function moveOwnLeases(from: string, into: string, now = Math.floor(Date.now() / 1000)): Promise<LeaseMoveResult> {
  const out: LeaseMoveResult = { moved: 0, kept: [] };
  let coord: Coordination;
  let leases: Lease[];
  try {
    coord = await requireCoordination();
    leases = (await coord.leaseList(from)).leases;
  } catch {
    return out;
  }
  const me = getConfig().USERNAME.toLowerCase();
  for (const l of leases) {
    if (l.expired || l.holder.user.toLowerCase() !== me) continue;
    try {
      const r = await coord.leaseAcquire({
        collection: into, key: l.key, session: l.holder.session, scope: l.scope,
        ttlSeconds: Math.max(LEASE_TTL_FLOOR, l.expires_at - now), ...(l.title ? { title: l.title } : {}),
      });
      if (!r.granted) { out.kept.push(l.key); continue; }
      await coord.leaseRelease(from, l.key, l.holder.session).catch(() => undefined);
      noteLeaseReleased(l.holder.session, from, l.key);
      noteLeaseHeld(l.holder.session, r.lease.ttl_seconds, now, { collection: into, key: l.key });
      out.moved++;
    } catch {
      out.kept.push(l.key);
    }
  }
  return out;
}
