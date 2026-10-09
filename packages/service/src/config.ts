/**
 * Service configuration, read from the environment once at startup.
 * Every variable is documented in packages/service/README.md.
 */

export type AuthMode = 'google' | 'insecure-test';

export interface RateLimitClass {
  /** Tokens added per second. */
  ratePerSec: number;
  /** Bucket size (burst). */
  burst: number;
}

export interface RateLimits {
  read: RateLimitClass;
  write: RateLimitClass;
  /** Documents written (upserted or deleted) per user; 2,000/min sustained. */
  writeDocs: RateLimitClass;
  similar: RateLimitClass;
}

export interface ServiceConfig {
  port: number;
  authMode: AuthMode;
  /** Accepted `aud` values for Google ID tokens. */
  audiences: string[];
  /** Required `hd` (Google Workspace domain) claim. */
  allowedHd: string;
  /** Create a users row on first sign-in for verified accounts in allowedHd (YAPA_AUTO_PROVISION=true). */
  autoProvision: boolean;
  /** Direct connection string (local dev and tests). */
  databaseUrl?: string;
  /** Cloud SQL `project:region:instance` (production, with IAM auth over private IP). */
  instanceConnectionName?: string;
  dbUser?: string;
  dbName?: string;
  /** IP type for the Cloud SQL connector; PRIVATE in production. */
  dbIpType: 'PRIVATE' | 'PUBLIC' | 'PSC';
  poolMax: number;
  statementTimeoutMs: number;
  /** Similarity threshold for the `similar` hint returned by upsert. */
  similarityThreshold: number;
  rateLimits: RateLimits | false;
  /** Per-user daily document write count that triggers an alert log line. */
  dailyWriteAlert: number;
  /** Byte budget of serialized documents per pull page. */
  pullMaxBytes: number;
}

/** 8 MiB: well under Cloud Run's 32 MiB response cap, even with embeddings. */
export const PULL_MAX_BYTES_DEFAULT = 8 * 1024 * 1024;

export const DEFAULT_RATE_LIMITS: RateLimits = {
  read: { ratePerSec: 20, burst: 100 },
  write: { ratePerSec: 10, burst: 50 },
  writeDocs: { ratePerSec: 2000 / 60, burst: 2000 },
  similar: { ratePerSec: 5, burst: 20 },
};

export class ConfigError extends Error {}

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

export function loadConfig(env: Record<string, string | undefined> = process.env): ServiceConfig {
  const mode = (env.YAPA_AUTH_MODE || 'google') as AuthMode;
  if (mode !== 'google' && mode !== 'insecure-test') {
    throw new ConfigError(`YAPA_AUTH_MODE must be "google" or "insecure-test", got "${mode}"`);
  }
  if (mode === 'insecure-test' && env.K_SERVICE) {
    // K_SERVICE is set by Cloud Run on every revision.
    throw new ConfigError('YAPA_AUTH_MODE=insecure-test is refused on Cloud Run (K_SERVICE is set)');
  }

  const audiences = list(env.YAPA_AUDIENCES);
  const allowedHd = (env.YAPA_ALLOWED_HD ?? '').trim().toLowerCase();
  if (mode === 'google') {
    if (audiences.length === 0) throw new ConfigError('YAPA_AUDIENCES is required (comma separated)');
    if (!allowedHd) throw new ConfigError('YAPA_ALLOWED_HD is required');
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

  const threshold = env.YAPA_SIMILARITY_THRESHOLD ? Number(env.YAPA_SIMILARITY_THRESHOLD) : 0.95;
  if (!(threshold >= 0.5 && threshold <= 1)) throw new ConfigError('YAPA_SIMILARITY_THRESHOLD must be in [0.5, 1]');

  const rl = (env.YAPA_RATE_LIMITS || 'on').toLowerCase();
  if (rl !== 'on' && rl !== 'off') throw new ConfigError('YAPA_RATE_LIMITS must be "on" or "off"');

  return {
    port: int(env, 'PORT', 8080),
    authMode: mode,
    audiences,
    allowedHd,
    autoProvision: (env.YAPA_AUTO_PROVISION ?? '').trim().toLowerCase() === 'true',
    databaseUrl,
    instanceConnectionName,
    dbUser: env.YAPA_DB_USER || undefined,
    dbName: env.YAPA_DB_NAME || undefined,
    dbIpType: ipType,
    poolMax: int(env, 'YAPA_DB_POOL_MAX', 5),
    statementTimeoutMs: int(env, 'YAPA_STATEMENT_TIMEOUT_MS', 5000),
    similarityThreshold: threshold,
    rateLimits: rl === 'off' ? false : DEFAULT_RATE_LIMITS,
    dailyWriteAlert: int(env, 'YAPA_DAILY_WRITE_ALERT', 20000),
    pullMaxBytes: int(env, 'YAPA_PULL_MAX_BYTES', PULL_MAX_BYTES_DEFAULT, 64 * 1024),
  };
}
