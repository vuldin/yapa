/**
 * Leases and counters through the sync service. Callers get either the
 * service's answer or a CoordinationUnavailableError, which means "nothing
 * was shared, fall back to local coordination and say so". Other errors (bad
 * input, a local-only collection) are real errors and are thrown as they are.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { getSyncBackend, isCycleFatal, isSyncConfigured, type Coordination, type Lease } from './backend.js';

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
}

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
    mkdirSync(getConfig().LEASE_STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(m.session), JSON.stringify(m), { mode: 0o600 });
  } catch {
    // best effort: without the marker the lease simply needs explicit heartbeats
  }
}

/** Record that `session` holds a lease with this TTL (call after a grant). */
export function noteLeaseHeld(session: string, ttlSeconds: number, now = Math.floor(Date.now() / 1000)): void {
  const prev = readMarker(session);
  writeMarker({ session, min_ttl: Math.min(prev?.min_ttl ?? ttlSeconds, ttlSeconds), last_beat: now });
}

function noteRenewed(session: string, renewed: Lease[], now: number): void {
  if (renewed.length === 0) {
    try { rmSync(markerPath(session), { force: true }); } catch { /* ignore */ }
    return;
  }
  writeMarker({ session, min_ttl: Math.min(...renewed.map(l => l.ttl_seconds)), last_beat: now });
}

/** Sessions on this machine that hold leases (for status and tests). */
export function sessionsHoldingLeases(): string[] {
  try {
    return readdirSync(getConfig().LEASE_STATE_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
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
  if (!isSyncConfigured()) return 0;
  let n = 0;
  for (const session of new Set(sessions.filter((s): s is string => !!s && SESSION_RE.test(s)))) {
    const m = readMarker(session);
    if (!m) continue;
    const interval = Math.max(10, Math.min(HEARTBEAT_MAX_INTERVAL_S, Math.floor(m.min_ttl / 3)));
    if (now - m.last_beat < interval) continue;
    try {
      const r = await (await requireCoordination()).leaseHeartbeat(undefined, session);
      noteRenewed(session, r.renewed, now);
      n += r.renewed.length;
    } catch {
      // offline or signed out: retry on the next prompt
    }
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
export async function requireCoordination(): Promise<Coordination> {
  if (!isSyncConfigured()) {
    throw new CoordinationUnavailableError('not_configured', 'leases and counters need the YAPA sync service (sync_enabled + sync_service_url)');
  }
  const backend = await getSyncBackend();
  if (!backend?.coordination) {
    throw new CoordinationUnavailableError('unsupported', 'leases and counters need the YAPA sync service; a direct Postgres sync target has none');
  }
  return wrap(backend.coordination);
}

/** True when `e` means the service could not answer (offline, signed out, throttled, an older service). */
export function isCoordinationUnavailable(e: unknown): boolean {
  if (e instanceof CoordinationUnavailableError) return true;
  const err = e as { code?: unknown; status?: unknown };
  // 404 not_found on a coordination route: the service predates schema v3.
  return isCycleFatal(e) || (err?.status === 404 && err?.code === 'not_found');
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
