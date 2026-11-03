/**
 * Task claims: a task in a shared collection that moves to `in_progress` is
 * claimed by taking a lease on its id (docs/sync-api.md section 9). The
 * service answers at once and atomically, so two people (or two sessions)
 * cannot both start the same task: the second is refused and told who holds
 * it. Leaving `in_progress` (complete, blocked, back to pending, deleted)
 * releases the claim.
 *
 * Fail open, loudly: offline or signed out, the status still changes locally
 * and the caller is told the claim is not shared; the claim is retried when
 * sync is back, and a clash found then is reported on the next prompt.
 */
import { getConfig } from '../config.js';
import { getDocumentsByFilter, getDocumentsByIds, listCollections, patchDocument } from '../store/index.js';
import { getDeviceId } from '../sync/device.js';
import { isSyncConfigured, type Lease } from '../sync/backend.js';
import {
  addClaimNotice, coordinatedLocally, currentSession, isCoordinationUnavailable, noteLeaseHeld, noteLeaseReleased, requireCoordination,
} from '../sync/coordination.js';
import { pushDocsNow } from '../sync/push.js';
import { isSyncableCollection } from '../sync/syncable.js';

export interface ClaimOptions {
  /** Holder inside the user; defaults to YAPA_SESSION / the Claude Code session, else this process. */
  session?: string;
  /** Extra hard scope for the lease (`key:<id>` is always included). Omitted: a renewal keeps the stored scope. */
  scope?: string[];
  ttlSeconds?: number;
  title?: string;
  /** Take over a live claim held by another session of the same user (after the user confirms). */
  reclaim?: boolean;
}

export type ClaimResult =
  /** Not a shared collection, or no sync configured: nothing to coordinate. */
  | { kind: 'local'; id: string }
  | { kind: 'granted'; id: string; collection: string; session: string; lease: Lease; renewed: boolean; tookOverFrom?: Record<string, unknown> }
  | { kind: 'refused'; id: string; collection: string; session: string; conflicts: Array<{ lease: Lease; overlap: string[] }> }
  | { kind: 'unshared'; id: string; collection: string; session: string; reason: string };

export type ReleaseResult =
  | { kind: 'local' | 'released' | 'not_held' }
  | { kind: 'held_by_other'; lease: Lease }
  | { kind: 'unshared'; reason: string };

/** Thrown by updateTask when another holder has a live claim on the task. */
export class TaskClaimedError extends Error {
  readonly code = 'task_claimed';
  constructor(readonly result: Extract<ClaimResult, { kind: 'refused' }>) {
    super(describeRefusal(result));
    this.name = 'TaskClaimedError';
  }
}

const SESSION_SAFE = /[^A-Za-z0-9._:-]/g;

/** The holder session: explicit, else YAPA_SESSION / CLAUDE_CODE_SESSION_ID, else this process. */
export function claimSession(explicit?: string): string {
  return currentSession(explicit) ?? `${getDeviceId()}:${process.pid}`.replace(SESSION_SAFE, '-').slice(0, 128);
}

/**
 * True when a status change on a task in `collection` goes through claims:
 * always since 1.10. Shared collections are claimed on the sync service;
 * local-only ones, and every collection when sync is off, on this machine
 * (sync/local-coordination.ts). Kept for callers and the `local` result kind.
 */
export function claimsApply(_collection: string): boolean {
  return true;
}

function utc(t: number, now = Math.floor(Date.now() / 1000)): string {
  const iso = new Date(t * 1000).toISOString();
  const day = iso.slice(0, 10);
  const hm = iso.slice(11, 16);
  return day === new Date(now * 1000).toISOString().slice(0, 10) ? `${hm} UTC` : `${day} ${hm} UTC`;
}

/** "alex (session 1234abcd) since 09:12 UTC" */
export function describeHolder(l: Lease, me = getConfig().USERNAME, mySession?: string, now = Math.floor(Date.now() / 1000)): string {
  const who = l.holder.user === me
    // Your own sessions in full: an abbreviated id gets copied back as a session name.
    ? (mySession && l.holder.session === mySession ? 'you (this session)' : `you (another session, ${l.holder.session})`)
    : `${l.holder.user} (session ${l.holder.session.slice(0, 8)})`;
  return `${who} since ${utc(l.acquired_at, now)}`;
}

export function describeRefusal(r: Extract<ClaimResult, { kind: 'refused' }>): string {
  const holders = r.conflicts.map(c => {
    const why = c.lease.key === r.id ? '' : ` (overlapping ${c.overlap.join(', ')} via ${c.lease.key})`;
    return `${describeHolder(c.lease, undefined, r.session)}${why}`;
  });
  const ownOther = r.conflicts.every(c => c.lease.holder.user === getConfig().USERNAME);
  return `${r.id} is being worked on by ${holders.join('; ')}; not changed.`
    + (ownOther ? ' If that other session is yours and finished or gone, retry with reclaim: true after the user confirms.' : '');
}

/**
 * Claim task `id` (in `collection`) for `session`. A task with unpushed
 * edits is pushed first, so the lease is keyed on the id the remote knows
 * (a task created offline can be re-keyed on its first push).
 */
export async function claimTask(id: string, collection: string, metadata: Record<string, any>, opts: ClaimOptions = {}): Promise<ClaimResult> {
  if (!claimsApply(collection)) return { kind: 'local', id };
  const session = claimSession(opts.session);
  // Another session on this machine claimed it while offline: the service
  // has not heard of that claim yet, so this store is the authority for it.
  const localHolder = metadata.status === 'in_progress' && typeof metadata.claim_unshared === 'string' ? metadata.claim_unshared : '';
  if (localHolder && localHolder !== session && !opts.reclaim) {
    const at = Number(metadata.updated_at ?? Math.floor(Date.now() / 1000));
    const lease: Lease = {
      collection, key: id, holder: { user: getConfig().USERNAME, session: localHolder, device: getDeviceId() }, title: null,
      scope: [`key:${id}`], ttl_seconds: 0, acquired_at: at, heartbeat_at: at, expires_at: at, expired: false, took_over_from: null,
    };
    return { kind: 'refused', id, collection, session, conflicts: [{ lease, overlap: [`key:${id}`] }] };
  }
  let key = id;
  if (metadata.is_synced === false && !coordinatedLocally(collection)) {
    try {
      const r = await pushDocsNow(collection, [id]);
      key = r.renamed[id] ?? id;
    } catch {
      // offline: the acquire below says so
    }
  }
  try {
    const c = await requireCoordination();
    const r = await c.leaseAcquire({
      collection, key, session,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.reclaim ? { reclaim: true } : {}),
    });
    if (!r.granted) return { kind: 'refused', id: key, collection, session, conflicts: r.conflicts };
    noteLeaseHeld(session, r.lease.ttl_seconds, undefined, { collection, key });
    return { kind: 'granted', id: key, collection, session, lease: r.lease, renewed: r.renewed, ...(r.took_over_from ? { tookOverFrom: r.took_over_from } : {}) };
  } catch (e) {
    if (isCoordinationUnavailable(e)) return unavailable(e, key, collection, session);
    throw e;
  }
}

/**
 * Claim a key that is not a task (a cleanup item such as `cleanup:triage`):
 * the same lease, with no task status to write.
 */
/** Busy local coordination is not "offline": nothing would ever retry it, so refuse with a clear reason. */
export class ClaimBusyError extends Error {
  readonly code = 'claim_busy';
  constructor(readonly id: string, readonly collection: string, cause: string) {
    super(`${id} was not claimed: ${cause}. Nothing changed; try again in a moment.`);
    this.name = 'ClaimBusyError';
  }
}

function unavailable(e: unknown, key: string, collection: string, session: string): ClaimResult {
  // On this machine (a local-only collection, or sync off) "unavailable" can
  // only mean its coordination lock was busy: say so instead of "not shared".
  if (coordinatedLocally(collection)) throw new ClaimBusyError(key, collection, (e as Error).message);
  return { kind: 'unshared', id: key, collection, session, reason: (e as Error).message };
}

export async function claimKey(collection: string, key: string, opts: ClaimOptions = {}): Promise<ClaimResult> {
  if (!claimsApply(collection)) return { kind: 'local', id: key };
  const session = claimSession(opts.session);
  try {
    const c = await requireCoordination();
    const r = await c.leaseAcquire({
      collection, key, session,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.reclaim ? { reclaim: true } : {}),
    });
    if (!r.granted) return { kind: 'refused', id: key, collection, session, conflicts: r.conflicts };
    noteLeaseHeld(session, r.lease.ttl_seconds, undefined, { collection, key });
    return { kind: 'granted', id: key, collection, session, lease: r.lease, renewed: r.renewed, ...(r.took_over_from ? { tookOverFrom: r.took_over_from } : {}) };
  } catch (e) {
    if (isCoordinationUnavailable(e)) return unavailable(e, key, collection, session);
    throw e;
  }
}

/** Release this session's claim on a task. Never throws for an unreachable service. */
export async function releaseTaskClaim(id: string, collection: string, outcome: string, session?: string): Promise<ReleaseResult> {
  if (!claimsApply(collection)) return { kind: 'local' };
  const s = claimSession(session);
  try {
    const r = await (await requireCoordination()).leaseRelease(collection, id, s, outcome);
    noteLeaseReleased(s, collection, id);
    if (r.released) return { kind: 'released' };
    if (r.reason === 'held_by_other') return { kind: 'held_by_other', lease: r.lease };
    return { kind: 'not_held' };
  } catch (e) {
    if (isCoordinationUnavailable(e)) return { kind: 'unshared', reason: (e as Error).message };
    throw e;
  }
}

/** One line for a tool reply: what the claim did. Empty when nothing was coordinated. */
export function describeClaim(r: ClaimResult): string {
  switch (r.kind) {
    case 'local': return '';
    case 'granted': {
      if (r.tookOverFrom) {
        const prev = r.tookOverFrom as { user?: string; session?: string; reclaim?: boolean };
        const whose = prev.user === getConfig().USERNAME ? `your other session ${String(prev.session ?? '')}` : `${prev.user}'s expired claim`;
        return `Claimed ${r.id} (took over from ${whose}).`;
      }
      return r.renewed ? `Claim on ${r.id} renewed.` : `Claimed ${r.id}: teammates see it as yours.`;
    }
    case 'refused': return describeRefusal(r);
    case 'unshared': return `Claim on ${r.id} is NOT shared (${r.reason}): others may start it too. It will be retried when sync is back; tell the user.`;
  }
}

// ------------------------------------------------- claims made offline

/**
 * Retry claims recorded while the service was unreachable (tasks marked
 * `claim_unshared`). Granted: the marker is cleared. Refused: someone else
 * claimed the task meanwhile; a notice goes to the next prompt and the
 * marker is cleared (the user decides what to do). Unreachable: kept.
 */
export async function retryUnsharedClaims(): Promise<{ granted: number; refused: number }> {
  const out = { granted: 0, refused: 0 };
  if (!isSyncConfigured()) return out;
  for (const col of await listCollections().catch(() => [])) {
    if (!isSyncableCollection(col.name)) continue;
    const pending = (await getDocumentsByFilter(col.name, { status: 'in_progress' }, 1000).catch(() => []))
      .filter(d => typeof d.metadata.claim_unshared === 'string' && d.metadata.claim_unshared);
    for (const d of pending) {
      let r: ClaimResult;
      try {
        r = await claimTask(d.id, col.name, d.metadata, { session: d.metadata.claim_unshared });
      } catch {
        continue;
      }
      if (r.kind === 'unshared' || r.kind === 'local') return out; // still offline: try again later
      // Only the marker: the rest of the task is left as it is now.
      await patchDocument(col.name, r.id, { claim_unshared: '' }).catch(() => undefined);
      if (r.kind === 'granted') {
        out.granted++;
      } else {
        out.refused++;
        addClaimNotice(`While you were offline, ${r.conflicts.map(c => describeHolder(c.lease, undefined, r.session)).join('; ')} claimed ${r.id} (${col.name}). Your claim was not shared: coordinate before continuing that work.`);
      }
    }
  }
  return out;
}

// ------------------------------------------------- who holds what

/**
 * Live claims in `collection`, by task id. Undefined when they could not be
 * read (offline, signed out, older service): callers then show no holders
 * rather than guessing.
 */
export async function claimsFor(collection: string, budgetMs = 1500): Promise<Map<string, Lease> | undefined> {
  if (!claimsApply(collection)) return undefined;
  try {
    const work = (async () => (await requireCoordination()).leaseList(collection))();
    const r = await Promise.race([work, new Promise<undefined>(res => setTimeout(() => res(undefined), budgetMs).unref())]);
    if (!r) return undefined;
    return new Map(r.leases.filter(l => !l.expired).map(l => [l.key, l]));
  } catch {
    return undefined;
  }
}

/**
 * The claim annotation for a task line: "claimed by alex (session ..) since
 * 09:12 UTC", "claimed by you (this session) ...", or "no live claim" for an
 * in_progress task nobody holds. Empty when there is nothing to say or the
 * claims are unknown.
 */
export function claimNote(task: { id: string; metadata: Record<string, any> }, claims: Map<string, Lease> | undefined, mySessions: Array<string | undefined> = [currentSession()]): string {
  if (!claims) return task.metadata.claim_unshared ? 'claim not shared yet' : '';
  const l = claims.get(task.id);
  if (l) {
    const mine = mySessions.find(s => s && s === l.holder.session);
    return `claimed by ${describeHolder(l, undefined, mine)}`;
  }
  if (task.metadata.status === 'in_progress') return task.metadata.claim_unshared ? 'claim not shared yet' : 'no live claim';
  return '';
}
