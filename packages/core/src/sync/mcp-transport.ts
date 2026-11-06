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
  IdTokenProvider, redactTokens, runCommand, ServiceError, TransportError,
  type SyncRequest, type SyncResponse, type SyncTransport,
} from './http-backend.js';

export const SYNC_TOOL = 'yapa_sync';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_TOOL_PAGES = 50;

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
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The bearer token for the gateway, from YAPA_SYNC_MCP_TOKEN_CMD. */
export function mcpTokenProvider(config: YapaConfig): IdTokenProvider {
  const cmd = config.SYNC_MCP_TOKEN_CMD.trim();
  const cache = config.SYNC_ID_TOKEN_CACHE ? join(dirname(config.SYNC_ID_TOKEN_CACHE), 'mcp-token') : '';
  return new IdTokenProvider(async () => {
    if (!cmd) throw new Error('sync over MCP needs a token command: set YAPA_SYNC_MCP_TOKEN_CMD (plugin option sync_mcp_token_cmd) to a command that prints your bearer token for the MCP gateway.');
    const out = await runCommand(cmd, detail => `could not get a token for the MCP gateway from \`${cmd}\`: ${detail}. Sign in to the gateway again (or fix YAPA_SYNC_MCP_TOKEN_CMD).`);
    if (!out.trim()) throw new Error(`\`${cmd}\` printed no token. Sign in to the MCP gateway again (or fix YAPA_SYNC_MCP_TOKEN_CMD).`);
    return out;
  }, Date.now, cache);
}

/** `yapa_sync`, or a gateway-prefixed name such as `server__yapa_sync`. */
export function pickSyncTool(names: string[]): string | undefined {
  if (names.includes(SYNC_TOOL)) return SYNC_TOOL;
  return names.find(n => n.length > SYNC_TOOL.length && n.endsWith(SYNC_TOOL) && /[^A-Za-z0-9]$/.test(n.slice(0, -SYNC_TOOL.length)));
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

  constructor(url: string) {
    this.target = url.trim();
    if (!/^https?:\/\//.test(this.target)) throw new Error(`sync MCP URL must start with https:// (got "${this.target}")`);
    this.url = new URL(this.target);
  }

  async send(req: SyncRequest, timeoutMs: number): Promise<SyncResponse> {
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
        session = await this.connect(req.token, timeoutMs);
        const result = await this.rpc(session, 'tools/call', { name: session.tool, arguments: args }, timeoutMs) as ToolResult;
        return toResponse(result);
      } catch (e) {
        this.forget(session);
        if (e instanceof ServiceError) throw e;
        const status = e instanceof HttpStatusError ? e.status : undefined;
        if (status === 401) return refusal(401, 'unauthenticated', 'the MCP gateway rejected the token');
        if (status === 403) return refusal(403, 'gateway_forbidden', 'the MCP gateway refused the request');
        // An expired MCP session: the call never reached the tool, so a new session may carry it.
        if (status === 404 && reused && session?.id && attempt === 0) continue;
        throw new TransportError(describeFailure(e, timeoutMs));
      }
    }
  }

  private async connect(token: string, timeoutMs: number): Promise<Session> {
    if (this.session?.token === token) return this.session;
    this.session = undefined;
    if (this.opening?.token !== token) {
      const promise = this.open(token, timeoutMs).finally(() => {
        if (this.opening?.promise === promise) this.opening = undefined;
      });
      this.opening = { token, promise };
    }
    return this.opening.promise;
  }

  private async open(token: string, timeoutMs: number): Promise<Session> {
    const session: Session = { token, tool: '' };
    const init = await this.rpc(session, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'yapa', version: '1' },
    }, timeoutMs) as { protocolVersion?: string };
    session.protocol = typeof init?.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION;
    await this.post(session, { jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs);
    session.tool = await this.findSyncTool(session, timeoutMs);
    this.session = session;
    return session;
  }

  private async findSyncTool(session: Session, timeoutMs: number): Promise<string> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const r = await this.rpc(session, 'tools/list', cursor ? { cursor } : {}, timeoutMs) as { tools?: Array<{ name?: unknown }>; nextCursor?: string };
      names.push(...(r?.tools ?? []).map(t => String(t?.name ?? '')));
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    const tool = pickSyncTool(names);
    if (!tool) {
      throw new ServiceError(`the MCP server at ${this.url.host} has no ${SYNC_TOOL} tool. Check YAPA_SYNC_MCP_URL, and that your account may use it.`, 0, 'no_sync_tool');
    }
    return tool;
  }

  private async rpc(session: Session, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const msg = await this.post(session, { jsonrpc: '2.0', id, method, params }, timeoutMs, id);
    if (msg?.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg?.result;
  }

  /** POST one JSON-RPC message; with `id`, resolve with the response to it (JSON body or SSE stream). */
  private async post(session: Session, message: object, timeoutMs: number, id?: number): Promise<any> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${session.token}`,
    };
    if (session.id) headers['mcp-session-id'] = session.id;
    if (session.protocol) headers['mcp-protocol-version'] = session.protocol;
    const res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpStatusError(res.status, `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
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

  private forget(session: Session | undefined): void {
    if (session && this.session === session) this.session = undefined;
  }

  describe(): string[] {
    const lines = [`Backend: YAPA sync over MCP (${this.url.host})`, `MCP server: ${this.target}`];
    if (this.session) lines.push(`Tool: ${this.session.tool}`);
    return lines;
  }

  async close(): Promise<void> {
    this.opening = undefined;
    this.session = undefined;
  }
}

/** Read `data:` events until the response to `id`; notifications and other messages are skipped. */
async function readSse(res: Response, id: number): Promise<any> {
  if (!res.body) throw new Error('the MCP server sent an empty event stream');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let end: number;
      while ((end = buf.search(/\r?\n\r?\n/)) >= 0) {
        const event = buf.slice(0, end);
        buf = buf.slice(end).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let msg: any;
        try { msg = JSON.parse(data); } catch { continue; }
        if (msg?.id === id && ('result' in msg || 'error' in msg)) return msg;
      }
    }
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

function refusal(status: number, code: string, message: string): SyncResponse {
  return { status, statusText: '', json: { error: { code, message } }, header: () => null };
}

function describeFailure(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  return redactTokens(String(err?.cause?.message ?? err?.message ?? e)).slice(0, 300);
}
