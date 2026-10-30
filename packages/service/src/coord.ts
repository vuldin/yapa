/**
 * Multi-session coordination (schema v3, infra/cloudsql/sql/06_coordination.sql;
 * docs/service-design.md section 5 "Coordination"). Leases with a scope and a
 * TTL, and atomic counters, answered synchronously so a caller knows before it
 * starts whether it holds the work: for any tool or workflow that runs
 * several sessions (or people) on one shared collection, and for task ids.
 *
 * Concurrency: every lease mutation in a collection takes a transaction-scoped
 * advisory lock on that collection first, so "is anything live that overlaps
 * my scope?" and "write my lease" are one step even for different keys.
 * Counters are a single INSERT ... ON CONFLICT DO UPDATE (row lock).
 */
import type pg from 'pg';
import { withUserTx } from './db.js';
import { ApiError } from './errors.js';
import { assertCollection } from './rules.js';
import type { RequestCtx } from './store.js';

export const LEASE_TTL_MIN = 30;
export const LEASE_TTL_MAX = 24 * 3600;
export const LEASE_TTL_DEFAULT = 2 * 3600;
export const MAX_SCOPE = 64;
/** Expired leases are kept (visible as expired) this long, then pruned. */
export const EXPIRED_KEEP_SECONDS = 7 * 24 * 3600;
/** Reserved counters collection for task ids (name = username). */
export const TASK_COUNTER_COLLECTION = '@tasks';

const KEY_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const COUNTER_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const OUTCOME_RE = /^[A-Za-z0-9._ :-]{0,64}$/;

export function assertKey(v: unknown, what = 'key'): string {
  if (typeof v !== 'string' || !KEY_RE.test(v)) throw new ApiError('invalid_request', `${what} must match ${KEY_RE.source}`);
  return v;
}

export function assertSession(v: unknown): string {
  if (typeof v !== 'string' || !SESSION_RE.test(v)) throw new ApiError('invalid_request', `session must match ${SESSION_RE.source}`);
  return v;
}

export function assertScope(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_SCOPE) throw new ApiError('invalid_request', `scope must be an array of at most ${MAX_SCOPE} strings`);
  return [...new Set(v.map(s => assertKey(s, 'scope entries')))].sort();
}

export function assertTtl(v: unknown): number {
  if (v === undefined) return LEASE_TTL_DEFAULT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < LEASE_TTL_MIN || v > LEASE_TTL_MAX) {
    throw new ApiError('invalid_request', `ttl_seconds must be an integer from ${LEASE_TTL_MIN} to ${LEASE_TTL_MAX}`);
  }
  return v;
}

export function assertCounterName(v: unknown): string {
  if (typeof v !== 'string' || !COUNTER_RE.test(v)) throw new ApiError('invalid_request', `name must match ${COUNTER_RE.source}`);
  return v;
}

export function assertFloor(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ApiError('invalid_request', 'floor must be a non-negative integer');
  return v;
}

export function assertOutcome(v: unknown): string {
  if (v === undefined) return 'done';
  if (typeof v !== 'string' || !OUTCOME_RE.test(v)) throw new ApiError('invalid_request', `outcome must match ${OUTCOME_RE.source}`);
  return v;
}

export function assertTitle(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > 300) throw new ApiError('invalid_request', 'title must be a string of at most 300 characters');
  return v;
}

/** Every lease covers its own key, so a scope never has to name it. */
export function effectiveScope(key: string, scope: string[]): string[] {
  return [...new Set([`key:${key}`, ...scope])].sort();
}

export interface LeaseOut {
  collection: string;
  key: string;
  holder: { user: string; session: string; device: string | null };
  title: string | null;
  scope: string[];
  ttl_seconds: number;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  expired: boolean;
  took_over_from: Record<string, unknown> | null;
}

export type AcquireResult =
  | { granted: true; lease: LeaseOut; renewed: boolean; took_over_from?: Record<string, unknown> }
  | { granted: false; conflicts: Array<{ lease: LeaseOut; overlap: string[] }> };

const LEASE_COLS = `collection, key, holder_user, holder_device, holder_session, title, scope, ttl_seconds,
  floor(extract(epoch from acquired_at))::bigint AS acquired_at,
  floor(extract(epoch from heartbeat_at))::bigint AS heartbeat_at,
  floor(extract(epoch from expires_at))::bigint AS expires_at,
  (expires_at <= clock_timestamp()) AS expired, took_over_from`;

function toLease(r: Record<string, any>): LeaseOut {
  return {
    collection: r.collection,
    key: r.key,
    holder: { user: r.holder_user, session: r.holder_session, device: r.holder_device ?? null },
    title: r.title ?? null,
    scope: r.scope ?? [],
    ttl_seconds: Number(r.ttl_seconds),
    acquired_at: Number(r.acquired_at),
    heartbeat_at: Number(r.heartbeat_at),
    expires_at: Number(r.expires_at),
    expired: Boolean(r.expired),
    took_over_from: r.took_over_from ?? null,
  };
}

async function lockCollection(c: pg.PoolClient, collection: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('yapa-lease:' || $1, 0))", [collection]);
}

async function logLease(c: pg.PoolClient, ctx: RequestCtx, collection: string, key: string, action: string, session: string, detail: Record<string, unknown> | null) {
  await c.query(
    `INSERT INTO lease_log (collection, key, action, actor, device, session, request_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [collection, key, action, ctx.caller.username, ctx.device, session, ctx.requestId, detail ? JSON.stringify(detail) : null],
  );
}

const isMine = (l: LeaseOut, me: string, session: string) => l.holder.user === me && l.holder.session === session;

export interface AcquireParams {
  collection: string;
  key: string;
  session: string;
  scope: string[];
  ttlSeconds: number;
  title: string | null;
}

/**
 * Grant `key` to (caller, session) unless a live lease held by anyone else
 * (including the caller's other sessions) has the same key or an overlapping
 * scope. Re-acquiring your own lease renews it and replaces its scope.
 */
export async function acquire(pool: pg.Pool, ctx: RequestCtx, p: AcquireParams): Promise<AcquireResult> {
  assertCollection(p.collection);
  const me = ctx.caller.username;
  const scope = effectiveScope(p.key, p.scope);
  return withUserTx(pool, me, async c => {
    await lockCollection(c, p.collection);
    await c.query(
      `DELETE FROM leases WHERE collection = $1 AND expires_at < clock_timestamp() - make_interval(secs => $2)`,
      [p.collection, EXPIRED_KEEP_SECONDS],
    );
    const live = await c.query(
      `SELECT ${LEASE_COLS} FROM leases
        WHERE collection = $1 AND expires_at > clock_timestamp() AND (key = $2 OR scope && $3::text[])`,
      [p.collection, p.key, scope],
    );
    const conflicts = live.rows.map(toLease)
      .filter(l => !isMine(l, me, p.session))
      .map(l => ({ lease: l, overlap: l.key === p.key ? [`key:${p.key}`] : l.scope.filter(s => scope.includes(s)) }));
    if (conflicts.length) {
      await logLease(c, ctx, p.collection, p.key, 'refused', p.session, { conflicts: conflicts.map(x => ({ key: x.lease.key, holder: x.lease.holder, overlap: x.overlap })) });
      return { granted: false as const, conflicts };
    }

    const prevRow = (await c.query(`SELECT ${LEASE_COLS} FROM leases WHERE collection = $1 AND key = $2 FOR UPDATE`, [p.collection, p.key])).rows[0];
    const prev = prevRow ? toLease(prevRow) : undefined;
    const renewed = prev !== undefined && isMine(prev, me, p.session);
    const takeover = prev !== undefined && !renewed
      ? { user: prev.holder.user, session: prev.holder.session, device: prev.holder.device, expired_at: prev.expires_at, acquired_at: prev.acquired_at }
      : undefined;
    const r = await c.query(
      `INSERT INTO leases (collection, key, holder_user, holder_device, holder_session, title, scope, ttl_seconds,
                           acquired_at, heartbeat_at, expires_at, took_over_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::int, clock_timestamp(), clock_timestamp(),
               clock_timestamp() + make_interval(secs => $8::int), $9::jsonb)
       ON CONFLICT (collection, key) DO UPDATE SET
         holder_user = EXCLUDED.holder_user, holder_device = EXCLUDED.holder_device,
         holder_session = EXCLUDED.holder_session, title = COALESCE(EXCLUDED.title, leases.title),
         scope = EXCLUDED.scope, ttl_seconds = EXCLUDED.ttl_seconds,
         acquired_at = CASE WHEN $10::boolean THEN leases.acquired_at ELSE EXCLUDED.acquired_at END,
         heartbeat_at = EXCLUDED.heartbeat_at, expires_at = EXCLUDED.expires_at,
         took_over_from = CASE WHEN $10::boolean THEN leases.took_over_from ELSE EXCLUDED.took_over_from END
       RETURNING ${LEASE_COLS}`,
      [p.collection, p.key, me, ctx.device, p.session, p.title, scope, p.ttlSeconds,
        takeover ? JSON.stringify(takeover) : null, renewed],
    );
    const lease = toLease(r.rows[0]);
    await logLease(c, ctx, p.collection, p.key, renewed ? 'reacquire' : takeover ? 'takeover' : 'acquire', p.session,
      { scope, ttl_seconds: p.ttlSeconds, ...(takeover ? { took_over_from: takeover } : {}) });
    return { granted: true as const, lease, renewed, ...(takeover ? { took_over_from: takeover } : {}) };
  });
}

/**
 * Renew the caller's leases for `session`: all of them, all in `collection`,
 * or just `keys` there. A lease that was taken over or released is reported
 * as lost; an expired one that nobody took is renewed.
 *
 * No collection lock: the UPDATE only matches rows the caller still holds,
 * and a concurrent takeover holds the row lock, so after it commits the row
 * no longer matches (READ COMMITTED re-checks the WHERE clause).
 */
export async function heartbeat(pool: pg.Pool, ctx: RequestCtx, collection: string | undefined, session: string, keys?: string[]): Promise<{ renewed: LeaseOut[]; lost: string[] }> {
  if (collection !== undefined) assertCollection(collection);
  if (keys && collection === undefined) throw new ApiError('invalid_request', 'keys needs a collection');
  const me = ctx.caller.username;
  return withUserTx(pool, me, async c => {
    const values: unknown[] = [me, session];
    let where = 'holder_user = $1 AND holder_session = $2';
    if (collection !== undefined) { values.push(collection); where += ` AND collection = $${values.length}`; }
    if (keys) { values.push(keys); where += ` AND key = ANY($${values.length}::text[])`; }
    const r = await c.query(
      `UPDATE leases SET heartbeat_at = clock_timestamp(), expires_at = clock_timestamp() + make_interval(secs => ttl_seconds)
        WHERE ${where}
        RETURNING ${LEASE_COLS}`,
      values,
    );
    const renewed = r.rows.map(toLease);
    const lost = (keys ?? []).filter(k => !renewed.some(l => l.key === k));
    return { renewed, lost };
  });
}

export type ReleaseResult =
  | { released: true; lease: LeaseOut }
  | { released: false; reason: 'not_held' }
  | { released: false; reason: 'held_by_other'; lease: LeaseOut };

export async function release(pool: pg.Pool, ctx: RequestCtx, collection: string, key: string, session: string, outcome: string): Promise<ReleaseResult> {
  assertCollection(collection);
  const me = ctx.caller.username;
  return withUserTx(pool, me, async c => {
    await lockCollection(c, collection);
    const row = (await c.query(`SELECT ${LEASE_COLS} FROM leases WHERE collection = $1 AND key = $2 FOR UPDATE`, [collection, key])).rows[0];
    if (!row) return { released: false as const, reason: 'not_held' as const };
    const lease = toLease(row);
    if (!isMine(lease, me, session)) return { released: false as const, reason: 'held_by_other' as const, lease };
    await c.query('DELETE FROM leases WHERE collection = $1 AND key = $2', [collection, key]);
    await logLease(c, ctx, collection, key, 'release', session, { outcome, held_seconds: Math.max(0, Math.floor(Date.now() / 1000) - lease.acquired_at) });
    return { released: true as const, lease };
  });
}

/** Live leases (and recently expired ones, marked) in a collection: doubles as presence. */
export async function list(pool: pg.Pool, ctx: RequestCtx, collection: string, includeExpired: boolean): Promise<LeaseOut[]> {
  assertCollection(collection);
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(
      `SELECT ${LEASE_COLS} FROM leases WHERE collection = $1 ${includeExpired ? '' : 'AND expires_at > clock_timestamp()'}
        ORDER BY acquired_at, key`,
      [collection],
    );
    return r.rows.map(toLease);
  });
}

async function bump(c: pg.PoolClient, collection: string, name: string, floor: number, me: string): Promise<number> {
  const r = await c.query(
    `INSERT INTO counters (collection, name, value, updated_by) VALUES ($1, $2, $3::bigint + 1, $4)
     ON CONFLICT (collection, name) DO UPDATE
       SET value = GREATEST(counters.value, $3::bigint) + 1, updated_at = clock_timestamp(), updated_by = $4
     RETURNING value::text`,
    [collection, name, floor, me],
  );
  return Number(r.rows[0].value);
}

/** Next value of (collection, name): strictly above the last one handed out and above `floor`. */
export async function counterNext(pool: pg.Pool, ctx: RequestCtx, collection: string, name: string, floor: number): Promise<number> {
  assertCollection(collection);
  return withUserTx(pool, ctx.caller.username, c => bump(c, collection, name, floor, ctx.caller.username));
}

/**
 * Next task number for the caller: one sequence per user across every
 * collection, floored by the client's local max and by the highest
 * `<user>-<n>` already on the server, so an id is never handed out twice.
 */
export async function nextTaskNumber(pool: pg.Pool, ctx: RequestCtx, clientFloor: number, serverMax: (c: pg.PoolClient) => Promise<number>): Promise<number> {
  const me = ctx.caller.username;
  return withUserTx(pool, me, async c => bump(c, TASK_COUNTER_COLLECTION, me, Math.max(clientFloor, await serverMax(c)), me));
}
