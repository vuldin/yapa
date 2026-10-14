/**
 * yapa-mcp configuration, read from the environment once at startup. Every
 * variable is documented in packages/mcp-remote/README.md. Database settings
 * use the same names as yapa-service.
 */
import { ConfigError, READER_USERNAME_RE, type DbConfig, type RateLimitClass } from '@yapa/service/lib';
import { DEFAULT_TOOLS, READ_TOOLS } from './tools.js';

export type McpAuthMode = 'google' | 'insecure-test';

export interface StaticKeyEntry {
  /** Username the key acts as; must be a reserved `svc-*` name. */
  principal: string;
  /** Lowercase hex sha256 of the full key string. */
  sha256: string;
}

export interface McpRateLimits {
  /** Every POST /mcp request. */
  read: RateLimitClass;
  /** Tool calls that embed a query server-side. */
  embed: RateLimitClass;
}

export interface McpConfig extends DbConfig {
  port: number;
  authMode: McpAuthMode;
  /** Required `hd` (Google Workspace domain) for people. */
  allowedHd: string;
  /** Create a users row on first sign-in (YAPA_AUTO_PROVISION=true), as yapa-service does. */
  autoProvision: boolean;
  /** OAuth client ids whose tokens are accepted (aud/azp). Empty = no user OAuth. */
  oauthClientIds: string[];
  /** kid -> entry. */
  staticKeys: ReadonlyMap<string, StaticKeyEntry>;
  /** Extra header carrying a static key (lowercase). */
  keyHeader: string;
  /** Public base URL (no trailing slash) for the protected-resource metadata; undefined = request origin. */
  publicUrl?: string;
  /** Reserved for the write phase; no write tools exist yet. */
  writesEnabled: boolean;
  /**
   * Read tools to expose (YAPA_MCP_TOOLS: comma-separated names, or "all").
   * Default: memory_recall only, so ADP users see one obvious tool.
   */
  tools: ReadonlySet<string>;
  modelDir?: string;
  allowRemoteModels: boolean;
  rateLimits: McpRateLimits | false;
}

export const DEFAULT_MCP_RATE_LIMITS: McpRateLimits = {
  read: { ratePerSec: 10, burst: 60 },
  embed: { ratePerSec: 2, burst: 20 },
};

/** `yapa_sk_<kid>_<secret>`: kid has no underscore, so the first one after it splits. */
export const STATIC_KEY_RE = /^yapa_sk_([A-Za-z0-9-]{1,32})_([A-Za-z0-9_-]{32,128})$/;
const KID_RE = /^[A-Za-z0-9-]{1,32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const HEADER_RE = /^[a-z0-9-]{1,64}$/;

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function int(env: Record<string, string | undefined>, name: string, dflt: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}

function bool(env: Record<string, string | undefined>, name: string, dflt: boolean): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '') return dflt;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${name} must be true or false`);
}

/**
 * YAPA_MCP_STATIC_KEYS: `{"<kid>": {"principal": "svc-adp", "sha256": "<hex>"}}`.
 * Only hashes live here (mounted from Secret Manager); the key itself is shown
 * once by scripts/new-static-key.mjs.
 */
export function parseStaticKeys(raw: string | undefined): Map<string, StaticKeyEntry> {
  const out = new Map<string, StaticKeyEntry>();
  if (!raw || !raw.trim()) return out;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new ConfigError('YAPA_MCP_STATIC_KEYS must be JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ConfigError('YAPA_MCP_STATIC_KEYS must be a JSON object keyed by kid');
  for (const [kid, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!KID_RE.test(kid)) throw new ConfigError(`YAPA_MCP_STATIC_KEYS: kid "${kid}" must match ${KID_RE}`);
    const e = entry as Partial<StaticKeyEntry> | null;
    const principal = typeof e?.principal === 'string' ? e.principal.trim().toLowerCase() : '';
    const sha256 = typeof e?.sha256 === 'string' ? e.sha256.trim().toLowerCase() : '';
    if (!READER_USERNAME_RE.test(principal)) {
      throw new ConfigError(`YAPA_MCP_STATIC_KEYS: principal for "${kid}" must match ${READER_USERNAME_RE}`);
    }
    if (!SHA256_RE.test(sha256)) throw new ConfigError(`YAPA_MCP_STATIC_KEYS: sha256 for "${kid}" must be 64 hex characters`);
    out.set(kid, { principal, sha256 });
  }
  return out;
}

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const mode = (env.YAPA_AUTH_MODE || 'google') as McpAuthMode;
  if (mode !== 'google' && mode !== 'insecure-test') {
    throw new ConfigError(`YAPA_AUTH_MODE must be "google" or "insecure-test", got "${mode}"`);
  }
  if (mode === 'insecure-test' && env.K_SERVICE) {
    // K_SERVICE is set by Cloud Run on every revision.
    throw new ConfigError('YAPA_AUTH_MODE=insecure-test is refused on Cloud Run (K_SERVICE is set)');
  }

  const allowedHd = (env.YAPA_ALLOWED_HD ?? '').trim().toLowerCase();
  const oauthClientIds = list(env.YAPA_MCP_OAUTH_CLIENT_IDS);
  const staticKeys = parseStaticKeys(env.YAPA_MCP_STATIC_KEYS);
  if (mode === 'google') {
    if (!allowedHd) throw new ConfigError('YAPA_ALLOWED_HD is required');
    if (oauthClientIds.length === 0 && staticKeys.size === 0) {
      throw new ConfigError('set YAPA_MCP_OAUTH_CLIENT_IDS and/or YAPA_MCP_STATIC_KEYS (nothing could authenticate)');
    }
  }

  const keyHeader = (env.YAPA_MCP_KEY_HEADER || 'x-yapa-key').trim().toLowerCase();
  if (!HEADER_RE.test(keyHeader) || keyHeader === 'authorization') {
    throw new ConfigError('YAPA_MCP_KEY_HEADER must be a header name other than Authorization');
  }

  let publicUrl: string | undefined;
  if (env.YAPA_MCP_PUBLIC_URL) {
    let u: URL;
    try {
      u = new URL(env.YAPA_MCP_PUBLIC_URL);
    } catch {
      throw new ConfigError('YAPA_MCP_PUBLIC_URL must be an absolute URL');
    }
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      throw new ConfigError('YAPA_MCP_PUBLIC_URL must use https');
    }
    publicUrl = `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  }

  const databaseUrl = env.YAPA_DATABASE_URL || undefined;
  const instanceConnectionName = env.YAPA_INSTANCE_CONNECTION_NAME || undefined;
  if (!databaseUrl && !instanceConnectionName) {
    throw new ConfigError('set YAPA_INSTANCE_CONNECTION_NAME (+ YAPA_DB_USER, YAPA_DB_NAME) or YAPA_DATABASE_URL');
  }
  if (databaseUrl && instanceConnectionName) {
    throw new ConfigError('set only one of YAPA_DATABASE_URL and YAPA_INSTANCE_CONNECTION_NAME');
  }
  if (instanceConnectionName && (!env.YAPA_DB_USER || !env.YAPA_DB_NAME)) {
    throw new ConfigError('YAPA_INSTANCE_CONNECTION_NAME needs YAPA_DB_USER (IAM user) and YAPA_DB_NAME');
  }
  const ipType = (env.YAPA_DB_IP_TYPE || 'PRIVATE').toUpperCase();
  if (ipType !== 'PRIVATE' && ipType !== 'PUBLIC' && ipType !== 'PSC') {
    throw new ConfigError('YAPA_DB_IP_TYPE must be PRIVATE, PUBLIC or PSC');
  }

  const rl = (env.YAPA_RATE_LIMITS || 'on').toLowerCase();
  if (rl !== 'on' && rl !== 'off') throw new ConfigError('YAPA_RATE_LIMITS must be "on" or "off"');

  return {
    port: int(env, 'PORT', 8080),
    authMode: mode,
    allowedHd,
    autoProvision: bool(env, 'YAPA_AUTO_PROVISION', false),
    oauthClientIds,
    staticKeys,
    keyHeader,
    publicUrl,
    writesEnabled: bool(env, 'YAPA_MCP_WRITES', false),
    tools: parseTools(env.YAPA_MCP_TOOLS),
    modelDir: env.YAPA_MCP_MODEL_DIR || undefined,
    allowRemoteModels: bool(env, 'YAPA_MCP_ALLOW_REMOTE_MODELS', true),
    rateLimits: rl === 'off' ? false : DEFAULT_MCP_RATE_LIMITS,
    databaseUrl,
    instanceConnectionName,
    dbUser: env.YAPA_DB_USER || undefined,
    dbName: env.YAPA_DB_NAME || undefined,
    dbIpType: ipType,
    poolMax: int(env, 'YAPA_DB_POOL_MAX', 5),
    statementTimeoutMs: int(env, 'YAPA_STATEMENT_TIMEOUT_MS', 5000),
  };
}

/** YAPA_MCP_TOOLS: "all", or a comma-separated subset of READ_TOOLS (default: memory_recall). */
export function parseTools(raw: string | undefined): ReadonlySet<string> {
  const v = (raw ?? '').trim();
  if (!v) return new Set(DEFAULT_TOOLS);
  if (v.toLowerCase() === 'all') return new Set(READ_TOOLS);
  const names = v.split(',').map(x => x.trim()).filter(Boolean);
  const unknown = names.filter(n => !(READ_TOOLS as readonly string[]).includes(n));
  if (unknown.length) {
    throw new ConfigError(`YAPA_MCP_TOOLS: unknown tool(s) ${unknown.join(', ')}; valid: ${READ_TOOLS.join(', ')}, or "all"`);
  }
  return new Set(names);
}
