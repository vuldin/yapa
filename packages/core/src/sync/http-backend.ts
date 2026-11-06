/**
 * Sync through the YAPA service (packages/service, API v1). The client holds
 * no database credentials: every request carries the user's Google ID token.
 * Requests travel over a SyncTransport: fetch to the service's base URL here,
 * or an MCP tool call (mcp-transport.ts).
 *
 * Header contract (packages/service/README.md, "Client headers"):
 *   Authorization: Bearer <token>   Cloud Run IAM (it strips the signature)
 *   X-Yapa-Id-Token: <token>        verified by the app
 *   X-Yapa-Device: <device id>      echo suppression and attribution
 *   Idempotency-Key: <uuid>         on writes, reused on the 401 retry
 *
 * Tokens come from `gcloud auth print-identity-token` (or the command in
 * YAPA_SYNC_ID_TOKEN_CMD) and are reused until ~5 minutes before `exp`. They
 * are never logged. Hooks are short-lived processes and minting costs ~1 s, so
 * the current token is also cached in a 0600 file (YAPA_SYNC_ID_TOKEN_CACHE,
 * 'off' disables): it is short-lived (1 h) and far less powerful than the
 * refresh token gcloud itself keeps on disk.
 */
import { redactTokens } from '../redact.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getConfig, getEmbeddingModel } from '../config.js';
import { getDeviceId } from './device.js';
import {
  applyServerUsername, chunk, isSignedOutError, noteSyncError, syncUsernameNote, UnsupportedByRemoteError, type PullPage, type PullRequest, type RemoteDocument, type RemoteOwner, type SimilarMatch, type SyncBackend,
  type UpsertDoc, type UpsertOutcome, type Coordination, type Lease, type LeaseAcquireResult, type LeaseReleaseResult,
  type DeletedDocument, type PurgeResult, type RemoteDeletion, type RestoreResult, type DataRules, describeDataRules, parseDataRules,
} from './backend.js';

/** Refresh this long before the token's `exp`. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Tokens without a readable `exp` (custom commands) are reused this long. */
const OPAQUE_TOKEN_TTL_MS = 60_000;
const TOKEN_CMD_TIMEOUT_MS = 20_000;

// Server limits (packages/service/src/rules.ts), with headroom on bytes.
const MAX_UPSERT_DOCS = 50;
const MAX_UPSERT_BODY_BYTES = 1_500_000;
const MAX_DELETE_IDS = 500;
const MAX_LOOKUP_IDS = 1000;
const MAX_RELATED_IDS = 100;
const PULL_PAGE_LIMIT = 500;

/**
 * Item errors that repeat until the doc itself changes. The doc stays local
 * and unsynced, marked so push does not resend it every cycle.
 */
const PERMANENT_ITEM_ERRORS = new Set([
  'secret_detected', 'embedding_dimension', 'embedding_invalid', 'invalid_request', 'invalid_collection',
  'local_only_collection', 'task_namespace', 'payload_too_large', 'not_owner',
  // The owner purged the id: no write of it will ever be accepted.
  'purged',
]);

export { redactTokens } from '../redact.js';

/** The JWT payload, decoded without verification (only to read `exp`/`email`). */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return json && typeof json === 'object' ? json : undefined;
  } catch {
    return undefined;
  }
}

export type TokenCommandRunner = () => Promise<string>;

/** Run a token command (or `fallback` when `cmd` is empty); `explain` turns its last stderr lines into the error. */
export function runCommand(cmd: string, explain: (detail: string) => string, fallback?: { file: string; args: string[] }): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (err) {
        // err.message repeats the whole command line, which may hold a secret.
        const why = String(stderr).trim() || ((err as { killed?: boolean }).killed ? 'timed out' : exitText((err as { code?: unknown }).code));
        const detail = redactTokens(why.split('\n').filter(Boolean).slice(-2).join(' ')).slice(0, 300);
        reject(new Error(explain(detail)));
        return;
      }
      resolve(String(stdout));
    };
    const opts = { timeout: TOKEN_CMD_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 };
    if (cmd || !fallback) exec(cmd, opts, done);
    else execFile(fallback.file, fallback.args, { ...opts, shell: process.platform === 'win32' }, done);
  });
}

/** A command's program name, safe to show (its arguments may hold a secret). */
/** The command's program name, never its arguments or leading `VAR=value` assignments (either can hold a secret). */
export function programOf(cmd: string): string {
  const word = cmd.trim().split(/\s+/).find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word && /^[\w./-]+$/.test(word) ? word.split('/').pop() || 'the token command' : 'the token command';
}

function exitText(code: unknown): string {
  return typeof code === 'number' ? `exit code ${code}` : String(code ?? 'failed');
}

function runTokenCommand(cmd: string): Promise<string> {
  return runCommand(
    cmd,
    detail => `could not get a Google ID token from \`${cmd ? programOf(cmd) : 'gcloud auth print-identity-token'}\`: ${detail}. Run \`gcloud auth login\` (or fix YAPA_SYNC_ID_TOKEN_CMD).`,
    { file: 'gcloud', args: ['auth', 'print-identity-token'] },
  );
}

/**
 * In-memory ID token cache. Concurrent callers share one command run; a 401
 * from the service calls `invalidate()` so the next `get()` mints a new one.
 */
export class IdTokenProvider {
  private token: string | undefined;
  private validUntil = 0;
  private inFlight: Promise<string> | undefined;
  private readonly run: TokenCommandRunner;
  /** Bumped on every newly minted token (identity caches key on it). */
  generation = 0;

  constructor(
    cmd: string | TokenCommandRunner = '',
    private readonly now: () => number = Date.now,
    private readonly cachePath: string = '',
    /** Reuse a token without a readable `exp` this long, and keep it in the file cache with its expiry. */
    private readonly opaqueTtlMs?: number,
  ) {
    this.run = typeof cmd === 'function' ? cmd : () => runTokenCommand(cmd);
  }

  async get(): Promise<string> {
    if (this.token && this.now() < this.validUntil) return this.token;
    if (this.loadCached()) return this.token!;
    this.inFlight ??= this.fetch().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  invalidate(): void {
    this.token = undefined;
    this.validUntil = 0;
    if (this.cachePath) rmSync(this.cachePath, { force: true });
  }

  private validity(token: string, now: number): number {
    const exp = Number(decodeJwtPayload(token)?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return now + (this.opaqueTtlMs ?? OPAQUE_TOKEN_TTL_MS);
    const life = exp * 1000 - now;
    return now + (life > 2 * REFRESH_MARGIN_MS ? life - REFRESH_MARGIN_MS : Math.max(0, life / 2));
  }

  /** Adopt a still-valid token cached by an earlier process (JWTs with `exp`, or opaque ones stored with their expiry). */
  private loadCached(): boolean {
    if (!this.cachePath) return false;
    try {
      const [first = '', stored] = readFileSync(this.cachePath, 'utf-8').split('\n');
      const token = first.trim();
      if (!token) return false;
      const jwt = Number.isFinite(Number(decodeJwtPayload(token)?.exp));
      if (!jwt && (this.opaqueTtlMs === undefined || !Number.isFinite(Number(stored)))) return false;
      const until = jwt ? this.validity(token, this.now()) : Number(stored);
      if (this.now() >= until) return false;
      this.token = token;
      this.validUntil = until;
      this.generation++;
      return true;
    } catch {
      return false;
    }
  }

  private saveCached(token: string): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.cachePath}.${process.pid}.tmp`;
      const opaque = this.opaqueTtlMs !== undefined && !Number.isFinite(Number(decodeJwtPayload(token)?.exp));
      writeFileSync(tmp, opaque ? `${token}\n${this.validUntil}` : token, { mode: 0o600 });
      renameSync(tmp, this.cachePath);
    } catch {
      // Cache is an optimization only.
    }
  }

  /** `email` claim of the cached token, if any (display only; the service verifies). */
  email(): string | undefined {
    const e = this.token ? decodeJwtPayload(this.token)?.email : undefined;
    return typeof e === 'string' ? e : undefined;
  }

  private async fetch(): Promise<string> {
    const out = (await this.run()).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const token = out[out.length - 1];
    if (!token || /\s/.test(token)) throw new Error('the ID token command printed no token. Run `gcloud auth login`.');
    this.token = token;
    this.validUntil = this.validity(token, this.now());
    this.generation++;
    this.saveCached(token);
    return token;
  }
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** One Sync API request as a transport carries it. */
export interface SyncRequest {
  method: string;
  /** Below the API root, with its query: `/v1/...`. */
  path: string;
  body?: unknown;
  token: string;
  device: string;
  idempotencyKey?: string;
}

/** The remote's answer, read the same way whichever transport carried it. */
export interface SyncResponse {
  status: number;
  statusText: string;
  /** The parsed body; undefined when it was empty or not JSON. */
  json: any;
  header(name: string): string | null;
}

/** No answer came back (network, timeout, a broken MCP connection). */
export class TransportError extends Error {}

export interface SyncTransport {
  readonly kind: 'http' | 'mcp';
  /** Where requests go, safe to show. */
  readonly target: string;
  /** What failures call the remote, e.g. "sync service". */
  readonly label: string;
  /** The fix for a rejected sign-in. */
  readonly signInHint: string;
  /** Rejects with TransportError when no answer came back, or with a ServiceError it diagnosed itself. */
  send(req: SyncRequest, timeoutMs: number): Promise<SyncResponse>;
  /** `sync status` lines naming the backend. */
  describe(): string[];
  close(): Promise<void>;
}

/** Sync API requests over fetch, to a base URL. */
export class FetchTransport implements SyncTransport {
  readonly kind = 'http' as const;
  readonly label = 'sync service';
  readonly signInHint = 'Run `gcloud auth login` (or check YAPA_SYNC_ID_TOKEN_CMD).';
  readonly target: string;

  constructor(baseUrl: string) {
    this.target = baseUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.target)) throw new Error(`sync service URL must start with https:// (got "${this.target}")`);
  }

  async send(req: SyncRequest, timeoutMs: number): Promise<SyncResponse> {
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${req.token}`,
      'x-yapa-id-token': req.token,
      'x-yapa-device': req.device,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (req.idempotencyKey) headers['idempotency-key'] = req.idempotencyKey;

    let res: Response;
    try {
      res = await fetch(`${this.target}${req.path}`, { method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      throw new TransportError(e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `timed out after ${timeoutMs} ms`
        : redactTokens(String(e?.cause?.message ?? e?.message ?? e)));
    }
    const text = await res.text().catch(() => '');
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, statusText: res.statusText, json, header: name => res.headers.get(name) };
  }

  describe(): string[] {
    return ['Backend: YAPA sync service', `Service: ${this.target}`];
  }

  async close(): Promise<void> {}
}

export interface HttpBackendOptions {
  baseUrl?: string;
  /** Takes the place of baseUrl. */
  transport?: SyncTransport;
  tokens?: IdTokenProvider;
  timeoutMs?: number;
  device?: () => string;
}

interface RequestOpts {
  body?: unknown;
  /** Send an Idempotency-Key (the same one on the 401 retry). */
  idempotent?: boolean;
  /** Return undefined instead of throwing on 404. */
  allow404?: boolean;
  /** Do not record a failure as the last sync error (coordination is not sync). */
  quiet?: boolean;
}

/** One-line, user-facing explanation of a failed service response. */
function explain(status: number, code: string, message: string, transport: SyncTransport): string {
  switch (code) {
    case 'unauthenticated':
      return `the ${transport.label} rejected the sign-in (401). ${transport.signInHint}`;
    case 'gateway_forbidden':
      return `the ${transport.label} refused the request (403): your account may not use this MCP server. Ask its admin.`;
    case 'not_member':
      return 'your Google account is not mapped to a YAPA user; ask a YAPA admin to add you.';
    case 'user_inactive':
      return 'your YAPA user is disabled; ask a YAPA admin.';
    case 'rate_limited':
      return `rate limited by the sync service (${message}); sync retries next cycle.`;
    case 'unavailable':
      return 'the sync service is temporarily unavailable; local changes stay unsynced and retry next cycle.';
    case 'cloud_run_forbidden':
      return 'Cloud Run refused the request (403): your Google account has no access to the sync service (roles/run.invoker). Ask a YAPA admin, then `gcloud auth login` with that account.';
    case 'cloud_run_unauthenticated':
      return 'Cloud Run rejected the ID token (401). Run `gcloud auth login`.';
    default:
      if (code.startsWith('http_')) {
        const body = message.replace(/^HTTP \d+:?\s*/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `the ${transport.label} answered HTTP ${status}${body ? `: ${body}` : ''}`;
      }
      return `sync service error ${status} ${code}: ${message}`;
  }
}

export class HttpBackend implements SyncBackend {
  readonly kind = 'service' as const;
  readonly capabilities = { deletionsFeed: true };
  readonly target: string;
  readonly transport: SyncTransport;
  private readonly tokens: IdTokenProvider;
  private readonly timeoutMs: number;
  private readonly device: () => string;
  private meCache: { username: string; email: string; limits: unknown; generation: number } | undefined;

  constructor(opts: HttpBackendOptions = {}) {
    const config = getConfig();
    this.transport = opts.transport ?? new FetchTransport(opts.baseUrl ?? config.SYNC_SERVICE_URL);
    this.target = this.transport.target;
    this.tokens = opts.tokens ?? new IdTokenProvider(config.SYNC_ID_TOKEN_CMD, Date.now, config.SYNC_ID_TOKEN_CACHE);
    this.timeoutMs = opts.timeoutMs ?? config.SYNC_HTTP_TIMEOUT_MS;
    this.device = opts.device ?? getDeviceId;
  }

  get identitySource(): string {
    return this.transport.kind === 'mcp' ? 'your sign-in' : 'your Google account';
  }

  private fail(err: Error, quiet = false): never {
    // Quiet calls (leases, counters) fall back locally, but a sign-out is
    // still the person's to fix, so it reaches the status line either way.
    if (!quiet || isSignedOutError(err)) noteSyncError(err);
    throw err;
  }

  private async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const idemKey = opts.idempotent ? randomUUID() : undefined;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.tokens.get();
      } catch (e) {
        return this.fail(new ServiceError(e instanceof Error ? e.message : String(e), 0, 'token_command'), opts.quiet);
      }

      let res: SyncResponse;
      try {
        res = await this.transport.send({ method, path, body: opts.body, token, device: this.device(), idempotencyKey: idemKey }, this.timeoutMs);
      } catch (e) {
        if (e instanceof ServiceError) return this.fail(e, opts.quiet);
        const why = e instanceof TransportError ? e.message : redactTokens(String((e as Error)?.message ?? e));
        return this.fail(new ServiceError(`${this.transport.label} unreachable (${new URL(this.target).host}): ${why}`, 0, 'unreachable'), opts.quiet);
      }

      const json = res.json;
      if (res.status >= 200 && res.status < 300) return json as T;
      if (res.status === 404 && opts.allow404) return undefined as T;

      const apiErr = json?.error;
      // Cloud Run IAM answers 401/403 itself, with an HTML body and no error code.
      const iam = this.transport.kind === 'http';
      const code: string = apiErr?.code
        ?? (iam && res.status === 401 ? 'cloud_run_unauthenticated' : iam && res.status === 403 ? 'cloud_run_forbidden' : `http_${res.status}`);
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      const message = redactTokens(String(apiErr?.message ?? res.statusText ?? '')).slice(0, 300);
      const details: Record<string, unknown> = { ...(apiErr?.details ?? {}) };
      const retryAfter = res.header('retry-after');
      if (retryAfter) details.retry_after = Number(retryAfter);
      return this.fail(new ServiceError(explain(res.status, code, message, this.transport), res.status, code, apiErr?.request_id, details), opts.quiet);
    }
  }

  /** GET /v1/me, cached per process until the token is re-minted. */
  async me(refresh = false): Promise<{ username: string; email: string }> {
    if (!this.meCache || refresh || this.meCache.generation !== this.tokens.generation) {
      const r = await this.request<{ username: string; email: string; limits?: unknown }>('GET', '/v1/me');
      this.meCache = { username: r.username, email: r.email, limits: r.limits, generation: this.tokens.generation };
    }
    return { username: this.meCache.username, email: this.meCache.email };
  }

  identity(): Promise<{ username: string; email: string }> {
    return this.me();
  }

  async dataRules(): Promise<DataRules> {
    await this.me();
    return parseDataRules(this.meCache?.limits);
  }

  cachedDataRules(): DataRules | undefined {
    return this.meCache ? parseDataRules(this.meCache.limits) : undefined;
  }

  async pull(collection: string, req: PullRequest): Promise<PullPage> {
    const q = new URLSearchParams();
    if (req.cursor) q.set('cursor', req.cursor);
    else q.set('since', String(Math.max(0, Math.floor(req.since))));
    q.set('limit', String(req.limit ?? PULL_PAGE_LIMIT));
    if (req.includeOwnDevice) q.set('include_own_device', 'true');
    // The local store embeds on insert; shipping 384 floats per row is waste.
    q.set('embeddings', 'false');
    const r = await this.request<{
      documents: RemoteDocument[];
      deletions?: Array<{ id: string; deleted_by: string; deleted_at: number; reason?: unknown; purged?: unknown }>;
      next_cursor?: string;
      has_more?: boolean;
    }>('GET', `/v1/collections/${encodeURIComponent(collection)}/documents?${q}`);
    return {
      documents: (r.documents ?? []).map(d => ({ ...d, related_ids: d.related_ids ?? [], metadata: d.metadata ?? {} })),
      deletions: (r.deletions ?? []).map(toDeletion),
      nextCursor: r.next_cursor,
      hasMore: Boolean(r.has_more),
    };
  }

  async upsertMany(docs: UpsertDoc[]): Promise<UpsertOutcome[]> {
    const model = embeddingModelLabel();
    const items = docs.map(d => ({
      id: d.id,
      collection: d.collection,
      content: d.content,
      embedding: d.embedding,
      ...(model ? { embedding_model: model } : {}),
      metadata: d.metadata,
      created_at: d.created_at,
      updated_at: d.updated_at,
    }));
    const out: UpsertOutcome[] = [];
    for (const batch of byteBatches(items, MAX_UPSERT_DOCS, MAX_UPSERT_BODY_BYTES)) {
      const r = await this.request<{ results: any[] }>('POST', '/v1/documents:batchUpsert', { body: { documents: batch }, idempotent: true });
      batch.forEach((item, i) => out.push(toOutcome(item.id, r.results?.[i])));
    }
    return out;
  }

  async delete(ids: string[], reason: 'delete' | 'retract' = 'delete'): Promise<number> {
    let deleted = 0;
    for (const part of chunk(ids, MAX_DELETE_IDS)) {
      const r = await this.request<{ deleted: number }>('POST', '/v1/documents:batchDelete', { body: { ids: part, reason }, idempotent: true });
      deleted += Number(r.deleted ?? 0);
    }
    return deleted;
  }

  /**
   * Soft-delete routes (service schema v4) are user actions, not sync: they
   * are quiet (a failure does not mark sync unhealthy, a sign-out still
   * does), and an older service's `404 not_found` becomes an
   * UnsupportedByRemoteError.
   */
  private async softDeleteCall<T>(feature: string, method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    try {
      return await this.request<T>(method, path, { ...opts, quiet: true });
    } catch (e) {
      if (e instanceof ServiceError && e.status === 404 && e.code === 'not_found') throw new UnsupportedByRemoteError(feature);
      throw e;
    }
  }

  async listDeleted(collection?: string, limit?: number): Promise<DeletedDocument[]> {
    const q = new URLSearchParams();
    if (collection) q.set('collection', collection);
    if (limit !== undefined) q.set('limit', String(limit));
    const qs = q.toString();
    const r = await this.softDeleteCall<{ documents?: any[] }>('listing deleted documents', 'GET', `/v1/me/deleted${qs ? `?${qs}` : ''}`);
    return (r.documents ?? []).map(d => ({
      id: String(d.id),
      collection: String(d.collection),
      content: String(d.content ?? ''),
      metadata: d.metadata ?? {},
      deleted_at: Number(d.deleted_at),
      reason: d.reason === 'retract' ? 'retract' : 'delete',
    }));
  }

  async restore(ids: string[]): Promise<RestoreResult[]> {
    const out: RestoreResult[] = [];
    for (const part of chunk([...new Set(ids)], MAX_DELETE_IDS)) {
      const r = await this.softDeleteCall<{ results?: any[] }>('restoring deleted documents', 'POST', '/v1/documents:restore', { body: { ids: part }, idempotent: true });
      const byId = new Map((r.results ?? []).map(x => [x?.id, x]));
      for (const id of part) {
        const x = byId.get(id);
        if (x?.status === 'restored') out.push({ id, status: 'restored', synced_at: Number(x.synced_at ?? 0) });
        else out.push({ id, status: x?.status === 'id_taken' ? 'id_taken' : 'not_found' });
      }
    }
    return out;
  }

  async purge(ids: string[]): Promise<PurgeResult[]> {
    const out: PurgeResult[] = [];
    for (const part of chunk([...new Set(ids)], MAX_DELETE_IDS)) {
      const r = await this.softDeleteCall<{ results?: any[] }>('purging documents', 'POST', '/v1/documents:purge', { body: { ids: part }, idempotent: true });
      const byId = new Map((r.results ?? []).map(x => [x?.id, x]));
      for (const id of part) {
        const x = byId.get(id);
        if (x?.status === 'purged' || x?.status === 'purged_copies' || x?.status === 'not_found') out.push({ id, status: x.status });
        else {
          const code = String(x?.error?.code ?? 'internal');
          out.push({ id, status: 'error', code, message: redactTokens(String(x?.error?.message ?? (x ? code : 'no result for this id'))).slice(0, 300), permanent: PERMANENT_ITEM_ERRORS.has(code) });
        }
      }
    }
    return out;
  }

  async collections(): Promise<Array<{ name: string; count: number }>> {
    return (await this.request<{ collections: Array<{ name: string; count: number }> }>('GET', '/v1/collections')).collections ?? [];
  }

  async collectionsForUser(): Promise<string[]> {
    return (await this.request<{ collections: string[] }>('GET', '/v1/me/collections')).collections ?? [];
  }

  async collectionsByIds(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const part of chunk(ids, MAX_LOOKUP_IDS)) {
      const r = await this.request<{ collections: Record<string, string> }>('POST', '/v1/documents:collections', { body: { ids: part } });
      for (const [id, c] of Object.entries(r.collections ?? {})) out.set(id, c);
    }
    return out;
  }

  async ownersByIds(ids: string[]): Promise<Map<string, RemoteOwner>> {
    const out = new Map<string, RemoteOwner>();
    for (const part of chunk(ids, MAX_LOOKUP_IDS)) {
      const r = await this.request<{ owners: Record<string, string>; created_at: Record<string, number> }>('POST', '/v1/documents:owners', { body: { ids: part } });
      for (const [id, owner] of Object.entries(r.owners ?? {})) out.set(id, { owner, createdAt: Number(r.created_at?.[id] ?? 0) });
    }
    return out;
  }

  async createdAt(id: string): Promise<number | undefined> {
    const r = await this.request<{ created_at: number } | undefined>('GET', `/v1/documents/${encodeURIComponent(id)}/created-at`, { allow404: true });
    return r ? Number(r.created_at) : undefined;
  }

  async maxTaskNumber(): Promise<number> {
    return Number((await this.request<{ max: number }>('GET', '/v1/me/max-task-number')).max ?? 0);
  }

  readonly coordination: Coordination = {
    leaseAcquire: req => this.request<LeaseAcquireResult>('POST', '/v1/leases:acquire', {
      // scope and ttl_seconds only when given: an omitted one keeps a renewed lease's stored value.
      body: {
        collection: req.collection, key: req.key, session: req.session, scope: req.scope, ttl_seconds: req.ttlSeconds, title: req.title,
        ...(req.reclaim ? { reclaim: true } : {}),
      },
      quiet: true,
    }),
    leaseHeartbeat: (collection, session, keys) =>
      this.request<{ renewed: Lease[]; lost: string[] }>('POST', '/v1/leases:heartbeat', { body: { collection, session, keys }, quiet: true }),
    leaseRelease: (collection, key, session, outcome) =>
      this.request<LeaseReleaseResult>('POST', '/v1/leases:release', { body: { collection, key, session, outcome }, quiet: true }),
    leaseList: (collection, includeExpired = false) => {
      const q = new URLSearchParams({ collection });
      if (includeExpired) q.set('include_expired', 'true');
      return this.request<{ leases: Lease[]; now: number }>('GET', `/v1/leases?${q}`, { quiet: true });
    },
    // Idempotent: a retried request (401 refresh) must not burn a second value.
    counterNext: async (collection, name, floor) =>
      Number((await this.request<{ value: number }>('POST', '/v1/counters:next', { body: { collection, name, floor }, idempotent: true, quiet: true })).value),
    nextTaskId: async floor =>
      (await this.request<{ id: string }>('POST', '/v1/me/task-ids:next', { body: { floor }, idempotent: true, quiet: true })).id,
  };

  async similar(collection: string, embedding: number[], threshold?: number): Promise<SimilarMatch[]> {
    const r = await this.request<{ matches: SimilarMatch[] }>('POST', `/v1/collections/${encodeURIComponent(collection)}:similar`, {
      body: { embedding, ...(threshold !== undefined ? { threshold } : {}), limit: 5 },
    });
    return r.matches ?? [];
  }

  async addRelatedIds(id: string, add: string[]): Promise<void> {
    for (const part of chunk(add, MAX_RELATED_IDS)) {
      await this.request('POST', `/v1/documents/${encodeURIComponent(id)}/related-ids`, { body: { add: part } });
    }
  }

  async health(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('GET', '/v1/health');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Sign in once at startup; the service's username becomes the effective USERNAME. */
  async prepare(): Promise<void> {
    applyServerUsername((await this.me(true)).username);
    const note = syncUsernameNote(this.identitySource);
    if (note) process.stderr.write(`[yapa-sync] ${note}\n`);
  }

  async maintain(): Promise<void> {
    // Schema and indexes are owned by the service's deploy pipeline.
  }

  async describe(): Promise<string[]> {
    const lines = this.transport.describe();
    try {
      const me = await this.me(true);
      applyServerUsername(me.username);
      lines.push(`Signed in as: ${me.username} (${me.email})`);
      const note = syncUsernameNote(this.identitySource);
      if (note) lines.push(note);
      lines.push(`Data rules: ${describeDataRules(parseDataRules(this.meCache?.limits))}`);
      lines.push('Connection: healthy');
    } catch (e) {
      lines.push(`Connection: error - ${e instanceof Error ? e.message : e}`);
    }
    return lines;
  }

  async close(): Promise<void> {
    this.tokens.invalidate();
    this.meCache = undefined;
    await this.transport.close();
  }
}

function toOutcome(id: string, r: any): UpsertOutcome {
  if (!r) return { id, ok: false, code: 'internal', message: 'no result for this document', permanent: false };
  if (r.status === 'error') {
    const err = r.error ?? {};
    const code = String(err.code ?? 'internal');
    return {
      id,
      ok: false,
      code,
      message: String(err.message ?? code),
      permanent: PERMANENT_ITEM_ERRORS.has(code),
      ...(typeof err.suggested_id === 'string' ? { suggestedId: err.suggested_id } : {}),
    };
  }
  // 'pending' (reserved by the API) is a successful write that is not yet visible to others.
  return { id, ok: true, status: String(r.status), ...(r.stale ? { stale: true } : {}), similar: Array.isArray(r.similar) ? r.similar : [] };
}

/** A pull's deletion entry; `reason` and `purged` only when a schema v4 service sent them. */
function toDeletion(d: { id: string; deleted_by: string; deleted_at: number; reason?: unknown; purged?: unknown }): RemoteDeletion {
  const out: RemoteDeletion = { id: d.id, deleted_by: d.deleted_by, deleted_at: Number(d.deleted_at) };
  if (d.reason === 'delete' || d.reason === 'retract') out.reason = d.reason;
  if (typeof d.purged === 'boolean') out.purged = d.purged;
  return out;
}

function embeddingModelLabel(): string | undefined {
  const c = getConfig();
  if (c.EMBEDDING_PROVIDER === 'chromadb') return 'Xenova/all-MiniLM-L6-v2:q8';
  const m = getEmbeddingModel(c);
  return m ? `${c.EMBEDDING_PROVIDER}:${m}`.slice(0, 200) : undefined;
}

/** Batches of at most `maxItems` whose JSON stays under `maxBytes` (a single oversized item gets its own batch). */
function byteBatches<T>(items: T[], maxItems: number, maxBytes: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (cur.length > 0 && (cur.length >= maxItems || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(item);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
