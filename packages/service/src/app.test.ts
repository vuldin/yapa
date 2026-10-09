/**
 * App-level tests that need no database: deny-by-default over every
 * registered route, /healthz, cursor handling and rate limiting.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createApp } from './app.js';
import { InsecureTestVerifier } from './auth.js';
import { DEFAULT_RATE_LIMITS } from './config.js';
import { decodeCursor, encodeCursor, posFromSince } from './cursor.js';
import { setLogSink } from './log.js';
import { DailyCounter, TokenBuckets } from './ratelimit.js';

// Any DB use in these tests is a bug: auth must reject before handlers run.
const noPool = new Proxy({}, { get: () => { throw new Error('database must not be touched'); } }) as pg.Pool;

let restore: () => void;
beforeEach(() => { restore = setLogSink(() => undefined); });
afterEach(() => restore());

function app(lookupUser = async () => undefined as never) {
  return createApp({
    pool: noPool,
    config: { similarityThreshold: 0.95, rateLimits: DEFAULT_RATE_LIMITS, dailyWriteAlert: 20000 },
    verifier: new InsecureTestVerifier(),
    lookupUser,
  });
}

function concrete(path: string): string {
  return path.replace(':c', 'customer-acme').replace(':id', 'acme-1').replace(':spec', 'customer-acme:similar');
}

describe('deny by default', () => {
  const a = app();
  const routes = a.routes.filter(r => r.method !== 'ALL');

  it('registers every API v1 route', () => {
    const paths = new Set(routes.map(r => `${r.method} ${r.path}`));
    for (const p of [
      'GET /healthz', 'GET /v1/health', 'GET /v1/me', 'GET /v1/me/collections', 'GET /v1/me/max-task-number',
      'GET /v1/collections', 'GET /v1/collections/:c/documents', 'POST /v1/documents:batchUpsert', 'PUT /v1/documents/:id',
      'POST /v1/documents:batchDelete', 'POST /v1/documents:collections', 'POST /v1/documents:owners',
      'GET /v1/documents/:id/created-at', 'POST /v1/documents/:id/related-ids', 'POST /v1/collections/:spec',
    ]) expect(paths).toContain(p);
  });

  for (const r of app().routes.filter(x => x.method !== 'ALL' && x.path !== '/healthz')) {
    it(`${r.method} ${r.path} rejects missing and invalid tokens`, async () => {
      const init = { method: r.method, headers: { 'content-type': 'application/json' }, body: r.method === 'GET' ? undefined : '{}' };
      const none = await a.request(concrete(r.path), init);
      expect(none.status).toBe(401);
      expect((await none.json()).error.code).toBe('unauthenticated');
      const bad = await a.request(concrete(r.path), { ...init, headers: { ...init.headers, authorization: 'Bearer forged' } });
      expect(bad.status).toBe(401);
    });
  }

  it('unknown paths are 401 without a token', async () => {
    expect((await a.request('/v1/nope')).status).toBe(401);
    expect((await a.request('/admin', { method: 'POST' })).status).toBe(401);
  });

  it('/healthz is open and needs no database', async () => {
    const r = await a.request('/healthz');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get('x-request-id')).toBeTruthy();
  });

  it('unmapped users get 403 not_member', async () => {
    const r = await a.request('/v1/me', { headers: { authorization: 'Bearer test:x@example.com' } });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe('not_member');
    expect(body.error.request_id).toBe(r.headers.get('x-request-id'));
  });
});

describe('authenticated, no-DB routes', () => {
  const user = async () => ({ username: 'alice', email: 'alice@example.com', active: true });
  const auth = { authorization: 'Bearer test:alice@example.com', 'x-yapa-device': 'dev-1' };

  it('/v1/me', async () => {
    const r = await app(user).request('/v1/me', { headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ username: 'alice', email: 'alice@example.com', device: 'dev-1', limits: { embedding_dims: 384 } });
  });

  it('local-only collections are rejected before any DB access', async () => {
    const a = app(user);
    for (const c of ['global', 'private-x', 'local-y']) {
      const r = await a.request(`/v1/collections/${c}/documents`, { headers: auth });
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe('local_only_collection');
      const s = await a.request(`/v1/collections/${c}:similar`, { method: 'POST', headers: auth, body: '{}' });
      expect(s.status).toBe(403);
    }
  });

  it('rejects a bad device header and oversize bodies', async () => {
    const a = app(user);
    expect((await a.request('/v1/me', { headers: { ...auth, 'x-yapa-device': 'bad device!' } })).status).toBe(400);
    const big = 'x'.repeat(2 * 1024 * 1024 + 10);
    const r = await a.request('/v1/documents:batchUpsert', { method: 'POST', headers: { ...auth, 'content-length': String(big.length) }, body: big });
    expect(r.status).toBe(413);
  });

  it('rate limits reads with 429 and Retry-After', async () => {
    const a = app(user);
    let last: Response | undefined;
    for (let i = 0; i < DEFAULT_RATE_LIMITS.read.burst + 1; i++) last = await a.request('/v1/me', { headers: auth });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await last!.json()).error.code).toBe('rate_limited');
  });
});

describe('TokenBuckets', () => {
  it('allows the burst, then refills at the sustained rate', () => {
    let t = 0;
    const b = new TokenBuckets(() => t);
    const cls = { ratePerSec: 2, burst: 3 };
    expect([b.take('u', cls), b.take('u', cls), b.take('u', cls)]).toEqual([0, 0, 0]);
    expect(b.take('u', cls)).toBe(1);
    t = 500; // +1 token
    expect(b.take('u', cls)).toBe(0);
    expect(b.take('other', cls)).toBe(0); // per key
  });
  it('charges batch cost and caps it at the burst', () => {
    const b = new TokenBuckets(() => 0);
    const cls = { ratePerSec: 10, burst: 100 };
    expect(b.take('u', cls, 60)).toBe(0);
    expect(b.take('u', cls, 60)).toBe(2);
    expect(new TokenBuckets(() => 0).take('u', cls, 500)).toBe(0);
  });
  it('DailyCounter alerts once per day', () => {
    let t = Date.UTC(2026, 0, 1);
    const d = new DailyCounter(() => t);
    expect(d.add('u', 10, 15)).toBe(false);
    expect(d.add('u', 10, 15)).toBe(true);
    expect(d.add('u', 10, 15)).toBe(false);
    t += 86_400_000;
    expect(d.add('u', 20, 15)).toBe(true);
  });
});

describe('cursor', () => {
  it('round-trips and is bound to its collection', () => {
    const cur = { c: 'customer-acme', d: { t: '1760000000123456', id: 'a' }, x: posFromSince(5) };
    expect(decodeCursor(encodeCursor(cur), 'customer-acme')).toEqual(cur);
    expect(() => decodeCursor(encodeCursor(cur), 'project-x')).toThrow(/different collection/);
    expect(() => decodeCursor('!!', 'customer-acme')).toThrow(/malformed/);
    expect(() => decodeCursor(Buffer.from('{"c":"customer-acme","d":{"t":"1; DROP","id":null},"x":{"t":"0","id":null}}').toString('base64url'), 'customer-acme')).toThrow(/malformed/);
    expect(posFromSince(2)).toEqual({ t: '2000000', id: null });
  });
});
