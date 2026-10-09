/**
 * Opt-in suite against the DEPLOYED service (Cloud Run IAM + app auth + RLS on
 * the production database). Skipped unless all of these are set:
 *
 *   YAPA_LIVE_URL         service URL
 *   YAPA_LIVE_TOKEN       caller's Google ID token (gcloud auth print-identity-token)
 *   YAPA_LIVE_ADMIN_URL   admin connection (via the IAP tunnel) used only to
 *                         plant a second owner's row and to clean up
 *   YAPA_LIVE_ADMIN_CA    server CA (PEM) for the admin connection
 *
 * Everything lives in a per-run collection and is removed afterwards.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const URL_ = process.env.YAPA_LIVE_URL;
const TOKEN = process.env.YAPA_LIVE_TOKEN;
const ADMIN = process.env.YAPA_LIVE_ADMIN_URL;
const ADMIN_CA = process.env.YAPA_LIVE_ADMIN_CA;
const enabled = Boolean(URL_ && TOKEN && ADMIN && ADMIN_CA);

const RUN = `live${Date.now().toString(36)}`;
const COL = `project-yapa-it-${RUN}`;
const OTHER = `itother-${RUN}`;
const NOW = Math.floor(Date.now() / 1000);

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * (i + 1)) + 0.01 * seed);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

const doc = (id: string, extra: Record<string, unknown> = {}) => ({
  id, collection: COL, content: `live content of ${id}`, embedding: unitVector(id.length + id.charCodeAt(3)),
  metadata: { type: 'memory' }, created_at: NOW - 100, updated_at: NOW - 50, ...extra,
});

async function call(method: string, path: string, body?: unknown, opts: { token?: string | null; device?: string } = {}) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-yapa-device': opts.device ?? `dev-${RUN}` };
  if (token) {
    headers.authorization = `Bearer ${token}`; // Cloud Run IAM
    headers['x-yapa-id-token'] = token; // verified by the app
  }
  const res = await fetch(`${URL_}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

describe.skipIf(!enabled)('deployed service (live)', { timeout: 60_000 }, () => {
  let admin: pg.Client;
  let me: string;

  beforeAll(async () => {
    const u = new URL(ADMIN!);
    u.searchParams.delete('sslmode');
    admin = new pg.Client({
      connectionString: u.toString(),
      ssl: { ca: readFileSync(ADMIN_CA!, 'utf-8'), rejectUnauthorized: true, checkServerIdentity: () => undefined },
    });
    await admin.connect();
    // A second owner who can never sign in (inactive), plus one row it owns.
    await admin.query('INSERT INTO users (username, email, active) VALUES ($1, $2, false)', [OTHER, `${OTHER}@unmapped.invalid`]);
    await admin.query(
      `INSERT INTO documents (id, collection, content, embedding, metadata, origin_user, created_at, updated_at)
       VALUES ($1, $2, 'owned by someone else', $3::vector, '{"type":"memory"}', $4, to_timestamp($5), to_timestamp($5))`,
      [`theirs-${RUN}`, COL, `[${unitVector(7).join(',')}]`, OTHER, NOW - 200],
    );
    me = (await call('GET', '/v1/me')).body.username;
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.query('DELETE FROM documents WHERE collection = $1', [COL]);
      await admin.query('DELETE FROM deletions WHERE collection = $1', [COL]).catch(() => {});
      await admin.query('DELETE FROM audit_log WHERE collection = $1', [COL]).catch(() => {});
      await admin.query('DELETE FROM idempotency_keys WHERE created_at > now() - interval \'1 hour\' AND key LIKE $1', [`%${RUN}%`]).catch(() => {});
      await admin.query('DELETE FROM users WHERE username = $1', [OTHER]);
    } finally {
      await admin.end();
    }
  });

  it('rejects requests without a valid app token', async () => {
    expect((await call('GET', '/v1/me', undefined, { token: null })).status).toBeGreaterThanOrEqual(401);
    // Cloud Run strips the Authorization signature; without the app header the app must refuse.
    const res = await fetch(`${URL_}/v1/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(401);
  });

  it('identifies the caller and reaches the database', async () => {
    expect(me).toMatch(/^[a-z0-9._-]+$/);
    expect((await call('GET', '/v1/health')).status).toBe(200);
  });

  it('insert, pull back from another device, update', async () => {
    const id = `${me}-live-${RUN}-a`;
    const ins = await call('POST', '/v1/documents:batchUpsert', { documents: [doc(id)] });
    expect(ins.status).toBe(200);
    expect(ins.body.results[0].status).toBe('inserted');
    const fromOther = await call('GET', `/v1/collections/${COL}/documents?since=0`, undefined, { device: `other-${RUN}` });
    expect(fromOther.body.documents.map((d: any) => d.id)).toContain(id);
    expect(fromOther.body.documents.find((d: any) => d.id === id).origin_user).toBe(me);
    const echo = await call('GET', `/v1/collections/${COL}/documents?since=0`);
    expect(echo.body.documents.map((d: any) => d.id)).not.toContain(id); // own device's echo
    const upd = await call('PUT', `/v1/documents/${id}`, doc(id, { content: 'edited', updated_at: NOW }));
    expect(upd.body.status ?? upd.body.results?.[0]?.status).toBe('updated');
  });

  it('cannot delete another owner\'s row; can update it with attribution', async () => {
    const del = await call('POST', '/v1/documents:batchDelete', { ids: [`theirs-${RUN}`] });
    expect(del.body.deleted).toBe(0);
    const row = (await admin.query('SELECT origin_user FROM documents WHERE id = $1', [`theirs-${RUN}`])).rows[0];
    expect(row.origin_user).toBe(OTHER);
    const upd = await call('PUT', `/v1/documents/theirs-${RUN}`, doc(`theirs-${RUN}`, { content: 'teammate edit', created_at: NOW - 200, updated_at: NOW, origin_user: me }));
    expect(upd.status).toBe(200);
    const after = (await admin.query('SELECT origin_user, last_editor FROM documents WHERE id = $1', [`theirs-${RUN}`])).rows[0];
    expect(after).toEqual({ origin_user: OTHER, last_editor: me });
  });

  it('rejects local-only collections, foreign task namespaces, secrets and bad embeddings', async () => {
    const local = await call('POST', '/v1/documents:batchUpsert', { documents: [{ ...doc(`g-${RUN}`), collection: 'global' }] });
    expect(local.body.results?.[0]?.error?.code ?? local.body.error?.code).toBe('local_only_collection');
    const squat = await call('POST', '/v1/documents:batchUpsert', { documents: [doc(`${OTHER}-9`, { metadata: { type: 'task' } })] });
    expect(squat.body.results[0].error.code).toBe('task_namespace');
    const secret = await call('POST', '/v1/documents:batchUpsert', { documents: [doc(`${me}-live-${RUN}-s`, { content: 'key AKIAABCDEFGHIJKLMNOP in a note' })] });
    expect(secret.body.results[0].error.code).toBe('secret_detected');
    const emb = await call('PUT', `/v1/documents/${me}-live-${RUN}-e`, doc(`${me}-live-${RUN}-e`, { embedding: [1, 0, 0] }));
    expect(emb.status).toBe(422);
  });

  it('owner delete reaches the deletions feed', async () => {
    const id = `${me}-live-${RUN}-d`;
    await call('POST', '/v1/documents:batchUpsert', { documents: [doc(id)] });
    const del = await call('POST', '/v1/documents:batchDelete', { ids: [id] });
    expect(del.body.deleted).toBe(1);
    const feed = await call('GET', `/v1/collections/${COL}/documents?since=0`, undefined, { device: `other-${RUN}` });
    expect((feed.body.deletions ?? []).map((d: any) => d.id)).toContain(id);
  });
});
