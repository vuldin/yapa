/**
 * Library entry (`@yapa/service/lib`) for other server packages, today the
 * remote MCP service (packages/mcp-remote). Re-exports only; importing it
 * starts nothing. The HTTP API itself stays in app.ts/server.ts.
 */
export {
  AuthFailure, bearerToken, checkGoogleClaims, GoogleTokenVerifier, logAuthFailure,
  type Caller as ServiceCaller, type TokenVerifier, type UserRow, type VerifiedIdentity,
} from './auth.js';
export {
  ConfigError, DEFAULT_RATE_LIMITS, READER_USERNAME_RE,
  type RateLimitClass, type ServiceConfig,
} from './config.js';
export { decodeCursor, encodeCursor, posFromSince, type FeedPos, type PullCursor } from './cursor.js';
export { createDb, isUnavailableError, withUserTx, type Db, type DbConfig } from './db.js';
export { ApiError, statusFor, type ErrorCode } from './errors.js';
export { log, setLogSink, type Severity } from './log.js';
export { TokenBuckets } from './ratelimit.js';
export {
  assertCollection, checkCollection, checkEmbedding, clamp, EMBEDDING_DIMS, isLocalOnlyCollection,
  MAX_FUTURE_SECONDS, toPgVector,
} from './rules.js';
export {
  findOrCreateUser, findUserByEmail, listCollections, pull, READER_USERNAME_PREFIX, usernameFromEmail,
  type DocumentOut, type PullResult, type RequestCtx,
} from './store.js';
