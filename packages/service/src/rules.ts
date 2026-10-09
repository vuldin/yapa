/**
 * Server-side validation and authorization rules that need no database
 * (docs/service-design.md sections 4, 5 and 8).
 */
import { ApiError, type ErrorCode } from './errors.js';

export const EMBEDDING_DIMS = 384;
export const NORM_TOLERANCE = 0.01;
export const MAX_CONTENT_BYTES = 64 * 1024;
export const MAX_METADATA_BYTES = 32 * 1024;
export const MAX_UPSERT_DOCS = 100;
export const MAX_UPSERT_BYTES = 2 * 1024 * 1024;
export const MAX_DELETE_IDS = 500;
export const MAX_LOOKUP_IDS = 1000;
export const MAX_RELATED_IDS = 100;
export const PULL_LIMIT_DEFAULT = 500;
export const PULL_LIMIT_MAX = 1000;
/** 2024-01-01T00:00:00Z: lower bound for client-supplied created_at. */
export const MIN_CREATED_AT = 1704067200;
export const MAX_FUTURE_SECONDS = 86400;

const COLLECTION_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DEVICE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `global`, `private-*`, `local-*` never reach the server (decision 6). */
export function isLocalOnlyCollection(name: string): boolean {
  return name === 'global' || name.startsWith('private-') || name.startsWith('local-');
}

export type CollectionCheck = { ok: true } | { ok: false; code: ErrorCode; message: string };

export function checkCollection(name: unknown): CollectionCheck {
  if (typeof name !== 'string' || !COLLECTION_RE.test(name)) {
    return { ok: false, code: 'invalid_collection', message: 'collection must match ^[a-z0-9][a-z0-9._-]{0,127}$' };
  }
  // Checked after the name format so a local-only name is never echoed back
  // in a different error; the name itself is not logged.
  if (isLocalOnlyCollection(name)) {
    return { ok: false, code: 'local_only_collection', message: 'global, private-* and local-* collections are local-only and never synced' };
  }
  return { ok: true };
}

export function assertCollection(name: unknown): string {
  const r = checkCollection(name);
  if (!r.ok) throw new ApiError(r.code, r.message);
  return name as string;
}

/** Document ids: 1..200 chars, printable, no whitespace, no leading `__` (local sentinels). */
export function checkDocId(id: unknown): string | undefined {
  if (typeof id !== 'string' || id.length < 1 || id.length > 200) return 'id must be a string of 1..200 characters';
  if (id.startsWith('__')) return 'ids starting with "__" are local sentinels and never synced';
  if (/[\s\u0000-\u001f\u007f]/.test(id)) return 'id must not contain whitespace or control characters';
  return undefined;
}

export function assertDocId(id: unknown): string {
  const err = checkDocId(id);
  if (err) throw new ApiError('invalid_request', err);
  return id as string;
}

export function assertIdList(ids: unknown, max: number, field = 'ids'): string[] {
  if (!Array.isArray(ids)) throw new ApiError('invalid_request', `${field} must be an array`);
  if (ids.length > max) throw new ApiError('payload_too_large', `at most ${max} ${field} per request`);
  for (const id of ids) {
    const err = checkDocId(id);
    if (err) throw new ApiError('invalid_request', `${field}: ${err}`);
  }
  return [...new Set(ids as string[])];
}

export function checkDevice(device: string | undefined): string | undefined {
  if (device === undefined || device === '') return undefined;
  return DEVICE_RE.test(device) ? device : undefined;
}

export function isValidUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

export type EmbeddingCheck =
  | { ok: true; vector: number[] }
  | { ok: false; code: 'embedding_dimension' | 'embedding_invalid'; message: string };

/** Decision 12: exactly 384 finite numbers with L2 norm within 1 +/- 0.01. */
export function checkEmbedding(v: unknown): EmbeddingCheck {
  if (!Array.isArray(v)) return { ok: false, code: 'embedding_invalid', message: 'embedding must be an array of numbers' };
  if (v.length !== EMBEDDING_DIMS) {
    return { ok: false, code: 'embedding_dimension', message: `embedding must have exactly ${EMBEDDING_DIMS} dimensions, got ${v.length}` };
  }
  let sq = 0;
  for (const x of v) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      return { ok: false, code: 'embedding_invalid', message: 'embedding values must be finite numbers' };
    }
    sq += x * x;
  }
  const norm = Math.sqrt(sq);
  if (Math.abs(norm - 1) > NORM_TOLERANCE) {
    return { ok: false, code: 'embedding_invalid', message: `embedding must be L2-normalized (norm ${norm.toFixed(4)})` };
  }
  return { ok: true, vector: v as number[] };
}

export function assertEmbedding(v: unknown): number[] {
  const r = checkEmbedding(v);
  if (!r.ok) throw new ApiError(r.code, r.message);
  return r.vector;
}

export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * Task-id namespace: `<user>-<n>`. Returns the prefix before the trailing
 * `-<digits>`, or undefined when the id has no numeric suffix.
 */
export function taskIdPrefix(id: string): string | undefined {
  const m = /^(.+)-([0-9]+)$/.exec(id);
  return m ? m[1] : undefined;
}

/**
 * Namespace rule for inserts (matrix row "Insert, id in another user's task
 * namespace"): a task's id must be `<caller>-<n>`, and no doc may be
 * inserted as `<other existing user>-<n>` (that would squat their next id).
 * `prefixIsOtherUser` says whether the prefix is another known username.
 */
export function violatesTaskNamespace(id: string, isTask: boolean, caller: string, prefixIsOtherUser: boolean): boolean {
  const prefix = taskIdPrefix(id);
  if (isTask) return prefix !== caller;
  return prefix !== undefined && prefix !== caller && prefixIsOtherUser;
}

export function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export interface UpsertInput {
  id: string;
  collection: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  embedding_model?: string;
}

export type ItemCheck = { ok: true; doc: UpsertInput } | { ok: false; id: string | undefined; code: ErrorCode; message: string };

/**
 * Validate one upsert item (shape, sizes, collection class, embedding,
 * timestamps). The secret check and namespace/ownership checks run after.
 * The order puts the collection class first so local-only content is never
 * inspected further.
 */
export function checkUpsertItem(raw: unknown, now: number = Math.floor(Date.now() / 1000)): ItemCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, id: undefined, code: 'invalid_request', message: 'each document must be an object' };
  }
  const d = raw as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id : undefined;
  const fail = (code: ErrorCode, message: string): ItemCheck => ({ ok: false, id, code, message });

  const coll = checkCollection(d.collection);
  if (!coll.ok) return fail(coll.code, coll.message);
  const idErr = checkDocId(d.id);
  if (idErr) return fail('invalid_request', idErr);

  if (typeof d.content !== 'string') return fail('invalid_request', 'content must be a string');
  if (bytes(d.content) > MAX_CONTENT_BYTES) return fail('payload_too_large', `content exceeds ${MAX_CONTENT_BYTES} bytes`);

  const metadata = d.metadata ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata === null) {
    return fail('invalid_request', 'metadata must be an object');
  }
  if (bytes(JSON.stringify(metadata)) > MAX_METADATA_BYTES) return fail('payload_too_large', `metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  if ((metadata as Record<string, unknown>).type === 'journal_draft') {
    return fail('invalid_request', 'journal drafts are never synced');
  }

  const emb = checkEmbedding(d.embedding);
  if (!emb.ok) return fail(emb.code, emb.message);

  const created = d.created_at;
  const updated = d.updated_at ?? d.created_at;
  if (typeof created !== 'number' || !Number.isFinite(created)) return fail('invalid_request', 'created_at must be Unix seconds');
  if (typeof updated !== 'number' || !Number.isFinite(updated)) return fail('invalid_request', 'updated_at must be Unix seconds');
  if (created < MIN_CREATED_AT || created > now + MAX_FUTURE_SECONDS) {
    return fail('invalid_request', 'created_at must be between 2024-01-01 and now + 1 day');
  }
  if (updated < MIN_CREATED_AT || updated > now + MAX_FUTURE_SECONDS) {
    return fail('invalid_request', 'updated_at must be between 2024-01-01 and now + 1 day');
  }
  if (d.embedding_model !== undefined && (typeof d.embedding_model !== 'string' || d.embedding_model.length > 200)) {
    return fail('invalid_request', 'embedding_model must be a short string');
  }

  return {
    ok: true,
    doc: {
      id: d.id as string,
      collection: d.collection as string,
      content: d.content,
      embedding: emb.vector,
      metadata: metadata as Record<string, unknown>,
      created_at: Math.floor(created),
      updated_at: Math.floor(updated),
      embedding_model: d.embedding_model as string | undefined,
    },
  };
}

/** Audit action for an update of an existing row. */
export function classifyUpdate(
  prev: { collection: string; metadata: Record<string, unknown> },
  next: { collection: string; metadata: Record<string, unknown> },
): 'move' | 'archive' | 'update' {
  if (prev.collection !== next.collection) return 'move';
  const wasArchived = prev.metadata.archived === true;
  const isArchived = next.metadata.archived === true;
  const supersededNow = next.metadata.superseded_by !== undefined && next.metadata.superseded_by !== prev.metadata.superseded_by;
  if ((!wasArchived && isArchived) || supersededNow) return 'archive';
  return 'update';
}

/** Metadata keys whose values differ (for audit_log.changed_keys). */
export function changedKeys(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter(k => JSON.stringify(prev[k]) !== JSON.stringify(next[k])).sort();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
