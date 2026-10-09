/**
 * Sync through the YAPA service (packages/service, API v1). The client holds
 * no database credentials: every request carries the user's Google ID token.
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
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getConfig, getEmbeddingModel } from '../config.js';
import { getDeviceId } from './device.js';
import {
  applyServerUsername, chunk, noteSyncError, syncUsernameNote, type PullPage, type PullRequest, type RemoteDocument, type RemoteOwner, type SimilarMatch, type SyncBackend,
  type UpsertDoc, type UpsertOutcome,
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
]);

/** Redact anything that looks like a JWT from text that may be shown or logged. */
export function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g, '<token>');
}

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

function runTokenCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (err) {
        const detail = redactTokens(String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ')).slice(0, 300);
        reject(new Error(`could not get a Google ID token from \`${cmd || 'gcloud auth print-identity-token'}\`: ${detail}. Run \`gcloud auth login\` (or fix YAPA_SYNC_ID_TOKEN_CMD).`));
        return;
      }
      resolve(String(stdout));
    };
    const opts = { timeout: TOKEN_CMD_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 };
    if (cmd) exec(cmd, opts, done);
    else execFile('gcloud', ['auth', 'print-identity-token'], { ...opts, shell: process.platform === 'win32' }, done);
  });
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
    if (!Number.isFinite(exp) || exp <= 0) return now + OPAQUE_TOKEN_TTL_MS;
    const life = exp * 1000 - now;
    return now + (life > 2 * REFRESH_MARGIN_MS ? life - REFRESH_MARGIN_MS : Math.max(0, life / 2));
  }

  /** Adopt a still-valid token cached by an earlier process (JWTs with `exp` only). */
  private loadCached(): boolean {
    if (!this.cachePath) return false;
    try {
      const token = readFileSync(this.cachePath, 'utf-8').trim();
      if (!token || !Number.isFinite(Number(decodeJwtPayload(token)?.exp))) return false;
      const until = this.validity(token, this.now());
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
      writeFileSync(tmp, token, { mode: 0o600 });
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

export interface HttpBackendOptions {
  baseUrl?: string;
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
}

/** One-line, user-facing explanation of a failed service response. */
function explain(status: number, code: string, message: string): string {
  switch (code) {
    case 'unauthenticated':
      return 'the sync service rejected the sign-in (401). Run `gcloud auth login` (or check YAPA_SYNC_ID_TOKEN_CMD).';
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
      return `sync service error ${status} ${code}: ${message}`;
  }
}

export class HttpBackend implements SyncBackend {
  readonly kind = 'service' as const;
  readonly capabilities = { deletionsFeed: true };
  readonly target: string;
  private readonly tokens: IdTokenProvider;
  private readonly timeoutMs: number;
  private readonly device: () => string;
  private meCache: { username: string; email: string; generation: number } | undefined;

  constructor(opts: HttpBackendOptions = {}) {
    const config = getConfig();
    this.target = (opts.baseUrl ?? config.SYNC_SERVICE_URL).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.target)) throw new Error(`sync service URL must start with https:// (got "${this.target}")`);
    this.tokens = opts.tokens ?? new IdTokenProvider(config.SYNC_ID_TOKEN_CMD, Date.now, config.SYNC_ID_TOKEN_CACHE);
    this.timeoutMs = opts.timeoutMs ?? config.SYNC_HTTP_TIMEOUT_MS;
    this.device = opts.device ?? getDeviceId;
  }

  private fail(err: Error): never {
    noteSyncError(err);
    throw err;
  }

  private async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const url = `${this.target}${path}`;
    const idemKey = opts.idempotent ? randomUUID() : undefined;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.tokens.get();
      } catch (e) {
        return this.fail(new ServiceError(e instanceof Error ? e.message : String(e), 0, 'token_command'));
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'x-yapa-id-token': token,
        'x-yapa-device': this.device(),
        accept: 'application/json',
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (idemKey) headers['idempotency-key'] = idemKey;

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e: any) {
        const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? `timed out after ${this.timeoutMs} ms`
          : redactTokens(String(e?.cause?.message ?? e?.message ?? e));
        return this.fail(new ServiceError(`sync service unreachable (${new URL(this.target).host}): ${why}`, 0, 'unreachable'));
      }

      const text = await res.text().catch(() => '');
      let json: any;
      try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }

      if (res.ok) return json as T;
      if (res.status === 404 && opts.allow404) return undefined as T;

      const apiErr = json?.error;
      // Cloud Run IAM answers 401/403 itself, with an HTML body and no error code.
      const code: string = apiErr?.code
        ?? (res.status === 401 ? 'cloud_run_unauthenticated' : res.status === 403 ? 'cloud_run_forbidden' : `http_${res.status}`);
      if (res.status === 401 && attempt === 0) {
        this.tokens.invalidate();
        continue;
      }
      const message = redactTokens(String(apiErr?.message ?? res.statusText ?? '')).slice(0, 300);
      const details: Record<string, unknown> = { ...(apiErr?.details ?? {}) };
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) details.retry_after = Number(retryAfter);
      return this.fail(new ServiceError(explain(res.status, code, message), res.status, code, apiErr?.request_id, details));
    }
  }

  /** GET /v1/me, cached per process until the token is re-minted. */
  async me(refresh = false): Promise<{ username: string; email: string }> {
    if (!this.meCache || refresh || this.meCache.generation !== this.tokens.generation) {
      const r = await this.request<{ username: string; email: string }>('GET', '/v1/me');
      this.meCache = { username: r.username, email: r.email, generation: this.tokens.generation };
    }
    return { username: this.meCache.username, email: this.meCache.email };
  }

  identity(): Promise<{ username: string; email: string }> {
    return this.me();
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
      deletions?: Array<{ id: string; deleted_by: string; deleted_at: number }>;
      next_cursor?: string;
      has_more?: boolean;
    }>('GET', `/v1/collections/${encodeURIComponent(collection)}/documents?${q}`);
    return {
      documents: (r.documents ?? []).map(d => ({ ...d, related_ids: d.related_ids ?? [], metadata: d.metadata ?? {} })),
      deletions: r.deletions ?? [],
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
    const note = syncUsernameNote();
    if (note) process.stderr.write(`[yapa-sync] ${note}\n`);
  }

  async maintain(): Promise<void> {
    // Schema and indexes are owned by the service's deploy pipeline.
  }

  async describe(): Promise<string[]> {
    const lines = ['Backend: YAPA sync service', `Service: ${this.target}`];
    try {
      const me = await this.me(true);
      applyServerUsername(me.username);
      lines.push(`Signed in as: ${me.username} (${me.email})`);
      const note = syncUsernameNote();
      if (note) lines.push(note);
      lines.push('Connection: healthy');
    } catch (e) {
      lines.push(`Connection: error - ${e instanceof Error ? e.message : e}`);
    }
    return lines;
  }

  async close(): Promise<void> {
    this.tokens.invalidate();
    this.meCache = undefined;
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
