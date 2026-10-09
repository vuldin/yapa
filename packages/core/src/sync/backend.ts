/**
 * The remote side of sync, behind one interface. Two implementations:
 *
 * - HttpBackend (http-backend.ts): the YAPA sync service (packages/service),
 *   authenticated with a Google ID token. No database credentials on the
 *   client. Selected by YAPA_SYNC_SERVICE_URL.
 * - PostgresBackend (postgres-backend.ts): a direct PostgreSQL+pgvector
 *   connection (advanced/self-host). Selected by YAPA_SYNC_DATABASE_URL when
 *   no service URL is set.
 *
 * push.ts, pull.ts, index.ts, task numbering, the MCP tools and the hooks only
 * talk to the remote through `getSyncBackend()`.
 */
import { getConfig, setConfig, type YapaConfig } from '../config.js';

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

/** Which backend the config selects: the service URL wins over a database URL. */
export function syncBackendKind(config: YapaConfig = getConfig()): SyncBackendKind | undefined {
  if (config.SYNC_SERVICE_URL) return 'service';
  if (config.SYNC_DATABASE_URL) return 'postgres';
  return undefined;
}

/** Sync is enabled and has somewhere to sync to. */
export function isSyncConfigured(config: YapaConfig = getConfig()): boolean {
  return config.SYNC_ENABLED && syncBackendKind(config) !== undefined;
}

let override: SyncBackend | undefined;
let active: { key: string; backend: SyncBackend } | undefined;

function keyOf(config: YapaConfig): string {
  return JSON.stringify([config.SYNC_SERVICE_URL, config.SYNC_ID_TOKEN_CMD, config.SYNC_DATABASE_URL, config.SYNC_CA_CERT, config.SYNC_HTTP_TIMEOUT_MS]);
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
  const backend: SyncBackend = kind === 'service'
    ? new (await import('./http-backend.js')).HttpBackend()
    : new (await import('./postgres-backend.js')).PostgresBackend();
  active = { key, backend };
  return backend;
}

/** Like getSyncBackend, but throws a clear error when sync has no target. */
export async function requireSyncBackend(): Promise<SyncBackend> {
  const b = await getSyncBackend();
  if (!b) throw new Error('sync has no target: set YAPA_SYNC_SERVICE_URL (plugin option sync_service_url)');
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

/** Remember the most recent sync failure for `sync status` (never contains tokens). */
export function noteSyncError(e: unknown): void {
  lastError = { message: e instanceof Error ? e.message : String(e), at: Date.now() };
}

export function lastSyncError(): { message: string; at: number } | undefined {
  return lastError;
}

/** Errors that make the rest of a cycle pointless (no network, not signed in, throttled). */
export function isCycleFatal(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && [
    'unreachable', 'unauthenticated', 'cloud_run_unauthenticated', 'cloud_run_forbidden', 'not_member', 'user_inactive',
    'rate_limited', 'unavailable', 'token_command',
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
