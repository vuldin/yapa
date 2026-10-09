/**
 * HTTP API v1 (docs/service-design.md section 5). Deny by default: the auth
 * middleware runs on every path except GET /healthz, including unknown paths
 * (they answer 401 without a token, 404 with one).
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import { APP_TOKEN_HEADER, authenticate, type Caller, type TokenVerifier, type UserLookup } from './auth.js';
import { PULL_MAX_BYTES_DEFAULT, type RateLimitClass, type RateLimits, type ServiceConfig } from './config.js';
import { decodeCursor, posFromSince } from './cursor.js';
import { isUnavailableError } from './db.js';
import { ApiError, statusFor, type ErrorCode } from './errors.js';
import { log } from './log.js';
import { DailyCounter, TokenBuckets } from './ratelimit.js';
import {
  assertCollection, assertDocId, assertEmbedding, assertIdList, checkDevice, checkUpsertItem, clamp,
  MAX_DELETE_IDS, MAX_LOOKUP_IDS, MAX_RELATED_IDS, MAX_UPSERT_BYTES, MAX_UPSERT_DOCS, PULL_LIMIT_DEFAULT, PULL_LIMIT_MAX,
  EMBEDDING_DIMS, MAX_CONTENT_BYTES, MAX_FUTURE_SECONDS, MAX_METADATA_BYTES,
} from './rules.js';
import * as store from './store.js';
import type { RequestCtx, UpsertResult } from './store.js';

type RateClass = 'read' | 'write' | 'similar';

type Env = {
  Variables: {
    requestId: string;
    caller: Caller;
    device: string | null;
    route: string;
  };
};

export interface AppDeps {
  pool: pg.Pool;
  config: Pick<ServiceConfig, 'similarityThreshold' | 'rateLimits' | 'dailyWriteAlert'> & Partial<Pick<ServiceConfig, 'pullMaxBytes'>>;
  verifier: TokenVerifier;
  /** Defaults to the users table. */
  lookupUser?: UserLookup;
  /** Injectable clock for rate-limit tests. */
  now?: () => number;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;
const IDEM_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function errorBody(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>) {
  return { error: { code, message, request_id: requestId, details: details ?? {} } };
}

export function createApp(deps: AppDeps): Hono<Env> {
  const { pool, config } = deps;
  const lookupUser: UserLookup = deps.lookupUser ?? (email => store.findUserByEmail(pool, email));
  const buckets = new TokenBuckets(deps.now);
  const daily = new DailyCounter(deps.now);
  const limits: RateLimits | false = config.rateLimits;
  const pullMaxBytes = config.pullMaxBytes ?? PULL_MAX_BYTES_DEFAULT;
  const nowMs = () => deps.now?.() ?? Date.now();
  const sweep = setInterval(() => buckets.sweep(), 5 * 60_000);
  sweep.unref();

  const app = new Hono<Env>();

  // Request id + access log (never bodies, queries or tokens).
  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    c.set('requestId', requestId);
    c.set('route', 'unmatched');
    const started = performance.now();
    await next();
    c.header('X-Request-Id', requestId);
    const status = c.res.status;
    log(status >= 500 ? 'ERROR' : status >= 400 ? 'WARNING' : 'INFO', 'request', {
      httpRequest: {
        requestMethod: c.req.method,
        requestUrl: new URL(c.req.url).pathname,
        status,
        latency: `${((performance.now() - started) / 1000).toFixed(4)}s`,
      },
      route: c.get('route'),
      actor: c.get('caller')?.username,
      request_id: requestId,
    });
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? randomUUID();
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json(errorBody(err.code, err.message, requestId, err.details), err.status as 400);
    }
    if (isUnavailableError(err)) {
      log('ERROR', 'database unavailable', { request_id: requestId, code: (err as { code?: string }).code });
      return c.json(errorBody('unavailable', 'service temporarily unavailable; retry later', requestId), 503);
    }
    // Message and code only: pg error `detail` can echo row values.
    log('ERROR', 'unhandled error', { request_id: requestId, error: err.message, code: (err as { code?: string }).code });
    return c.json(errorBody('internal', 'internal error', requestId), 500);
  });

  app.notFound(c => c.json(errorBody('not_found', 'no such route', c.get('requestId')), 404));

  // Unauthenticated liveness probe: no DB, no auth.
  // /health too: Cloud Run's front end reserves some paths ending in `z`, so
  // /healthz only answers the platform's own probes, not external callers.
  for (const path of ['/healthz', '/health']) {
    app.get(path, c => {
      c.set('route', `GET ${path}`);
      return c.json({ ok: true });
    });
  }

  // Deny by default: everything below /healthz needs a verified, active user.
  app.use('*', async (c, next) => {
    if ((c.req.path === '/healthz' || c.req.path === '/health') && c.req.method === 'GET') return next();
    const caller = await authenticate(c.req.header('authorization'), deps.verifier, lookupUser, c.get('requestId'), c.req.header(APP_TOKEN_HEADER));
    c.set('caller', caller);
    const rawDevice = c.req.header('x-yapa-device');
    const device = checkDevice(rawDevice);
    if (rawDevice && !device) throw new ApiError('invalid_request', 'X-Yapa-Device must match ^[A-Za-z0-9._:-]{1,128}$');
    c.set('device', device ?? null);
    return next();
  });

  app.use('*', bodyLimit({
    maxSize: MAX_UPSERT_BYTES,
    onError: () => { throw new ApiError('payload_too_large', `request body exceeds ${MAX_UPSERT_BYTES} bytes`); },
  }));

  // ------------------------------------------------------------- helpers

  const ctxOf = (c: Context<Env>): RequestCtx => ({ caller: c.get('caller'), device: c.get('device'), requestId: c.get('requestId') });

  const take = (c: Context<Env>, cls: RateLimitClass, key: string, cost = 1) => {
    const wait = buckets.take(`${c.get('caller').username}:${key}`, cls, cost);
    if (wait > 0) throw new ApiError('rate_limited', 'rate limit exceeded', { retry_after: wait }, { 'Retry-After': String(wait) });
  };

  const limit = (c: Context<Env>, cls: RateClass) => {
    if (limits) take(c, limits[cls], cls);
  };

  const requireDevice = (c: Context<Env>): string => {
    const d = c.get('device');
    if (!d) throw new ApiError('invalid_request', 'X-Yapa-Device header is required');
    return d;
  };

  async function jsonBody(c: Context<Env>): Promise<{ raw: string; body: Record<string, unknown> }> {
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ApiError('invalid_request', 'body must be JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('invalid_request', 'body must be a JSON object');
    return { raw, body: body as Record<string, unknown> };
  }

  const countWrites = (c: Context<Env>, n: number) => {
    if (n <= 0) return;
    const user = c.get('caller').username;
    if (daily.add(user, n, config.dailyWriteAlert)) {
      log('WARNING', 'daily write cap exceeded', { event: 'daily_write_cap', actor: user, limit: config.dailyWriteAlert });
    }
  };

  /** Replays a stored response for a repeated Idempotency-Key; otherwise runs `fn` and stores its result. */
  async function idempotent(c: Context<Env>, raw: string, fn: () => Promise<{ status: number; body: unknown }>) {
    const key = c.req.header('idempotency-key');
    if (key === undefined) {
      const r = await fn();
      return c.json(r.body as object, r.status as 200);
    }
    if (!IDEM_KEY_RE.test(key)) throw new ApiError('invalid_request', 'Idempotency-Key must match ^[A-Za-z0-9._:-]{1,200}$');
    const ctx = ctxOf(c);
    // Method + concrete path (not the route template): the same key on
    // PUT /v1/documents/a and PUT /v1/documents/b must not replay.
    const target = `${c.req.method} ${c.req.path}`;
    const storageKey = store.idempotencyStorageKey(ctx.caller.username, target, key);
    const hash = store.requestHash(target, raw);
    const prior = await store.getIdempotent(pool, ctx, storageKey);
    if (prior) {
      if (prior.request_sha256 !== hash) throw new ApiError('invalid_request', 'Idempotency-Key was already used with a different request body');
      c.header('Idempotent-Replay', 'true');
      return c.json(prior.body as object, prior.status as 200);
    }
    const r = await fn();
    if (r.status < 500) await store.putIdempotent(pool, ctx, storageKey, { request_sha256: hash, status: r.status, body: r.body });
    return c.json(r.body as object, r.status as 200);
  }

  function route(method: 'get' | 'post' | 'put', path: string, handler: (c: Context<Env>) => Promise<Response> | Response) {
    app[method](path, async c => {
      c.set('route', `${method.toUpperCase()} ${path}`);
      return handler(c);
    });
  }

  // ------------------------------------------------------------- routes

  route('get', '/v1/health', async c => {
    limit(c, 'read');
    await store.dbHealthy(pool);
    return c.json({ ok: true });
  });

  route('get', '/v1/me', c => {
    limit(c, 'read');
    const caller = c.get('caller');
    return c.json({
      username: caller.username,
      email: caller.email,
      device: c.get('device'),
      limits: {
        embedding_dims: EMBEDDING_DIMS,
        max_upsert_docs: MAX_UPSERT_DOCS,
        max_upsert_bytes: MAX_UPSERT_BYTES,
        max_content_bytes: MAX_CONTENT_BYTES,
        max_metadata_bytes: MAX_METADATA_BYTES,
        max_delete_ids: MAX_DELETE_IDS,
        max_lookup_ids: MAX_LOOKUP_IDS,
        max_related_ids: MAX_RELATED_IDS,
        pull_limit_max: PULL_LIMIT_MAX,
        pull_max_bytes: pullMaxBytes,
        similarity_threshold: config.similarityThreshold,
      },
    });
  });

  route('get', '/v1/me/collections', async c => {
    limit(c, 'read');
    return c.json({ collections: await store.myCollections(pool, ctxOf(c)) });
  });

  route('get', '/v1/me/max-task-number', async c => {
    limit(c, 'read');
    return c.json({ max: await store.myMaxTaskNumber(pool, ctxOf(c)) });
  });

  route('get', '/v1/collections', async c => {
    limit(c, 'read');
    return c.json({ collections: await store.listCollections(pool, ctxOf(c)) });
  });

  route('get', '/v1/collections/:c/documents', async c => {
    limit(c, 'read');
    const collection = assertCollection(c.req.param('c'));
    requireDevice(c);
    const q = c.req.query();
    const bool = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : v === 'true' || v === '1');
    const lim = q.limit === undefined ? PULL_LIMIT_DEFAULT : Number(q.limit);
    if (!Number.isInteger(lim) || lim < 1) throw new ApiError('invalid_request', 'limit must be a positive integer');
    let docsPos, delsPos;
    if (q.cursor) {
      const cur = decodeCursor(q.cursor, collection, nowMs());
      docsPos = cur.d;
      delsPos = cur.x;
    } else {
      const since = q.since === undefined || q.since === '' ? 0 : Number(q.since);
      // Bounded so the microsecond position always fits a bigint (a huge value was a 500).
      if (!Number.isFinite(since) || since < 0 || since > nowMs() / 1000 + MAX_FUTURE_SECONDS) {
        throw new ApiError('invalid_request', `since must be Unix seconds between 0 and now + ${MAX_FUTURE_SECONDS}`);
      }
      docsPos = delsPos = posFromSince(since);
    }
    const result = await store.pull(pool, ctxOf(c), {
      collection,
      docsPos,
      delsPos,
      limit: Math.min(lim, PULL_LIMIT_MAX),
      includeOwnDevice: bool(q.include_own_device, false),
      embeddings: bool(q.embeddings, true),
      maxBytes: pullMaxBytes,
    });
    return c.json(result);
  });

  const upsertItems = async (c: Context<Env>, items: unknown[]): Promise<UpsertResult[]> => {
    const ctx = ctxOf(c);
    const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const results: UpsertResult[] = [];
    for (const raw of items) {
      const chk = checkUpsertItem(raw, now);
      if (!chk.ok) {
        results.push({ id: chk.id, status: 'error', error: { code: chk.code, message: chk.message } });
        continue;
      }
      results.push(await store.upsertOne(pool, ctx, chk.doc, config.similarityThreshold));
    }
    countWrites(c, results.filter(r => r.status === 'inserted' || r.status === 'updated').length);
    return results;
  };

  route('post', '/v1/documents:batchUpsert', async c => {
    limit(c, 'write');
    requireDevice(c);
    const { raw, body } = await jsonBody(c);
    const docs = body.documents;
    if (!Array.isArray(docs)) throw new ApiError('invalid_request', 'documents must be an array');
    if (docs.length > MAX_UPSERT_DOCS) throw new ApiError('payload_too_large', `at most ${MAX_UPSERT_DOCS} documents per request`);
    return idempotent(c, raw, async () => {
      if (limits) take(c, limits.writeDocs, 'docs', docs.length);
      return { status: 200, body: { results: await upsertItems(c, docs) } };
    });
  });

  route('put', '/v1/documents/:id', async c => {
    limit(c, 'write');
    requireDevice(c);
    const id = assertDocId(c.req.param('id'));
    const { raw, body } = await jsonBody(c);
    if (body.id !== undefined && body.id !== id) throw new ApiError('invalid_request', 'body id does not match the path');
    return idempotent(c, raw, async () => {
      if (limits) take(c, limits.writeDocs, 'docs', 1);
      const [r] = await upsertItems(c, [{ ...body, id }]);
      if (r.status === 'error') {
        const { code, message, ...details } = r.error;
        return { status: statusFor(code), body: errorBody(code, message, c.get('requestId'), details) };
      }
      return { status: 200, body: r };
    });
  });

  route('post', '/v1/documents:batchDelete', async c => {
    limit(c, 'write');
    const { raw, body } = await jsonBody(c);
    const ids = assertIdList(body.ids, MAX_DELETE_IDS);
    const reason = body.reason ?? 'delete';
    if (reason !== 'delete' && reason !== 'retract') throw new ApiError('invalid_request', 'reason must be "delete" or "retract"');
    return idempotent(c, raw, async () => {
      if (limits) take(c, limits.writeDocs, 'docs', ids.length);
      const out = await store.deleteMany(pool, ctxOf(c), ids, reason);
      countWrites(c, out.deleted);
      return { status: 200, body: out };
    });
  });

  route('post', '/v1/documents:collections', async c => {
    limit(c, 'read');
    const { body } = await jsonBody(c);
    const ids = assertIdList(body.ids, MAX_LOOKUP_IDS);
    return c.json({ collections: await store.collectionsByIds(pool, ctxOf(c), ids) });
  });

  route('post', '/v1/documents:owners', async c => {
    limit(c, 'read');
    const { body } = await jsonBody(c);
    const ids = assertIdList(body.ids, MAX_LOOKUP_IDS);
    return c.json(await store.ownersByIds(pool, ctxOf(c), ids));
  });

  route('get', '/v1/documents/:id/created-at', async c => {
    limit(c, 'read');
    const id = assertDocId(c.req.param('id'));
    const t = await store.createdAt(pool, ctxOf(c), id);
    if (t === undefined) throw new ApiError('not_found', 'document not found');
    return c.json({ created_at: t });
  });

  route('post', '/v1/documents/:id/related-ids', async c => {
    limit(c, 'write');
    const id = assertDocId(c.req.param('id'));
    const { body } = await jsonBody(c);
    const add = assertIdList(body.add, MAX_RELATED_IDS, 'add');
    return c.json({ related_ids: await store.addRelatedIds(pool, ctxOf(c), id, add) });
  });

  // `/v1/collections/{c}:similar`: the colon is inside one path segment.
  route('post', '/v1/collections/:spec', async c => {
    const m = /^(.+):similar$/.exec(c.req.param('spec') ?? '');
    if (!m) throw new ApiError('not_found', 'no such route');
    if (limits) take(c, limits.similar, 'similar');
    const collection = assertCollection(m[1]);
    const { body } = await jsonBody(c);
    const embedding = assertEmbedding(body.embedding);
    const threshold = clamp(typeof body.threshold === 'number' && Number.isFinite(body.threshold) ? body.threshold : config.similarityThreshold, 0.5, 1);
    const lim = clamp(typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.floor(body.limit) : 5, 1, 20);
    return c.json({ matches: await store.similar(pool, ctxOf(c), collection, embedding, threshold, lim) });
  });

  return app;
}
