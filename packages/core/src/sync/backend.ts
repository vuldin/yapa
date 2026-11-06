/**
 * The remote side of sync, behind one interface. Two implementations:
 *
 * - HttpBackend (http-backend.ts): Sync API v1. No database credentials on
 *   the client. Over MCP (mcp-transport.ts) when YAPA_SYNC_MCP_URL is set: a
 *   remote that serves the API as the `yapa_sync` tool, signed in with the
 *   token from YAPA_SYNC_MCP_TOKEN_CMD. Otherwise over HTTPS to
 *   YAPA_SYNC_SERVICE_URL, signed in with a Google ID token.
 * - PostgresBackend (postgres-backend.ts): a direct PostgreSQL+pgvector
 *   connection (advanced/self-host). Selected by YAPA_SYNC_DATABASE_URL when
 *   neither URL above is set.
 *
 * Precedence: MCP URL, then service URL, then database URL.
 *
 * push.ts, pull.ts, index.ts, task numbering, the MCP tools and the hooks only
 * talk to the remote through `getSyncBackend()`.
 */
import { getConfig, setConfig, type YapaConfig } from '../config.js';
import { healthStatusFor, recordSyncHealth } from './health.js';

export interface RemoteDocument {
  id: string;
  collection: string;
  content: string;
  /** Omitted by backends that skip embeddings on pull (the local store re-embeds). */
  embedding?: number[];
  metadata: Record<string, any>;
  origin_user: string;
  related_ids: string[];
  /** Date (Postgres) or Unix seconds (service). */
  synced_at: Date | number;
  created_at: Date | number;
  updated_at: Date | number;
}

export interface RemoteDeletion {
  id: string;
  deleted_by: string;
  /** Unix seconds. */
  deleted_at: number;
  /** Why the row left (service schema v4): a delete, or a retract into a local-only collection. Absent from older remotes. */
  reason?: 'delete' | 'retract';
  /** The owner purged the id for good (service schema v4): drop every copy; upserts of it are refused (`purged`). */
  purged?: boolean;
}

// ------------------------------------------------------------- soft delete
// Service schema v4 (infra/cloudsql/sql/07_soft_delete.sql). A delete keeps
// the row restorable by its owner for the remote's retention window
// (GET /v1/me `limits.deleted_retention_days`, default 30).

/** One of the caller's soft-deleted rows (GET /v1/me/deleted). */
export interface DeletedDocument {
  id: string;
  collection: string;
  /** The first 300 characters of the content. */
  content: string;
  metadata: Record<string, any>;
  /** Unix seconds. */
  deleted_at: number;
  reason: 'delete' | 'retract';
}

/**
 * `restored`: the newest deleted copy is live again with updated_at = now
 * (pulls on every device, the restoring one included, fetch it as an update).
 * `not_found`: no own deleted copy within retention. `id_taken`: a live row
 * with that id exists now.
 */
export type RestoreResult =
  | { id: string; status: 'restored'; synced_at: number }
  | { id: string; status: 'not_found' | 'id_taken' };

/** `purged`: the live row and every deleted copy are gone, and the id can never be written again. */
export type PurgeResult =
  /** `purged_copies`: the id is now someone else's live document; only your deleted copies were purged. */
  | { id: string; status: 'purged' | 'purged_copies' | 'not_found' }
  /** `permanent`: retrying can't help (not_owner, a bad request); otherwise the purge stays queued. */
  | { id: string; status: 'error'; code: string; message: string; permanent?: boolean };

/**
 * The remote does not have this route (an older sync service answers
 * `404 not_found`). Nothing was changed; tell the user the feature needs a
 * newer service.
 */
export class UnsupportedByRemoteError extends Error {
  readonly code = 'unsupported_by_remote';
  constructor(readonly feature: string, message = `the sync service does not support ${feature} yet (it needs a newer service release)`) {
    super(message);
    this.name = 'UnsupportedByRemoteError';
  }
}

export interface PullRequest {
  /** Unix seconds; ignored when `cursor` is set. */
  since: number;
  /** Opaque continuation from the previous page. */
  cursor?: string;
  /** Also return rows this device wrote (first pull of a wiped store). */
  includeOwnDevice?: boolean;
  limit?: number;
}

export interface PullPage {
  documents: RemoteDocument[];
  /** Rows deleted remotely since the position (empty for backends without a deletions feed). */
  deletions: RemoteDeletion[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface UpsertDoc {
  id: string;
  collection: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
  origin_user: string;
  created_at: number;
  updated_at: number;
}

export interface SimilarMatch {
  id: string;
  similarity: number;
}

export type UpsertOutcome =
  | { id: string; ok: true; status: string; stale?: boolean; similar: SimilarMatch[] }
  | {
    id: string;
    ok: false;
    code: string;
    message: string;
    /** Item-level rejection that will repeat until the doc changes (secret, bad embedding, namespace). */
    permanent: boolean;
    /** id_taken / task_namespace: the id the server suggests. */
    suggestedId?: string;
  };

export interface RemoteOwner {
  owner: string;
  /** Unix seconds. */
  createdAt: number;
}

export type SyncBackendKind = 'service' | 'postgres';

// ------------------------------------------------------------ coordination
// Leases and counters (service schema v3, docs/service-design.md section 5
// "Coordination"). Synchronous: the answer is the service's, not a queued push.

export interface Lease {
  collection: string;
  key: string;
  holder: { user: string; session: string; device: string | null };
  title: string | null;
  scope: string[];
  ttl_seconds: number;
  /** Unix seconds. */
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  expired: boolean;
  took_over_from: Record<string, unknown> | null;
}

export interface LeaseAcquireRequest {
  collection: string;
  key: string;
  /** Who holds it inside the user: a Claude session id, a process, ... */
  session: string;
  /**
   * What the work touches, e.g. `doc:runbook`, `res:staging-cluster`; `key:<key>` is always added.
   * Omitted: a renewal (same user and session) keeps the stored scope, anything else gets just `key:<key>`.
   * `[]` replaces the stored scope with just `key:<key>`.
   */
  scope?: string[];
  /** Omitted: a renewal keeps the stored TTL, anything else gets the server default (7200). */
  ttlSeconds?: number;
  title?: string;
  /**
   * Live leases of your own other sessions are not conflicts; one on this key is
   * taken over (took_over_from.reclaim = true). Other users' leases still refuse.
   * For picking work back up after a resumed or restarted session; confirm with the user first.
   */
  reclaim?: boolean;
}

export type LeaseAcquireResult =
  | { granted: true; lease: Lease; renewed: boolean; took_over_from?: Record<string, unknown> }
  | { granted: false; conflicts: Array<{ lease: Lease; overlap: string[] }> };

export type LeaseReleaseResult =
  | { released: true; lease: Lease }
  | { released: false; reason: 'not_held' }
  | { released: false; reason: 'held_by_other'; lease: Lease };

export interface Coordination {
  leaseAcquire(req: LeaseAcquireRequest): Promise<LeaseAcquireResult>;
  /**
   * No collection: renew the session's leases in every collection. `unreachable`
   * set: the sync service could not be asked, so only this machine's leases
   * were renewed (the message says why).
   */
  leaseHeartbeat(collection: string | undefined, session: string, keys?: string[]): Promise<{ renewed: Lease[]; lost: string[]; unreachable?: string }>;
  leaseRelease(collection: string, key: string, session: string, outcome?: string): Promise<LeaseReleaseResult>;
  leaseList(collection: string, includeExpired?: boolean): Promise<{ leases: Lease[]; now: number }>;
  /** Next value strictly above the last one handed out and above `floor`. */
  counterNext(collection: string, name: string, floor?: number): Promise<number>;
  /** Next `<caller>-<n>` task id: one sequence per user, floored by the server's own max and `floor`. */
  nextTaskId(floor?: number): Promise<string>;
}

export interface SyncBackend {
  readonly kind: SyncBackendKind;
  /** Where it syncs to, safe to show (credentials redacted). */
  readonly target: string;
  /** Pull pages and returns deletions (the service); Postgres returns everything in one page, no deletions. */
  readonly capabilities: { deletionsFeed: boolean };

  pull(collection: string, req: PullRequest): Promise<PullPage>;
  /** Per-item outcomes in input order; throws only when the whole call failed. */
  upsertMany(docs: UpsertDoc[]): Promise<UpsertOutcome[]>;
  /** Delete the caller's own rows. Returns how many were deleted. */
  delete(ids: string[], reason: 'delete' | 'retract'): Promise<number>;
  /**
   * The caller's own soft-deleted rows within retention, newest first
   * (optionally one collection). Service only; throws UnsupportedByRemoteError
   * on a service without the route.
   */
  listDeleted?(collection?: string, limit?: number): Promise<DeletedDocument[]>;
  /** Restore the caller's own soft-deleted rows; results in input order (duplicates removed). Service only. */
  restore?(ids: string[]): Promise<RestoreResult[]>;
  /** Remove the caller's own ids for good (live row and deleted copies); results in input order (duplicates removed). Service only. */
  purge?(ids: string[]): Promise<PurgeResult[]>;
  /** Shared collections with document counts. */
  collections(): Promise<Array<{ name: string; count: number }>>;
  /** Collections holding the caller's rows (recovery). */
  collectionsForUser(): Promise<string[]>;
  /** Remote collection of each id; missing ids are absent. */
  collectionsByIds(ids: string[]): Promise<Map<string, string>>;
  /** Owner and creation time of each id; missing ids are absent. */
  ownersByIds(ids: string[]): Promise<Map<string, RemoteOwner>>;
  createdAt(id: string): Promise<number | undefined>;
  /** Highest `<caller>-<n>` task number remotely (0 if none). */
  maxTaskNumber(): Promise<number>;
  /** Leases and counters; only the sync service has them. */
  readonly coordination?: Coordination;
  similar(collection: string, embedding: number[], threshold?: number): Promise<SimilarMatch[]>;
  addRelatedIds(id: string, add: string[]): Promise<void>;
  health(): Promise<{ ok: boolean; error?: string }>;
  /** One-time startup work (Postgres: create the schema when missing). */
  prepare(): Promise<void>;
  /** Periodic best-effort maintenance (Postgres: vector index). */
  maintain(): Promise<void>;
  /**
   * The caller as the remote knows it (service: GET /v1/me). Backends without
   * server-side identity (Postgres) omit it and use YAPA_USERNAME.
   */
  identity?(): Promise<{ username: string; email: string }>;
  /** Lines for `sync status`: backend, target, identity, TLS, last error. */
  describe(): Promise<string[]>;
  close(): Promise<void>;
}

/** Which backend the config selects: an MCP or service URL (both the Sync API) wins over a database URL. */
export function syncBackendKind(config: YapaConfig = getConfig()): SyncBackendKind | undefined {
  if (config.SYNC_MCP_URL || config.SYNC_SERVICE_URL) return 'service';
  if (config.SYNC_DATABASE_URL) return 'postgres';
  return undefined;
}

/** How the Sync API is reached: MCP wins over a service URL. */
export function syncTransportKind(config: YapaConfig = getConfig()): 'mcp' | 'http' | undefined {
  if (config.SYNC_MCP_URL) return 'mcp';
  if (config.SYNC_SERVICE_URL) return 'http';
  return undefined;
}

/** Sync is enabled and has somewhere to sync to. */
export function isSyncConfigured(config: YapaConfig = getConfig()): boolean {
  return config.SYNC_ENABLED && syncBackendKind(config) !== undefined;
}

let override: SyncBackend | undefined;
let active: { key: string; backend: SyncBackend } | undefined;

function keyOf(config: YapaConfig): string {
  return JSON.stringify([config.SYNC_MCP_URL, config.SYNC_MCP_TOKEN_CMD, config.SYNC_SERVICE_URL, config.SYNC_ID_TOKEN_CMD, config.SYNC_DATABASE_URL, config.SYNC_CA_CERT, config.SYNC_HTTP_TIMEOUT_MS]);
}

/**
 * The backend for the current config, created on first use and replaced when
 * the sync settings change. Undefined when nothing is configured. Creating a
 * backend never touches the network.
 */
export async function getSyncBackend(): Promise<SyncBackend | undefined> {
  const b = await selectBackend();
  // A host may re-install its config (hot reload) with the configured
  // username; keep the server's username in force.
  if (b?.kind === 'service' && serverUsername && getConfig().USERNAME !== serverUsername) applyServerUsername(serverUsername);
  return b;
}

async function selectBackend(): Promise<SyncBackend | undefined> {
  if (override) return override;
  const config = getConfig();
  const kind = syncBackendKind(config);
  if (!kind) return undefined;
  const key = keyOf(config);
  if (active?.key === key) return active.backend;
  if (active) await active.backend.close().catch(() => undefined);
  serverUsername = undefined;
  const backend: SyncBackend = kind === 'postgres'
    ? new (await import('./postgres-backend.js')).PostgresBackend()
    : syncTransportKind(config) === 'mcp'
      ? await mcpBackend(config)
      : new (await import('./http-backend.js')).HttpBackend();
  active = { key, backend };
  return backend;
}

async function mcpBackend(config: YapaConfig): Promise<SyncBackend> {
  const [{ HttpBackend }, { McpTransport, mcpTokenProvider }] = await Promise.all([import('./http-backend.js'), import('./mcp-transport.js')]);
  return new HttpBackend({ transport: new McpTransport(config.SYNC_MCP_URL), tokens: mcpTokenProvider(config) });
}

/** Like getSyncBackend, but throws a clear error when sync has no target. */
export async function requireSyncBackend(): Promise<SyncBackend> {
  const b = await getSyncBackend();
  if (!b) throw new Error('sync has no target: set YAPA_SYNC_SERVICE_URL (plugin option sync_service_url) or YAPA_SYNC_MCP_URL (sync_mcp_url)');
  return b;
}

/** Test/host hook: use this backend regardless of config (undefined restores config selection). */
export function setSyncBackend(backend: SyncBackend | undefined): void {
  override = backend;
  serverUsername = undefined;
  configuredUsername = undefined;
}

/** Close and forget the config-selected backend (connections, cached tokens). */
export async function closeSyncBackend(): Promise<void> {
  const b = active?.backend;
  active = undefined;
  serverUsername = undefined;
  if (b) await b.close();
}

/** Split `items` into chunks of at most `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

let lastError: { message: string; at: number } | undefined;

/**
 * Remember the most recent sync failure for `sync status` (never contains
 * tokens), and record it in the health file the status line reads.
 */
export function noteSyncError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  lastError = { message, at: Date.now() };
  const code = (e as { code?: unknown })?.code;
  recordSyncHealth({ status: healthStatusFor(code), code: typeof code === 'string' ? code : undefined, message });
}

/** A round trip to the remote succeeded: clear the failure. */
export function noteSyncOk(unpushed?: number): void {
  lastError = undefined;
  recordSyncHealth({ status: 'ok', unpushed });
}

/** Not signed in (or the token command failed): worth recording even for quiet requests. */
export function isSignedOutError(e: unknown): boolean {
  return healthStatusFor((e as { code?: unknown })?.code) === 'signed_out';
}

export function lastSyncError(): { message: string; at: number } | undefined {
  return lastError;
}

/** Errors that make the rest of a cycle pointless (no network, not signed in, throttled). */
export function isCycleFatal(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && [
    'unreachable', 'unauthenticated', 'cloud_run_unauthenticated', 'cloud_run_forbidden', 'not_member', 'user_inactive',
    'rate_limited', 'unavailable', 'token_command', 'gateway_forbidden', 'no_sync_tool',
  ].includes(code);
}

// ---------------------------------------------------------------- identity
//
// With the sync service, the username is not a client setting: the service
// derives it from the verified Google account (GET /v1/me) and rejects task
// ids and ownership under any other name. Once known, it replaces
// YAPA_USERNAME in the active config, so task ids, origin_user stamping,
// owner checks and attribution all use it. The configured value is kept only
// to explain the difference in `sync status`.

let serverUsername: string | undefined;
let configuredUsername: string | undefined;

/** Install the server's username as the effective USERNAME. */
export function applyServerUsername(username: string): void {
  serverUsername = username;
  const c = getConfig();
  if (c.USERNAME === username) return;
  configuredUsername = c.USERNAME;
  setConfig({ ...c, USERNAME: username });
}

/**
 * The effective username: the service's (fetched once per token, then
 * cached) or YAPA_USERNAME for backends without server identity. Fails open:
 * an unreachable service leaves the current value.
 */
export async function resolveSyncUsername(): Promise<string> {
  const b = await getSyncBackend();
  if (b?.identity) {
    try {
      applyServerUsername((await b.identity()).username);
    } catch {
      // offline or not signed in: keep what we have; push/pull report the error
    }
  }
  return getConfig().USERNAME;
}

/** Explanation for `sync status` when the configured username was replaced. */
export function syncUsernameNote(): string | undefined {
  if (!serverUsername || !configuredUsername || configuredUsername === serverUsername) return undefined;
  return `Username: using '${serverUsername}' from your Google account (the username option '${configuredUsername}' is informational with the sync service)`;
}
