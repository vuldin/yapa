/**
 * SQL for every API v1 operation (schema v2, infra/cloudsql/sql/). All
 * queries are parameterized and run inside withUserTx, so the RLS policies
 * in 04_rls.sql apply on top of the checks made here.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Caller } from './auth.js';
import { withUserTx } from './db.js';
import { itemError, type ItemError } from './errors.js';
import { logAudit, type AuditLine } from './log.js';
import { encodeCursor, type FeedPos, type PullCursor } from './cursor.js';
import {
  changedKeys, classifyUpdate, isLocalOnlyCollection, MAX_RELATED_IDS, taskIdPrefix, toPgVector,
  violatesTaskNamespace, type UpsertInput,
} from './rules.js';
import { detectSecretInDoc } from './secrets.js';
import { ApiError } from './errors.js';

export interface RequestCtx {
  caller: Caller;
  device: string | null;
  requestId: string;
}

export interface DocumentOut {
  id: string;
  collection: string;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  origin_user: string;
  last_editor: string | null;
  related_ids: string[];
  created_at: number;
  updated_at: number;
  synced_at: number;
}

const LOCAL_ONLY_SQL = "collection <> 'global' AND collection NOT LIKE 'private-%' AND collection NOT LIKE 'local-%'";
const SECS = (col: string) => `floor(extract(epoch from ${col}))::bigint AS ${col}`;
const MICROS = (col: string, as: string) => `(extract(epoch from ${col}) * 1000000)::bigint::text AS ${as}`;

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ------------------------------------------------------------------ audit

interface AuditRow extends AuditLine {
  content_sha256?: string | null;
  changed_keys?: string[] | null;
}

async function audit(c: pg.PoolClient, a: AuditRow): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (actor, actor_email, device, request_id, action, doc_id, collection, prev_collection,
                            prev_editor, row_owner, change_class, content_sha256, changed_keys)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [a.actor, a.actor_email, a.device, a.request_id, a.action, a.doc_id, a.collection, a.prev_collection ?? null,
      a.prev_editor ?? null, a.row_owner, a.change_class, a.content_sha256 ?? null, a.changed_keys ?? null],
  );
  const { content_sha256: _h, changed_keys: _k, ...line } = a;
  logAudit(line);
}

function auditBase(ctx: RequestCtx): Pick<AuditLine, 'actor' | 'actor_email' | 'device' | 'request_id'> {
  return { actor: ctx.caller.username, actor_email: ctx.caller.email, device: ctx.device, request_id: ctx.requestId };
}

// ------------------------------------------------------------------- pull

export interface PullParams {
  collection: string;
  docsPos: FeedPos;
  delsPos: FeedPos;
  limit: number;
  includeOwnDevice: boolean;
  embeddings: boolean;
  /** Byte budget for the serialized documents of one page (at least one row is always returned). */
  maxBytes: number;
}

export interface PullResult {
  documents: DocumentOut[];
  deletions: Array<{ id: string; deleted_by: string; deleted_at: number }>;
  next_cursor: string;
  has_more: boolean;
}

function posClause(tcol: string, pos: FeedPos, param: (v: unknown) => string): string {
  const ts = `('epoch'::timestamptz + ${param(pos.t)}::bigint * interval '1 microsecond')`;
  return pos.id === null ? `${tcol} > ${ts}` : `(${tcol}, id) > (${ts}, ${param(pos.id)})`;
}

/**
 * Echo rule (buildRemoteDocsSinceQuery): skip a row only when its LAST write
 * was made by the caller from this device. Matching on the device alone let a
 * teammate send X-Yapa-Device = <owner's device> and hide their edit from the
 * owner's pulls. Legacy rows (no device stamp at all) are echoes only for
 * their owner.
 */
export function echoClause(param: (v: unknown) => string, me: string, device: string): string {
  const m = param(me);
  const d = param(device);
  return `NOT (COALESCE(last_editor, origin_user) = ${m} AND COALESCE(last_device, metadata->>'origin_device', '') = ${d})
          AND NOT (origin_user = ${m} AND COALESCE(last_device, metadata->>'origin_device') IS NULL)`;
}

/**
 * How many of the fetched rows fit in the page byte budget. `sizes` are the
 * exact serialized sizes in feed order; the first row is always taken so a
 * single oversized document cannot stall pagination.
 */
export function rowsWithinBudget(sizes: number[], maxBytes: number): number {
  let total = 0;
  let n = 0;
  for (const s of sizes) {
    if (n > 0 && total + s > maxBytes) break;
    total += s;
    n++;
  }
  return n;
}

export async function pull(pool: pg.Pool, ctx: RequestCtx, p: PullParams): Promise<PullResult> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const values: unknown[] = [p.collection];
    const param = (v: unknown) => { values.push(v); return `$${values.length}`; };
    let where = `collection = $1 AND ${posClause('synced_at', p.docsPos, param)}`;
    if (!p.includeOwnDevice) where += ` AND ${echoClause(param, ctx.caller.username, ctx.device ?? '')}`;
    const lim = param(p.limit + 1);
    const budget = param(p.maxBytes);
    // The inner query takes at most limit+1 rows in feed order; the outer one
    // drops rows whose raw size (a lower bound of their JSON size) is already
    // past the budget, so big pages are never shipped from Postgres. ORDER BY
    // uses documents.synced_at explicitly: the bare name would bind to the
    // output column (whole seconds) and break (synced_at, id) pagination.
    const est = `octet_length(content) + octet_length(metadata::text)${p.embeddings ? ' + octet_length(embedding::text)' : ''}`;
    const docs = await c.query(
      `SELECT * FROM (
         SELECT s.*, sum(s.est_bytes) OVER w AS est_cum, row_number() OVER w AS rn, count(*) OVER () AS total
           FROM (
             SELECT id, collection, content, ${p.embeddings ? 'embedding::text AS embedding,' : ''} metadata, origin_user, last_editor,
                    related_ids, ${SECS('created_at')}, ${SECS('updated_at')}, ${SECS('synced_at')}, ${MICROS('synced_at', 'synced_us')},
                    documents.synced_at AS synced_ts, (${est})::bigint AS est_bytes
               FROM documents WHERE ${where} AND ${LOCAL_ONLY_SQL}
              ORDER BY documents.synced_at, documents.id LIMIT ${lim}
           ) s
         WINDOW w AS (ORDER BY s.synced_ts, s.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
       ) t
       WHERE rn = 1 OR est_cum <= ${budget}
       ORDER BY rn`,
      values,
    );

    const dvalues: unknown[] = [p.collection];
    const dparam = (v: unknown) => { dvalues.push(v); return `$${dvalues.length}`; };
    const dwhere = `collection = $1 AND ${posClause('deleted_at', p.delsPos, dparam)}`;
    const dels = await c.query(
      `SELECT id, deleted_by, ${SECS('deleted_at')}, ${MICROS('deleted_at', 'deleted_us')}
         FROM deletions WHERE ${dwhere} ORDER BY deletions.deleted_at, deletions.id LIMIT ${dparam(p.limit + 1)}`,
      dvalues,
    );

    const fetched = docs.rows.slice(0, p.limit);
    const outs = fetched.map(r => toDocumentOut(r, p.embeddings));
    const take = rowsWithinBudget(outs.map(o => Buffer.byteLength(JSON.stringify(o), 'utf8')), p.maxBytes);
    const docRows = fetched.slice(0, take);
    const totalCandidates = docs.rows.length ? Number(docs.rows[0].total) : 0;
    const delRows = dels.rows.slice(0, p.limit);
    const lastDoc = docRows[docRows.length - 1];
    const lastDel = delRows[delRows.length - 1];
    const cursor: PullCursor = {
      c: p.collection,
      d: lastDoc ? { t: lastDoc.synced_us, id: lastDoc.id } : p.docsPos,
      x: lastDel ? { t: lastDel.deleted_us, id: lastDel.id } : p.delsPos,
    };
    return {
      documents: outs.slice(0, take),
      deletions: delRows.map(r => ({ id: r.id, deleted_by: r.deleted_by, deleted_at: Number(r.deleted_at) })),
      next_cursor: encodeCursor(cursor),
      has_more: docRows.length < totalCandidates || dels.rows.length > p.limit,
    };
  });
}

function toDocumentOut(r: Record<string, any>, withEmbedding: boolean): DocumentOut {
  const out: DocumentOut = {
    id: r.id,
    collection: r.collection,
    content: r.content,
    metadata: r.metadata ?? {},
    origin_user: r.origin_user,
    last_editor: r.last_editor ?? null,
    related_ids: r.related_ids ?? [],
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    synced_at: Number(r.synced_at),
  };
  if (withEmbedding) out.embedding = JSON.parse(r.embedding);
  return out;
}

// ----------------------------------------------------------------- upsert

export type UpsertResult =
  | { id: string; status: 'inserted' | 'updated' | 'unchanged' | 'pending'; synced_at: number; stale?: boolean; similar: Array<{ id: string; similarity: number }> }
  | { id: string | undefined; status: 'error'; error: ItemError };

async function maxTaskNumber(c: pg.PoolClient, username: string): Promise<number> {
  const r = await c.query(
    `SELECT COALESCE(MAX(substring(id from length($1) + 2)::numeric), 0)::text AS n
       FROM documents
      WHERE left(id, length($1) + 1) = $1 || '-'
        AND substring(id from length($1) + 2) ~ '^[0-9]+$'
        AND ${LOCAL_ONLY_SQL}`,
    [username],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function similarIn(c: pg.PoolClient, collection: string, vec: string, threshold: number, limit: number, excludeId?: string) {
  const r = await c.query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS similarity
       FROM documents
      WHERE collection = $2 AND ${LOCAL_ONLY_SQL} ${excludeId !== undefined ? 'AND id <> $4' : ''}
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    excludeId !== undefined ? [vec, collection, limit, excludeId] : [vec, collection, limit],
  );
  return r.rows
    .map(row => ({ id: row.id as string, similarity: Number(row.similarity) }))
    .filter(s => s.similarity > threshold);
}

/**
 * Upsert one validated document in its own transaction. Item-level problems
 * come back as `status: "error"`; only infrastructure errors throw.
 */
export async function upsertOne(pool: pg.Pool, ctx: RequestCtx, doc: UpsertInput, similarityThreshold: number): Promise<UpsertResult> {
  const me = ctx.caller.username;
  const secret = detectSecretInDoc(doc.content, doc.metadata);
  if (secret) {
    return { id: doc.id, status: 'error', error: itemError('secret_detected', `content matches a secret pattern (${secret.pattern}); keep it in a private-* collection`, { pattern: secret.pattern }) };
  }
  const isTask = doc.metadata.type === 'task';
  const vec = toPgVector(doc.embedding);

  return withUserTx(pool, me, async c => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await c.query(
        `SELECT id, collection, origin_user, last_editor, metadata, ${SECS('created_at')}, ${SECS('updated_at')}
           FROM documents WHERE id = $1 FOR UPDATE`,
        [doc.id],
      );
      const existing = cur.rows[0];

      if (!existing) {
        // Insert: namespace check, then attribute to the caller.
        const prefix = taskIdPrefix(doc.id);
        let prefixIsOtherUser = false;
        if (prefix !== undefined && prefix !== me) {
          prefixIsOtherUser = (await c.query('SELECT 1 FROM users WHERE username = $1', [prefix])).rowCount! > 0;
        }
        if (violatesTaskNamespace(doc.id, isTask, me, prefixIsOtherUser)) {
          return { id: doc.id, status: 'error' as const, error: itemError('task_namespace', `task ids must be "${me}-<n>"`, { suggested_id: `${me}-${(await maxTaskNumber(c, me)) + 1}` }) };
        }
        const metadata = { ...doc.metadata, origin_device: ctx.device ?? undefined, origin_user: me };
        const ins = await c.query(
          `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at,
                                  last_editor, last_device, synced_at)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, to_timestamp($7), to_timestamp($8), $6, $9, clock_timestamp())
           ON CONFLICT (id) DO NOTHING
           RETURNING ${SECS('synced_at')}`,
          [doc.id, doc.collection, doc.content, vec, JSON.stringify(metadata), me, doc.created_at, doc.updated_at, ctx.device],
        );
        if (ins.rowCount === 0) continue; // lost an insert race; lock the winner's row and treat as update
        await audit(c, {
          ...auditBase(ctx), action: 'insert', doc_id: doc.id, collection: doc.collection, row_owner: me,
          change_class: 'own', prev_editor: null, content_sha256: sha256(doc.content), changed_keys: Object.keys(metadata).sort(),
        });
        const similar = await similarIn(c, doc.collection, vec, similarityThreshold, 5, doc.id);
        return { id: doc.id, status: 'inserted' as const, synced_at: Number(ins.rows[0].synced_at), similar };
      }

      // Existing row.
      if (isTask && Math.abs(Number(existing.created_at) - doc.created_at) > 1) {
        return {
          id: doc.id, status: 'error' as const,
          error: itemError('id_taken', 'this task id belongs to a different task', {
            remote_created_at: Number(existing.created_at),
            suggested_id: `${me}-${(await maxTaskNumber(c, me)) + 1}`,
          }),
        };
      }
      const owner: string = existing.origin_user;
      const metadata = { ...doc.metadata, origin_device: ctx.device ?? undefined, origin_user: owner };
      const metaJson = JSON.stringify(metadata);
      const same = await c.query(
        `SELECT (content = $2 AND metadata = $3::jsonb AND embedding = $4::vector AND collection = $5) AS same,
                ${SECS('synced_at')}
           FROM documents WHERE id = $1`,
        [doc.id, doc.content, metaJson, vec, doc.collection],
      );
      if (same.rows[0]?.same) {
        const similar = await similarIn(c, doc.collection, vec, similarityThreshold, 5, doc.id);
        return { id: doc.id, status: 'unchanged' as const, synced_at: Number(same.rows[0].synced_at), similar };
      }

      const upd = await c.query(
        `UPDATE documents
            SET collection = $2, content = $3, embedding = $4::vector, metadata = $5::jsonb,
                updated_at = to_timestamp($6), last_editor = $7, last_device = $8, synced_at = clock_timestamp()
          WHERE id = $1
          RETURNING ${SECS('synced_at')}`,
        [doc.id, doc.collection, doc.content, vec, metaJson, doc.updated_at, me, ctx.device],
      );
      const prevEditor: string = existing.last_editor ?? owner;
      const changeClass = owner === me ? 'own' : 'teammate';
      const prevMeta = existing.metadata ?? {};
      const base = {
        ...auditBase(ctx), doc_id: doc.id, collection: doc.collection, prev_collection: existing.collection,
        prev_editor: prevEditor, row_owner: owner, change_class: changeClass as 'own' | 'teammate',
        content_sha256: sha256(doc.content), changed_keys: changedKeys(prevMeta, metadata),
      };
      await audit(c, { ...base, action: classifyUpdate({ collection: existing.collection, metadata: prevMeta }, { collection: doc.collection, metadata }) });
      if (prevEditor !== me) {
        // Decision 4: last-writer-wins, but replacing someone else's version is recorded.
        await audit(c, { ...base, action: 'overwrote_teammate_edit' });
      }
      const similar = await similarIn(c, doc.collection, vec, similarityThreshold, 5, doc.id);
      const stale = Number(existing.updated_at) > doc.updated_at;
      return { id: doc.id, status: 'updated' as const, synced_at: Number(upd.rows[0].synced_at), ...(stale ? { stale: true } : {}), similar };
    }
    throw new Error('upsert retry limit reached');
  });
}

// ----------------------------------------------------------------- delete

export type DeleteResult =
  | { id: string; status: 'deleted' | 'not_found' }
  | { id: string; status: 'error'; error: ItemError };

export async function deleteMany(pool: pg.Pool, ctx: RequestCtx, ids: string[], action: 'delete' | 'retract'): Promise<{ results: DeleteResult[]; deleted: number }> {
  const me = ctx.caller.username;
  return withUserTx(pool, me, async c => {
    const rows = await c.query(
      `SELECT id, collection, origin_user, last_editor FROM documents WHERE id = ANY($1::text[]) AND ${LOCAL_ONLY_SQL} FOR UPDATE`,
      [ids],
    );
    const byId = new Map(rows.rows.map(r => [r.id as string, r]));
    const results: DeleteResult[] = [];
    let deleted = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) { results.push({ id, status: 'not_found' }); continue; }
      if (r.origin_user !== me) {
        results.push({ id, status: 'error', error: itemError('not_owner', 'only the owner can delete a shared row; keep a local tombstone instead') });
        continue;
      }
      const del = await c.query('DELETE FROM documents WHERE id = $1 AND origin_user = $2', [id, me]);
      if (del.rowCount === 0) { results.push({ id, status: 'not_found' }); continue; }
      await c.query(
        'INSERT INTO deletions (id, collection, deleted_by, deleted_at) VALUES ($1, $2, $3, clock_timestamp())',
        [id, r.collection, me],
      );
      await audit(c, {
        ...auditBase(ctx), action, doc_id: id, collection: r.collection, row_owner: me, change_class: 'own',
        prev_editor: r.last_editor ?? r.origin_user,
      });
      results.push({ id, status: 'deleted' });
      deleted++;
    }
    return { results, deleted };
  });
}

// ---------------------------------------------------------------- lookups

export async function listCollections(pool: pg.Pool, ctx: RequestCtx): Promise<Array<{ name: string; count: number }>> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(`SELECT collection, count(*)::int AS n FROM documents WHERE ${LOCAL_ONLY_SQL} GROUP BY collection ORDER BY collection`);
    return r.rows.map(row => ({ name: row.collection, count: row.n }));
  });
}

export async function myCollections(pool: pg.Pool, ctx: RequestCtx): Promise<string[]> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(`SELECT DISTINCT collection FROM documents WHERE origin_user = $1 AND ${LOCAL_ONLY_SQL} ORDER BY collection`, [ctx.caller.username]);
    return r.rows.map(row => row.collection);
  });
}

export async function collectionsByIds(pool: pg.Pool, ctx: RequestCtx, ids: string[]): Promise<Record<string, string>> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(`SELECT id, collection FROM documents WHERE id = ANY($1::text[]) AND ${LOCAL_ONLY_SQL}`, [ids]);
    return Object.fromEntries(r.rows.map(row => [row.id, row.collection]));
  });
}

export async function ownersByIds(pool: pg.Pool, ctx: RequestCtx, ids: string[]): Promise<{ owners: Record<string, string>; created_at: Record<string, number> }> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(`SELECT id, origin_user, ${SECS('created_at')} FROM documents WHERE id = ANY($1::text[]) AND ${LOCAL_ONLY_SQL}`, [ids]);
    return {
      owners: Object.fromEntries(r.rows.map(row => [row.id, row.origin_user])),
      created_at: Object.fromEntries(r.rows.map(row => [row.id, Number(row.created_at)])),
    };
  });
}

export async function createdAt(pool: pg.Pool, ctx: RequestCtx, id: string): Promise<number | undefined> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(`SELECT ${SECS('created_at')} FROM documents WHERE id = $1 AND ${LOCAL_ONLY_SQL}`, [id]);
    return r.rows[0] ? Number(r.rows[0].created_at) : undefined;
  });
}

export async function myMaxTaskNumber(pool: pg.Pool, ctx: RequestCtx): Promise<number> {
  return withUserTx(pool, ctx.caller.username, c => maxTaskNumber(c, ctx.caller.username));
}

export async function similar(pool: pg.Pool, ctx: RequestCtx, collection: string, embedding: number[], threshold: number, limit: number) {
  return withUserTx(pool, ctx.caller.username, c => similarIn(c, collection, toPgVector(embedding), threshold, limit));
}

export async function addRelatedIds(pool: pg.Pool, ctx: RequestCtx, id: string, add: string[]): Promise<string[]> {
  const me = ctx.caller.username;
  return withUserTx(pool, me, async c => {
    const r = await c.query('SELECT collection, origin_user, last_editor, related_ids FROM documents WHERE id = $1 FOR UPDATE', [id]);
    const row = r.rows[0];
    if (!row || isLocalOnlyCollection(row.collection)) throw new ApiError('not_found', 'document not found');
    const current: string[] = row.related_ids ?? [];
    const merged = [...current];
    for (const x of add) if (x !== id && !merged.includes(x)) merged.push(x);
    if (merged.length === current.length) return current;
    if (merged.length > MAX_RELATED_IDS) {
      throw new ApiError('payload_too_large', `a document can have at most ${MAX_RELATED_IDS} related ids`);
    }
    // A link is not an edit: last_editor/last_device stay with the content's writer.
    await c.query('UPDATE documents SET related_ids = $2::text[], synced_at = clock_timestamp() WHERE id = $1', [id, merged]);
    await audit(c, {
      ...auditBase(ctx), action: 'link', doc_id: id, collection: row.collection, row_owner: row.origin_user,
      change_class: row.origin_user === me ? 'own' : 'teammate', prev_editor: row.last_editor ?? row.origin_user,
    });
    return merged;
  });
}

// ------------------------------------------------------------ idempotency

export interface StoredResponse {
  request_sha256: string;
  status: number;
  body: unknown;
}

/**
 * `target` is the method plus the CONCRETE path (e.g. `PUT /v1/documents/acme-1`),
 * so one key reused on a different document id cannot replay another response.
 */
export function idempotencyStorageKey(username: string, target: string, key: string): string {
  return sha256(`${username}\n${target}\n${key}`);
}

export async function getIdempotent(pool: pg.Pool, ctx: RequestCtx, storageKey: string): Promise<StoredResponse | undefined> {
  return withUserTx(pool, ctx.caller.username, async c => {
    const r = await c.query(
      `SELECT response FROM idempotency_keys
        WHERE key = $1 AND username = $2 AND created_at > now() - interval '24 hours'`,
      [storageKey, ctx.caller.username],
    );
    return r.rows[0]?.response as StoredResponse | undefined;
  });
}

let lastSweep = 0;

export async function putIdempotent(pool: pg.Pool, ctx: RequestCtx, storageKey: string, resp: StoredResponse): Promise<void> {
  await withUserTx(pool, ctx.caller.username, async c => {
    if (Date.now() - lastSweep > 60_000) {
      lastSweep = Date.now();
      await c.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'");
    }
    // An expired row with the same key may survive the sweep window: replace it.
    await c.query("DELETE FROM idempotency_keys WHERE key = $1 AND created_at <= now() - interval '24 hours'", [storageKey]);
    await c.query(
      'INSERT INTO idempotency_keys (key, username, response) VALUES ($1, $2, $3::jsonb) ON CONFLICT (key) DO NOTHING',
      [storageKey, ctx.caller.username, JSON.stringify(resp)],
    );
  });
}

export function requestHash(target: string, body: string): string {
  return sha256(`${target}\n${body}`);
}

// ------------------------------------------------------------------ users

export async function findUserByEmail(pool: pg.Pool, email: string) {
  const r = await pool.query('SELECT username, email, active FROM users WHERE lower(email) = lower($1)', [email]);
  return r.rows[0] as { username: string; email: string; active: boolean } | undefined;
}

export async function dbHealthy(pool: pg.Pool): Promise<boolean> {
  await pool.query('SELECT 1 FROM schema_version LIMIT 1');
  return true;
}
