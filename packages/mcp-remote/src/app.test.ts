/**
 * App-level tests that need no database: deny by default, the MCP handshake
 * and tool list for both caller kinds, protected-resource metadata, 401
 * headers, body and rate limits, and tool errors that never reach SQL.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { setLogSink, type UserRow } from '@yapa/service/lib';
import { createApp, MAX_BODY_BYTES } from './app.js';
import { McpAuthenticator } from './auth.js';
import { DEFAULT_MCP_RATE_LIMITS, parseTools, type McpRateLimits } from './config.js';
import type { QueryEmbedder } from './embedder.js';
import { READ_TOOLS } from './tools.js';

// Any DB use in these tests is a bug.
const noPool = new Proxy({}, { get: () => { throw new Error('database must not be touched'); } }) as pg.Pool;

const KEY = `yapa_sk_adp-1_${randomBytes(32).toString('base64url')}`;
const KEYS = new Map([['adp-1', { principal: 'svc-adp', sha256: createHash('sha256').update(KEY).digest('hex') }]]);
const USERS: Record<string, UserRow> = { 'alice@example.com': { username: 'alice', email: 'alice@example.com', active: true } };

let ready = true;
const embedder: QueryEmbedder = { embed: async () => { throw new Error('not in these tests'); }, ready: () => ready };

function app(opts: { publicUrl?: string; rateLimits?: McpRateLimits | false; now?: () => number; tools?: ReadonlySet<string> } = {}) {
  return createApp({
    pool: noPool,
    config: { publicUrl: opts.publicUrl, rateLimits: opts.rateLimits ?? DEFAULT_MCP_RATE_LIMITS, writesEnabled: true, tools: opts.tools },
    authenticator: new McpAuthenticator({
      config: { authMode: 'insecure-test', staticKeys: KEYS, keyHeader: 'x-yapa-key' },
      lookupUser: async email => USERS[email],
    }),
    embedder,
    now: opts.now,
    version: '1.0.2-test',
  });
}

const USER = { authorization: 'Bearer test:alice@example.com' };
const SERVICE = { 'x-yapa-key': KEY };

async function rpc(a: ReturnType<typeof app>, headers: Record<string, string>, method: string, params: unknown = {}, id = 1) {
  const r = await a.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : undefined };
}

let lines: string[] = [];
let restore: () => void;
beforeEach(() => { lines = []; ready = true; restore = setLogSink(l => lines.push(l)); });
afterEach(() => restore());

describe('deny by default', () => {
  it('401 with WWW-Authenticate pointing at the resource metadata', async () => {
    const r = await app({ publicUrl: 'https://mcp.example' }).request('/mcp', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"');
    expect((await r.json()).error.code).toBe('unauthenticated');
  });

  it('adds error="invalid_token" when a bad credential was presented, and uses the request origin without YAPA_MCP_PUBLIC_URL', async () => {
    const r = await app().request('https://mcp.internal/mcp', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://mcp.internal/.well-known/oauth-protected-resource", error="invalid_token"');
  });

  it('unknown paths: 401 without credentials, 404 with', async () => {
    expect((await app().request('/v1/collections')).status).toBe(401);
    expect((await app().request('/v1/collections', { headers: USER })).status).toBe(404);
  });

  it('GET and DELETE /mcp are 405 (stateless, no SSE)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await app().request('/mcp', { method, headers: SERVICE });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
    }
  });
});

describe('open routes', () => {
  it('/health reports ready only after the model is loaded', async () => {
    ready = false;
    expect((await app().request('/health')).status).toBe(503);
    ready = true;
    const r = await app().request('/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('serves RFC 9728 metadata at both paths without auth', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await app({ publicUrl: 'https://mcp.example' }).request(path);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        resource: 'https://mcp.example/mcp',
        authorization_servers: ['https://accounts.google.com'],
        scopes_supported: ['openid', 'email'],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('metadata falls back to the request origin, honoring X-Forwarded-Proto', async () => {
    const r = await app().request('http://mcp.internal/.well-known/oauth-protected-resource', { headers: { 'x-forwarded-proto': 'https' } });
    expect((await r.json()).resource).toBe('https://mcp.internal/mcp');
  });
});

describe('MCP over stateless Streamable HTTP', () => {
  it('initializes without a session id', async () => {
    const r = await rpc(app(), USER, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toBeNull();
    expect(r.body.result.serverInfo).toEqual({ name: 'yapa-remote', version: '1.0.2-test' });
    expect(r.body.result.instructions).toMatch(/Read-only/);
  });

  for (const [kind, headers] of [['user', USER], ['service', SERVICE]] as const) {
    it(`tools/list shows only the read tools, all readOnlyHint, for a ${kind} caller (even with YAPA_MCP_WRITES=true)`, async () => {
      const r = await rpc(app(), headers, 'tools/list');
      expect(r.status).toBe(200);
      const tools = r.body.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>;
      expect(tools.map(t => t.name).sort()).toEqual([...READ_TOOLS].sort());
      for (const t of tools) {
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.destructiveHint).toBe(false);
      }
    });
  }

  it('YAPA_MCP_TOOLS limits the listed and callable tools (default: memory_recall only)', async () => {
    const a = app({ tools: parseTools(undefined) });
    const r = await rpc(a, USER, 'tools/list');
    expect((r.body.result.tools as Array<{ name: string }>).map(t => t.name)).toEqual(['memory_recall']);
    const hidden = await rpc(a, USER, 'tools/call', { name: 'collection_list', arguments: {} });
    expect(JSON.stringify(hidden.body)).toMatch(/not found|unknown tool/i);
    expect([...parseTools('all')].sort()).toEqual([...READ_TOOLS].sort());
    expect([...parseTools('memory_recall, task_search')]).toEqual(['memory_recall', 'task_search']);
    expect(() => parseTools('memory_store')).toThrow(/unknown tool/);
  });

  it('rejects local-only collections as a tool error without touching the database, and logs no arguments', async () => {
    const r = await rpc(app(), USER, 'tools/call', { name: 'memory_list', arguments: { collection: 'private-secret-notes' } });
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.content[0].text).toMatch(/local_only_collection/);
    const call = lines.map(l => JSON.parse(l)).find(l => l.event === 'mcp_call');
    expect(call).toMatchObject({ actor: 'alice', kind: 'user', tool: 'memory_list', outcome: 'error', error_code: 'local_only_collection', result_count: 0 });
    expect(typeof call.latency_ms).toBe('number');
    expect(call.request_id).toBeTruthy();
    expect(lines.join('\n')).not.toContain('private-secret-notes');
  });

  it('answers a malformed body with a JSON-RPC parse error', async () => {
    const r = await app().request('/mcp', { method: 'POST', headers: { ...USER, 'content-type': 'application/json' }, body: '{nope' });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe(-32700);
  });

  it(`caps the request body at ${MAX_BODY_BYTES} bytes`, async () => {
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(MAX_BODY_BYTES) } });
    const r = await app().request('/mcp', { method: 'POST', headers: { ...USER, 'content-type': 'application/json' }, body: big });
    expect(r.status).toBe(413);
  });

  it('rate-limits per username with Retry-After', async () => {
    const t = 1_000_000;
    const a = app({ rateLimits: { read: { ratePerSec: 1, burst: 2 }, embed: { ratePerSec: 1, burst: 1 } }, now: () => t });
    expect((await rpc(a, SERVICE, 'tools/list')).status).toBe(200);
    expect((await rpc(a, SERVICE, 'tools/list')).status).toBe(200);
    const r = await rpc(a, SERVICE, 'tools/list');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('1');
    expect((await rpc(a, USER, 'tools/list')).status).toBe(200); // separate bucket per username
  });
});
