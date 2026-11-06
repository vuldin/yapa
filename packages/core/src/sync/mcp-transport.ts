/**
 * Sync API v1 over MCP: a remote that serves the API as one tool, `yapa_sync`,
 * usually behind an MCP gateway that forwards each person's sign-in. Each
 * request becomes one tool call carrying what the HTTP request would have
 * (method, path with query, body, device, idempotency key), and the result's
 * `{status, body, headers}` is read as the HTTP response would be. Everything
 * else (routes, paging, errors, the 401 retry) is HttpBackend's.
 *
 * The bearer token for the gateway comes from YAPA_SYNC_MCP_TOKEN_CMD and is
 * cached like the ID token (IdTokenProvider). A connection is kept per token:
 * a new token opens a new connection.
 */
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { YapaConfig } from '../config.js';
import {
  IdTokenProvider, redactTokens, runCommand, ServiceError, TransportError,
  type SyncRequest, type SyncResponse, type SyncTransport,
} from './http-backend.js';

export const SYNC_TOOL = 'yapa_sync';
const MAX_TOOL_PAGES = 50;

export interface McpTransportOptions {
  /** Open the MCP transport for a token (tests: an in-memory pair). Default: Streamable HTTP to the URL. */
  connect?: (url: URL, token: string) => Transport;
}

interface Connection {
  client: Client;
  token: string;
  tool: string;
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
  private conn: Connection | undefined;
  private opening: { token: string; promise: Promise<Connection> } | undefined;

  constructor(url: string, private readonly opts: McpTransportOptions = {}) {
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
      const reused = this.conn?.token === req.token;
      let conn: Connection | undefined;
      try {
        conn = await this.connection(req.token, timeoutMs);
        const result = await conn.client.callTool({ name: conn.tool, arguments: args }, undefined, { timeout: timeoutMs });
        return toResponse(result as CallToolResult);
      } catch (e) {
        await this.drop(conn);
        if (e instanceof ServiceError) throw e;
        const status = e instanceof StreamableHTTPError ? e.code : undefined;
        if (status === 401) return refusal(401, 'unauthenticated', 'the MCP gateway rejected the token');
        if (status === 403) return refusal(403, 'gateway_forbidden', 'the MCP gateway refused the request');
        // An expired MCP session: the call never reached the tool, so a new session may carry it.
        if (status === 404 && reused && attempt === 0) continue;
        throw new TransportError(describeFailure(e, timeoutMs));
      }
    }
  }

  private async connection(token: string, timeoutMs: number): Promise<Connection> {
    if (this.conn?.token === token) return this.conn;
    if (this.conn) await this.drop(this.conn);
    if (this.opening?.token !== token) {
      const promise = this.open(token, timeoutMs).finally(() => {
        if (this.opening?.promise === promise) this.opening = undefined;
      });
      this.opening = { token, promise };
    }
    return this.opening.promise;
  }

  private async open(token: string, timeoutMs: number): Promise<Connection> {
    const transport = this.opts.connect?.(this.url, token)
      ?? new StreamableHTTPClientTransport(this.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'yapa', version: '1' });
    try {
      await client.connect(transport, { timeout: timeoutMs });
      const tool = await findSyncTool(client, timeoutMs, this.url.host);
      this.conn = { client, token, tool };
      return this.conn;
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
  }

  private async drop(conn: Connection | undefined): Promise<void> {
    if (!conn) return;
    if (this.conn === conn) this.conn = undefined;
    await conn.client.close().catch(() => undefined);
  }

  describe(): string[] {
    const lines = [`Backend: YAPA sync over MCP (${this.url.host})`, `MCP server: ${this.target}`];
    if (this.conn) lines.push(`Tool: ${this.conn.tool}`);
    return lines;
  }

  async close(): Promise<void> {
    this.opening = undefined;
    await this.drop(this.conn);
  }
}

async function findSyncTool(client: Client, timeoutMs: number, host: string): Promise<string> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    names.push(...r.tools.map(t => t.name));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  const tool = pickSyncTool(names);
  if (!tool) {
    throw new ServiceError(`the MCP server at ${host} has no ${SYNC_TOOL} tool. Check YAPA_SYNC_MCP_URL, and that your account may use it.`, 0, 'no_sync_tool');
  }
  return tool;
}

/** The tool's `{status, body, headers}` as an HTTP response; anything else is the gateway's or server's own error. */
function toResponse(result: CallToolResult): SyncResponse {
  const text = result.content?.find(c => c.type === 'text')?.text ?? '';
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && Number.isInteger(parsed.status)) {
    const headers = new Map(Object.entries(parsed.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status: parsed.status, statusText: '', json: parsed.body ?? undefined, header: name => headers.get(name.toLowerCase()) ?? null };
  }
  const message = redactTokens(text).slice(0, 300) || 'the tool returned no result';
  if (result.isError && /unauthori[sz]ed|unauthenticated|\b401\b|(expired|invalid) token/i.test(message)) return refusal(401, 'unauthenticated', message);
  return refusal(502, result.isError ? 'mcp_tool_error' : 'bad_response', message);
}

function refusal(status: number, code: string, message: string): SyncResponse {
  return { status, statusText: '', json: { error: { code, message } }, header: () => null };
}

function describeFailure(e: unknown, timeoutMs: number): string {
  if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return `timed out after ${timeoutMs} ms`;
  const err = e as { name?: string; message?: string; cause?: { message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${timeoutMs} ms`;
  return redactTokens(String(err?.cause?.message ?? err?.message ?? e)).slice(0, 300);
}
