/**
 * Leases and counters for the MCP tools and the `yapa coord` CLI (josh-631).
 * One implementation, two front ends: both get a result with a JSON body, a
 * one-line summary and the CLI exit code.
 *
 * Exit codes (stable; scripts branch on them):
 *   0  done (granted, renewed, released, listed, value handed out; also
 *      release of a key nobody holds)
 *   3  refused (a live lease overlaps, or the key is held by someone else)
 *   4  coordination unavailable: nothing was shared, fall back to local
 *      coordination and say the work is not shared
 *   2  bad arguments or input the service rejected
 *   1  any other error
 */
import { currentSession, getDeviceId, isCoordinationUnavailable, noteLeaseHeld, requireCoordination, type Lease } from '@yapa/core';

// Re-exported so the CLI never imports the whole @yapa/core namespace (it would defeat tree-shaking).
export { currentSession };

export const EXIT = { ok: 0, error: 1, usage: 2, refused: 3, unavailable: 4 } as const;

export interface CoordResult {
  exit: number;
  json: Record<string, unknown>;
  text: string;
}

/**
 * The holder session when the caller names none: YAPA_SESSION, else the
 * Claude Code session id (the same one the hooks heartbeat), else this
 * process (outside Claude Code).
 */
export function defaultSession(): string {
  return currentSession() ?? `${getDeviceId()}:${process.pid}`.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
}

const ago = (now: number, t: number) => {
  const s = Math.max(0, now - t);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

export function describeLease(l: Lease, now = Math.floor(Date.now() / 1000)): string {
  const state = l.expired ? `EXPIRED ${ago(now, l.expires_at)} ago` : `expires in ${ago(l.expires_at, now)}`;
  return `${l.key} held by ${l.holder.user} (session ${l.holder.session}${l.holder.device ? `, ${l.holder.device}` : ''}) since ${new Date(l.acquired_at * 1000).toISOString()}, ${state}; scope ${l.scope.join(', ')}`
    + (l.title ? `; "${l.title}"` : '');
}

async function run(fn: () => Promise<CoordResult>): Promise<CoordResult> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string; reason?: string };
    if (isCoordinationUnavailable(e)) {
      return {
        exit: EXIT.unavailable,
        json: { ok: false, unavailable: true, reason: err.reason ?? 'unreachable', message: err.message },
        text: `not shared: ${err.message} (fall back to local coordination and say the work is not shared)`,
      };
    }
    const usage = err.status === 400 || err.status === 403 || err.status === 413;
    return { exit: usage ? EXIT.usage : EXIT.error, json: { ok: false, code: err.code, message: err.message }, text: `error: ${err.message}` };
  }
}

export interface AcquireArgs {
  collection: string;
  key: string;
  session?: string;
  scope?: string[];
  ttlSeconds?: number;
  title?: string;
}

export function leaseAcquire(a: AcquireArgs): Promise<CoordResult> {
  return run(async () => {
    const session = a.session ?? defaultSession();
    const r = await (await requireCoordination()).leaseAcquire({ ...a, session });
    if (!r.granted) {
      const lines = r.conflicts.map(c => `CONFLICT ${a.key}: ${describeLease(c.lease)} (overlap: ${c.overlap.join(', ')})`);
      return { exit: EXIT.refused, json: { ok: false, ...r }, text: lines.join('\n') };
    }
    const prev = r.took_over_from as { user?: string; session?: string } | undefined;
    noteLeaseHeld(session, r.lease.ttl_seconds);
    const verb = r.renewed ? 'renewed' : prev ? `took over (expired lease of ${prev.user} session ${prev.session}; say so in the task notes)` : 'granted';
    return { exit: EXIT.ok, json: { ok: true, ...r }, text: `${verb} ${a.key} to session ${session}: scope ${r.lease.scope.join(', ')}, expires ${new Date(r.lease.expires_at * 1000).toISOString()}` };
  });
}

export function leaseHeartbeat(collection: string | undefined, session?: string, keys?: string[]): Promise<CoordResult> {
  return run(async () => {
    const s = session ?? defaultSession();
    const r = await (await requireCoordination()).leaseHeartbeat(collection, s, keys);
    if (r.renewed.length) noteLeaseHeld(s, Math.min(...r.renewed.map(l => l.ttl_seconds)));
    const lost = r.lost.length ? `; LOST (taken over or released): ${r.lost.join(', ')}` : '';
    return { exit: EXIT.ok, json: { ok: true, ...r }, text: `renewed ${r.renewed.length} lease(s) for session ${s}${lost}` };
  });
}

export function leaseRelease(collection: string, key: string, session?: string, outcome?: string): Promise<CoordResult> {
  return run(async () => {
    const s = session ?? defaultSession();
    const r = await (await requireCoordination()).leaseRelease(collection, key, s, outcome);
    if (r.released) return { exit: EXIT.ok, json: { ok: true, ...r }, text: `released ${key} (${outcome ?? 'done'})` };
    if (r.reason === 'not_held') return { exit: EXIT.ok, json: { ok: true, ...r }, text: `${key} is not leased` };
    return { exit: EXIT.refused, json: { ok: false, ...r }, text: `${key} is not yours to release: ${describeLease(r.lease)}` };
  });
}

export function leaseList(collection: string, includeExpired = false): Promise<CoordResult> {
  return run(async () => {
    const r = await (await requireCoordination()).leaseList(collection, includeExpired);
    const text = r.leases.length
      ? r.leases.map(l => `- ${describeLease(l, r.now)}`).join('\n')
      : `no ${includeExpired ? '' : 'live '}leases in ${collection}`;
    return { exit: EXIT.ok, json: { ok: true, ...r }, text };
  });
}

export function counterNext(collection: string, name: string, floor?: number): Promise<CoordResult> {
  return run(async () => {
    const value = await (await requireCoordination()).counterNext(collection, name, floor);
    return { exit: EXIT.ok, json: { ok: true, value }, text: String(value) };
  });
}

export function nextTaskId(floor?: number): Promise<CoordResult> {
  return run(async () => {
    const id = await (await requireCoordination()).nextTaskId(floor);
    return { exit: EXIT.ok, json: { ok: true, id }, text: id };
  });
}
