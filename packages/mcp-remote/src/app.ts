/**
 * yapa-mcp HTTP app: MCP over Streamable HTTP, stateless (a fresh McpServer
 * and transport per request, JSON responses, no sessions). Deny by default:
 * the auth middleware runs on every path except GET /health(z) and the
 * RFC 9728 protected-resource metadata, including unknown paths (401 without
 * credentials, 404 with them). Patterns follow packages/service/src/app.ts.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import { ApiError, isUnavailableError, log, TokenBuckets, type ErrorCode } from '@yapa/service/lib';
import type { Caller, McpAuthenticator } from './auth.js';
import type { McpConfig, McpRateLimits } from './config.js';
import type { QueryEmbedder } from './embedder.js';
import { registerReadTools, registerWriteTools } from './tools.js';

export const MAX_BODY_BYTES = 256 * 1024;
export const METADATA_PATH = '/.well-known/oauth-protected-resource';

type Env = {
  Variables: {
    requestId: string;
    caller: Caller;
    route: string;
  };
};

export interface McpAppDeps {
  pool: pg.Pool;
  config: Pick<McpConfig, 'publicUrl' | 'rateLimits' | 'writesEnabled'> & Partial<Pick<McpConfig, 'tools'>>;
  authenticator: McpAuthenticator;
  embedder: QueryEmbedder;
  /** Injectable clock for rate-limit tests. */
  now?: () => number;
  version?: string;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

const INSTRUCTIONS = [
  'YAPA is the team\'s shared memory of customer and project work: meeting notes, decisions, cluster and config facts, contacts and follow-ups.',
  'Read-only. Call memory_recall with the user\'s question in plain words before answering anything about a customer or account;',
  'it detects the customer named in the question, so collections are optional.',
  'Every result names its customer/project, author ("by <user>") and date: use them when drafting status updates, and say when nothing relevant was found.',
].join(' ');

function errorBody(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>) {
  return { error: { code, message, request_id: requestId, details: details ?? {} } };
}

/** Base URL for metadata and WWW-Authenticate: YAPA_MCP_PUBLIC_URL, else the request origin. */
function baseUrl(c: Context, configured: string | undefined): string {
  if (configured) return configured;
  const u = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return `${proto === 'https' || proto === 'http' ? proto : u.protocol.replace(':', '')}://${u.host}`;
}

export function createApp(deps: McpAppDeps): Hono<Env> {
  const { pool, config } = deps;
  const buckets = new TokenBuckets(deps.now);
  const limits: McpRateLimits | false = config.rateLimits;
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
      kind: c.get('caller')?.kind,
      request_id: requestId,
    });
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? randomUUID();
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      if (err.status === 401) {
        // RFC 9728 section 5.1: point OAuth clients at the resource metadata.
        const presented = !!(c.req.header('authorization') || c.req.header(deps.authenticator.keyHeader));
        c.header('WWW-Authenticate', `Bearer resource_metadata="${baseUrl(c, config.publicUrl)}${METADATA_PATH}"${presented ? ', error="invalid_token"' : ''}`);
      }
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

  // ------------------------------------------------------- open routes

  // Readiness: 503 until the embedding model is loaded (startup probe).
  // /health is the external route; Cloud Run reserves /healthz for its own probes.
  for (const path of ['/healthz', '/health']) {
    app.get(path, c => {
      c.set('route', `GET ${path}`);
      return deps.embedder.ready() ? c.json({ ok: true }) : c.json({ ok: false, reason: 'warming_up' }, 503);
    });
  }

  // RFC 9728 protected-resource metadata (also at the path-suffixed form for /mcp).
  const OPEN = new Set(['/healthz', '/health', METADATA_PATH, `${METADATA_PATH}/mcp`]);
  for (const path of [METADATA_PATH, `${METADATA_PATH}/mcp`]) {
    app.get(path, c => {
      c.set('route', `GET ${path}`);
      const base = baseUrl(c, config.publicUrl);
      c.header('Cache-Control', 'public, max-age=3600');
      return c.json({
        resource: `${base}/mcp`,
        authorization_servers: ['https://accounts.google.com'],
        scopes_supported: ['openid', 'email'],
        bearer_methods_supported: ['header'],
      });
    });
  }

  // Deny by default: everything else needs a verified caller.
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' && OPEN.has(c.req.path)) return next();
    const caller = await deps.authenticator.authenticate(
      { authorization: c.req.header('authorization'), key: c.req.header(deps.authenticator.keyHeader) },
      c.get('requestId'),
    );
    c.set('caller', caller);
    return next();
  });

  app.use('*', bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => { throw new ApiError('payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`); },
  }));

  // ------------------------------------------------------------ /mcp

  const take = (c: Context<Env>, cls: keyof McpRateLimits): number => {
    if (!limits) return 0;
    return buckets.take(`${c.get('caller').username}:${cls}`, limits[cls]);
  };

  app.post('/mcp', async c => {
    c.set('route', 'POST /mcp');
    const wait = take(c, 'read');
    if (wait > 0) throw new ApiError('rate_limited', 'rate limit exceeded', { retry_after: wait }, { 'Retry-After': String(wait) });

    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400);
    }

    const server = new McpServer({ name: 'yapa-remote', version: deps.version ?? '0.0.0' }, { instructions: INSTRUCTIONS });
    const ctx = {
      pool,
      caller: c.get('caller'),
      requestId: c.get('requestId'),
      embedder: deps.embedder,
      takeEmbed: () => take(c, 'embed'),
    };
    registerReadTools(server, ctx, config.tools);
    registerWriteTools(server, ctx, config.writesEnabled);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, { parsedBody: body });
    } finally {
      // JSON mode: the response body is complete once handleRequest resolves.
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  });

  // No SSE stream and no sessions: GET/DELETE (and anything else) on /mcp is 405.
  app.all('/mcp', c => {
    c.set('route', `${c.req.method} /mcp`);
    c.header('Allow', 'POST');
    return c.json(errorBody('invalid_request', 'only POST is supported on /mcp (stateless Streamable HTTP)', c.get('requestId')), 405);
  });

  return app;
}
