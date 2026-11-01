/**
 * The ready queue: which task in a collection to start next, and (with
 * `claim`) claiming it in the same call. A task is ready when it is pending,
 * every task it depends on is complete, nobody holds a live claim on it, and
 * it passes the tag filters. An in_progress task whose claim lapsed (its
 * holder went quiet past the TTL) is offered again, marked as such.
 *
 * Order: tasks "near" live work last (their soft scope, `claim_scope`,
 * overlaps something claimed), then priority, then due date (earliest first,
 * none last), then how many open tasks each one unblocks, then age.
 */
import { getDocumentsByFilter } from '../store/index.js';
import type { Lease } from '../sync/backend.js';
import { claimsFor, describeHolder, TaskClaimedError, type ClaimOptions, type ClaimResult } from './claim.js';
import { getTask, updateTask } from './update.js';

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface NextOptions extends ClaimOptions {
  collection: string;
  /** Only tasks carrying every one of these tags. */
  tags?: string[];
  /** Skip tasks carrying any of these tags. */
  excludeTags?: string[];
  /** Claim the first ready task (trying the next one if a claim is refused). */
  claim?: boolean;
}

export interface ReadyTask {
  id: string;
  title: string;
  collection: string;
  priority: string;
  status: string;
  due_date?: number;
  /** Open tasks in the collection that wait on this one. */
  unblocks: number;
  /** Live claims whose scope overlaps this task's soft scope (`claim_scope`). */
  near: string[];
  /** in_progress before, but its claim lapsed: someone started and went quiet. */
  lapsed: boolean;
}

export interface NextResult {
  ready: ReadyTask[];
  skipped: Array<{ id: string; reason: string }>;
  /** False when live claims could not be read (offline): readiness then ignores claims. */
  claimsKnown: boolean;
  /** With `claim`: what happened to the task that was claimed (or the last refusal). */
  claimed?: ClaimResult;
}

const norm = (x: unknown): string[] => (Array.isArray(x) ? x : (x ?? '').toString().split(',')).map(String).map(s => s.trim()).filter(Boolean);

export async function nextTasks(opts: NextOptions): Promise<NextResult> {
  const docs = await getDocumentsByFilter(opts.collection, { type: 'task' }, 5000).catch(() => []);
  const open = docs.filter(d => d.metadata.status !== 'complete');
  const byId = new Map(docs.map(d => [d.id, d]));
  const claims = await claimsFor(opts.collection);
  const live: Lease[] = claims ? [...claims.values()] : [];

  // Soft scope of what is live right now: the leases' own scope plus the
  // claimed tasks' claim_scope.
  const liveScope = new Map<string, string>();
  for (const l of live) {
    for (const s of l.scope) if (s !== `key:${l.key}`) liveScope.set(s, l.key);
    for (const s of norm(byId.get(l.key)?.metadata.claim_scope)) liveScope.set(s, l.key);
  }

  const openIds = new Set(open.map(d => d.id));
  const skipped: NextResult['skipped'] = [];
  const ready: ReadyTask[] = [];
  const depCache = new Map<string, string | undefined>();
  const depStatus = async (id: string): Promise<string | undefined> => {
    if (byId.has(id)) return byId.get(id)!.metadata.status;
    if (!depCache.has(id)) depCache.set(id, (await getTask(id).catch(() => null))?.metadata.status);
    return depCache.get(id);
  };

  for (const d of open) {
    const tags = norm(d.metadata.tags);
    if (opts.tags?.length && !opts.tags.every(t => tags.includes(t))) continue;
    if (opts.excludeTags?.some(t => tags.includes(t))) {
      skipped.push({ id: d.id, reason: `tagged ${opts.excludeTags.filter(t => tags.includes(t)).join(', ')}` });
      continue;
    }
    const status = d.metadata.status ?? 'pending';
    if (status === 'blocked') {
      skipped.push({ id: d.id, reason: `blocked${d.metadata.blockedReason ? `: ${d.metadata.blockedReason}` : ''}` });
      continue;
    }
    const held = claims?.get(d.id);
    if (held) {
      skipped.push({ id: d.id, reason: `claimed by ${describeHolder(held)}` });
      continue;
    }
    if (status === 'in_progress' && !claims) {
      skipped.push({ id: d.id, reason: 'in_progress (claims unknown: offline)' });
      continue;
    }
    if (status === 'in_progress' && d.metadata.claim_unshared) {
      skipped.push({ id: d.id, reason: 'in_progress (claimed on this machine, not shared yet)' });
      continue;
    }
    const waiting: string[] = [];
    for (const dep of norm(d.metadata.depends_on)) {
      const s = await depStatus(dep);
      if (s !== undefined && s !== 'complete') waiting.push(dep);
    }
    if (waiting.length) {
      skipped.push({ id: d.id, reason: `waiting on ${waiting.join(', ')}` });
      continue;
    }
    const near = [...new Set(norm(d.metadata.claim_scope).filter(s => liveScope.has(s)).map(s => liveScope.get(s)!))];
    ready.push({
      id: d.id,
      title: d.content,
      collection: opts.collection,
      priority: d.metadata.priority ?? 'medium',
      status,
      ...(d.metadata.due_date ? { due_date: Number(d.metadata.due_date) } : {}),
      unblocks: norm(d.metadata.blocks).filter(b => openIds.has(b)).length,
      near,
      lapsed: status === 'in_progress',
    });
  }

  const created = (id: string) => Number(byId.get(id)?.metadata.created_at ?? 0);
  ready.sort((a, b) =>
    (a.near.length ? 1 : 0) - (b.near.length ? 1 : 0)
    || (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2)
    || (a.due_date ?? Infinity) - (b.due_date ?? Infinity)
    || b.unblocks - a.unblocks
    || created(a.id) - created(b.id));

  const result: NextResult = { ready, skipped, claimsKnown: claims !== undefined };
  if (!opts.claim) return result;

  const { collection: _c, tags: _t, excludeTags: _x, claim: _k, ...claimOpts } = opts;
  for (const r of ready) {
    try {
      const u = await updateTask(r.id, { status: 'in_progress' }, claimOpts);
      result.claimed = u.claim ?? { kind: 'local', id: u.id };
      return result;
    } catch (e) {
      if (e instanceof TaskClaimedError) {
        // Lost a race for this one: note it and try the next.
        result.claimed = e.result;
        skipped.push({ id: r.id, reason: `claim refused: ${e.message}` });
        continue;
      }
      throw e;
    }
  }
  return result;
}
