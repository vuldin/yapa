/**
 * Sync over MCP: the shared HttpBackend suites (http-backend.suites.ts) run
 * through a local MCP gateway whose `yapa_sync` tool forwards each call to the
 * suites' mock service as the person's own request, as a real remote does.
 * Then what only MCP has: gateway auth, tool discovery, sessions, tool errors.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { setConfig, createConfig, getConfig } from '../config.js';
import { HttpBackend, IdTokenProvider } from './http-backend.js';
import { McpTransport, mcpTokenProvider, pickSyncTool } from './mcp-transport.js';
import { setSyncBackend, getSyncBackend, isSyncConfigured, syncBackendKind, syncTransportKind, UnsupportedByRemoteError } from './backend.js';
import { syncTargetKey } from './shared-cycle.js';
import { readSyncHealth } from './health.js';
import { base, httpBackendSuites, jwt, seen, setHandler, tokens } from './http-backend.suites.js';

/** The tool's input contract: what the remote validates before running a request. */
const PATH = /^\/v1\/[A-Za-z0-9._~%:/-]*(\?[A-Za-z0-9._~%:=&+-]*)?$/;
const KEPT_HEADERS = ['x-request-id', 'retry-after', 'idempotent-replay'];

/** An MCP gateway and the remote's MCP server in one: Bearer auth, sessions, and a yapa_sync tool. */
class Gateway {
  toolName = 'yapa_sync';
  /** Tokens refused with an HTTP 401 before MCP sees the request. */
  refuse = new Set<string>();
  /** Answer a call itself instead of forwarding it. */
  intercept: ((args: Record<string, any>) => CallToolResult | undefined) | undefined;
  calls: Array<{ token: string; args: Record<string, any> }> = [];
  requests: Array<{ method: string; authorization?: string }> = [];
  sessions = new Map<string, StreamableHTTPServerTransport>();
  url = '';
  private http: HttpServer | undefined;

  constructor(private readonly service: () => string) {}

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>(resolve => this.http!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/mcp`;
  }

  async stop(): Promise<void> {
    this.forgetSessions();
    this.http?.closeAllConnections();
    await new Promise(resolve => this.http?.close(resolve));
  }

  forgetSessions(): void {
    for (const t of this.sessions.values()) t.close().catch(() => undefined);
    this.sessions.clear();
  }

  reset(): void {
    this.toolName = 'yapa_sync';
    this.refuse.clear();
    this.intercept = undefined;
    this.calls.length = 0;
    this.requests.length = 0;
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    this.requests.push({ method: req.method!, authorization: req.headers.authorization });
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!token || this.refuse.has(token)) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? this.sessions.get(sid) : undefined;
    if (!transport) {
      if (sid || !isInitializeRequest(body)) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
        return;
      }
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: id => { this.sessions.set(id, t); },
      });
      transport = t;
      await this.mcpServer().connect(t);
    }
    await transport.handleRequest(req, res, body);
  }

  private mcpServer(): Server {
    const server = new Server({ name: 'test-remote', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'recall', inputSchema: { type: 'object' as const } },
        { name: this.toolName, inputSchema: { type: 'object' as const } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      if (req.params.name !== this.toolName) return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
      const a = (req.params.arguments ?? {}) as Record<string, any>;
      const bodyOk = a.body === undefined || (typeof a.body === 'object' && a.body !== null && !Array.isArray(a.body));
      if (!['GET', 'POST', 'PUT'].includes(a.method) || typeof a.path !== 'string' || a.path.length > 4096 || !PATH.test(a.path) || !bodyOk) {
        return { content: [{ type: 'text', text: `MCP error -32602: Input validation error: ${JSON.stringify(a).slice(0, 200)}` }], isError: true };
      }
      const token = String(extra.requestInfo?.headers.authorization ?? '').replace(/^Bearer /, '');
      this.calls.push({ token, args: a });
      const own = this.intercept?.(a);
      if (own) return own;
      // The person's own request, as the remote runs it.
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-yapa-id-token': token, 'content-type': 'application/json' };
      if (a.device) headers['x-yapa-device'] = a.device;
      if (a.idempotency_key) headers['idempotency-key'] = a.idempotency_key;
      if (a.request_id) headers['x-request-id'] = a.request_id;
      const r = await fetch(`${this.service()}${a.path}`, { method: a.method, headers, body: a.method === 'GET' ? undefined : JSON.stringify(a.body ?? {}) });
      const text = await r.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = null; }
      const kept: Record<string, string> = {};
      for (const h of KEPT_HEADERS) {
        const v = r.headers.get(h);
        if (v !== null) kept[h] = v;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ status: r.status, body: json, headers: kept }) }], ...(r.status >= 400 ? { isError: true } : {}) };
    });
    return server;
  }
}

const gateway = new Gateway(() => base);
const opened: HttpBackend[] = [];

function mcpBackend(opts: { tokens: IdTokenProvider; timeoutMs?: number; device?: () => string; url?: string }): HttpBackend {
  const b = new HttpBackend({ transport: new McpTransport(opts.url ?? gateway.url), tokens: opts.tokens, timeoutMs: opts.timeoutMs ?? 2000, device: opts.device ?? (() => 'dev-A') });
  opened.push(b);
  return b;
}

httpBackendSuites({
  start: () => gateway.start(),
  stop: async () => {
    await Promise.all(opened.splice(0).map(b => b.close()));
    await gateway.stop();
  },
  backend: opts => mcpBackend(opts),
  signInHint: /Sign in to the MCP gateway again/,
  describeLines: () => [`Backend: YAPA sync over MCP (${new URL(gateway.url).host})`, `MCP server: ${gateway.url}`],
});

describe('sync over MCP', () => {
  beforeEach(() => gateway.reset());

  it('sends Bearer to the gateway and the HTTP request as tool arguments', async () => {
    const t = jwt(Math.floor(Date.now() / 1000) + 3600);
    setHandler(() => ({ json: { results: [{ id: 'a', status: 'inserted', synced_at: 1, similar: [] }] } }));
    await mcpBackend({ tokens: tokens([t]).provider }).upsertMany([{ id: 'a', collection: 'project-x', content: 'c', embedding: [1], metadata: {}, origin_user: 'tester', created_at: 1, updated_at: 1 }]);
    expect(gateway.requests.every(r => r.authorization === `Bearer ${t}`)).toBe(true);
    const [call] = gateway.calls;
    expect(call.args).toMatchObject({ method: 'POST', path: '/v1/documents:batchUpsert', device: 'dev-A' });
    expect(call.args.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.args.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.args.body.documents[0]).toMatchObject({ id: 'a', collection: 'project-x' });
  });

  it('GETs carry the query in the path and no body; characters outside the tool\'s path pattern are percent-encoded', async () => {
    setHandler(s => ({ json: { created_at: s.path === "/v1/documents/a(b)*!/created-at" ? 7 : 0, documents: [], has_more: false } }));
    const b = mcpBackend({ tokens: tokens().provider });
    expect(await b.createdAt("a(b)*!")).toBe(7);
    await b.pull('project-x', { since: 5 });
    expect(gateway.calls[1].args).not.toHaveProperty('body');
    expect(gateway.calls[1].args.path).toBe('/v1/collections/project-x/documents?since=5&limit=500&embeddings=false');
  });

  it('one connection per token: tools are listed once, a new token reconnects', async () => {
    setHandler(() => ({ json: { max: 1 } }));
    let now = 1_000_000_000_000;
    const tk = tokens([jwt(now / 1000 + 3600, 'a@example.com', 1), jwt(now / 1000 + 7200, 'a@example.com', 2)], () => now);
    const b = mcpBackend({ tokens: tk.provider });
    const sessions = gateway.sessions.size;
    await b.maxTaskNumber();
    await b.maxTaskNumber();
    expect(gateway.sessions.size).toBe(sessions + 1);
    now += 3600_000;
    await b.maxTaskNumber();
    expect(gateway.sessions.size).toBe(sessions + 2);
    expect(tk.calls()).toBe(2);
    expect(gateway.calls.map(c => c.token)).toEqual([...Array(2).fill(gateway.calls[0].token), gateway.calls[2].token]);
    expect(gateway.calls[2].token).not.toBe(gateway.calls[0].token);
  });

  it('a gateway 401 refreshes the token once, reconnects and retries; a second 401 explains how to sign in', async () => {
    const t1 = jwt(Math.floor(Date.now() / 1000) + 3600, 'a@example.com', 1);
    const t2 = jwt(Math.floor(Date.now() / 1000) + 3600, 'a@example.com', 2);
    gateway.refuse.add(t1);
    setHandler(() => ({ json: { collections: [{ name: 'project-x', count: 1 }] } }));
    const tk = tokens([t1, t2]);
    expect(await mcpBackend({ tokens: tk.provider }).collections()).toEqual([{ name: 'project-x', count: 1 }]);
    expect(tk.calls()).toBe(2);
    gateway.refuse.add(t2);
    const err = await mcpBackend({ tokens: tokens([t2]).provider }).collections().catch(e => e);
    expect(err.code).toBe('unauthenticated');
    expect(err.message).toMatch(/the MCP gateway rejected the sign-in \(401\)\. Sign in to the MCP gateway again/);
    expect(err.message).not.toContain(t2);
  });

  it('a tool result that says unauthenticated in plain text also refreshes and retries', async () => {
    let first = true;
    gateway.intercept = () => {
      if (!first) return undefined;
      first = false;
      return { content: [{ type: 'text', text: 'Unauthorized: token expired' }], isError: true };
    };
    setHandler(() => ({ json: { max: 4 } }));
    const tk = tokens();
    expect(await mcpBackend({ tokens: tk.provider }).maxTaskNumber()).toBe(4);
    expect(tk.calls()).toBe(2);
  });

  it('an isError 404 not_found on a soft-delete route is UnsupportedByRemoteError; a 429 keeps retry-after', async () => {
    setHandler(() => ({ status: 404, json: { error: { code: 'not_found', message: 'no such route' } } }));
    const b = mcpBackend({ tokens: tokens().provider });
    await expect(b.purge(['a'])).rejects.toBeInstanceOf(UnsupportedByRemoteError);
    setHandler(() => ({ status: 429, json: { error: { code: 'rate_limited', message: 'slow down' } }, headers: { 'retry-after': '7' } }));
    const err = await b.collections().catch(e => e);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, details: { retry_after: 7 } });
  });

  it('other tool errors that are not Sync API answers are reported, not retried', async () => {
    gateway.intercept = () => ({ content: [{ type: 'text', text: 'upstream MCP server unavailable' }], isError: true });
    const tk = tokens();
    const err = await mcpBackend({ tokens: tk.provider }).collections().catch(e => e);
    expect(err).toMatchObject({ code: 'mcp_tool_error', status: 502 });
    expect(err.message).toMatch(/upstream MCP server unavailable/);
    expect(tk.calls()).toBe(1);
  });

  it('finds a gateway-prefixed tool name, and says so when there is no sync tool', async () => {
    expect(pickSyncTool(['recall', 'yapa_sync', 'x__yapa_sync'])).toBe('yapa_sync');
    expect(pickSyncTool(['recall', 'remote-mcp__yapa_sync'])).toBe('remote-mcp__yapa_sync');
    expect(pickSyncTool(['notyapa_sync', 'yapa_sync_v2'])).toBeUndefined();
    gateway.toolName = 'remote-mcp_yapa_sync';
    setHandler(() => ({ json: { max: 2 } }));
    const b = mcpBackend({ tokens: tokens().provider });
    expect(await b.maxTaskNumber()).toBe(2);
    expect((await b.describe())).toContain('Tool: remote-mcp_yapa_sync');
    gateway.toolName = 'something_else';
    const err = await mcpBackend({ tokens: tokens().provider }).maxTaskNumber().catch(e => e);
    expect(err.code).toBe('no_sync_tool');
    expect(err.message).toMatch(/has no yapa_sync tool/);
  });

  it('an expired MCP session reconnects and carries the same call once', async () => {
    setHandler(() => ({ json: { max: 3 } }));
    const b = mcpBackend({ tokens: tokens().provider });
    await b.maxTaskNumber();
    gateway.forgetSessions();
    expect(await b.maxTaskNumber()).toBe(3);
    expect(gateway.calls).toHaveLength(2);
    expect(seen.filter(s => s.path === '/v1/me/max-task-number')).toHaveLength(2);
  });

  it('an unreachable gateway is a network error (unreachable), like the HTTP backend', async () => {
    const dead = createServer();
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/mcp`;
    await new Promise(resolve => dead.close(resolve));
    const err = await mcpBackend({ tokens: tokens().provider, url }).collections().catch(e => e);
    expect(err.code).toBe('unreachable');
    expect(err.message).toMatch(/^MCP gateway unreachable \(127\.0\.0\.1:\d+\)/);
  });

  it('the token command: required, cached, and a failure is a clear sign-in error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yapa-mcp-token-'));
    try {
      const cfg = (cmd: string) => createConfig({ YAPA_SYNC_MCP_URL: gateway.url, YAPA_SYNC_MCP_TOKEN_CMD: cmd, YAPA_SYNC_ID_TOKEN_CACHE: join(dir, 'id-token') });
      await expect(mcpTokenProvider(cfg('')).get()).rejects.toThrow(/needs a token command: set YAPA_SYNC_MCP_TOKEN_CMD/);
      const failing = mcpBackend({ tokens: mcpTokenProvider(cfg('echo "session expired, log in again" >&2; exit 3')) });
      const err = await failing.collections().catch(e => e);
      expect(err.code).toBe('token_command');
      expect(err.message).toMatch(/could not get a token for the MCP gateway from `.*`: session expired, log in again\. Sign in to the gateway again/);
      await expect(mcpTokenProvider(cfg('true')).get()).rejects.toThrow(/printed no token/);
      const t = jwt(Math.floor(Date.now() / 1000) + 3600);
      expect(await mcpTokenProvider(cfg(`echo ${t}`)).get()).toBe(t);
      expect(await mcpTokenProvider(cfg('exit 1')).get()).toBe(t); // the next process reuses the cached token
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('selecting sync over MCP', () => {
  it('the MCP URL wins over a service URL and a database URL', async () => {
    const both = { YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_MCP_URL: 'https://gw.example/mcp/sync', YAPA_SYNC_SERVICE_URL: 'https://svc.example', YAPA_SYNC_DATABASE_URL: 'postgres://u:p@h/db' };
    expect(syncBackendKind(createConfig(both))).toBe('service');
    expect(syncTransportKind(createConfig(both))).toBe('mcp');
    expect(syncTransportKind(createConfig({ YAPA_SYNC_SERVICE_URL: 'https://svc.example' }))).toBe('http');
    expect(isSyncConfigured(createConfig({ YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_MCP_URL: 'https://gw.example/mcp/sync' }))).toBe(true);
    expect(syncTargetKey(createConfig(both))).not.toBe(syncTargetKey(createConfig({ ...both, YAPA_SYNC_MCP_URL: '' })));
    setSyncBackend(undefined);
    const prev = getConfig();
    try {
      setConfig(createConfig(both));
      const b = await getSyncBackend() as HttpBackend;
      expect(b.kind).toBe('service');
      expect(b.transport.kind).toBe('mcp');
      expect(b.target).toBe('https://gw.example/mcp/sync');
    } finally {
      setConfig(prev);
    }
  });

  it('the health record tells the status line how to sign in again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yapa-mcp-health-'));
    const prev = getConfig();
    try {
      const file = join(dir, 'sync-health.json');
      setConfig(createConfig({ YAPA_SYNC_ENABLED: 'true', YAPA_SYNC_MCP_URL: gateway.url || 'https://gw.example/mcp', YAPA_SYNC_HEALTH_FILE: file }));
      const broken = new IdTokenProvider(async () => { throw new Error('no session'); });
      await mcpBackend({ tokens: broken }).collections().catch(() => undefined);
      expect(readSyncHealth(file)).toMatchObject({ status: 'signed_out', code: 'token_command', sign_in: 'sign in to the MCP gateway' });
    } finally {
      setConfig(prev);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
