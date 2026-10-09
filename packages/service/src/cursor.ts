/**
 * Opaque pull cursor (design section 5, "Pull"): the last (synced_at, id) of
 * the documents feed and the last (deleted_at, id) of the deletions feed.
 * Timestamps are integer microseconds since the epoch (exact, unlike float
 * seconds). An `id` of null means "strictly after this time" (a position that
 * came from `since`, before any row was returned).
 */
import { ApiError } from './errors.js';

export interface FeedPos {
  t: string; // microseconds, as a decimal string (exceeds 2^53 safely)
  id: string | null;
}

export interface PullCursor {
  c: string; // collection the cursor belongs to
  d: FeedPos;
  x: FeedPos;
}

export function encodeCursor(c: PullCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Cursor timestamps may be at most this far past the server clock. */
const MAX_FUTURE_MICROS = 86_400n * 1_000_000n;

export function decodeCursor(raw: string, collection: string, nowMs: number = Date.now()): PullCursor {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError('invalid_request', 'malformed cursor');
  }
  const ok = (p: unknown): p is FeedPos => {
    const q = p as FeedPos;
    return !!q && typeof q.t === 'string' && /^[0-9]{1,20}$/.test(q.t) && (q.id === null || (typeof q.id === 'string' && q.id.length <= 200));
  };
  const cur = v as PullCursor;
  if (!cur || typeof cur !== 'object' || !ok(cur.d) || !ok(cur.x)) throw new ApiError('invalid_request', 'malformed cursor');
  if (cur.c !== collection) throw new ApiError('invalid_request', 'cursor belongs to a different collection');
  // Range check: an out-of-range t overflowed ::bigint in SQL (a 500).
  const maxT = BigInt(Math.floor(nowMs)) * 1000n + MAX_FUTURE_MICROS;
  if (BigInt(cur.d.t) > maxT || BigInt(cur.x.t) > maxT) throw new ApiError('invalid_request', 'cursor position is out of range');
  return cur;
}

/** `since` must already be range-checked (0 <= since <= now + 1 day). */
export function posFromSince(since: number): FeedPos {
  return { t: (BigInt(Math.max(0, Math.floor(since))) * 1_000_000n).toString(), id: null };
}
