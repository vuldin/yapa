/**
 * Coordination endpoints (leases, counters, task ids) against a real
 * Postgres with the production schema, grants and RLS (see pgsetup.ts).
 * Skipped unless YAPA_SERVICE_IT_DATABASE_URL is set; see integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { InsecureTestVerifier } from '../src/auth.js';
import { setLogSink } from '../src/log.js';
import { createItDb, type ItDb } from './pgsetup.js';

const URL_ = process.env.YAPA_SERVICE_IT_DATABASE_URL;
const NOW = Math.floor(Date.now() / 1000);
const C = 'project-acme';

function unitVector(seed: number): number[] {
  const v = Array.from({ length: 384 }, (_, i) => Math.sin(seed * (i + 1)) + 0.01 * seed);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

describe.skipIf(!URL_)('coordination (real Postgres)', () => {
  let db: ItDb;
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let restoreLog: () => void;

  const call = async (user: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer test:${user}@example.com`, 'x-yapa-device': `${user}-laptop`, ...headers };
    const r = await app.request(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const acquire = (user: string, session: string, key: string, scope: string[] = [], extra: Record<string, unknown> = {}) =>
    call(user, 'POST', '/v1/leases:acquire', { collection: C, key, session, scope, ...extra });
  const expire = (key: string) =>
    db.adminPool.query("UPDATE leases SET expires_at = now() - interval '1 second' WHERE collection = $1 AND key = $2", [C, key]);

  beforeAll(async () => {
    restoreLog = setLogSink(() => undefined);
    db = await createItDb(URL_!);
    await db.adminPool.query(`INSERT INTO users (username, email) VALUES ('alice', 'alice@example.com'), ('bob', 'bob@example.com')`);
    pool = new pg.Pool({ connectionString: db.runtimeUrl, max: 8, statement_timeout: 5000 });
    app = createApp({
      pool,
      config: { similarityThreshold: 0.95, rateLimits: false, dailyWriteAlert: 20000 },
      verifier: new InsecureTestVerifier(),
    });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    restoreLog?.();
  });

  describe('leases', () => {
    it('grants a free key and reports it in the listing with holder and expiry', async () => {
      const r = await acquire('alice', 's1', 'alice-1', ['doc:runbook', 'res:staging'], { ttl_seconds: 600, title: 'first item' });
      expect(r.status).toBe(200);
      expect(r.body.granted).toBe(true);
      expect(r.body.renewed).toBe(false);
      expect(r.body.lease.scope).toEqual(['doc:runbook', 'key:alice-1', 'res:staging']);
      expect(r.body.lease.holder).toEqual({ user: 'alice', session: 's1', device: 'alice-laptop' });
      expect(r.body.lease.expires_at - r.body.lease.heartbeat_at).toBe(600);
      const l = await call('bob', 'GET', `/v1/leases?collection=${C}`);
      expect(l.body.leases.map((x: any) => [x.key, x.holder.user, x.title])).toContainEqual(['alice-1', 'alice', 'first item']);
    });

    it('refuses the same key to another user and to the same user in another session', async () => {
      const bob = await acquire('bob', 'b1', 'alice-1');
      expect(bob.body.granted).toBe(false);
      expect(bob.body.conflicts[0].lease.holder.user).toBe('alice');
      expect(bob.body.conflicts[0].overlap).toEqual(['key:alice-1']);
      const otherSession = await acquire('alice', 's2', 'alice-1');
      expect(otherSession.body.granted).toBe(false);
    });

    it('refuses a different key whose scope overlaps a live lease', async () => {
      const r = await acquire('bob', 'b1', 'bob-7', ['res:staging']);
      expect(r.body.granted).toBe(false);
      expect(r.body.conflicts.map((x: any) => [x.lease.key, x.overlap])).toEqual([['alice-1', ['res:staging']]]);
      expect((await acquire('bob', 'b1', 'bob-7', ['res:other'])).body.granted).toBe(true);
    });

    it('re-acquire by the holder renews and replaces the scope, keeping acquired_at', async () => {
      const before = (await call('alice', 'GET', `/v1/leases?collection=${C}`)).body.leases.find((x: any) => x.key === 'alice-1');
      const r = await acquire('alice', 's1', 'alice-1', ['doc:runbook']);
      expect(r.body.granted).toBe(true);
      expect(r.body.renewed).toBe(true);
      expect(r.body.lease.acquired_at).toBe(before.acquired_at);
      expect(r.body.lease.scope).toEqual(['doc:runbook', 'key:alice-1']);
      // res:staging is free now
      expect((await acquire('bob', 'b2', 'bob-8', ['res:staging'])).body.granted).toBe(true);
    });

    it('an expired lease can be taken over, and the takeover is recorded', async () => {
      await expire('bob-8');
      const r = await acquire('alice', 's1', 'bob-8', ['res:staging']);
      expect(r.body.granted).toBe(true);
      expect(r.body.took_over_from).toMatchObject({ user: 'bob', session: 'b2' });
      expect(r.body.lease.took_over_from).toMatchObject({ user: 'bob', session: 'b2' });
      const log = await db.adminPool.query("SELECT action, actor FROM lease_log WHERE key = 'bob-8' ORDER BY seq");
      expect(log.rows.map(x => x.action)).toEqual(['acquire', 'takeover']);
      // the old holder's heartbeat no longer renews it
      const hb = await call('bob', 'POST', '/v1/leases:heartbeat', { collection: C, session: 'b2', keys: ['bob-8'] });
      expect(hb.body).toMatchObject({ renewed: [], lost: ['bob-8'] });
    });

    it('expired leases are hidden from the default listing and do not block', async () => {
      await expire('bob-7');
      const l = await call('alice', 'GET', `/v1/leases?collection=${C}`);
      expect(l.body.leases.map((x: any) => x.key)).not.toContain('bob-7');
      const all = await call('alice', 'GET', `/v1/leases?collection=${C}&include_expired=true`);
      expect(all.body.leases.find((x: any) => x.key === 'bob-7').expired).toBe(true);
      expect((await acquire('alice', 's3', 'x-1', ['res:other'])).body.granted).toBe(true);
    });

    it('heartbeat renews every lease of the session (an expired untaken one too)', async () => {
      await expire('alice-1');
      const hb = await call('alice', 'POST', '/v1/leases:heartbeat', { collection: C, session: 's1' });
      expect(hb.body.renewed.map((x: any) => x.key).sort()).toEqual(['alice-1', 'bob-8']);
      expect(hb.body.renewed.every((x: any) => x.expired === false)).toBe(true);
    });

    it('heartbeat without a collection renews the session in every collection, and only its own leases', async () => {
      await call('alice', 'POST', '/v1/leases:acquire', { collection: 'project-other', key: 'o-1', session: 's1' });
      await call('alice', 'POST', '/v1/leases:acquire', { collection: 'project-other', key: 'o-2', session: 's9' });
      await db.adminPool.query("UPDATE leases SET expires_at = now() + interval '5 seconds' WHERE holder_session IN ('s1', 's9')");
      const hb = await call('alice', 'POST', '/v1/leases:heartbeat', { session: 's1' });
      expect(hb.body.renewed.map((x: any) => `${x.collection}/${x.key}`).sort()).toEqual(['project-acme/alice-1', 'project-acme/bob-8', 'project-other/o-1']);
      const other = await db.adminPool.query("SELECT expires_at > now() + interval '1 minute' AS long FROM leases WHERE key = 'o-2'");
      expect(other.rows[0].long).toBe(false);
      expect((await call('bob', 'POST', '/v1/leases:heartbeat', { session: 's1' })).body.renewed).toEqual([]);
      expect((await call('alice', 'POST', '/v1/leases:heartbeat', { session: 's1', keys: ['o-1'] })).status).toBe(400);
    });

    it('only the holder session releases; release frees the key', async () => {
      expect((await call('bob', 'POST', '/v1/leases:release', { collection: C, key: 'alice-1', session: 'b1' })).body)
        .toMatchObject({ released: false, reason: 'held_by_other' });
      expect((await call('alice', 'POST', '/v1/leases:release', { collection: C, key: 'alice-1', session: 's2' })).body)
        .toMatchObject({ released: false, reason: 'held_by_other' });
      const r = await call('alice', 'POST', '/v1/leases:release', { collection: C, key: 'alice-1', session: 's1', outcome: 'done' });
      expect(r.body.released).toBe(true);
      expect((await call('alice', 'POST', '/v1/leases:release', { collection: C, key: 'alice-1', session: 's1' })).body)
        .toMatchObject({ released: false, reason: 'not_held' });
      expect((await acquire('bob', 'b1', 'alice-1')).body.granted).toBe(true);
    });

    it('exactly one of many concurrent overlapping acquires wins', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        acquire(i % 2 ? 'alice' : 'bob', `race-${i}`, `race-key-${i}`, ['res:race'])));
      expect(results.every(r => r.status === 200)).toBe(true);
      expect(results.filter(r => r.body.granted).length).toBe(1);
    });

    it('validates input and refuses local-only collections', async () => {
      expect((await call('alice', 'POST', '/v1/leases:acquire', { collection: 'global', key: 'k', session: 's' })).body.error.code).toBe('local_only_collection');
      expect((await call('alice', 'POST', '/v1/leases:acquire', { collection: C, key: 'bad key', session: 's' })).status).toBe(400);
      expect((await call('alice', 'POST', '/v1/leases:acquire', { collection: C, key: 'k', session: 's', ttl_seconds: 5 })).status).toBe(400);
      expect((await call('alice', 'POST', '/v1/leases:acquire', { collection: C, key: 'k' })).status).toBe(400);
      for (const reclaim of ['true', 1, null, {}]) {
        const r = await call('alice', 'POST', '/v1/leases:acquire', { collection: C, key: 'k', session: 's', reclaim });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe('invalid_request');
      }
    });
  });

  describe('renewal keeps stored scope and ttl when omitted', () => {
    // Raw bodies: the acquire() helper always sends a scope.
    const raw = (user: string, session: string, key: string, extra: Record<string, unknown> = {}) =>
      call(user, 'POST', '/v1/leases:acquire', { collection: C, key, session, ...extra });

    it('a fresh acquire without scope or ttl gets just key:<key> and the default ttl', async () => {
      const r = await raw('alice', 'rn-1', 'rn-fresh');
      expect(r.body.granted).toBe(true);
      expect(r.body.lease.scope).toEqual(['key:rn-fresh']);
      expect(r.body.lease.ttl_seconds).toBe(7200);
    });

    it('a renewal without scope keeps the stored scope, and without ttl keeps the stored ttl', async () => {
      expect((await raw('alice', 'rn-1', 'rn-a', { scope: ['res:rn-a'], ttl_seconds: 600 })).body.granted).toBe(true);
      const r = await raw('alice', 'rn-1', 'rn-a');
      expect(r.body).toMatchObject({ granted: true, renewed: true });
      expect(r.body.lease.scope).toEqual(['key:rn-a', 'res:rn-a']);
      expect(r.body.lease.ttl_seconds).toBe(600);
      expect(r.body.lease.expires_at - r.body.lease.heartbeat_at).toBe(600);
      // the kept scope still blocks others
      expect((await acquire('bob', 'rn-b', 'rn-bob', ['res:rn-a'])).body.granted).toBe(false);
      // omitted ttl with a new scope: ttl kept, scope replaced
      const s2 = await raw('alice', 'rn-1', 'rn-a', { scope: ['res:rn-a2'] });
      expect(s2.body.lease.scope).toEqual(['key:rn-a', 'res:rn-a2']);
      expect(s2.body.lease.ttl_seconds).toBe(600);
    });

    it('an explicit scope (even []) and ttl replace the stored ones on a renewal', async () => {
      const r = await raw('alice', 'rn-1', 'rn-a', { scope: [], ttl_seconds: 900 });
      expect(r.body).toMatchObject({ granted: true, renewed: true });
      expect(r.body.lease.scope).toEqual(['key:rn-a']);
      expect(r.body.lease.ttl_seconds).toBe(900);
      expect((await acquire('bob', 'rn-b', 'rn-bob', ['res:rn-a2'])).body.granted).toBe(true);
      expect((await raw('alice', 'rn-1', 'rn-a')).body.lease.ttl_seconds).toBe(900);
    });

    it('re-acquiring your own expired lease without scope keeps its scope and ttl', async () => {
      expect((await raw('alice', 'rn-1', 'rn-c', { scope: ['res:rn-c'], ttl_seconds: 300 })).body.granted).toBe(true);
      await expire('rn-c');
      const r = await raw('alice', 'rn-1', 'rn-c');
      expect(r.body).toMatchObject({ granted: true, renewed: true });
      expect(r.body.lease.scope).toEqual(['key:rn-c', 'res:rn-c']);
      expect(r.body.lease.ttl_seconds).toBe(300);
      expect(r.body.lease.expired).toBe(false);
    });

    it('the conflict check of a renewal without scope uses the stored scope', async () => {
      expect((await raw('alice', 'rn-1', 'rn-d', { scope: ['res:rn-d'], ttl_seconds: 300 })).body.granted).toBe(true);
      await expire('rn-d');
      expect((await acquire('bob', 'rn-b', 'rn-bob-d', ['res:rn-d'])).body.granted).toBe(true);
      const r = await raw('alice', 'rn-1', 'rn-d');
      expect(r.body.granted).toBe(false);
      expect(r.body.conflicts.map((x: any) => [x.lease.key, x.overlap])).toEqual([['rn-bob-d', ['res:rn-d']]]);
      // with an explicit scope that no longer overlaps, the renewal goes through
      expect((await raw('alice', 'rn-1', 'rn-d', { scope: [] })).body).toMatchObject({ granted: true, renewed: true });
    });

    it('a takeover of an expired lease without scope or ttl does not inherit them', async () => {
      expect((await raw('bob', 'rn-b', 'rn-e', { scope: ['res:rn-e'], ttl_seconds: 300 })).body.granted).toBe(true);
      await expire('rn-e');
      const r = await raw('alice', 'rn-1', 'rn-e');
      expect(r.body).toMatchObject({ granted: true, renewed: false, took_over_from: { user: 'bob', session: 'rn-b' } });
      expect(r.body.took_over_from.reclaim).toBeUndefined();
      expect(r.body.lease.scope).toEqual(['key:rn-e']);
      expect(r.body.lease.ttl_seconds).toBe(7200);
    });
  });

  describe('reclaim', () => {
    it('takes over a live lease held by your own other session and records it', async () => {
      const old = await acquire('alice', 'rc-old', 'rc-1', ['res:rc-1'], { ttl_seconds: 600 });
      expect(old.body.granted).toBe(true);
      // without reclaim your other session still conflicts
      const plain = await acquire('alice', 'rc-new', 'rc-1');
      expect(plain.body.granted).toBe(false);
      expect(plain.body.conflicts[0].lease.holder.session).toBe('rc-old');

      const r = await call('alice', 'POST', '/v1/leases:acquire', { collection: C, key: 'rc-1', session: 'rc-new', reclaim: true });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ granted: true, renewed: false });
      const from = { user: 'alice', session: 'rc-old', device: 'alice-laptop', expired_at: old.body.lease.expires_at, acquired_at: old.body.lease.acquired_at, reclaim: true };
      expect(r.body.took_over_from).toEqual(from);
      expect(r.body.lease.took_over_from).toEqual(from);
      expect(r.body.lease.holder.session).toBe('rc-new');
      expect(r.body.lease.scope).toEqual(['key:rc-1']);

      const log = await db.adminPool.query("SELECT action, detail FROM lease_log WHERE key = 'rc-1' ORDER BY seq");
      expect(log.rows.map(x => x.action)).toEqual(['acquire', 'refused', 'takeover']);
      expect(log.rows[2].detail).toMatchObject({ reclaim: true, took_over_from: { session: 'rc-old', reclaim: true } });
      // the old session lost it
      const hb = await call('alice', 'POST', '/v1/leases:heartbeat', { collection: C, session: 'rc-old', keys: ['rc-1'] });
      expect(hb.body).toMatchObject({ renewed: [], lost: ['rc-1'] });
    });

    it('is refused when another user holds the key, listing only that user', async () => {
      expect((await acquire('bob', 'rc-bob', 'rc-2')).body.granted).toBe(true);
      const r = await call('alice', 'POST', '/v1/leases:acquire', { collection: C, key: 'rc-2', session: 'rc-new', reclaim: true });
      expect(r.body.granted).toBe(false);
      expect(r.body.conflicts.map((x: any) => x.lease.holder.user)).toEqual(['bob']);
    });

    it('with own and other-user overlaps: refused listing only the other user; without that overlap granted, own lease left in place', async () => {
      expect((await acquire('alice', 'rc-old', 'rc-3', ['res:rc-x'])).body.granted).toBe(true);
      expect((await acquire('bob', 'rc-bob', 'rc-4', ['res:rc-y'])).body.granted).toBe(true);
      const both = await acquire('alice', 'rc-new', 'rc-5', ['res:rc-x', 'res:rc-y'], { reclaim: true });
      expect(both.body.granted).toBe(false);
      expect(both.body.conflicts.map((x: any) => [x.lease.key, x.lease.holder.user, x.overlap])).toEqual([['rc-4', 'bob', ['res:rc-y']]]);

      const own = await acquire('alice', 'rc-new', 'rc-5', ['res:rc-x'], { reclaim: true });
      expect(own.body).toMatchObject({ granted: true, renewed: false });
      expect(own.body.took_over_from).toBeUndefined();
      const l = (await call('alice', 'GET', `/v1/leases?collection=${C}`)).body.leases;
      expect(l.find((x: any) => x.key === 'rc-3')).toMatchObject({ holder: { session: 'rc-old' }, scope: ['key:rc-3', 'res:rc-x'] });
      expect(l.find((x: any) => x.key === 'rc-5')).toMatchObject({ holder: { session: 'rc-new' } });
    });
  });

  describe('counters', () => {
    it('hands out strictly increasing values, never below the floor', async () => {
      const next = (floor?: number) => call('alice', 'POST', '/v1/counters:next', { collection: C, name: 'RFC', floor });
      expect((await next(148)).body.value).toBe(149);
      expect((await next()).body.value).toBe(150);
      expect((await next(10)).body.value).toBe(151);
      expect((await next(200)).body.value).toBe(201);
    });

    it('concurrent callers never get the same value', async () => {
      const vals = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        call(i % 2 ? 'alice' : 'bob', 'POST', '/v1/counters:next', { collection: C, name: 'INCIDENT' }).then(r => r.body.value)));
      expect(new Set(vals).size).toBe(20);
      expect(Math.max(...vals)).toBe(20);
    });

    it('an Idempotency-Key replays the same value on retry', async () => {
      const h = { 'idempotency-key': 'next-note-1' };
      const a = await call('alice', 'POST', '/v1/counters:next', { collection: C, name: 'NOTE' }, h);
      const b = await call('alice', 'POST', '/v1/counters:next', { collection: C, name: 'NOTE' }, h);
      expect(a.body.value).toBe(b.body.value);
      expect((await call('alice', 'POST', '/v1/counters:next', { collection: C, name: 'NOTE' })).body.value).toBe(a.body.value + 1);
    });
  });

  describe('task ids', () => {
    it('start above the highest <user>-N already on the server and above the client floor', async () => {
      await call('alice', 'POST', '/v1/documents:batchUpsert', {
        documents: [{ id: 'alice-41', collection: C, content: 't', embedding: unitVector(3), metadata: { type: 'task' }, created_at: NOW - 10, updated_at: NOW - 10 }],
      });
      expect((await call('alice', 'POST', '/v1/me/task-ids:next', {})).body).toEqual({ id: 'alice-42', number: 42 });
      expect((await call('alice', 'POST', '/v1/me/task-ids:next', { floor: 50 })).body.id).toBe('alice-51');
      expect((await call('alice', 'POST', '/v1/me/task-ids:next', { floor: 3 })).body.id).toBe('alice-52');
      expect((await call('bob', 'POST', '/v1/me/task-ids:next', {})).body.id).toBe('bob-1');
    });

    it("one user's concurrent sessions never mint the same id", async () => {
      const ids = await Promise.all(Array.from({ length: 10 }, () => call('bob', 'POST', '/v1/me/task-ids:next', {}).then(r => r.body.id)));
      expect(new Set(ids).size).toBe(10);
    });
  });
});
