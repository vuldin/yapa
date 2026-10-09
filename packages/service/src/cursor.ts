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

export function decodeCursor(raw: string, collection: string): PullCursor {
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
  return cur;
}

export function posFromSince(since: number): FeedPos {
  return { t: (BigInt(Math.max(0, Math.floor(since))) * 1_000_000n).toString(), id: null };
}
