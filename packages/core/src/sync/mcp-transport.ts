/**
 * Sync API v1 over MCP: a remote that serves the API as one tool, `yapa_sync`,
 * usually behind an MCP gateway that forwards each person's sign-in. Each
 * request becomes one tool call carrying what the HTTP request would have
 * (method, path with query, body, device, idempotency key), and the result's
 * `{status, body, headers}` is read as the HTTP response would be. Everything
 * else (routes, paging, errors, the 401 retry) is HttpBackend's.
 *
 * A minimal Streamable HTTP client on fetch (initialize, tools/list,
 * tools/call): the hooks bundle loads this on every prompt, so no SDK. The
 * bearer token comes from YAPA_SYNC_MCP_TOKEN_CMD and is cached like the ID
 * token (IdTokenProvider); a new token opens a new session.
 */
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { YapaConfig } from '../config.js';
import {
  IdTokenProvider, programOf, redactTokens, runCommand, ServiceError, TransportError,
  type SyncRequest, type SyncResponse, type SyncTransport,
} from './http-backend.js';

export const SYNC_TOOL = 'yapa_sync';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOL_PAGES = 50;
/** Gateway tokens rarely carry a readable `exp`; a 401 refreshes sooner. */
const OPAQUE_TOKEN_TTL_MS = 50 * 60_000;
const END_SESSION_TIMEOUT_MS = 2000;
const PREFIX_SEPARATORS = ['__', '.', '/', '-'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface McpTransportOptions {
  /** The sync tool's exact name (YAPA_SYNC_MCP_TOOL). */
  tool?: string;
}

interface Session {
  token: string;
  id?: string;
  protocol?: string;
  tool: string;
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** The gateway or MCP server answered with this HTTP status. */
class HttpStatusError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter: string | null) {
    super(message);
  }
}

/** A JSON-RPC error reply. */
class RpcError extends Error {}

/** The bearer token for the gateway, from YAPA_SYNC_MCP_TOKEN_CMD. */
export function mcpTokenProvider(config: YapaConfig): IdTokenProvider {
  const cmd = config.SYNC_MCP_TOKEN_CMD.trim();
  const cache = config.SYNC_ID_TOKEN_CACHE ? join(dirname(config.SYNC_ID_TOKEN_CACHE), 'mcp-token') : '';
  const fix = 'Sign in to the MCP gateway again (or fix YAPA_SYNC_MCP_TOKEN_CMD).';
  return new IdTokenProvider(async () => {
    if (!cmd) throw new Error('sync over MCP needs a token command: set YAPA_SYNC_MCP_TOKEN_CMD (plugin option sync_mcp_token_cmd) to a command that prints your bearer token for the MCP gateway.');
    const out = await runCommand(cmd, detail => `could not get a token for the MCP gateway from \`${programOf(cmd)}\`: ${detail}. ${fix}`);
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const token = (lines[lines.length - 1] ?? '').replace(/^Bearer\s+/i, '');
    if (!token || /\s/.test(token)) throw new Error(`the MCP token command (\`${programOf(cmd)}\`) printed no token. ${fix}`);
    return token;
  }, Date.now, cache, OPAQUE_TOKEN_TTL_MS);
}

/**
 * The sync tool among `names`: the configured one, else `yapa_sync`, else the
 * one gateway-prefixed name (`server__yapa_sync`). Several prefixed ones are
 * ambiguous.
 */
export function pickSyncTool(names: string[], host: string, explicit = ''): string {
  if (explicit) {
    if (names.includes(explicit)) return explicit;
    throw new ServiceError(`the MCP server at ${host} has no tool named ${explicit} (YAPA_SYNC_MCP_TOOL).`, 0, 'no_sync_tool');
  }
  if (names.includes(SYNC_TOOL)) return SYNC_TOOL;
  const prefixed = [...new Set(names.filter(n => PREFIX_SEPARATORS.some(sep => n.endsWith(`${sep}${SYNC_TOOL}`) && n.length > sep.length + SYNC_TOOL.length)))];
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new ServiceError(`the MCP server at ${host} has several sync tools (${prefixed.join(', ')}). Set YAPA_SYNC_MCP_TOOL (plugin option sync_mcp_tool) to the one to use.`, 0, 'ambiguous_sync_tool');
  }
  const near = names.filter(n => n.endsWith(SYNC_TOOL));
  if (near.length) {
    throw new ServiceError(`the MCP server at ${host} has no ${SYNC_TOOL} tool, but has ${near.join(', ')}. If that is the sync tool, set YAPA_SYNC_MCP_TOOL (plugin option sync_mcp_tool) to it.`, 0, 'no_sync_tool');
  }
  throw new ServiceError(`the MCP server at ${host} has no ${SYNC_TOOL} tool. Check YAPA_SYNC_MCP_URL, and that your account may use it.`, 0, 'no_sync_tool');
}

export class McpTransport implements SyncTransport {
  readonly kind = 'mcp' as const;
  readonly label = 'MCP gateway';
  readonly signInHint = 'Sign in to the MCP gateway again (or check YAPA_SYNC_MCP_TOKEN_CMD).';
  readonly target: string;
  private readonly url: URL;
  private session: Session | undefined;
  private opening: { token: string; promise: Promise<Session> } | undefined;
  private nextId = 1;

  constructor(url: string, private readonly opts: McpTransportOptions = {}) {
    this.target = url.trim();
    if (!/^https?:\/\//.test(this.target)) throw new Error(`sync MCP URL must start with https:// (got "${this.target}")`);
    this.url = new URL(this.target);
    if (this.url.protocol === 'http:' && !LOOPBACK.has(this.url.hostname)) {
      throw new Error(`sync MCP URL must use https:// (http:// only for localhost; got "${this.target}")`);
    }
  }

  async send(req: SyncRequest, timeoutMs: number): Promise<SyncResponse> {
    const deadline = Date.now() + timeoutMs;
    const args = {
      method: req.method,
      // The tool's path pattern has no room for the characters encodeURIComponent and URLSearchParams leave alone.
      path: req.path.replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
      ...(req.body === undefined ? {} : { body: req.body }),
      device: req.device,
      ...(req.idempotencyKey ? { idempotency_key: req.idempotencyKey } : {}),
      request_id: randomUUID(),
    };
    for (let attempt = 0; ; attempt++) {
      const reused = this.session?.token === req.token;
      let session: Session | undefined;
      try {
        session = await this.connect(req.token, deadline);
        const result = await this.rpc(session, 'tools/call', { name: session.tool, arguments: args }, deadline) as ToolResult;
        return toResponse(result);
      } catch (e) {
        if (session && this.session === session) this.session = undefined;
        if (e instanceof ServiceError) throw e;
        if (e instanceof RpcError) return refusal(502, 'mcp_error', redactTokens(e.message).slice(0, 300));
        if (!(e instanceof HttpStatusError)) throw new TransportError(describeFailure(e, timeoutMs));
        const { status } = e;
        if (status === 401) return refusal(401, 'unauthenticated', 'the MCP gateway rejected the token');
        if (status === 403) return refusal(403, 'gateway_forbidden', 'the MCP gateway refused the request');
        // An expired MCP session: the call never reached the tool, so a new session may carry it.
        if (status === 404 && reused && session?.id && attempt === 0) continue;
        if (status === 429) return refusal(429, 'rate_limited', 'the MCP gateway is rate limiting requests', e.retryAfter);
        return { status, statusText: e.message, json: undefined, header: () => null };
      }
    }
  }

  private async connect(token: string, deadline: number): Promise<Session> {
    if (this.session?.token === token) return this.session;
    if (this.session) this.end(this.session);
    this.session = undefined;
    if (this.opening?.token !== token) {
      const promise = this.open(token, deadline).finally(() => {
        if (this.opening?.promise === promise) this.opening = undefined;
      });
      this.opening = { token, promise };
    }
    return this.opening.promise;
  }

  private async open(token: string, deadline: number): Promise<Session> {
    const session: Session = { token, tool: '' };
    try {
      const init = await this.rpc(session, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'yapa', version: '1' },
      }, deadline) as { protocolVersion?: string };
      session.protocol = typeof init?.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION;
      await this.post(session, { jsonrpc: '2.0', method: 'notifications/initialized' }, deadline);
      const names: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const r = await this.rpc(session, 'tools/list', cursor ? { cursor } : {}, deadline) as { tools?: Array<{ name?: unknown }>; nextCursor?: string };
        names.push(...(r?.tools ?? []).map(t => String(t?.name ?? '')));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      session.tool = pickSyncTool(names, this.url.host, this.opts.tool);
      this.session = session;
      return session;
    } catch (e) {
      this.end(session);
      throw e;
    }
  }

  private async rpc(session: Session, method: string, params: unknown, deadline: number): Promise<unknown> {
    const id = this.nextId++;
    const msg = await this.post(session, { jsonrpc: '2.0', id, method, params }, deadline, id);
    if (msg?.error) throw new RpcError(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg?.result;
  }

  private headers(session: Session): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${session.token}`,
    };
    if (session.id) headers['mcp-session-id'] = session.id;
    if (session.protocol) headers['mcp-protocol-version'] = session.protocol;
    return headers;
  }

  /** POST one JSON-RPC message; with `id`, resolve with the response to it (JSON body or SSE stream). */
  private async post(session: Session, message: object, deadline: number, id?: number): Promise<any> {
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(session), body: JSON.stringify(message), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpStatusError(res.status, redactTokens(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`), res.headers.get('retry-after'));
    }
    session.id ??= res.headers.get('mcp-session-id') ?? undefined;
    if (id === undefined) {
      await res.body?.cancel();
      return undefined;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) return readSse(res, id);
    const body = await res.json();
    const found = (Array.isArray(body) ? body : [body]).find(m => m?.id === id);
    if (!found) throw new Error('the MCP server answered without a response to the request');
    return found;
  }

  /** Best effort: tell the server a session is over (DELETE), without waiting for it. */
  private end(session: Session): void {
    if (!session.id) return;
    fetch(this.url, { method: 'DELETE', headers: this.headers(session), signal: AbortSignal.timeout(END_SESSION_TIMEOUT_MS) })
      .then(r => r.body?.cancel())
      .catch(() => undefined);
  }

  describe(): string[] {
    const lines = [`Backend: YAPA sync over MCP (${this.url.host})`, `MCP server: ${this.target}`];
    if (this.session) lines.push(`Tool: ${this.session.tool}`);
    return lines;
  }

  async close(): Promise<void> {
    this.opening = undefined;
    if (this.session) this.end(this.session);
    this.session = undefined;
  }
}

/** Read events until the response to `id`; notifications and other messages are skipped. */
export async function readSse(res: Response, id: number): Promise<any> {
  if (!res.body) throw new Error('the MCP server sent an empty event stream');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let data: string[] = [];
  const line = (l: string): any => {
    if (l !== '') {
      if (l.startsWith('data:')) data.push(l.slice(5).replace(/^ /, ''));
      return undefined;
    }
    const payload = data.join('\n');
    data = [];
    if (!payload) return undefined;
    try {
      const msg = JSON.parse(payload);
      return msg?.id === id && ('result' in msg || 'error' in msg) ? msg : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      for (let m = /\r\n|\r|\n/.exec(buf); m; m = /\r\n|\r|\n/.exec(buf)) {
        // A trailing CR may be the first half of CRLF: wait for the next chunk.
        if (m[0] === '\r' && m.index === buf.length - 1) break;
        const found = line(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        if (found) return found;
      }
    }
    const found = (buf ? line(buf) : undefined) ?? line('');
    if (found) return found;
  } finally {
    reader.cancel().catch(() => undefined);
  }
  throw new Error('the MCP server closed the event stream without a response');
}

/** The tool's `{status, body, headers}` as an HTTP response; anything else is the gateway's or server's own error. */
function toResponse(result: ToolResult): SyncResponse {
  const text = result?.content?.find(c => c.type === 'text')?.text ?? '';
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.status)) {
    const headers = new Map(Object.entries(parsed.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status: parsed.status, statusText: '', json: parsed.body ?? undefined, header: name => headers.get(name.toLowerCase()) ?? null };
  }
  const message = redactTokens(text).slice(0, 300) || 'the tool returned no result';
  if (result?.isError && /unauthori[sz]ed|unauthenticated|\b401\b|(expired|invalid) token/i.test(message)) return refusal(401, 'unauthenticated', message);
  return refusal(502, result?.isError ? 'mcp_tool_error' : 'bad_response', message);
}

function refusal(status: number, code: string, message: string, retryAfter: string | null = null): SyncResponse {
  return { status, statusText: '', json: { error: { code, message } }, header: name => (name.toLowerCase() === 'retry-after' ? retryAfter : null) };
}

function describeFailure(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  return redactTokens(String(err?.cause?.message ?? err?.message ?? e)).slice(0, 300);
}
